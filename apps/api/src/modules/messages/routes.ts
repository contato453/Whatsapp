import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { MediaPayload } from "@zapdesk/shared";
import { RealtimeEvents } from "@zapdesk/shared";
import { accessibleInstanceIds, instanceScope } from "../../lib/access.js";
import { authenticate } from "../../lib/auth.js";
import { AppError, NotFoundError } from "../../lib/errors.js";
import { extensionFromMime } from "../../lib/media-storage.js";
import { serializeConversation, serializeMessage } from "../../lib/serialize.js";
import { instanceAudience } from "../../realtime/socket.js";
import { buildPreview } from "../../services/message-ingest.js";
import type { AppDeps } from "../../types.js";

const listQuerySchema = z.object({
  before: z.string().datetime().optional(),
  limit: z.coerce.number().min(1).max(100).default(50),
});

function mediaTypeFromMime(mimeType: string): MediaPayload["type"] {
  if (mimeType.startsWith("image/")) return "image";
  if (mimeType.startsWith("audio/")) return "audio";
  if (mimeType.startsWith("video/")) return "video";
  return "document";
}

export async function messageRoutes(app: FastifyInstance, deps: AppDeps): Promise<void> {
  /** Escopado por organização e pelas conexões liberadas para o usuário. */
  async function findConversationOr404(id: string, user: FastifyRequest["user"]) {
    const allowed = await accessibleInstanceIds(deps.prisma, user);
    const conversation = await deps.prisma.conversation.findFirst({
      where: { id, organizationId: user.organizationId, ...instanceScope(allowed) },
      include: { instance: true },
    });
    if (!conversation) throw new NotFoundError("Conversa");
    return conversation;
  }

  async function afterOutboundPersist(
    conversationId: string,
    organizationId: string,
    messageId: string,
  ): Promise<void> {
    const [conversation, message] = await Promise.all([
      deps.prisma.conversation.findUnique({
        where: { id: conversationId },
        include: {
          assignedUser: true,
          department: true,
          instance: true,
          tags: { include: { tag: true } },
        },
      }),
      deps.prisma.message.findUnique({ where: { id: messageId } }),
    ]);
    if (!conversation || !message) return;
    const room = instanceAudience(organizationId, conversation.whatsappInstanceId);
    deps.io.to(room).emit(RealtimeEvents.MessageNew, {
      conversation: serializeConversation(conversation),
      message: serializeMessage(message),
    });
    deps.io.to(room).emit(RealtimeEvents.ConversationUpdated, serializeConversation(conversation));
  }

  app.get("/conversations/:id/messages", { preHandler: authenticate }, async (request) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const query = listQuerySchema.parse(request.query);
    await findConversationOr404(id, request.user);
    const messages = await deps.prisma.message.findMany({
      where: {
        conversationId: id,
        ...(query.before ? { timestamp: { lt: new Date(query.before) } } : {}),
      },
      orderBy: { timestamp: "desc" },
      take: query.limit,
    });
    return { messages: messages.reverse().map(serializeMessage) };
  });

  app.post("/conversations/:id/messages", { preHandler: authenticate }, async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const { content } = z.object({ content: z.string().min(1).max(65_000) }).parse(request.body);
    const conversation = await findConversationOr404(id, request.user);

    const result = await deps.provider.sendText(
      conversation.whatsappInstanceId,
      conversation.externalChatId,
      content,
    );

    const message = await deps.prisma.message.create({
      data: {
        organizationId: request.user.organizationId,
        conversationId: id,
        externalMessageId: result.externalMessageId,
        direction: "outbound",
        type: "text",
        content,
        senderName: request.user.name,
        timestamp: result.timestamp,
        status: "sent",
        sentByUserId: request.user.sub,
      },
    });
    await deps.prisma.conversation.update({
      where: { id },
      data: {
        lastMessageAt: result.timestamp,
        lastMessagePreview: buildPreview({ type: "text", content }),
        ...(conversation.status === "new" ? { status: "open" as const } : {}),
      },
    });
    deps.audit.record({
      organizationId: request.user.organizationId,
      userId: request.user.sub,
      action: "message.sent",
      entityType: "Conversation",
      entityId: id,
    });
    await afterOutboundPersist(id, request.user.organizationId, message.id);
    return reply.status(201).send({ message: serializeMessage(message) });
  });

  app.post(
    "/conversations/:id/messages/media",
    { preHandler: authenticate },
    async (request, reply) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
      const conversation = await findConversationOr404(id, request.user);

      const file = await request.file();
      if (!file) {
        throw new AppError("Arquivo é obrigatório", 400, "file_required");
      }
      const buffer = await file.toBuffer();
      const mimeType = file.mimetype || "application/octet-stream";
      const caption =
        typeof (file.fields.caption as { value?: unknown } | undefined)?.value === "string"
          ? ((file.fields.caption as { value: string }).value || undefined)
          : undefined;
      const asVoiceNote =
        (file.fields.asVoiceNote as { value?: unknown } | undefined)?.value === "true";

      const mediaType = mediaTypeFromMime(mimeType);
      const result = await deps.provider.sendMedia(
        conversation.whatsappInstanceId,
        conversation.externalChatId,
        {
          data: buffer,
          mimeType,
          filename: file.filename,
          caption,
          type: mediaType,
          asVoiceNote,
        },
      );

      const mediaUrl = await deps.storage.save(buffer, {
        instanceId: conversation.whatsappInstanceId,
        extension: file.filename?.split(".").pop() ?? extensionFromMime(mimeType),
      });

      const message = await deps.prisma.message.create({
        data: {
          organizationId: request.user.organizationId,
          conversationId: id,
          externalMessageId: result.externalMessageId,
          direction: "outbound",
          type: mediaType,
          content: caption ?? null,
          mediaUrl,
          mimeType,
          filename: file.filename ?? null,
          senderName: request.user.name,
          timestamp: result.timestamp,
          status: "sent",
          sentByUserId: request.user.sub,
        },
      });
      await deps.prisma.conversation.update({
        where: { id },
        data: {
          lastMessageAt: result.timestamp,
          lastMessagePreview: buildPreview({ type: mediaType, content: caption ?? null }),
          ...(conversation.status === "new" ? { status: "open" as const } : {}),
        },
      });
      deps.audit.record({
        organizationId: request.user.organizationId,
        userId: request.user.sub,
        action: "message.media_sent",
        entityType: "Conversation",
        entityId: id,
        metadata: { mediaType },
      });
      await afterOutboundPersist(id, request.user.organizationId, message.id);
      return reply.status(201).send({ message: serializeMessage(message) });
    },
  );

  /** Download/exibição da mídia de uma mensagem (autenticado, escopado por organização). */
  app.get("/messages/:id/media", { preHandler: authenticate }, async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const allowed = await accessibleInstanceIds(deps.prisma, request.user);
    const message = await deps.prisma.message.findFirst({
      where: {
        id,
        organizationId: request.user.organizationId,
        ...(allowed ? { conversation: { whatsappInstanceId: { in: allowed } } } : {}),
      },
    });
    if (!message?.mediaUrl) throw new NotFoundError("Mídia");
    const data = await deps.storage.read(message.mediaUrl);
    reply.header("Content-Type", message.mimeType ?? "application/octet-stream");
    if (message.filename) {
      reply.header(
        "Content-Disposition",
        `inline; filename="${encodeURIComponent(message.filename)}"`,
      );
    }
    reply.header("Cache-Control", "private, max-age=31536000, immutable");
    return reply.send(data);
  });
}

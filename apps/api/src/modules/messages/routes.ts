import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { MediaPayload, QuotedMessageRef } from "@zapdesk/shared";
import { RealtimeEvents } from "@zapdesk/shared";
import { accessibleInstanceIds, instanceScope } from "../../lib/access.js";
import { authenticate } from "../../lib/auth.js";
import { AppError, NotFoundError } from "../../lib/errors.js";
import { extensionFromMime } from "../../lib/media-storage.js";
import { transcodeToOpusOgg } from "../../lib/audio-transcode.js";
import {
  serializeConversation,
  serializeMessage,
  type QuotedPreview,
} from "../../lib/serialize.js";
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

  /**
   * Resolve as mensagens citadas de um lote, em uma única consulta,
   * para exibir a pré-visualização do reply.
   */
  async function loadQuotedPreviews(
    conversationId: string,
    messages: Array<{ quotedMessageId: string | null }>,
  ): Promise<Map<string, QuotedPreview>> {
    const ids = [
      ...new Set(messages.map((message) => message.quotedMessageId).filter((value): value is string => !!value)),
    ];
    if (ids.length === 0) return new Map();
    const originals = await deps.prisma.message.findMany({
      where: { conversationId, externalMessageId: { in: ids } },
      select: {
        id: true,
        externalMessageId: true,
        senderName: true,
        senderPhone: true,
        content: true,
        type: true,
        direction: true,
      },
    });
    return new Map(
      originals.map((original) => [
        original.externalMessageId as string,
        {
          id: original.id,
          senderName:
            original.direction === "outbound"
              ? (original.senderName ?? "Você")
              : (original.senderName ?? original.senderPhone),
          content: original.content,
          type: original.type,
        },
      ]),
    );
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
      include: { reactions: true },
    });
    const ordered = messages.reverse();
    const quotedMap = await loadQuotedPreviews(id, ordered);
    const total = await deps.prisma.message.count({ where: { conversationId: id } });
    return {
      messages: ordered.map((message) =>
        serializeMessage(
          message,
          message.quotedMessageId ? (quotedMap.get(message.quotedMessageId) ?? null) : null,
        ),
      ),
      // Indica se ainda há histórico anterior para carregar
      hasMore: total > messages.length + (query.before ? 1 : 0),
    };
  });

  /** Reage a uma mensagem (emoji vazio remove a reação). */
  app.post("/messages/:id/reactions", { preHandler: authenticate }, async (request) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const { emoji } = z.object({ emoji: z.string().max(16) }).parse(request.body);
    const allowed = await accessibleInstanceIds(deps.prisma, request.user);
    const message = await deps.prisma.message.findFirst({
      where: {
        id,
        organizationId: request.user.organizationId,
        ...(allowed ? { conversation: { whatsappInstanceId: { in: allowed } } } : {}),
      },
      include: { conversation: true },
    });
    if (!message?.externalMessageId) throw new NotFoundError("Mensagem");

    await deps.provider.sendReaction(
      message.conversation.whatsappInstanceId,
      message.conversation.externalChatId,
      {
        externalMessageId: message.externalMessageId,
        fromMe: message.direction === "outbound",
        participantExternalId:
          message.conversation.type === "group" ? message.senderExternalId : null,
      },
      emoji,
    );

    const ownKey = `me:${request.user.organizationId}`;
    if (emoji) {
      await deps.prisma.messageReaction.upsert({
        where: { messageId_senderExternalId: { messageId: id, senderExternalId: ownKey } },
        update: { emoji, senderName: request.user.name },
        create: {
          messageId: id,
          emoji,
          senderExternalId: ownKey,
          senderName: request.user.name,
          fromMe: true,
        },
      });
    } else {
      await deps.prisma.messageReaction.deleteMany({
        where: { messageId: id, senderExternalId: ownKey },
      });
    }

    const reactions = await deps.prisma.messageReaction.findMany({ where: { messageId: id } });
    const audience = instanceAudience(
      request.user.organizationId,
      message.conversation.whatsappInstanceId,
    );
    deps.io.to(audience).emit(RealtimeEvents.MessageReaction, {
      conversationId: message.conversationId,
      messageId: id,
      reactions: reactions.map((entry) => ({
        emoji: entry.emoji,
        senderName: entry.senderName,
        fromMe: entry.fromMe,
      })),
    });
    return { ok: true };
  });

  /** Apaga a mensagem para todos (só mensagens enviadas por nós). */
  app.delete("/messages/:id", { preHandler: authenticate }, async (request) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const message = await deps.prisma.message.findFirst({
      where: { id, organizationId: request.user.organizationId },
      include: { conversation: true },
    });
    if (!message?.externalMessageId) throw new NotFoundError("Mensagem");
    if (message.direction !== "outbound") {
      throw new AppError("Só é possível apagar mensagens enviadas por você", 400, "not_outbound");
    }
    if (message.deletedAt) return { ok: true };

    await deps.provider.deleteMessage(
      message.conversation.whatsappInstanceId,
      message.conversation.externalChatId,
      {
        externalMessageId: message.externalMessageId,
        fromMe: true,
        participantExternalId: null,
      },
    );
    const updated = await deps.prisma.message.update({
      where: { id },
      data: { deletedAt: new Date(), deletedByUserId: request.user.sub, content: null },
    });
    deps.audit.record({
      organizationId: request.user.organizationId,
      userId: request.user.sub,
      action: "message.deleted",
      entityType: "Message",
      entityId: id,
    });
    deps.io
      .to(instanceAudience(request.user.organizationId, message.conversation.whatsappInstanceId))
      .emit(RealtimeEvents.MessageUpdated, serializeMessage(updated));
    return { ok: true };
  });

  /** Edita o texto de uma mensagem enviada. */
  app.patch("/messages/:id", { preHandler: authenticate }, async (request) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const { content } = z.object({ content: z.string().min(1).max(65_000) }).parse(request.body);
    const message = await deps.prisma.message.findFirst({
      where: { id, organizationId: request.user.organizationId },
      include: { conversation: true },
    });
    if (!message?.externalMessageId) throw new NotFoundError("Mensagem");
    if (message.direction !== "outbound" || message.type !== "text") {
      throw new AppError(
        "Só é possível editar mensagens de texto enviadas por você",
        400,
        "not_editable",
      );
    }
    if (message.deletedAt) {
      throw new AppError("Mensagem apagada não pode ser editada", 400, "deleted");
    }

    await deps.provider.editMessage(
      message.conversation.whatsappInstanceId,
      message.conversation.externalChatId,
      {
        externalMessageId: message.externalMessageId,
        fromMe: true,
        participantExternalId: null,
      },
      content,
    );
    const updated = await deps.prisma.message.update({
      where: { id },
      data: { content, editedAt: new Date() },
    });
    deps.audit.record({
      organizationId: request.user.organizationId,
      userId: request.user.sub,
      action: "message.edited",
      entityType: "Message",
      entityId: id,
    });
    deps.io
      .to(instanceAudience(request.user.organizationId, message.conversation.whatsappInstanceId))
      .emit(RealtimeEvents.MessageUpdated, serializeMessage(updated));
    return { message: serializeMessage(updated) };
  });

  /** Encaminha uma mensagem (texto ou mídia) para outra conversa. */
  app.post("/messages/:id/forward", { preHandler: authenticate }, async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const { conversationId } = z
      .object({ conversationId: z.string().uuid() })
      .parse(request.body);

    const allowedForForward = await accessibleInstanceIds(deps.prisma, request.user);
    const original = await deps.prisma.message.findFirst({
      where: {
        id,
        organizationId: request.user.organizationId,
        ...(allowedForForward
          ? { conversation: { whatsappInstanceId: { in: allowedForForward } } }
          : {}),
      },
    });
    if (!original) throw new NotFoundError("Mensagem");
    const target = await findConversationOr404(conversationId, request.user);

    let result: Awaited<ReturnType<typeof deps.provider.sendText>>;
    if (original.mediaUrl) {
      const data = await deps.storage.read(original.mediaUrl);
      result = await deps.provider.sendMedia(
        target.whatsappInstanceId,
        target.externalChatId,
        {
          data,
          mimeType: original.mimeType ?? "application/octet-stream",
          filename: original.filename ?? undefined,
          caption: original.content ?? undefined,
          type: mediaTypeFromMime(original.mimeType ?? ""),
        },
      );
    } else {
      if (!original.content) throw new AppError("Mensagem sem conteúdo para encaminhar", 400);
      result = await deps.provider.sendText(
        target.whatsappInstanceId,
        target.externalChatId,
        original.content,
      );
    }

    const forwarded = await deps.prisma.message.create({
      data: {
        organizationId: request.user.organizationId,
        conversationId: target.id,
        externalMessageId: result.externalMessageId,
        direction: "outbound",
        type: original.type,
        content: original.content,
        mediaUrl: original.mediaUrl,
        mimeType: original.mimeType,
        filename: original.filename,
        senderName: request.user.name,
        timestamp: result.timestamp,
        status: "sent",
        sentByUserId: request.user.sub,
      },
    });
    await deps.prisma.conversation.update({
      where: { id: target.id },
      data: {
        lastMessageAt: result.timestamp,
        lastMessagePreview: buildPreview({ type: original.type, content: original.content }),
        ...(target.status === "new" ? { status: "open" as const } : {}),
      },
    });
    deps.audit.record({
      organizationId: request.user.organizationId,
      userId: request.user.sub,
      action: "message.forwarded",
      entityType: "Message",
      entityId: id,
      metadata: { toConversationId: target.id },
    });
    await afterOutboundPersist(target.id, request.user.organizationId, forwarded.id);
    return reply.status(201).send({ message: serializeMessage(forwarded) });
  });

  app.post("/conversations/:id/messages", { preHandler: authenticate }, async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const { content, replyToMessageId } = z
      .object({
        content: z.string().min(1).max(65_000),
        replyToMessageId: z.string().uuid().optional(),
      })
      .parse(request.body);
    const conversation = await findConversationOr404(id, request.user);

    // Reply: monta a referência da mensagem citada a partir do que temos salvo.
    let quoted: QuotedMessageRef | undefined;
    let quotedExternalId: string | null = null;
    if (replyToMessageId) {
      const original = await deps.prisma.message.findFirst({
        where: { id: replyToMessageId, conversationId: id },
      });
      if (original?.externalMessageId) {
        quotedExternalId = original.externalMessageId;
        quoted = {
          externalMessageId: original.externalMessageId,
          participantExternalId:
            conversation.type === "group" ? original.senderExternalId : null,
          fromMe: original.direction === "outbound",
          text: original.content,
        };
      }
    }

    const result = await deps.provider.sendText(
      conversation.whatsappInstanceId,
      conversation.externalChatId,
      content,
      quoted,
    );

    const message = await deps.prisma.message.create({
      data: {
        organizationId: request.user.organizationId,
        conversationId: id,
        externalMessageId: result.externalMessageId,
        direction: "outbound",
        type: "text",
        content,
        quotedMessageId: quotedExternalId,
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
      let buffer = await file.toBuffer();
      let mimeType = file.mimetype || "application/octet-stream";
      const caption =
        typeof (file.fields.caption as { value?: unknown } | undefined)?.value === "string"
          ? ((file.fields.caption as { value: string }).value || undefined)
          : undefined;
      let asVoiceNote =
        (file.fields.asVoiceNote as { value?: unknown } | undefined)?.value === "true";

      // Mensagem de voz: o navegador grava em WebM/Opus e o WhatsApp espera
      // OGG/Opus. Sem ffmpeg, envia como arquivo de áudio comum.
      if (asVoiceNote && mimeType.startsWith("audio/") && !mimeType.includes("ogg")) {
        const converted = await transcodeToOpusOgg(buffer, deps.logger);
        if (converted) {
          buffer = converted;
          mimeType = "audio/ogg; codecs=opus";
        } else {
          asVoiceNote = false;
          deps.logger.warn({
            conversationId: id,
            event: "voice_note_fallback",
            reason: "ffmpeg indisponível — enviado como arquivo de áudio",
          });
        }
      }

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

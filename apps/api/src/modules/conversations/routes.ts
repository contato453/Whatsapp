import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Prisma } from "@zapdesk/database";
import { z } from "zod";
import { RealtimeEvents } from "@zapdesk/shared";
import { accessibleInstanceIds, instanceScope } from "../../lib/access.js";
import { authenticate } from "../../lib/auth.js";
import { NotFoundError } from "../../lib/errors.js";
import { serializeConversation, serializeUser } from "../../lib/serialize.js";
import { instanceAudience } from "../../realtime/socket.js";
import type { AppDeps } from "../../types.js";

const listQuerySchema = z.object({
  status: z.enum(["new", "open", "waiting", "resolved", "archived"]).optional(),
  type: z.enum(["individual", "group"]).optional(),
  assigned: z.string().optional(), // "me" | "none" | userId
  departmentId: z.string().uuid().optional(),
  instanceId: z.string().uuid().optional(),
  tagId: z.string().uuid().optional(),
  unread: z.coerce.boolean().optional(),
  q: z.string().max(120).optional(),
  limit: z.coerce.number().min(1).max(100).default(50),
  offset: z.coerce.number().min(0).default(0),
});

const conversationInclude = {
  assignedUser: true,
  department: true,
  instance: true,
  tags: { include: { tag: true } },
} satisfies Prisma.ConversationInclude;

export async function conversationRoutes(app: FastifyInstance, deps: AppDeps): Promise<void> {
  /**
   * Além da organização, respeita as conexões liberadas para o usuário:
   * conversa de um número sem acesso responde 404, como se não existisse.
   */
  async function findConversationOr404(id: string, user: FastifyRequest["user"]) {
    const allowed = await accessibleInstanceIds(deps.prisma, user);
    const conversation = await deps.prisma.conversation.findFirst({
      where: { id, organizationId: user.organizationId, ...instanceScope(allowed) },
      include: conversationInclude,
    });
    if (!conversation) throw new NotFoundError("Conversa");
    return conversation;
  }

  async function emitConversationUpdated(id: string, organizationId: string): Promise<void> {
    const conversation = await deps.prisma.conversation.findUnique({
      where: { id },
      include: conversationInclude,
    });
    if (conversation) {
      deps.io
        .to(instanceAudience(organizationId, conversation.whatsappInstanceId))
        .emit(RealtimeEvents.ConversationUpdated, serializeConversation(conversation));
    }
  }

  app.get("/conversations", { preHandler: authenticate }, async (request) => {
    const query = listQuerySchema.parse(request.query);
    const allowed = await accessibleInstanceIds(deps.prisma, request.user);
    // Filtro por um número ao qual o usuário não tem acesso: lista vazia.
    if (query.instanceId && allowed && !allowed.includes(query.instanceId)) {
      return { conversations: [], total: 0 };
    }
    const where: Prisma.ConversationWhereInput = {
      organizationId: request.user.organizationId,
      ...instanceScope(allowed),
      ...(query.status ? { status: query.status } : {}),
      ...(query.type ? { type: query.type } : {}),
      ...(query.departmentId ? { departmentId: query.departmentId } : {}),
      ...(query.instanceId ? { whatsappInstanceId: query.instanceId } : {}),
      ...(query.unread ? { unreadCount: { gt: 0 } } : {}),
      ...(query.tagId ? { tags: { some: { tagId: query.tagId } } } : {}),
      ...(query.q ? { title: { contains: query.q, mode: "insensitive" } } : {}),
    };
    if (query.assigned === "me") {
      where.assignedUserId = request.user.sub;
    } else if (query.assigned === "none") {
      where.assignedUserId = null;
    } else if (query.assigned) {
      where.assignedUserId = query.assigned;
    }

    const [conversations, total] = await Promise.all([
      deps.prisma.conversation.findMany({
        where,
        include: conversationInclude,
        orderBy: [{ lastMessageAt: { sort: "desc", nulls: "last" } }, { createdAt: "desc" }],
        take: query.limit,
        skip: query.offset,
      }),
      deps.prisma.conversation.count({ where }),
    ]);
    return { conversations: conversations.map(serializeConversation), total };
  });

  app.get("/conversations/:id", { preHandler: authenticate }, async (request) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const conversation = await findConversationOr404(id, request.user);

    // Painel de contexto: grupo + participantes + histórico de atribuição
    const [group, history, notes] = await Promise.all([
      conversation.type === "group"
        ? deps.prisma.whatsAppGroup.findFirst({
            where: {
              whatsappInstanceId: conversation.whatsappInstanceId,
              externalId: conversation.externalChatId,
            },
            include: { participants: { orderBy: { name: "asc" } } },
          })
        : Promise.resolve(null),
      deps.prisma.conversationAssignmentHistory.findMany({
        where: { conversationId: id },
        orderBy: { createdAt: "desc" },
        take: 20,
        include: { performedBy: true },
      }),
      deps.prisma.internalNote.findMany({
        where: { conversationId: id },
        orderBy: { createdAt: "desc" },
        take: 50,
        include: { user: true },
      }),
    ]);

    // Busca as fotos dos participantes em segundo plano; o frontend é
    // avisado por WebSocket quando houver novidade.
    if (group) {
      void deps.instanceManager.syncParticipantAvatars(id, request.user.organizationId);
    }

    return {
      conversation: serializeConversation(conversation),
      group: group
        ? {
            id: group.id,
            name: group.name,
            description: group.description,
            participantCount: group.participantCount,
            participants: group.participants.map((participant) => ({
              id: participant.id,
              phoneNumber: participant.phoneNumber,
              name: participant.name,
              isAdmin: participant.isAdmin || participant.isSuperAdmin,
              hasAvatar: participant.avatarUrl != null,
            })),
          }
        : null,
      assignmentHistory: history.map((entry) => ({
        id: entry.id,
        action: entry.action,
        performedBy: entry.performedBy ? serializeUser(entry.performedBy) : null,
        note: entry.note,
        createdAt: entry.createdAt.toISOString(),
      })),
      notes: notes.map((note) => ({
        id: note.id,
        content: note.content,
        user: note.user ? serializeUser(note.user) : null,
        createdAt: note.createdAt.toISOString(),
      })),
    };
  });

  /** Foto de perfil da conversa (contato ou grupo), autenticada. */
  app.get("/conversations/:id/avatar", { preHandler: authenticate }, async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const allowed = await accessibleInstanceIds(deps.prisma, request.user);
    const conversation = await deps.prisma.conversation.findFirst({
      where: { id, organizationId: request.user.organizationId, ...instanceScope(allowed) },
      select: { profilePicture: true },
    });
    if (!conversation?.profilePicture) throw new NotFoundError("Foto de perfil");
    const data = await deps.storage.read(conversation.profilePicture);
    reply.header("Content-Type", "image/jpeg");
    reply.header("Cache-Control", "private, max-age=86400");
    return reply.send(data);
  });

  /** Foto de perfil de um participante de grupo, autenticada. */
  app.get("/group-participants/:id/avatar", { preHandler: authenticate }, async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const allowed = await accessibleInstanceIds(deps.prisma, request.user);
    const participant = await deps.prisma.groupParticipant.findFirst({
      where: {
        id,
        group: { organizationId: request.user.organizationId, ...instanceScope(allowed) },
      },
      select: { avatarUrl: true },
    });
    if (!participant?.avatarUrl) throw new NotFoundError("Foto de perfil");
    const data = await deps.storage.read(participant.avatarUrl);
    reply.header("Content-Type", "image/jpeg");
    reply.header("Cache-Control", "private, max-age=86400");
    return reply.send(data);
  });

  /**
   * Força nova busca das fotos (da conversa e, em grupos, dos participantes).
   * Útil quando alguém troca a imagem ou quando uma consulta anterior falhou.
   */
  app.post("/conversations/:id/avatar/refresh", { preHandler: authenticate }, async (request) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const conversation = await findConversationOr404(id, request.user);
    const group = await deps.prisma.whatsAppGroup.findFirst({
      where: { conversationId: id, organizationId: request.user.organizationId },
      select: { id: true },
    });

    await deps.instanceManager.resetAvatarChecks(id, group?.id);
    const updated = await deps.instanceManager.syncConversationAvatar(
      {
        id: conversation.id,
        whatsappInstanceId: conversation.whatsappInstanceId,
        externalChatId: conversation.externalChatId,
      },
      { force: true },
    );
    if (updated) {
      await emitConversationUpdated(id, request.user.organizationId);
    }
    if (group) {
      // Participantes são buscados em segundo plano (pode levar alguns segundos).
      void deps.instanceManager.syncParticipantAvatars(id, request.user.organizationId);
    }
    return { updated };
  });

  app.post("/conversations/:id/read", { preHandler: authenticate }, async (request) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    await findConversationOr404(id, request.user);
    await deps.prisma.conversation.update({ where: { id }, data: { unreadCount: 0 } });
    await emitConversationUpdated(id, request.user.organizationId);
    return { ok: true };
  });

  // ---------------- Atribuição de atendimento ----------------

  const assignSchema = z.object({
    userId: z.string().uuid().optional(),
    departmentId: z.string().uuid().optional(),
    note: z.string().max(500).optional(),
  });

  app.post("/conversations/:id/assign", { preHandler: authenticate }, async (request) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const body = assignSchema.parse(request.body);
    const conversation = await findConversationOr404(id, request.user);

    // Sem corpo: o próprio usuário assume o atendimento.
    const targetUserId = body.userId ?? request.user.sub;
    const isTransfer = conversation.assignedUserId != null && conversation.assignedUserId !== targetUserId;

    await deps.prisma.$transaction([
      deps.prisma.conversation.update({
        where: { id },
        data: {
          assignedUserId: targetUserId,
          ...(body.departmentId ? { departmentId: body.departmentId } : {}),
          ...(conversation.status === "new" ? { status: "open" as const } : {}),
        },
      }),
      deps.prisma.conversationAssignmentHistory.create({
        data: {
          organizationId: request.user.organizationId,
          conversationId: id,
          action: isTransfer ? "transferred_user" : "assigned",
          fromUserId: conversation.assignedUserId,
          toUserId: targetUserId,
          performedByUserId: request.user.sub,
          note: body.note,
        },
      }),
    ]);
    deps.audit.record({
      organizationId: request.user.organizationId,
      userId: request.user.sub,
      action: isTransfer ? "conversation.transferred" : "conversation.assigned",
      entityType: "Conversation",
      entityId: id,
    });
    await emitConversationUpdated(id, request.user.organizationId);
    return { ok: true };
  });

  app.post(
    "/conversations/:id/transfer-department",
    { preHandler: authenticate },
    async (request) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
      const body = z
        .object({ departmentId: z.string().uuid(), note: z.string().max(500).optional() })
        .parse(request.body);
      const conversation = await findConversationOr404(id, request.user);
      const department = await deps.prisma.department.findFirst({
        where: { id: body.departmentId, organizationId: request.user.organizationId },
      });
      if (!department) throw new NotFoundError("Departamento");

      await deps.prisma.$transaction([
        deps.prisma.conversation.update({
          where: { id },
          data: { departmentId: body.departmentId, assignedUserId: null },
        }),
        deps.prisma.conversationAssignmentHistory.create({
          data: {
            organizationId: request.user.organizationId,
            conversationId: id,
            action: "transferred_department",
            fromUserId: conversation.assignedUserId,
            fromDepartmentId: conversation.departmentId,
            toDepartmentId: body.departmentId,
            performedByUserId: request.user.sub,
            note: body.note,
          },
        }),
      ]);
      await emitConversationUpdated(id, request.user.organizationId);
      return { ok: true };
    },
  );

  app.post("/conversations/:id/unassign", { preHandler: authenticate }, async (request) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const conversation = await findConversationOr404(id, request.user);
    await deps.prisma.$transaction([
      deps.prisma.conversation.update({ where: { id }, data: { assignedUserId: null } }),
      deps.prisma.conversationAssignmentHistory.create({
        data: {
          organizationId: request.user.organizationId,
          conversationId: id,
          action: "unassigned",
          fromUserId: conversation.assignedUserId,
          performedByUserId: request.user.sub,
        },
      }),
    ]);
    await emitConversationUpdated(id, request.user.organizationId);
    return { ok: true };
  });

  app.post("/conversations/:id/resolve", { preHandler: authenticate }, async (request) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    await findConversationOr404(id, request.user);
    await deps.prisma.$transaction([
      deps.prisma.conversation.update({ where: { id }, data: { status: "resolved" } }),
      deps.prisma.conversationAssignmentHistory.create({
        data: {
          organizationId: request.user.organizationId,
          conversationId: id,
          action: "resolved",
          performedByUserId: request.user.sub,
        },
      }),
    ]);
    deps.audit.record({
      organizationId: request.user.organizationId,
      userId: request.user.sub,
      action: "conversation.resolved",
      entityType: "Conversation",
      entityId: id,
    });
    await emitConversationUpdated(id, request.user.organizationId);
    return { ok: true };
  });

  app.post("/conversations/:id/reopen", { preHandler: authenticate }, async (request) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    await findConversationOr404(id, request.user);
    await deps.prisma.$transaction([
      deps.prisma.conversation.update({ where: { id }, data: { status: "open" } }),
      deps.prisma.conversationAssignmentHistory.create({
        data: {
          organizationId: request.user.organizationId,
          conversationId: id,
          action: "reopened",
          performedByUserId: request.user.sub,
        },
      }),
    ]);
    await emitConversationUpdated(id, request.user.organizationId);
    return { ok: true };
  });

  const statusSchema = z.object({
    status: z.enum(["new", "open", "waiting", "resolved", "archived"]),
  });

  app.post("/conversations/:id/status", { preHandler: authenticate }, async (request) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const { status } = statusSchema.parse(request.body);
    await findConversationOr404(id, request.user);
    await deps.prisma.conversation.update({ where: { id }, data: { status } });
    await emitConversationUpdated(id, request.user.organizationId);
    return { ok: true };
  });

  // ---------------- Etiquetas da conversa ----------------

  app.post("/conversations/:id/tags/:tagId", { preHandler: authenticate }, async (request) => {
    const { id, tagId } = z
      .object({ id: z.string().uuid(), tagId: z.string().uuid() })
      .parse(request.params);
    await findConversationOr404(id, request.user);
    const tag = await deps.prisma.tag.findFirst({
      where: { id: tagId, organizationId: request.user.organizationId },
    });
    if (!tag) throw new NotFoundError("Etiqueta");
    await deps.prisma.conversationTag.upsert({
      where: { conversationId_tagId: { conversationId: id, tagId } },
      update: {},
      create: { conversationId: id, tagId },
    });
    deps.audit.record({
      organizationId: request.user.organizationId,
      userId: request.user.sub,
      action: "conversation.tag_added",
      entityType: "Conversation",
      entityId: id,
      metadata: { tagId },
    });
    await emitConversationUpdated(id, request.user.organizationId);
    return { ok: true };
  });

  app.delete("/conversations/:id/tags/:tagId", { preHandler: authenticate }, async (request) => {
    const { id, tagId } = z
      .object({ id: z.string().uuid(), tagId: z.string().uuid() })
      .parse(request.params);
    await findConversationOr404(id, request.user);
    await deps.prisma.conversationTag.deleteMany({ where: { conversationId: id, tagId } });
    await emitConversationUpdated(id, request.user.organizationId);
    return { ok: true };
  });

  // ---------------- Notas internas ----------------

  app.post("/conversations/:id/notes", { preHandler: authenticate }, async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const { content } = z.object({ content: z.string().min(1).max(2000) }).parse(request.body);
    await findConversationOr404(id, request.user);
    const note = await deps.prisma.internalNote.create({
      data: {
        organizationId: request.user.organizationId,
        conversationId: id,
        userId: request.user.sub,
        content,
      },
      include: { user: true },
    });
    return reply.status(201).send({
      note: {
        id: note.id,
        content: note.content,
        user: note.user ? serializeUser(note.user) : null,
        createdAt: note.createdAt.toISOString(),
      },
    });
  });
}

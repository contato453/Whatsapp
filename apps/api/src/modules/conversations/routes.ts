import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Prisma } from "@azvchat/database";
import { z } from "zod";
import { CONVERSATION_STATUSES, RealtimeEvents } from "@azvchat/shared";
import {
  conversationScope,
  groupScope,
  loadConversationAccess,
} from "../../lib/access.js";
import { authenticate } from "../../lib/auth.js";
import { AppError, ForbiddenError, NotFoundError } from "../../lib/errors.js";
import { serializeConversation, serializeUserDirectory } from "../../lib/serialize.js";
import { resolveContacts, type SenderInfo } from "../../lib/sender-directory.js";
import { conversationAudience } from "../../realtime/socket.js";
import type { AppDeps } from "../../types.js";

const listQuerySchema = z.object({
  status: z.enum(CONVERSATION_STATUSES).optional(),
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
    const access = await loadConversationAccess(deps.prisma, user);
    const conversation = await deps.prisma.conversation.findFirst({
      where: { id, organizationId: user.organizationId, ...conversationScope(access) },
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
        .to(conversationAudience(organizationId, conversation))
        .emit(RealtimeEvents.ConversationUpdated, serializeConversation(conversation));
    }
  }

  app.get("/conversations", { preHandler: authenticate }, async (request) => {
    const query = listQuerySchema.parse(request.query);
    const access = await loadConversationAccess(deps.prisma, request.user);
    // Filtro por um número ao qual o usuário não tem acesso: lista vazia.
    if (query.instanceId && access.instanceIds && !access.instanceIds.includes(query.instanceId)) {
      return { conversations: [], total: 0 };
    }
    const where: Prisma.ConversationWhereInput = {
      organizationId: request.user.organizationId,
      ...conversationScope(access),
      ...(query.status ? { status: query.status } : {}),
      ...(query.type ? { type: query.type } : {}),
      ...(query.departmentId ? { departmentId: query.departmentId } : {}),
      ...(query.instanceId ? { whatsappInstanceId: query.instanceId } : {}),
      ...(query.unread ? { unreadCount: { gt: 0 } } : {}),
      ...(query.tagId ? { tags: { some: { tagId: query.tagId } } } : {}),
      // Busca pelo nome ou pelo código do cadastro ("EMPRESA 001")
      ...(query.q
        ? {
            OR: [
              { title: { contains: query.q, mode: "insensitive" as const } },
              { externalReference: { contains: query.q, mode: "insensitive" as const } },
            ],
          }
        : {}),
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

    // Em grupos "@lid" os metadados nem sempre trazem nome e telefone de
    // cada participante. Completamos com duas fontes: o cadastro de
    // contatos e o nome que o WhatsApp envia junto das mensagens (pushName).
    const participantIds = group?.participants.map((p) => p.externalContactId) ?? [];
    const [participantContacts, namesFromMessages] = await Promise.all([
      group
        ? resolveContacts(deps.prisma, conversation.whatsappInstanceId, participantIds)
        : Promise.resolve(new Map<string, SenderInfo>()),
      group
        ? deps.prisma.message.findMany({
            where: {
              conversationId: id,
              senderExternalId: { in: participantIds },
              senderName: { not: null },
            },
            distinct: ["senderExternalId"],
            orderBy: { timestamp: "desc" },
            select: { senderExternalId: true, senderName: true },
          })
        : Promise.resolve([]),
    ]);
    const pushNames = new Map(
      namesFromMessages
        .filter((entry) => entry.senderExternalId)
        .map((entry) => [entry.senderExternalId as string, entry.senderName]),
    );

    return {
      conversation: serializeConversation(conversation),
      group: group
        ? {
            id: group.id,
            name: group.name,
            description: group.description,
            participantCount: group.participantCount,
            participants: group.participants.map((participant) => {
              const known = participantContacts.get(participant.externalContactId);
              return {
                id: participant.id,
                // Permite ligar o remetente de cada mensagem ao participante
                // (e, com isso, exibir a foto dele no chat).
                externalContactId: participant.externalContactId,
                phoneNumber: participant.phoneNumber || known?.phoneNumber || "",
                name:
                  participant.name ||
                  known?.name ||
                  pushNames.get(participant.externalContactId) ||
                  null,
                isAdmin: participant.isAdmin || participant.isSuperAdmin,
                hasAvatar: participant.avatarUrl != null,
              };
            }),
          }
        : null,
      assignmentHistory: history.map((entry) => ({
        id: entry.id,
        action: entry.action,
        performedBy: entry.performedBy ? serializeUserDirectory(entry.performedBy) : null,
        note: entry.note,
        createdAt: entry.createdAt.toISOString(),
      })),
      notes: notes.map((note) => ({
        id: note.id,
        content: note.content,
        user: note.user ? serializeUserDirectory(note.user) : null,
        createdAt: note.createdAt.toISOString(),
      })),
    };
  });

  /** Foto de perfil da conversa (contato ou grupo), autenticada. */
  app.get("/conversations/:id/avatar", { preHandler: authenticate }, async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const access = await loadConversationAccess(deps.prisma, request.user);
    const conversation = await deps.prisma.conversation.findFirst({
      where: { id, organizationId: request.user.organizationId, ...conversationScope(access) },
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
    const access = await loadConversationAccess(deps.prisma, request.user);
    const participant = await deps.prisma.groupParticipant.findFirst({
      where: {
        id,
        group: { organizationId: request.user.organizationId, ...groupScope(access) },
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
   * Abre a conversa individual com um participante do grupo, criando-a se
   * ainda não existir. É o "chamar no privado": tirar um assunto do grupo
   * sem sair do sistema e sem procurar o número na mão.
   */
  app.post(
    "/group-participants/:id/conversation",
    { preHandler: authenticate },
    async (request, reply) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
      const access = await loadConversationAccess(deps.prisma, request.user);
      const participant = await deps.prisma.groupParticipant.findFirst({
        where: {
          id,
          group: { organizationId: request.user.organizationId, ...groupScope(access) },
        },
        select: {
          name: true,
          phoneNumber: true,
          group: { select: { whatsappInstanceId: true } },
        },
      });
      if (!participant) throw new NotFoundError("Participante");

      // Sem telefone não há para onde abrir: em grupo anônimo o WhatsApp
      // só entrega o número de quem já escreveu.
      const phone = participant.phoneNumber?.replace(/\D/g, "") ?? "";
      if (!phone) {
        throw new AppError(
          "O WhatsApp não informou o número desta pessoa, então não dá para abrir a conversa.",
          400,
          "participant_without_phone",
        );
      }

      const conversation = await deps.ingest.ensureConversation(
        {
          instanceId: participant.group.whatsappInstanceId,
          externalChatId: `${phone}@s.whatsapp.net`,
          isGroup: false,
          callerName: participant.name,
          callerPhone: phone,
        },
        request.user.organizationId,
      );
      deps.audit.record({
        organizationId: request.user.organizationId,
        userId: request.user.sub,
        action: "conversation.opened_from_group",
        entityType: "Conversation",
        entityId: conversation.id,
      });
      return reply.status(201).send({ conversationId: conversation.id });
    },
  );

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
    status: z.enum(CONVERSATION_STATUSES),
  });

  app.post("/conversations/:id/status", { preHandler: authenticate }, async (request) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const { status } = statusSchema.parse(request.body);
    const conversation = await findConversationOr404(id, request.user);
    if (conversation.status === status) return { ok: true };

    // Concluir e reabrir continuam aparecendo no histórico da conversa; as
    // trocas entre os status de espera são registradas só na auditoria.
    const historyAction =
      status === "resolved" ? "resolved" : conversation.status === "resolved" ? "reopened" : null;

    await deps.prisma.$transaction([
      deps.prisma.conversation.update({ where: { id }, data: { status } }),
      ...(historyAction
        ? [
            deps.prisma.conversationAssignmentHistory.create({
              data: {
                organizationId: request.user.organizationId,
                conversationId: id,
                action: historyAction,
                performedByUserId: request.user.sub,
              },
            }),
          ]
        : []),
    ]);
    deps.audit.record({
      organizationId: request.user.organizationId,
      userId: request.user.sub,
      action: "conversation.status_changed",
      entityType: "Conversation",
      entityId: id,
      metadata: { from: conversation.status, to: status },
    });
    await emitConversationUpdated(id, request.user.organizationId);
    return { ok: true };
  });

  /**
   * Código do cadastro da empresa/grupo no escritório ("EMPRESA 001").
   *
   * Usa o campo externalReference, que já existia no modelo para referência
   * a sistemas externos. externalSource marca que veio digitado, e não de
   * uma integração — para uma sincronização futura saber o que pode
   * sobrescrever.
   */
  app.patch("/conversations/:id/reference", { preHandler: authenticate }, async (request) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const { externalReference } = z
      .object({ externalReference: z.string().trim().max(40).nullable() })
      .parse(request.body);
    await findConversationOr404(id, request.user);

    const value = externalReference && externalReference.length > 0 ? externalReference : null;
    await deps.prisma.conversation.update({
      where: { id },
      data: { externalReference: value, externalSource: value ? "manual" : null },
    });
    deps.audit.record({
      organizationId: request.user.organizationId,
      userId: request.user.sub,
      action: "conversation.reference_changed",
      entityType: "Conversation",
      entityId: id,
      metadata: { externalReference: value },
    });
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
    const conversation = await findConversationOr404(id, request.user);
    const note = await deps.prisma.internalNote.create({
      data: {
        organizationId: request.user.organizationId,
        conversationId: id,
        userId: request.user.sub,
        content,
      },
      include: { user: true },
    });
    const payload = {
      id: note.id,
      conversationId: id,
      content: note.content,
      user: note.user ? serializeUserDirectory(note.user) : null,
      createdAt: note.createdAt.toISOString(),
    };
    // Aparece na hora para toda a equipe, dentro da conversa.
    deps.io
      .to(conversationAudience(request.user.organizationId, conversation))
      .emit(RealtimeEvents.InternalNote, payload);
    return reply.status(201).send({ note: payload });
  });

  /** Edita uma nota interna (autor, supervisor ou admin). */
  app.patch("/conversations/:id/notes/:noteId", { preHandler: authenticate }, async (request) => {
    const { id, noteId } = z
      .object({ id: z.string().uuid(), noteId: z.string().uuid() })
      .parse(request.params);
    const { content } = z.object({ content: z.string().min(1).max(2000) }).parse(request.body);
    const note = await deps.prisma.internalNote.findFirst({
      where: { id: noteId, conversationId: id, organizationId: request.user.organizationId },
    });
    if (!note) throw new NotFoundError("Nota interna");
    if (note.userId !== request.user.sub && request.user.role === "agent") {
      throw new ForbiddenError("Só o autor pode editar esta nota");
    }
    const updated = await deps.prisma.internalNote.update({
      where: { id: noteId },
      data: { content },
      include: { user: true },
    });
    deps.audit.record({
      organizationId: request.user.organizationId,
      userId: request.user.sub,
      action: "note.updated",
      entityType: "InternalNote",
      entityId: noteId,
    });
    return {
      note: {
        id: updated.id,
        conversationId: id,
        content: updated.content,
        user: updated.user ? serializeUserDirectory(updated.user) : null,
        createdAt: updated.createdAt.toISOString(),
      },
    };
  });

  /** Remove uma nota interna (autor ou supervisor/admin). */
  app.delete("/conversations/:id/notes/:noteId", { preHandler: authenticate }, async (request) => {
    const { id, noteId } = z
      .object({ id: z.string().uuid(), noteId: z.string().uuid() })
      .parse(request.params);
    const note = await deps.prisma.internalNote.findFirst({
      where: { id: noteId, conversationId: id, organizationId: request.user.organizationId },
    });
    if (!note) throw new NotFoundError("Nota interna");
    if (note.userId !== request.user.sub && request.user.role === "agent") {
      throw new ForbiddenError("Só o autor pode excluir esta nota");
    }
    await deps.prisma.internalNote.delete({ where: { id: noteId } });
    deps.audit.record({
      organizationId: request.user.organizationId,
      userId: request.user.sub,
      action: "note.deleted",
      entityType: "InternalNote",
      entityId: noteId,
    });
    return { ok: true };
  });
}

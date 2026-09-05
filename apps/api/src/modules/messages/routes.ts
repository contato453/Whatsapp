import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { Prisma } from "@azvchat/database";
import type { MediaPayload, PollVotes, QuotedMessageRef, QuotedSnapshot } from "@azvchat/shared";
import {
  MESSAGE_EDIT_EXPIRED_MESSAGE,
  appendMessageVersion,
  isEditableMessageType,
  isWithinEditWindow,
  departmentResourceAppliesTo,
  outboundMediaTypeFromMime,
  quickReplyMediaTypeFromMime,
  quotedSenderLabel,
  withQuotedSnapshot,
  RealtimeEvents,
} from "@azvchat/shared";
import {
  accessibleDepartmentIds,
  conversationScope,
  departmentResourceScope,
  loadConversationAccess,
} from "../../lib/access.js";
import { authenticate } from "../../lib/auth.js";
import { requirePermission } from "../../lib/permissions.js";
import { AppError, ForbiddenError, NotFoundError } from "../../lib/errors.js";
import { extensionFromMime } from "../../lib/media-storage.js";
import { mentionsSchema, resolveMentionTargets } from "../../lib/mentions.js";
import { prepareOutboundAudio } from "../../lib/outbound-audio.js";
import {
  pinItem,
  pinnedItemsIfMessagePinned,
  unpinItem,
  unpinMessageIfPinned,
} from "../../lib/pinned-items.js";
import { convertToSticker } from "../../lib/sticker-convert.js";
import {
  serializeConversation,
  serializeMessage,
  serializePinnedItems,
  type QuotedPreview,
} from "../../lib/serialize.js";
import { resolveConversationPersonName } from "../../lib/person-profile.js";
import { resolveSenders, type SenderDirectory } from "../../lib/sender-directory.js";
import { applySignature, type Signer } from "../../lib/signature.js";
import { conversationAudience } from "../../realtime/socket.js";
import { buildPreview } from "../../services/message-ingest.js";
import type { AppDeps } from "../../types.js";

const listQuerySchema = z.object({
  before: z.string().datetime().optional(),
  limit: z.coerce.number().min(1).max(100).default(50),
});

export async function messageRoutes(app: FastifyInstance, deps: AppDeps): Promise<void> {
  /** Escopado por organização e pelas conexões liberadas para o usuário. */
  async function findConversationOr404(id: string, user: FastifyRequest["user"]) {
    const access = await loadConversationAccess(deps.prisma, user);
    const conversation = await deps.prisma.conversation.findFirst({
      where: { id, organizationId: user.organizationId, ...conversationScope(access) },
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
    // Conversa individual sai com o nome da PESSOA no título — sem isso o
    // DTO da mensagem sobrescreveria o nome corrigido na lista.
    const personName = await resolveConversationPersonName(
      deps.prisma,
      organizationId,
      conversation,
    );
    const room = conversationAudience(organizationId, conversation);
    deps.io.to(room).emit(RealtimeEvents.MessageNew, {
      conversation: serializeConversation(conversation, personName),
      message: serializeMessage(message),
    });
    deps.io
      .to(room)
      .emit(RealtimeEvents.ConversationUpdated, serializeConversation(conversation, personName));
  }

  /**
   * Reenvia a lista de fixadas para todo mundo com a conversa aberta.
   * Evento próprio (`conversation:pinned-items`), não `message:updated`: a
   * fixação pode ser de uma NOTA interna, que não é `Message`.
   */
  function emitPinnedItems(
    organizationId: string,
    conversation: {
      id: string;
      whatsappInstanceId: string;
      departmentId: string | null;
      assignedUserId: string | null;
    },
    items: Parameters<typeof serializePinnedItems>[0],
  ): void {
    deps.io.to(conversationAudience(organizationId, conversation)).emit(RealtimeEvents.PinnedItems, {
      conversationId: conversation.id,
      items: serializePinnedItems(items),
    });
  }

  /**
   * Descobre nome e telefone dos remetentes do lote no cadastro de
   * participantes/contatos. Necessário em grupos com endereçamento "@lid",
   * onde a mensagem chega sem o telefone de quem escreveu.
   */
  async function loadSenders(
    conversation: { whatsappInstanceId: string; externalChatId: string; type: string },
    messages: Array<{ senderExternalId: string | null }>,
  ): Promise<SenderDirectory> {
    return resolveSenders(
      deps.prisma,
      conversation,
      messages.map((message) => message.senderExternalId),
    );
  }

  function senderOf(directory: SenderDirectory, senderExternalId: string | null) {
    return senderExternalId ? (directory.get(senderExternalId) ?? null) : null;
  }

  /**
   * Assinatura configurada no cadastro do atendente. Lida do banco a cada
   * envio de propósito: ligar ou desligar a opção passa a valer na hora,
   * sem depender de o atendente entrar de novo no sistema.
   */
  async function currentSigner(userId: string): Promise<Signer | null> {
    return deps.prisma.user.findUnique({
      where: { id: userId },
      select: { name: true, signMessages: true },
    });
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
          senderName: quotedSenderLabel(original),
          content: original.content,
          type: original.type,
        },
      ]),
    );
  }

  app.get("/conversations/:id/messages", { preHandler: authenticate }, async (request) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const query = listQuerySchema.parse(request.query);
    const conversation = await findConversationOr404(id, request.user);
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
    const [quotedMap, senders] = await Promise.all([
      loadQuotedPreviews(id, ordered),
      loadSenders(conversation, ordered),
    ]);
    const total = await deps.prisma.message.count({ where: { conversationId: id } });
    return {
      messages: ordered.map((message) =>
        serializeMessage(
          message,
          message.quotedMessageId ? (quotedMap.get(message.quotedMessageId) ?? null) : null,
          senderOf(senders, message.senderExternalId),
        ),
      ),
      // Indica se ainda há histórico anterior para carregar
      hasMore: total > messages.length + (query.before ? 1 : 0),
    };
  });

  /** Busca dentro da conversa aberta. */
  app.get("/conversations/:id/messages/search", { preHandler: authenticate }, async (request) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const { q, limit } = z
      .object({ q: z.string().min(2).max(120), limit: z.coerce.number().min(1).max(50).default(30) })
      .parse(request.query);
    const conversation = await findConversationOr404(id, request.user);
    const results = await deps.prisma.message.findMany({
      where: {
        conversationId: id,
        deletedAt: null,
        OR: [
          { content: { contains: q, mode: "insensitive" } },
          { filename: { contains: q, mode: "insensitive" } },
          { senderName: { contains: q, mode: "insensitive" } },
        ],
      },
      orderBy: { timestamp: "desc" },
      take: limit,
      include: { reactions: true },
    });
    const senders = await loadSenders(conversation, results);
    return {
      messages: results.map((message) =>
        serializeMessage(message, null, senderOf(senders, message.senderExternalId)),
      ),
    };
  });

  /**
   * Carrega uma janela de mensagens em torno de um horário — usado ao
   * clicar num resultado da busca para ver o contexto da conversa.
   */
  app.get("/conversations/:id/messages/around", { preHandler: authenticate }, async (request) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    // `at` veio da busca; `messageId` veio do clique no bloco de citação,
    // que só conhece o id local da original. Um dos dois é obrigatório.
    const { at, messageId } = z
      .object({ at: z.string().datetime().optional(), messageId: z.string().uuid().optional() })
      .refine((query) => query.at != null || query.messageId != null, {
        message: "Informe at ou messageId",
      })
      .parse(request.query);
    const conversation = await findConversationOr404(id, request.user);
    let pivot: Date;
    if (messageId) {
      const target = await deps.prisma.message.findFirst({
        where: { id: messageId, conversationId: id },
        select: { timestamp: true },
      });
      if (!target) throw new NotFoundError("Mensagem");
      pivot = target.timestamp;
    } else {
      pivot = new Date(at as string);
    }
    const [before, after] = await Promise.all([
      deps.prisma.message.findMany({
        where: { conversationId: id, timestamp: { lte: pivot } },
        orderBy: { timestamp: "desc" },
        take: 25,
        include: { reactions: true },
      }),
      deps.prisma.message.findMany({
        where: { conversationId: id, timestamp: { gt: pivot } },
        orderBy: { timestamp: "asc" },
        take: 25,
        include: { reactions: true },
      }),
    ]);
    const ordered = [...before.reverse(), ...after];
    const [quotedMap, senders] = await Promise.all([
      loadQuotedPreviews(id, ordered),
      loadSenders(conversation, ordered),
    ]);
    const oldest = ordered[0];
    const olderCount = oldest
      ? await deps.prisma.message.count({
          where: { conversationId: id, timestamp: { lt: oldest.timestamp } },
        })
      : 0;
    return {
      messages: ordered.map((message) =>
        serializeMessage(
          message,
          message.quotedMessageId ? (quotedMap.get(message.quotedMessageId) ?? null) : null,
          senderOf(senders, message.senderExternalId),
        ),
      ),
      hasMore: olderCount > 0,
    };
  });

  /** Envia uma enquete para a conversa. */
  app.post("/conversations/:id/polls", { preHandler: authenticate }, async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const body = z
      .object({
        question: z.string().min(1).max(255),
        options: z.array(z.string().min(1).max(100)).min(2).max(12),
        selectableCount: z.coerce.number().min(1).max(12).default(1),
      })
      .parse(request.body);
    const conversation = await findConversationOr404(id, request.user);

    const result = await deps.provider.sendPoll(
      conversation.whatsappInstanceId,
      conversation.externalChatId,
      {
        question: body.question,
        options: body.options,
        selectableCount: Math.min(body.selectableCount, body.options.length),
      },
    );

    const message = await deps.prisma.message.create({
      data: {
        organizationId: request.user.organizationId,
        conversationId: id,
        externalMessageId: result.externalMessageId,
        direction: "outbound",
        type: "poll",
        content: body.question,
        metadata: { pollOptions: body.options, selectableCount: body.selectableCount },
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
        lastMessagePreview: `📊 ${body.question}`.slice(0, 120),
      },
    });
    deps.audit.record({
      organizationId: request.user.organizationId,
      userId: request.user.sub,
      action: "message.poll_sent",
      entityType: "Conversation",
      entityId: id,
    });
    await afterOutboundPersist(id, request.user.organizationId, message.id);
    return reply.status(201).send({ message: serializeMessage(message) });
  });

  /**
   * Vota numa enquete RECEBIDA, pelo número conectado. `selectedNames` é a
   * seleção completa (o WhatsApp substitui o voto anterior, não soma). O
   * AstraCalls não devolve o próprio voto por webhook, então gravamos aqui a
   * escolha do número na PRÓPRIA mensagem da enquete e avisamos a tela.
   */
  app.post("/conversations/:id/polls/:messageId/vote", { preHandler: authenticate }, async (request) => {
    const { id, messageId } = z
      .object({ id: z.string().uuid(), messageId: z.string().uuid() })
      .parse(request.params);
    const body = z.object({ selectedNames: z.array(z.string()).max(12) }).parse(request.body);
    const conversation = await findConversationOr404(id, request.user);

    const poll = await deps.prisma.message.findFirst({
      where: { id: messageId, conversationId: id, type: "poll" },
      select: { id: true, externalMessageId: true, metadata: true },
    });
    if (!poll?.externalMessageId) throw new NotFoundError("Enquete");
    const pollExternalId = poll.externalMessageId;

    const metadata = (poll.metadata as Record<string, unknown> | null) ?? {};
    const options = Array.isArray(metadata.pollOptions) ? (metadata.pollOptions as string[]) : [];
    const selectableCount = typeof metadata.selectableCount === "number" ? metadata.selectableCount : 1;
    // Só opções que existem na enquete; e respeita o teto de seleção dela.
    const chosen = body.selectedNames.filter((name) => options.includes(name));
    if (chosen.length > Math.max(selectableCount, 1)) {
      throw new AppError("Seleção acima do permitido para esta enquete.", 400, "poll_too_many");
    }

    const provider = deps.provider as {
      votePoll?: (
        instanceId: string,
        chatId: string,
        pollExternalMessageId: string,
        selectedNames: string[],
      ) => Promise<void>;
    };
    if (typeof provider.votePoll !== "function") {
      throw new AppError("O provider atual não permite votar em enquete.", 501, "poll_vote_unsupported");
    }
    await provider.votePoll(
      conversation.whatsappInstanceId,
      conversation.externalChatId,
      pollExternalId,
      chosen,
    );

    // Registra o voto do NÚMERO conectado (o WhatsApp guarda um voto por
    // número). A chave é o telefone do número; o nome exibido é o do atendente
    // que clicou, para a equipe saber de onde saiu.
    const votes = { ...((metadata.votes as PollVotes | undefined) ?? {}) };
    const voterKey = deps.provider.getPhoneNumber(conversation.whatsappInstanceId) ?? "self";
    votes[voterKey] = { names: chosen, voterName: request.user.name, at: new Date().toISOString() };
    const updated = await deps.prisma.message.update({
      where: { id: poll.id },
      data: { metadata: { ...metadata, votes } as unknown as Prisma.InputJsonValue },
    });

    deps.io
      .to(conversationAudience(request.user.organizationId, conversation))
      .emit(RealtimeEvents.MessageUpdated, serializeMessage(updated));
    return { message: serializeMessage(updated) };
  });

  /** Reage a uma mensagem (emoji vazio remove a reação). */
  app.post("/messages/:id/reactions", { preHandler: authenticate }, async (request) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const { emoji } = z.object({ emoji: z.string().max(16) }).parse(request.body);
    const access = await loadConversationAccess(deps.prisma, request.user);
    const message = await deps.prisma.message.findFirst({
      where: {
        id,
        organizationId: request.user.organizationId,
        conversation: conversationScope(access),
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
    const audience = conversationAudience(request.user.organizationId, message.conversation);
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
  app.delete(
    "/messages/:id",
    { preHandler: requirePermission(deps, "message.delete_sent") },
    async (request) => {
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
      .to(conversationAudience(request.user.organizationId, message.conversation))
      .emit(RealtimeEvents.MessageUpdated, serializeMessage(updated));
    // Mensagem fixada e apagada não pode continuar destacada no topo: a
    // faixa sumiria só no próximo reload, mostrando até lá uma referência
    // quebrada. Sem auditoria própria — não foi "alguém desafixando", foi
    // consequência de apagar; o log de `message.deleted` já cobre o motivo.
    const freedByDelete = await unpinMessageIfPinned(deps.prisma, message.conversationId, id);
    if (freedByDelete) {
      emitPinnedItems(request.user.organizationId, message.conversation, freedByDelete);
    }
    return { ok: true };
  });

  /** Edita o texto de uma mensagem enviada. */
  app.patch(
    "/messages/:id",
    { preHandler: requirePermission(deps, "message.edit_sent") },
    async (request) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const { content } = z.object({ content: z.string().min(1).max(65_000) }).parse(request.body);
    const message = await deps.prisma.message.findFirst({
      where: { id, organizationId: request.user.organizationId },
      include: { conversation: true },
    });
    if (!message?.externalMessageId) throw new NotFoundError("Mensagem");
    if (message.direction !== "outbound" || !isEditableMessageType(message.type)) {
      // Áudio e figurinha ficam de fora porque não têm legenda no WhatsApp.
      throw new AppError(
        "Esta mensagem não pode ser editada",
        400,
        "not_editable",
      );
    }
    if (message.deletedAt) {
      throw new AppError("Mensagem apagada não pode ser editada", 400, "deleted");
    }
    // A janela é do WhatsApp, não nossa. Sem esta conferência o servidor
    // recusaria a edição e nós gravaríamos o texto novo assim mesmo — a
    // Inbox passaria a mostrar uma frase que o cliente nunca recebeu.
    if (!isWithinEditWindow(message.timestamp)) {
      throw new AppError(MESSAGE_EDIT_EXPIRED_MESSAGE, 400, "edit_window_closed");
    }

    // Mídia: a edição troca a mensagem inteira, então o arquivo vai junto —
    // do storage da API, sem passar pelo navegador. Só a legenda muda.
    let media: MediaPayload | undefined;
    if (message.type !== "text") {
      if (!message.mediaUrl) {
        throw new AppError("Mídia indisponível para edição", 400, "media_missing");
      }
      const data = await deps.storage.read(message.mediaUrl);
      media = {
        data,
        mimeType: message.mimeType ?? "application/octet-stream",
        ...(message.filename ? { filename: message.filename } : {}),
        type: outboundMediaTypeFromMime(message.mimeType),
      };
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
      media ? { media } : undefined,
    );
    // Mesmo histórico da edição feita pelo cliente: o que a mensagem dizia
    // ANTES fica guardado, e a marca "editada" vale para os dois lados.
    const editedAt = new Date();
    const updated = await deps.prisma.message.update({
      where: { id },
      data: {
        content,
        editedAt,
        metadata: appendMessageVersion(
          message.metadata,
          message.content,
          editedAt,
        ) as Prisma.InputJsonValue,
      },
    });
    deps.audit.record({
      organizationId: request.user.organizationId,
      userId: request.user.sub,
      action: "message.edited",
      entityType: "Message",
      entityId: id,
    });
    deps.io
      .to(conversationAudience(request.user.organizationId, message.conversation))
      .emit(RealtimeEvents.MessageUpdated, serializeMessage(updated));
    // Mensagem fixada mostra o conteúdo na própria faixa (é o uso principal:
    // o link em destaque) — editar sem atualizar a faixa deixaria a equipe
    // lendo um texto que o cliente já não vê mais.
    const refreshedByEdit = await pinnedItemsIfMessagePinned(deps.prisma, message.conversationId, id);
    if (refreshedByEdit) {
      emitPinnedItems(request.user.organizationId, message.conversation, refreshedByEdit);
    }
    return { message: serializeMessage(updated) };
  });

  /** Fixa uma mensagem no topo da conversa — só para a equipe, nunca vai ao
   * WhatsApp (ver `pinned-items.ts` para o porquê). */
  app.post(
    "/messages/:id/pin",
    { preHandler: requirePermission(deps, "message.pin") },
    async (request, reply) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
      const { replaceItemId } = z
        .object({ replaceItemId: z.string().uuid().optional() })
        .parse(request.body ?? {});
      const access = await loadConversationAccess(deps.prisma, request.user);
      const message = await deps.prisma.message.findFirst({
        where: {
          id,
          organizationId: request.user.organizationId,
          conversation: conversationScope(access),
        },
        include: { conversation: true },
      });
      if (!message) throw new NotFoundError("Mensagem");

      const result = await pinItem(deps.prisma, {
        organizationId: request.user.organizationId,
        conversationId: message.conversationId,
        target: { kind: "message", id },
        userId: request.user.sub,
        replaceItemId,
      });
      if (!result.alreadyPinned) {
        deps.audit.record({
          organizationId: request.user.organizationId,
          userId: request.user.sub,
          action: "message.pinned",
          entityType: "Message",
          entityId: id,
          metadata: { conversationId: message.conversationId },
        });
        if (result.replaced) {
          deps.audit.record({
            organizationId: request.user.organizationId,
            userId: request.user.sub,
            action: "message.unpinned",
            entityType: result.replaced.messageId ? "Message" : "InternalNote",
            entityId: (result.replaced.messageId ?? result.replaced.noteId) as string,
            metadata: { conversationId: message.conversationId, replacedBy: id },
          });
        }
        emitPinnedItems(request.user.organizationId, message.conversation, result.items);
      }
      return reply.status(201).send({ items: serializePinnedItems(result.items) });
    },
  );

  /** Desafixa uma mensagem — pelo menu da bolha ou pela própria faixa. */
  app.post(
    "/messages/:id/unpin",
    { preHandler: requirePermission(deps, "message.pin") },
    async (request) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
      const access = await loadConversationAccess(deps.prisma, request.user);
      const message = await deps.prisma.message.findFirst({
        where: {
          id,
          organizationId: request.user.organizationId,
          conversation: conversationScope(access),
        },
        include: { conversation: true },
      });
      if (!message) throw new NotFoundError("Mensagem");

      const result = await unpinItem(deps.prisma, {
        conversationId: message.conversationId,
        target: { kind: "message", id },
      });
      if (result.removed) {
        deps.audit.record({
          organizationId: request.user.organizationId,
          userId: request.user.sub,
          action: "message.unpinned",
          entityType: "Message",
          entityId: id,
          metadata: { conversationId: message.conversationId },
        });
        emitPinnedItems(request.user.organizationId, message.conversation, result.items);
      }
      return { items: serializePinnedItems(result.items) };
    },
  );

  /** Encaminha uma mensagem (texto ou mídia) para outra conversa. */
  app.post("/messages/:id/forward", { preHandler: authenticate }, async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const { conversationId } = z
      .object({ conversationId: z.string().uuid() })
      .parse(request.body);

    const accessForForward = await loadConversationAccess(deps.prisma, request.user);
    const original = await deps.prisma.message.findFirst({
      where: {
        id,
        organizationId: request.user.organizationId,
        conversation: conversationScope(accessForForward),
      },
    });
    if (!original) throw new NotFoundError("Mensagem");
    const target = await findConversationOr404(conversationId, request.user);

    let result: Awaited<ReturnType<typeof deps.provider.sendText>>;
    if (original.mediaUrl) {
      let data = await deps.storage.read(original.mediaUrl);
      let mimeType = original.mimeType ?? "application/octet-stream";
      const forwardType = outboundMediaTypeFromMime(original.mimeType);
      let forwardSeconds: number | undefined;
      // Mensagem antiga pode ter ficado guardada em WebM, de antes da
      // normalização existir. Encaminhar sem converter repetiria o defeito
      // no chat de outro cliente.
      if (forwardType === "audio") {
        const prepared = await prepareOutboundAudio(data, mimeType, false, deps.logger);
        data = prepared.data;
        mimeType = prepared.mimeType;
        forwardSeconds = prepared.seconds;
      }
      result = await deps.provider.sendMedia(
        target.whatsappInstanceId,
        target.externalChatId,
        {
          data,
          mimeType,
          filename: original.filename ?? undefined,
          caption: original.content ?? undefined,
          type: forwardType,
          ...(forwardSeconds !== undefined ? { seconds: forwardSeconds } : {}),
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
    const { content, replyToMessageId, mentions } = z
      .object({
        content: z.string().min(1).max(65_000),
        replyToMessageId: z.string().uuid().optional(),
        // Identificadores dos participantes marcados. Vem separado do texto
        // porque é ele, e não o texto, que faz o WhatsApp notificar.
        mentions: mentionsSchema.optional(),
      })
      .parse(request.body);
    const conversation = await findConversationOr404(id, request.user);

    // Marcação: confere um a um contra os participantes DESTA conversa —
    // ninguém pode notificar um número que não está no grupo. Quem saiu
    // entre a escolha e o Enter é descartado, e a mensagem segue para os
    // demais: perder o texto por causa disso seria pior.
    const resolvedMentions = mentions?.length
      ? resolveMentionTargets(
          conversation.type,
          mentions,
          await deps.prisma.groupParticipant.findMany({
            where: {
              externalContactId: { in: mentions },
              group: {
                whatsappInstanceId: conversation.whatsappInstanceId,
                externalId: conversation.externalChatId,
              },
            },
            select: { externalContactId: true, phoneNumber: true },
          }),
        )
      : { jids: [], dropped: 0 };
    const mentionedJids = resolvedMentions.jids;
    if (resolvedMentions.dropped > 0) {
      // Só a contagem: identificador de participante é conteúdo da conversa.
      deps.logger.info({
        conversationId: id,
        event: "mentions_dropped",
        dropped: resolvedMentions.dropped,
      });
    }

    // Reply: monta a referência da mensagem citada a partir do que temos salvo.
    let quoted: QuotedMessageRef | undefined;
    let quotedExternalId: string | null = null;
    let quotedSnapshot: QuotedSnapshot | null = null;
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
        // Resumo congelado no metadata: é ele que faz o bloco de citação
        // aparecer JÁ na resposta do POST e no `message:new` — a leitura ao
        // vivo só acontece ao recarregar a lista.
        quotedSnapshot = {
          id: original.id,
          senderName: quotedSenderLabel(original),
          content: original.content,
          type: original.type,
        };
      }
    }

    // O texto é gravado já assinado: a conversa precisa mostrar exatamente
    // o que o cliente recebeu.
    const outgoing =
      applySignature(content, await currentSigner(request.user.sub)) ?? content;

    const result = await deps.provider.sendText(
      conversation.whatsappInstanceId,
      conversation.externalChatId,
      outgoing,
      quoted,
      mentionedJids.length > 0 ? { mentionedExternalIds: mentionedJids } : undefined,
    );

    // Sem a lista de marcados a mensagem enviada voltaria à tela com o número
    // cru; o resumo da citação divide o mesmo objeto, preservando um ao outro.
    let outgoingMetadata: Record<string, unknown> | null =
      mentionedJids.length > 0 ? { mentions: mentionedJids } : null;
    if (quotedSnapshot) {
      outgoingMetadata = withQuotedSnapshot(outgoingMetadata, quotedSnapshot);
    }

    const message = await deps.prisma.message.create({
      data: {
        organizationId: request.user.organizationId,
        conversationId: id,
        externalMessageId: result.externalMessageId,
        direction: "outbound",
        type: "text",
        content: outgoing,
        quotedMessageId: quotedExternalId,
        senderName: request.user.name,
        timestamp: result.timestamp,
        status: "sent",
        sentByUserId: request.user.sub,
        ...(outgoingMetadata ? { metadata: outgoingMetadata as Prisma.InputJsonValue } : {}),
      },
    });
    await deps.prisma.conversation.update({
      where: { id },
      data: {
        lastMessageAt: result.timestamp,
        lastMessagePreview: buildPreview({ type: "text", content: outgoing }),
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
      const rawCaption =
        typeof (file.fields.caption as { value?: unknown } | undefined)?.value === "string"
          ? ((file.fields.caption as { value: string }).value || undefined)
          : undefined;
      // Legenda vazia continua vazia — assinar criaria uma legenda só com
      // o nome do atendente embaixo da mídia.
      const caption =
        applySignature(rawCaption ?? null, await currentSigner(request.user.sub)) ?? undefined;
      let asVoiceNote =
        (file.fields.asVoiceNote as { value?: unknown } | undefined)?.value === "true";
      const asSticker =
        (file.fields.asSticker as { value?: unknown } | undefined)?.value === "true";

      // Figurinha: o WhatsApp exige WebP 512x512.
      if (asSticker && mimeType.startsWith("image/")) {
        const converted = await convertToSticker(buffer, deps.logger);
        if (converted) {
          buffer = converted;
          mimeType = "image/webp";
        } else {
          deps.logger.warn({
            conversationId: id,
            event: "sticker_fallback",
            reason: "conversão indisponível — enviado como imagem",
          });
        }
      }

      // Áudio: o navegador grava WebM (Chrome, Edge) ou MP4 (Safari), e o
      // WhatsApp só toca OGG/Opus. A normalização olha os bytes, não o mime
      // declarado, e falha em voz alta: mandar assim mesmo entrega ao cliente
      // um áudio que ele não consegue ouvir. Se sai como mensagem de voz ou
      // como arquivo de áudio quem decide é `VOICE_NOTE_ENABLED`, em
      // lib/outbound-audio.ts, onde está o porquê.
      let audioSeconds: number | undefined;
      let audioWaveform: Uint8Array | undefined;
      let originalMediaUrl: string | null = null;
      if (!asSticker && outboundMediaTypeFromMime(mimeType) === "audio") {
        const prepared = await prepareOutboundAudio(buffer, mimeType, asVoiceNote, deps.logger);
        if (prepared.converted) {
          // O original fica guardado para reprocessar se algo der errado; o
          // que a Inbox mostra é o mesmo arquivo que saiu para o cliente.
          originalMediaUrl = await deps.storage.save(buffer, {
            instanceId: conversation.whatsappInstanceId,
            extension: file.filename?.split(".").pop() ?? extensionFromMime(mimeType),
          });
        }
        buffer = prepared.data;
        mimeType = prepared.mimeType;
        asVoiceNote = prepared.asVoiceNote;
        audioSeconds = prepared.seconds;
        audioWaveform = prepared.waveform;
      }

      const mediaType: MediaPayload["type"] =
        asSticker && mimeType === "image/webp" ? "sticker" : outboundMediaTypeFromMime(mimeType);
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
          ...(audioSeconds !== undefined ? { seconds: audioSeconds } : {}),
          ...(audioWaveform !== undefined ? { waveform: audioWaveform } : {}),
        },
      );

      // Guarda o arquivo CONVERTIDO: reenviar (encaminhar) não converte de novo.
      // No áudio convertido a extensão vem do mime, e não do nome que o
      // navegador inventou: o arquivo é OGG e continuar chamando de .webm
      // faria o player interno pedir um decodificador que não é o certo.
      const mediaUrl = await deps.storage.save(buffer, {
        instanceId: conversation.whatsappInstanceId,
        extension: originalMediaUrl
          ? extensionFromMime(mimeType)
          : (file.filename?.split(".").pop() ?? extensionFromMime(mimeType)),
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
          ...(originalMediaUrl || audioSeconds !== undefined
            ? {
                metadata: {
                  ...(originalMediaUrl ? { originalMediaUrl } : {}),
                  ...(audioSeconds !== undefined ? { audioSeconds } : {}),
                },
              }
            : {}),
        },
      });
      await deps.prisma.conversation.update({
        where: { id },
        data: {
          lastMessageAt: result.timestamp,
          lastMessagePreview: buildPreview({ type: mediaType, content: caption ?? null }),
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

  /**
   * Envia a mídia de uma resposta rápida SEM passar pelo navegador.
   *
   * O arquivo já mora no storage da API: baixar o binário na tela para subir
   * de volta dobrava a transferência e fazia vídeo grande parecer travado no
   * composer. Aqui a única coisa que trafega do navegador é um JSON, e a
   * mensagem gravada reutiliza a própria chave do storage — nenhum byte é
   * copiado (o arquivo nunca é apagado do storage, então a chave não fica
   * órfã nem quando a mídia da resposta é trocada ou removida).
   */
  app.post(
    "/conversations/:id/quick-reply-media",
    { preHandler: authenticate },
    async (request, reply) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
      const body = z
        .object({ quickReplyId: z.string().uuid(), caption: z.string().max(4000).optional() })
        .parse(request.body);
      const conversation = await findConversationOr404(id, request.user);

      // Recorte de leitura: usar a resposta não exige poder gerenciá-la.
      const departmentIds = await accessibleDepartmentIds(deps.prisma, request.user);
      const quickReply = await deps.prisma.quickReply.findFirst({
        where: {
          id: body.quickReplyId,
          organizationId: request.user.organizationId,
          ...departmentResourceScope(departmentIds),
        },
        include: { departments: true },
      });
      const mediaType = quickReplyMediaTypeFromMime(quickReply?.mediaMimeType);
      if (!quickReply?.mediaUrl || !mediaType) throw new NotFoundError("Mídia");
      if (
        !departmentResourceAppliesTo(
          quickReply.isGeneral,
          quickReply.departments.map((link) => link.departmentId),
          conversation.departmentId,
        )
      ) {
        throw new ForbiddenError("Esta resposta não vale para o departamento desta conversa");
      }

      let buffer = await deps.storage.read(quickReply.mediaUrl);
      let mimeType = quickReply.mediaMimeType ?? "application/octet-stream";
      let audioSeconds: number | undefined;
      // Áudio de resposta rápida entra aqui como arquivo, sem flag de voz:
      // quem cadastrou anexou um arquivo, não gravou no microfone. Converte
      // só o que o WhatsApp não toca, e grava a conversão de volta na
      // resposta para não repetir o ffmpeg a cada envio.
      if (mediaType === "audio") {
        const prepared = await prepareOutboundAudio(buffer, mimeType, false, deps.logger);
        audioSeconds = prepared.seconds;
        if (prepared.converted) {
          const convertedUrl = await deps.storage.save(prepared.data, {
            instanceId: `quick-replies-${request.user.organizationId}`,
            extension: extensionFromMime(prepared.mimeType),
          });
          await deps.prisma.quickReply.update({
            where: { id: quickReply.id },
            data: { mediaUrl: convertedUrl, mediaMimeType: prepared.mimeType },
          });
          quickReply.mediaUrl = convertedUrl;
        }
        buffer = prepared.data;
        mimeType = prepared.mimeType;
      }
      // Áudio não tem legenda no WhatsApp — a tela envia o texto como
      // mensagem separada; gravar legenda aqui mostraria na Inbox um texto
      // que o cliente nunca recebeu.
      const rawCaption = mediaType === "audio" ? null : body.caption || null;
      const caption =
        applySignature(rawCaption, await currentSigner(request.user.sub)) ?? undefined;

      const result = await deps.provider.sendMedia(
        conversation.whatsappInstanceId,
        conversation.externalChatId,
        {
          data: buffer,
          mimeType,
          filename: quickReply.mediaFilename ?? undefined,
          caption,
          type: mediaType,
          ...(audioSeconds !== undefined ? { seconds: audioSeconds } : {}),
        },
      );

      const message = await deps.prisma.message.create({
        data: {
          organizationId: request.user.organizationId,
          conversationId: id,
          externalMessageId: result.externalMessageId,
          direction: "outbound",
          type: mediaType,
          content: caption ?? null,
          mediaUrl: quickReply.mediaUrl,
          mimeType,
          filename: quickReply.mediaFilename,
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
        },
      });
      // O uso é o envio, e ele acabou de acontecer aqui — a tela não
      // precisa da segunda chamada a /quick-replies/:id/used.
      await deps.prisma.quickReply.update({
        where: { id: quickReply.id },
        data: { lastUsedAt: new Date() },
      });
      deps.audit.record({
        organizationId: request.user.organizationId,
        userId: request.user.sub,
        action: "message.media_sent",
        entityType: "Conversation",
        entityId: id,
        metadata: { mediaType, quickReplyId: quickReply.id },
      });
      await afterOutboundPersist(id, request.user.organizationId, message.id);
      return reply.status(201).send({ message: serializeMessage(message) });
    },
  );

  /** Download/exibição da mídia de uma mensagem (autenticado, escopado por organização). */
  app.get("/messages/:id/media", { preHandler: authenticate }, async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const access = await loadConversationAccess(deps.prisma, request.user);
    const message = await deps.prisma.message.findFirst({
      where: {
        id,
        organizationId: request.user.organizationId,
        conversation: conversationScope(access),
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

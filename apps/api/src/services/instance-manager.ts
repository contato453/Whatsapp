import type { PrismaClient } from "@azvchat/database";
import type {
  ProviderContact,
  ProviderChat,
  ProviderGroup,
} from "@azvchat/shared";
import { RealtimeEvents } from "@azvchat/shared";
import type { WhatsAppProvider } from "@azvchat/whatsapp";
import type { Server } from "socket.io";
import type { Logger } from "pino";
import { instanceAudience } from "../realtime/socket.js";
import { serializeConversation, serializeMessage } from "../lib/serialize.js";
import { extensionFromMime, type MediaStorage } from "../lib/media-storage.js";
import type { MessageIngestService } from "./message-ingest.js";
import type { AuditService } from "../modules/audit/service.js";

/** Intervalo entre downloads de foto para não sobrecarregar o WhatsApp. */
const AVATAR_FETCH_DELAY_MS = 300;
/** Máximo de fotos buscadas por rodada de backfill. */
const AVATAR_BACKFILL_LIMIT = 300;
/** Máximo de participantes consultados por abertura de grupo. */
const PARTICIPANT_AVATAR_LIMIT = 80;
/** Textos exibidos para cada desfecho de chamada. */
const CALL_LABELS: Record<string, (isVideo: boolean) => string> = {
  ringing: (isVideo) => (isVideo ? "Chamada de vídeo recebida" : "Chamada de voz recebida"),
  accepted: (isVideo) => (isVideo ? "Chamada de vídeo atendida" : "Chamada de voz atendida"),
  rejected: (isVideo) => (isVideo ? "Chamada de vídeo recusada" : "Chamada de voz recusada"),
  missed: (isVideo) => (isVideo ? "Chamada de vídeo perdida" : "Chamada de voz perdida"),
};

/** Revalida a foto de um participante no máximo a cada 7 dias. */
const PARTICIPANT_AVATAR_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Orquestra o ciclo de vida das instâncias de WhatsApp:
 * - liga eventos do provider a persistência e tempo real;
 * - retoma sessões após restart do backend;
 * - mantém cache instanceId -> organizationId.
 *
 * Consome EXCLUSIVAMENTE a interface WhatsAppProvider.
 */
export class InstanceManager {
  private readonly orgByInstance = new Map<string, string>();
  /** Conversas sem foto disponível — evita repetir download a cada evento. */
  private readonly avatarsUnavailable = new Set<string>();
  private avatarSyncRunning = false;

  constructor(
    private readonly prisma: PrismaClient,
    private readonly provider: WhatsAppProvider,
    private readonly ingest: MessageIngestService,
    private readonly io: Server,
    private readonly audit: AuditService,
    private readonly storage: MediaStorage,
    private readonly logger: Logger,
  ) {}

  wireProviderEvents(): void {
    this.provider.on("status", (event) => {
      void this.handleStatus(event.instanceId, event.status, event.phoneNumber ?? null, event.reason);
    });

    this.provider.on("qr", (event) => {
      void this.withOrg(event.instanceId, (organizationId) => {
        this.io.to(instanceAudience(organizationId, event.instanceId)).emit(RealtimeEvents.InstanceQr, {
          instanceId: event.instanceId,
          qrDataUrl: event.qrDataUrl,
        });
      });
    });

    this.provider.on("message", (message) => {
      void this.withOrg(message.instanceId, async (organizationId) => {
        const result = await this.ingest.ingest(message, { organizationId });
        // O nome que o WhatsApp envia junto da mensagem (pushName) costuma
        // ser a melhor fonte para identificar participantes de grupo.
        if (message.chatType === "group" && message.senderExternalId && message.senderName) {
          void this.enrichParticipant(
            message.instanceId,
            message.externalChatId,
            message.senderExternalId,
            message.senderName,
            message.senderPhone,
          );
        }
        if (!result?.isNewMessage) return;
        const [conversation, persisted] = await Promise.all([
          this.prisma.conversation.findUnique({
            where: { id: result.conversationId },
            include: {
              assignedUser: true,
              department: true,
              instance: true,
              tags: { include: { tag: true } },
            },
          }),
          this.prisma.message.findUnique({ where: { id: result.messageId } }),
        ]);
        if (!conversation || !persisted) return;
        const room = instanceAudience(organizationId, conversation.whatsappInstanceId);
        this.io.to(room).emit(RealtimeEvents.MessageNew, {
          conversation: serializeConversation(conversation),
          message: serializeMessage(persisted),
        });
        this.io.to(room).emit(RealtimeEvents.ConversationUpdated, serializeConversation(conversation));
      });
    });

    this.provider.on("message-status", (update) => {
      void this.withOrg(update.instanceId, async (organizationId) => {
        const conversation = await this.prisma.conversation.findUnique({
          where: {
            whatsappInstanceId_externalChatId: {
              whatsappInstanceId: update.instanceId,
              externalChatId: update.externalChatId,
            },
          },
          select: { id: true },
        });
        if (!conversation) return;
        const message = await this.prisma.message.findUnique({
          where: {
            conversationId_externalMessageId: {
              conversationId: conversation.id,
              externalMessageId: update.externalMessageId,
            },
          },
          select: { id: true, status: true },
        });
        if (!message) return;
        // Nunca regride status (read -> delivered).
        const order = { pending: 0, sent: 1, delivered: 2, read: 3, failed: 4 } as const;
        if (order[update.status] <= order[message.status as keyof typeof order]) return;
        await this.prisma.message.update({
          where: { id: message.id },
          data: { status: update.status },
        });
        this.io.to(instanceAudience(organizationId, update.instanceId)).emit(RealtimeEvents.MessageStatus, {
          conversationId: conversation.id,
          messageId: message.id,
          status: update.status,
        });
      });
    });

    this.provider.on("message-reaction", (reaction) => {
      void this.withOrg(reaction.instanceId, async (organizationId) => {
        const conversation = await this.prisma.conversation.findUnique({
          where: {
            whatsappInstanceId_externalChatId: {
              whatsappInstanceId: reaction.instanceId,
              externalChatId: reaction.externalChatId,
            },
          },
          select: { id: true },
        });
        if (!conversation) return;
        const message = await this.prisma.message.findUnique({
          where: {
            conversationId_externalMessageId: {
              conversationId: conversation.id,
              externalMessageId: reaction.targetExternalMessageId,
            },
          },
          select: { id: true },
        });
        if (!message) return;

        if (reaction.emoji) {
          await this.prisma.messageReaction.upsert({
            where: {
              messageId_senderExternalId: {
                messageId: message.id,
                senderExternalId: reaction.senderExternalId,
              },
            },
            update: { emoji: reaction.emoji, senderName: reaction.senderName },
            create: {
              messageId: message.id,
              emoji: reaction.emoji,
              senderExternalId: reaction.senderExternalId,
              senderName: reaction.senderName,
              fromMe: reaction.fromMe,
            },
          });
        } else {
          // Emoji vazio = reação removida
          await this.prisma.messageReaction.deleteMany({
            where: { messageId: message.id, senderExternalId: reaction.senderExternalId },
          });
        }

        const reactions = await this.prisma.messageReaction.findMany({
          where: { messageId: message.id },
        });
        this.io
          .to(instanceAudience(organizationId, reaction.instanceId))
          .emit(RealtimeEvents.MessageReaction, {
          conversationId: conversation.id,
          messageId: message.id,
          reactions: reactions.map((entry) => ({
            emoji: entry.emoji,
            senderName: entry.senderName,
            fromMe: entry.fromMe,
          })),
        });
      });
    });

    // Chamada de voz/vídeo — vira um registro dentro da conversa
    this.provider.on("call", (event) => {
      void this.withOrg(event.instanceId, async (organizationId) => {
        const conversation = await this.prisma.conversation.findUnique({
          where: {
            whatsappInstanceId_externalChatId: {
              whatsappInstanceId: event.instanceId,
              externalChatId: event.externalChatId,
            },
          },
          select: { id: true, status: true },
        });
        if (!conversation) return;

        const label = (CALL_LABELS[event.status] ?? CALL_LABELS.ringing)?.(event.isVideo) ?? "Chamada";
        // Mesma chamada emite vários eventos (tocando → atendida/perdida):
        // usamos o id da chamada para atualizar em vez de duplicar.
        const existing = await this.prisma.message.findUnique({
          where: {
            conversationId_externalMessageId: {
              conversationId: conversation.id,
              externalMessageId: `call:${event.callId}`,
            },
          },
          select: { id: true },
        });

        const message = existing
          ? await this.prisma.message.update({
              where: { id: existing.id },
              data: { content: label, metadata: { callStatus: event.status, isVideo: event.isVideo } },
            })
          : await this.prisma.message.create({
              data: {
                organizationId,
                conversationId: conversation.id,
                externalMessageId: `call:${event.callId}`,
                direction: "inbound",
                type: "call",
                content: label,
                metadata: { callStatus: event.status, isVideo: event.isVideo },
                senderExternalId: event.fromExternalId,
                timestamp: event.timestamp,
                status: "delivered",
              },
            });

        await this.prisma.conversation.update({
          where: { id: conversation.id },
          data: {
            lastMessageAt: event.timestamp,
            lastMessagePreview: label,
            ...(conversation.status === "new" ? { status: "open" as const } : {}),
          },
        });

        const full = await this.prisma.conversation.findUnique({
          where: { id: conversation.id },
          include: {
            assignedUser: true,
            department: true,
            instance: true,
            tags: { include: { tag: true } },
          },
        });
        const room = instanceAudience(organizationId, event.instanceId);
        if (existing) {
          this.io.to(room).emit(RealtimeEvents.MessageUpdated, serializeMessage(message));
        } else if (full) {
          this.io.to(room).emit(RealtimeEvents.MessageNew, {
            conversation: serializeConversation(full),
            message: serializeMessage(message),
          });
        }
        if (full) {
          this.io
            .to(room)
            .emit(RealtimeEvents.ConversationUpdated, serializeConversation(full));
        }
      });
    });

    // Cliente apagou uma mensagem para todos
    this.provider.on("message-deleted", (event) => {
      void this.withOrg(event.instanceId, async (organizationId) => {
        const message = await this.findMessageByExternalId(
          event.instanceId,
          event.externalChatId,
          event.targetExternalMessageId,
        );
        if (!message || message.deletedAt) return;
        const updated = await this.prisma.message.update({
          where: { id: message.id },
          data: { deletedAt: new Date(), content: null },
        });
        this.io
          .to(instanceAudience(organizationId, event.instanceId))
          .emit(RealtimeEvents.MessageUpdated, serializeMessage(updated));
      });
    });

    // Cliente editou o texto de uma mensagem
    this.provider.on("message-edited", (event) => {
      void this.withOrg(event.instanceId, async (organizationId) => {
        const message = await this.findMessageByExternalId(
          event.instanceId,
          event.externalChatId,
          event.targetExternalMessageId,
        );
        if (!message || message.deletedAt) return;
        const updated = await this.prisma.message.update({
          where: { id: message.id },
          data: { content: event.newText, editedAt: new Date() },
        });
        this.io
          .to(instanceAudience(organizationId, event.instanceId))
          .emit(RealtimeEvents.MessageUpdated, serializeMessage(updated));
      });
    });

    this.provider.on("chats-sync", (event) => {
      void this.withOrg(event.instanceId, (organizationId) =>
        this.syncChats(event.instanceId, organizationId, event.chats),
      );
    });

    this.provider.on("contacts-sync", (event) => {
      void this.withOrg(event.instanceId, (organizationId) =>
        this.syncContacts(event.instanceId, organizationId, event.contacts),
      );
    });

    this.provider.on("groups-sync", (event) => {
      void this.withOrg(event.instanceId, (organizationId) =>
        this.syncGroups(event.instanceId, organizationId, event.groups),
      );
    });
  }

  /**
   * Completa nome/telefone de um participante de grupo a partir dos dados
   * que chegam nas mensagens — o WhatsApp não entrega esses campos na
   * listagem de participantes quando o grupo usa identificadores internos.
   */
  private async enrichParticipant(
    instanceId: string,
    externalChatId: string,
    externalContactId: string,
    name: string,
    phone: string | null,
  ): Promise<void> {
    try {
      const group = await this.prisma.whatsAppGroup.findUnique({
        where: {
          whatsappInstanceId_externalId: {
            whatsappInstanceId: instanceId,
            externalId: externalChatId,
          },
        },
        select: { id: true },
      });
      if (!group) return;
      const participant = await this.prisma.groupParticipant.findUnique({
        where: {
          groupId_externalContactId: { groupId: group.id, externalContactId },
        },
        select: { id: true, name: true, phoneNumber: true },
      });
      if (!participant) return;
      const needsName = !participant.name || participant.name !== name;
      const needsPhone = !participant.phoneNumber && !!phone;
      if (!needsName && !needsPhone) return;
      await this.prisma.groupParticipant.update({
        where: { id: participant.id },
        data: {
          ...(needsName ? { name } : {}),
          ...(needsPhone && phone ? { phoneNumber: phone } : {}),
        },
      });
    } catch (err) {
      this.logger.debug({ event: "participant_enrich_failed", error: String(err) });
    }
  }

  /** Localiza uma mensagem persistida a partir do id externo do WhatsApp. */
  private async findMessageByExternalId(
    instanceId: string,
    externalChatId: string,
    externalMessageId: string,
  ) {
    const conversation = await this.prisma.conversation.findUnique({
      where: {
        whatsappInstanceId_externalChatId: {
          whatsappInstanceId: instanceId,
          externalChatId,
        },
      },
      select: { id: true },
    });
    if (!conversation) return null;
    return this.prisma.message.findUnique({
      where: {
        conversationId_externalMessageId: {
          conversationId: conversation.id,
          externalMessageId,
        },
      },
    });
  }

  /** Retoma sessões que estavam ativas antes do último shutdown/deploy. */
  async resumeSessions(): Promise<void> {
    const instances = await this.prisma.whatsAppInstance.findMany({
      where: { status: { not: "disconnected" } },
    });
    for (const instance of instances) {
      this.orgByInstance.set(instance.id, instance.organizationId);
      this.logger.info({ instanceId: instance.id, event: "session_resume" });
      try {
        await this.provider.connect(instance.id);
      } catch (err) {
        this.logger.error({ instanceId: instance.id, event: "session_resume_failed", error: String(err) });
        await this.prisma.whatsAppInstance.update({
          where: { id: instance.id },
          data: { status: "error" },
        });
      }
    }
  }

  registerInstance(instanceId: string, organizationId: string): void {
    this.orgByInstance.set(instanceId, organizationId);
  }

  private async withOrg(
    instanceId: string,
    handler: (organizationId: string) => void | Promise<void>,
  ): Promise<void> {
    try {
      let organizationId = this.orgByInstance.get(instanceId);
      if (!organizationId) {
        const instance = await this.prisma.whatsAppInstance.findUnique({
          where: { id: instanceId },
          select: { organizationId: true },
        });
        if (!instance) return;
        organizationId = instance.organizationId;
        this.orgByInstance.set(instanceId, organizationId);
      }
      await handler(organizationId);
    } catch (err) {
      this.logger.error({ instanceId, event: "provider_event_failed", error: String(err) });
    }
  }

  private async handleStatus(
    instanceId: string,
    status: "disconnected" | "connecting" | "qr_required" | "connected" | "reconnecting" | "error",
    phoneNumber: string | null,
    reason?: string,
  ): Promise<void> {
    await this.withOrg(instanceId, async (organizationId) => {
      const now = new Date();
      await this.prisma.whatsAppInstance.update({
        where: { id: instanceId },
        data: {
          status,
          ...(phoneNumber ? { phoneNumber } : {}),
          ...(status === "connected" ? { lastConnectionAt: now } : {}),
          ...(status === "disconnected" || status === "error"
            ? { lastDisconnectionAt: now }
            : {}),
        },
      });
      this.audit.record({
        organizationId,
        action: status === "connected" ? "whatsapp.connected" : `whatsapp.status.${status}`,
        entityType: "WhatsAppInstance",
        entityId: instanceId,
        metadata: reason ? { reason } : undefined,
      });
      this.io.to(instanceAudience(organizationId, instanceId)).emit(RealtimeEvents.InstanceStatus, {
        instanceId,
        status,
        phoneNumber,
        reason,
      });

      if (status === "connected") {
        // Aguarda a sincronização inicial de chats/grupos antes de buscar fotos.
        setTimeout(() => {
          void this.backfillAvatars(instanceId, organizationId);
        }, 15_000);
      }
    });
  }

  /**
   * Baixa e armazena a foto de perfil de uma conversa (contato ou grupo).
   * Retorna true se a foto foi atualizada.
   */
  async syncConversationAvatar(
    conversation: { id: string; whatsappInstanceId: string; externalChatId: string },
    options: { force?: boolean } = {},
  ): Promise<boolean> {
    if (!options.force && this.avatarsUnavailable.has(conversation.id)) return false;
    try {
      // Um erro aqui é temporário (o provider retorna null quando é
      // definitivo) — cai no catch e será tentado de novo depois.
      const picture = await this.provider.getProfilePicture(
        conversation.whatsappInstanceId,
        conversation.externalChatId,
      );
      if (!picture) {
        this.avatarsUnavailable.add(conversation.id);
        return false;
      }
      const key = await this.storage.save(picture.data, {
        instanceId: conversation.whatsappInstanceId,
        extension: extensionFromMime(picture.mimeType) ?? "jpg",
      });
      await this.prisma.conversation.update({
        where: { id: conversation.id },
        data: { profilePicture: key },
      });
      this.avatarsUnavailable.delete(conversation.id);
      return true;
    } catch (err) {
      // Falha temporária: não marca como indisponível para tentar de novo.
      this.logger.debug({
        conversationId: conversation.id,
        event: "avatar_sync_retry_later",
        error: String(err),
      });
      return false;
    }
  }

  /** Limpa a marcação de "sem foto" para forçar nova consulta. */
  async resetAvatarChecks(conversationId: string, groupId?: string): Promise<void> {
    this.avatarsUnavailable.delete(conversationId);
    if (groupId) {
      await this.prisma.groupParticipant.updateMany({
        where: { groupId },
        data: { avatarCheckedAt: null },
      });
    }
  }

  /**
   * Busca as fotos dos participantes de um grupo sob demanda (quando a
   * conversa é aberta). Só consulta quem ainda não foi verificado ou cuja
   * verificação está antiga, e avisa o frontend ao terminar.
   */
  async syncParticipantAvatars(conversationId: string, organizationId: string): Promise<void> {
    try {
      const group = await this.prisma.whatsAppGroup.findFirst({
        where: { conversationId, organizationId },
        select: { id: true, whatsappInstanceId: true },
      });
      if (!group) return;

      const staleBefore = new Date(Date.now() - PARTICIPANT_AVATAR_TTL_MS);
      const pending = await this.prisma.groupParticipant.findMany({
        where: {
          groupId: group.id,
          OR: [{ avatarCheckedAt: null }, { avatarCheckedAt: { lt: staleBefore } }],
        },
        select: { id: true, externalContactId: true },
        take: PARTICIPANT_AVATAR_LIMIT,
      });
      if (pending.length === 0) return;

      let updated = 0;
      let withoutPicture = 0;
      let transientFailures = 0;
      for (const participant of pending) {
        try {
          const picture = await this.provider.getProfilePicture(
            group.whatsappInstanceId,
            participant.externalContactId,
          );
          if (picture) {
            const key = await this.storage.save(picture.data, {
              instanceId: group.whatsappInstanceId,
              extension: extensionFromMime(picture.mimeType) ?? "jpg",
            });
            await this.prisma.groupParticipant.update({
              where: { id: participant.id },
              data: { avatarUrl: key, avatarCheckedAt: new Date() },
            });
            updated += 1;
          } else {
            // Sem foto ou privacidade: registra a verificação para não insistir.
            await this.prisma.groupParticipant.update({
              where: { id: participant.id },
              data: { avatarCheckedAt: new Date() },
            });
            withoutPicture += 1;
          }
        } catch {
          // Falha temporária: NÃO marca como verificado — tenta de novo
          // na próxima vez que o grupo for aberto.
          transientFailures += 1;
        }
        await new Promise((resolve) => setTimeout(resolve, AVATAR_FETCH_DELAY_MS));
      }

      this.logger.info({
        conversationId,
        event: "participant_avatars_synced",
        checked: pending.length,
        updated,
        withoutPicture,
        transientFailures,
      });
      if (updated > 0) {
        this.io
          .to(instanceAudience(organizationId, group.whatsappInstanceId))
          .emit(RealtimeEvents.GroupParticipants, { conversationId });
      }
    } catch (err) {
      this.logger.warn({
        conversationId,
        event: "participant_avatars_failed",
        error: String(err),
      });
    }
  }

  /**
   * Preenche as fotos das conversas que ainda não têm — roda quando a
   * instância conecta e após sincronizações, em ritmo controlado para não
   * sobrecarregar o WhatsApp.
   */
  private async backfillAvatars(instanceId: string, organizationId: string): Promise<void> {
    if (this.avatarSyncRunning) return;
    this.avatarSyncRunning = true;
    try {
      const pending = await this.prisma.conversation.findMany({
        where: {
          whatsappInstanceId: instanceId,
          profilePicture: null,
          id: { notIn: [...this.avatarsUnavailable] },
        },
        select: { id: true, whatsappInstanceId: true, externalChatId: true },
        orderBy: { lastMessageAt: { sort: "desc", nulls: "last" } },
        take: AVATAR_BACKFILL_LIMIT,
      });
      if (pending.length === 0) return;

      this.logger.info({ instanceId, event: "avatar_backfill_started", count: pending.length });
      let updated = 0;
      for (const conversation of pending) {
        const changed = await this.syncConversationAvatar(conversation);
        if (changed) {
          updated += 1;
          const full = await this.prisma.conversation.findUnique({
            where: { id: conversation.id },
            include: {
              assignedUser: true,
              department: true,
              instance: true,
              tags: { include: { tag: true } },
            },
          });
          if (full) {
            this.io
              .to(instanceAudience(organizationId, instanceId))
              .emit(RealtimeEvents.ConversationUpdated, serializeConversation(full));
          }
        }
        await new Promise((resolve) => setTimeout(resolve, AVATAR_FETCH_DELAY_MS));
      }
      this.logger.info({ instanceId, event: "avatar_backfill_finished", updated });
    } catch (err) {
      this.logger.warn({ instanceId, event: "avatar_backfill_failed", error: String(err) });
    } finally {
      this.avatarSyncRunning = false;
    }
  }

  private async syncChats(
    instanceId: string,
    organizationId: string,
    chats: ProviderChat[],
  ): Promise<void> {
    for (const chat of chats) {
      const title = chat.name ?? chat.externalChatId.split("@")[0] ?? chat.externalChatId;
      await this.prisma.conversation.upsert({
        where: {
          whatsappInstanceId_externalChatId: {
            whatsappInstanceId: instanceId,
            externalChatId: chat.externalChatId,
          },
        },
        update: {
          ...(chat.name ? { title: chat.name } : {}),
          ...(chat.lastMessageAt ? { lastMessageAt: chat.lastMessageAt } : {}),
        },
        create: {
          organizationId,
          whatsappInstanceId: instanceId,
          externalChatId: chat.externalChatId,
          type: chat.type,
          title,
          status: "new",
          unreadCount: chat.unreadCount,
          lastMessageAt: chat.lastMessageAt,
        },
      });
    }
    this.logger.info({ instanceId, event: "chats_synced", count: chats.length });
    void this.backfillAvatars(instanceId, organizationId);
  }

  private async syncContacts(
    instanceId: string,
    organizationId: string,
    contacts: ProviderContact[],
  ): Promise<void> {
    for (const contact of contacts) {
      await this.prisma.contact.upsert({
        where: {
          whatsappInstanceId_externalId: {
            whatsappInstanceId: instanceId,
            externalId: contact.externalId,
          },
        },
        update: { ...(contact.name ? { name: contact.name } : {}) },
        create: {
          organizationId,
          whatsappInstanceId: instanceId,
          externalId: contact.externalId,
          phoneNumber: contact.phoneNumber || null,
          name: contact.name,
        },
      });
    }
    this.logger.info({ instanceId, event: "contacts_synced", count: contacts.length });
  }

  private async syncGroups(
    instanceId: string,
    organizationId: string,
    groups: ProviderGroup[],
  ): Promise<void> {
    for (const group of groups) {
      // Grupo é entidade de primeira classe: garante conversa + registro do grupo.
      const conversation = await this.prisma.conversation.upsert({
        where: {
          whatsappInstanceId_externalChatId: {
            whatsappInstanceId: instanceId,
            externalChatId: group.externalId,
          },
        },
        update: { title: group.name, type: "group" },
        create: {
          organizationId,
          whatsappInstanceId: instanceId,
          externalChatId: group.externalId,
          type: "group",
          title: group.name,
          status: "new",
        },
      });

      const record = await this.prisma.whatsAppGroup.upsert({
        where: {
          whatsappInstanceId_externalId: {
            whatsappInstanceId: instanceId,
            externalId: group.externalId,
          },
        },
        update: {
          name: group.name,
          description: group.description,
          participantCount: group.participantCount,
          conversationId: conversation.id,
        },
        create: {
          organizationId,
          whatsappInstanceId: instanceId,
          externalId: group.externalId,
          name: group.name,
          description: group.description,
          participantCount: group.participantCount,
          conversationId: conversation.id,
        },
      });

      for (const participant of group.participants) {
        await this.prisma.groupParticipant.upsert({
          where: {
            groupId_externalContactId: {
              groupId: record.id,
              externalContactId: participant.externalContactId,
            },
          },
          update: {
            isAdmin: participant.isAdmin,
            isSuperAdmin: participant.isSuperAdmin,
            ...(participant.name ? { name: participant.name } : {}),
          },
          create: {
            groupId: record.id,
            externalContactId: participant.externalContactId,
            phoneNumber: participant.phoneNumber,
            name: participant.name,
            isAdmin: participant.isAdmin,
            isSuperAdmin: participant.isSuperAdmin,
          },
        });
      }
    }
    this.logger.info({ instanceId, event: "groups_synced", count: groups.length });
    void this.backfillAvatars(instanceId, organizationId);
  }
}

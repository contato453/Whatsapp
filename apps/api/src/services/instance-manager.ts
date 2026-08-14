import type { PrismaClient } from "@zapdesk/database";
import type {
  ProviderContact,
  ProviderChat,
  ProviderGroup,
} from "@zapdesk/shared";
import { RealtimeEvents } from "@zapdesk/shared";
import type { WhatsAppProvider } from "@zapdesk/whatsapp";
import type { Server } from "socket.io";
import type { Logger } from "pino";
import { orgRoom } from "../realtime/socket.js";
import { serializeConversation, serializeMessage } from "../lib/serialize.js";
import type { MessageIngestService } from "./message-ingest.js";
import type { AuditService } from "../modules/audit/service.js";

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

  constructor(
    private readonly prisma: PrismaClient,
    private readonly provider: WhatsAppProvider,
    private readonly ingest: MessageIngestService,
    private readonly io: Server,
    private readonly audit: AuditService,
    private readonly logger: Logger,
  ) {}

  wireProviderEvents(): void {
    this.provider.on("status", (event) => {
      void this.handleStatus(event.instanceId, event.status, event.phoneNumber ?? null, event.reason);
    });

    this.provider.on("qr", (event) => {
      void this.withOrg(event.instanceId, (organizationId) => {
        this.io.to(orgRoom(organizationId)).emit(RealtimeEvents.InstanceQr, {
          instanceId: event.instanceId,
          qrDataUrl: event.qrDataUrl,
        });
      });
    });

    this.provider.on("message", (message) => {
      void this.withOrg(message.instanceId, async (organizationId) => {
        const result = await this.ingest.ingest(message, { organizationId });
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
        const room = orgRoom(organizationId);
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
        this.io.to(orgRoom(organizationId)).emit(RealtimeEvents.MessageStatus, {
          conversationId: conversation.id,
          messageId: message.id,
          status: update.status,
        });
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
      this.io.to(orgRoom(organizationId)).emit(RealtimeEvents.InstanceStatus, {
        instanceId,
        status,
        phoneNumber,
        reason,
      });
    });
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
  }
}

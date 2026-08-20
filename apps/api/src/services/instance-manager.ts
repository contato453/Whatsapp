import type { PrismaClient } from "@azvchat/database";
import type {
  ProviderContact,
  ProviderChat,
  ProviderGroup,
} from "@azvchat/shared";
import { RealtimeEvents, readMessageSecret, type CallIncomingPayload } from "@azvchat/shared";
import type { WhatsAppProvider } from "@azvchat/whatsapp";
import { decryptEditedText } from "@azvchat/whatsapp";
import type { Server } from "socket.io";
import type { Logger } from "pino";
import { conversationAudience, instanceAudience } from "../realtime/socket.js";
import { serializeConversation, serializeMessage } from "../lib/serialize.js";
import { resolveCallerIdentity } from "../lib/call-identity.js";
import { resolveConversationPersonName } from "../lib/person-profile.js";
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
        // Conversa individual leva o nome da PESSOA no título — o DTO da
        // mensagem não pode sobrescrever o nome corrigido na lista.
        const personName = await resolveConversationPersonName(
          this.prisma,
          organizationId,
          conversation,
        );
        const room = conversationAudience(organizationId, conversation);
        this.io.to(room).emit(RealtimeEvents.MessageNew, {
          conversation: serializeConversation(conversation, personName),
          message: serializeMessage(persisted),
        });
        this.io
          .to(room)
          .emit(RealtimeEvents.ConversationUpdated, serializeConversation(conversation, personName));
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
          select: {
            id: true,
            whatsappInstanceId: true,
            departmentId: true,
            assignedUserId: true,
          },
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
        this.io.to(conversationAudience(organizationId, conversation)).emit(RealtimeEvents.MessageStatus, {
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
          select: {
            id: true,
            whatsappInstanceId: true,
            departmentId: true,
            assignedUserId: true,
          },
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
          .to(conversationAudience(organizationId, conversation))
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
        // Quem nunca escreveu e só ligou também precisa aparecer na fila,
        // então a conversa é criada na primeira chamada.
        const caller = event.fromExternalId
          ? await this.prisma.contact.findFirst({
              where: {
                whatsappInstanceId: event.instanceId,
                externalId: event.fromExternalId,
              },
              select: { name: true, pushName: true, phoneNumber: true },
            })
          : null;
        const callerName = caller?.name ?? caller?.pushName ?? null;
        const conversation = await this.ingest.ensureConversation(
          {
            instanceId: event.instanceId,
            externalChatId: event.externalChatId,
            isGroup: event.isGroup,
            callerName,
            callerPhone: event.fromPhone,
          },
          organizationId,
        );

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
            // Chamada recebida é contato do cliente: devolve para a fila,
            // igual a uma mensagem nova. Arquivada não volta — mesma regra
            // da mensagem: o chip de backup também recebe chamadas.
            ...((conversation.status === "resolved" || conversation.status === "waiting_client") &&
            !conversation.archivedAt
              ? { status: "open" as const }
              : {}),
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
        const room = conversationAudience(organizationId, full ?? conversation);
        const personName = full
          ? await resolveConversationPersonName(this.prisma, organizationId, full)
          : null;
        if (existing) {
          this.io.to(room).emit(RealtimeEvents.MessageUpdated, serializeMessage(message));
        } else if (full) {
          this.io.to(room).emit(RealtimeEvents.MessageNew, {
            conversation: serializeConversation(full, personName),
            message: serializeMessage(message),
          });
        }
        if (full) {
          this.io
            .to(room)
            .emit(RealtimeEvents.ConversationUpdated, serializeConversation(full, personName));
        }

        // Está tocando agora: avisa o responsável em qualquer tela do sistema.
        // O sistema nunca atende nem rejeita — o telefone segue tocando.
        if (!existing && event.status === "ringing") {
          // A identidade é resolvida AQUI, no backend, para a tela receber
          // pronto — nada de consulta de agenda espalhada por componente.
          // São só consultas locais indexadas: não seguram o aviso.
          //
          // E falha na resolução NUNCA derruba o aviso: a chamada toca por
          // poucos segundos, e um aviso anônimo agora vale mais do que um
          // aviso perfeito que não chega. Sem nome, a tela mostra o rótulo
          // neutro — que é o degrau "nada encontrado" da própria regra.
          const ref = full ?? conversation;
          const identity = await resolveCallerIdentity(this.prisma, {
            organizationId,
            whatsappInstanceId: event.instanceId,
            callerExternalId: event.fromExternalId,
            callerPhone: event.fromPhone,
            conversation: {
              id: ref.id,
              title: ref.title,
              customTitle: ref.customTitle,
              externalChatId: ref.externalChatId,
              hasAvatar: ref.profilePicture != null,
            },
            isGroup: event.isGroup,
            contact: caller,
          }).catch((err) => {
            // Sem telefone nem conteúdo no log — só o suficiente para achar.
            this.logger.warn({
              instanceId: event.instanceId,
              conversationId: conversation.id,
              event: "call_identity_failed",
              error: String(err),
            });
            return { name: callerName, phone: event.fromPhone, groups: [], avatar: null };
          });
          const payload: CallIncomingPayload = {
            conversationId: conversation.id,
            conversationTitle:
              full?.customTitle ?? full?.title ?? conversation.customTitle ?? conversation.title,
            callerName: identity.name,
            callerPhone: identity.phone,
            callerGroups: identity.groups,
            callerAvatar: identity.avatar,
            isVideo: event.isVideo,
            isGroup: event.isGroup,
            assignedUserId: full?.assignedUserId ?? conversation.assignedUserId,
            instanceId: event.instanceId,
            instanceName: full?.instance?.name ?? null,
            at: event.timestamp.toISOString(),
          };
          this.io.to(room).emit(RealtimeEvents.CallIncoming, payload);
          // Rastro para diagnosticar "a chamada tocou e o aviso não veio":
          // sem telefone e sem nome no log, só o suficiente para achar.
          this.logger.info({
            instanceId: event.instanceId,
            conversationId: conversation.id,
            event: "call_incoming_emitted",
            identified: identity.name != null,
          });
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
          .to(conversationAudience(organizationId, message.conversation))
          .emit(RealtimeEvents.MessageUpdated, serializeMessage(updated));
      });
    });

    // Cliente editou o texto (ou a legenda) de uma mensagem.
    //
    // Quem atualiza é o pipeline de ingestão, e não este handler: edição é
    // ATUALIZAÇÃO da mensagem original, então ela tem que passar pelo mesmo
    // lugar que grava mensagem, com a mesma chave
    // (conversationId, externalMessageId) e a mesma idempotência. O evento
    // chega pelos dois canais do Baileys e pode repetir — `applyEdit`
    // devolve null quando não há o que fazer, e aí nada é publicado.
    this.provider.on("message-edited", (event) => {
      void this.withOrg(event.instanceId, async (organizationId) => {
        const result = await this.ingest.applyEdit({
          instanceId: event.instanceId,
          externalChatId: event.externalChatId,
          targetExternalMessageId: event.targetExternalMessageId,
          newContent: event.newText,
          editedAt: event.editedAt,
        });
        if (!result) return;
        this.io
          .to(conversationAudience(organizationId, result.conversation))
          .emit(RealtimeEvents.MessageUpdated, serializeMessage(result.message));
        // A prévia da lista pode ter mudado junto: quem está com a Inbox
        // aberta precisa ver a linha acompanhar o texto novo.
        const conversation = await this.prisma.conversation.findUnique({
          where: { id: result.conversation.id },
          include: {
            assignedUser: true,
            department: true,
            instance: true,
            tags: { include: { tag: true } },
          },
        });
        if (!conversation) return;
        const personName = await resolveConversationPersonName(
          this.prisma,
          organizationId,
          conversation,
        );
        this.io
          .to(conversationAudience(organizationId, conversation))
          .emit(RealtimeEvents.ConversationUpdated, serializeConversation(conversation, personName));
      });
    });

    /**
     * Edição CIFRADA. O WhatsApp trocou o mecanismo: em vez do texto novo em
     * claro, manda um envelope cuja chave é derivada do `messageSecret` da
     * mensagem ORIGINAL. O provider reconhece e repassa; abrir é aqui,
     * porque o segredo mora no banco, junto da mensagem que ele protege.
     *
     * Mensagem que chegou antes de passarmos a guardar o segredo não tem
     * como ser aberta — é o desenho do protocolo, não um defeito nosso, e
     * por isso o caso é registrado no log e ignorado sem bolha de erro.
     */
    this.provider.on("message-edit-encrypted", (event) => {
      void this.withOrg(event.instanceId, async (organizationId) => {
        const original = await this.findMessageByExternalId(
          event.instanceId,
          event.externalChatId,
          event.targetExternalMessageId,
        );
        if (!original || original.deletedAt) return;
        const secret = readMessageSecret(original.metadata);
        if (!secret) {
          this.logger.info({
            instanceId: event.instanceId,
            messageId: original.id,
            event: "message_edit_secret_missing",
          });
          return;
        }
        // O WhatsApp endereça a mesma pessoa de DUAS formas — pelo telefone
        // (`@s.whatsapp.net`) e pelo identificador interno (`@lid`) — e a
        // chave da edição é derivada do JID que O APARELHO DELE usou, que
        // não é necessariamente o que chega para nós. O telefone entra na
        // lista porque o aparelho conhece o próprio número e tende a usá-lo,
        // enquanto o `@lid` é como nós o enxergamos.
        //
        // Testar é seguro: a etiqueta do AES-GCM só confere com a chave
        // exata, então nenhuma combinação errada produz texto plausível. O
        // log registra a vencedora, e é ela que vai permitir enxugar isto.
        const [contato, instancia] = await Promise.all([
          original.senderExternalId
            ? this.prisma.contact.findFirst({
                where: {
                  whatsappInstanceId: event.instanceId,
                  externalId: original.senderExternalId,
                },
                select: { phoneNumber: true },
              })
            : Promise.resolve(null),
          this.prisma.whatsAppInstance.findUnique({
            where: { id: event.instanceId },
            select: { phoneNumber: true },
          }),
        ]);
        const comoTelefone = (phone: string | null | undefined): string =>
          phone ? `${phone.replace(/\D/g, "")}@s.whatsapp.net` : "";
        const pessoais = [
          original.senderExternalId ?? "",
          comoTelefone(original.senderPhone),
          comoTelefone(contato?.phoneNumber),
          event.externalChatId,
          event.originalSenderExternalId ?? "",
        ];
        const nossos = [event.targetRemoteJid ?? "", comoTelefone(instancia?.phoneNumber)];
        const decrypted = decryptEditedText({
          encPayload: event.encPayload,
          encIv: event.encIv,
          messageSecret: Buffer.from(secret, "base64"),
          targetExternalMessageId: event.targetExternalMessageId,
          originalSenderCandidates: [...pessoais, ...nossos],
          editorCandidates: [event.editorExternalId, ...pessoais, ...nossos],
        });
        if (!decrypted) {
          this.logger.warn({
            instanceId: event.instanceId,
            messageId: original.id,
            event: "message_edit_decrypt_failed",
            // Nomes de campo e comprimento, nunca o conteúdo: é o que
            // permite ver se o segredo veio inteiro e quais JIDs tentamos.
            secretBytes: Buffer.from(secret, "base64").length,
            candidates: [...new Set([...pessoais, ...nossos, event.editorExternalId])].filter(
              (value) => value.length > 0,
            ),
            targetId: event.targetExternalMessageId,
          });
          return;
        }
        this.logger.info({
          instanceId: event.instanceId,
          messageId: original.id,
          event: "message_edit_decrypted",
          usedAad: decrypted.usedAad,
        });
        const newText = decrypted.text;
        const result = await this.ingest.applyEdit({
          instanceId: event.instanceId,
          externalChatId: event.externalChatId,
          targetExternalMessageId: event.targetExternalMessageId,
          newContent: newText,
          editedAt: event.editedAt,
        });
        if (!result) return;
        this.io
          .to(conversationAudience(organizationId, result.conversation))
          .emit(RealtimeEvents.MessageUpdated, serializeMessage(result.message));
        const conversation = await this.prisma.conversation.findUnique({
          where: { id: result.conversation.id },
          include: {
            assignedUser: true,
            department: true,
            instance: true,
            tags: { include: { tag: true } },
          },
        });
        if (!conversation) return;
        const personName = await resolveConversationPersonName(
          this.prisma,
          organizationId,
          conversation,
        );
        this.io
          .to(conversationAudience(organizationId, conversation))
          .emit(RealtimeEvents.ConversationUpdated, serializeConversation(conversation, personName));
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
      select: {
        id: true,
        whatsappInstanceId: true,
        departmentId: true,
        assignedUserId: true,
      },
    });
    if (!conversation) return null;
    const message = await this.prisma.message.findUnique({
      where: {
        conversationId_externalMessageId: {
          conversationId: conversation.id,
          externalMessageId,
        },
      },
    });
    // A conversa vai junto porque quem emite precisa dela para calcular
    // a audiência (número, departamento e responsável).
    return message ? { ...message, conversation } : null;
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
        select: {
          id: true,
          whatsappInstanceId: true,
          conversation: {
            select: {
              whatsappInstanceId: true,
              departmentId: true,
              assignedUserId: true,
            },
          },
        },
      });
      if (!group) return;

      const staleBefore = new Date(Date.now() - PARTICIPANT_AVATAR_TTL_MS);
      const pending = await this.prisma.groupParticipant.findMany({
        where: {
          groupId: group.id,
          OR: [{ avatarCheckedAt: null }, { avatarCheckedAt: { lt: staleBefore } }],
        },
        select: { id: true, externalContactId: true, phoneNumber: true },
        take: PARTICIPANT_AVATAR_LIMIT,
      });
      if (pending.length === 0) return;

      let updated = 0;
      let withoutPicture = 0;
      let transientFailures = 0;
      for (const participant of pending) {
        try {
          let picture = await this.provider.getProfilePicture(
            group.whatsappInstanceId,
            participant.externalContactId,
          );
          // Identificador anônimo costuma não responder à consulta de foto.
          // Com o telefone conhecido, tentamos de novo pelo JID de telefone.
          if (!picture && participant.externalContactId.endsWith("@lid") && participant.phoneNumber) {
            picture = await this.provider.getProfilePicture(
              group.whatsappInstanceId,
              `${participant.phoneNumber}@s.whatsapp.net`,
            );
          }
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
          .to(
            conversationAudience(
              organizationId,
              group.conversation ?? {
                whatsappInstanceId: group.whatsappInstanceId,
                departmentId: null,
                assignedUserId: null,
              },
            ),
          )
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
              .to(conversationAudience(organizationId, full))
              .emit(
                RealtimeEvents.ConversationUpdated,
                serializeConversation(
                  full,
                  await resolveConversationPersonName(this.prisma, organizationId, full),
                ),
              );
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

  /** Padrões do número aplicados às conversas que nascem nele. */
  private async instanceDefaults(
    instanceId: string,
  ): Promise<{ departmentId: string | null; isBackup: boolean }> {
    const instance = await this.prisma.whatsAppInstance.findUnique({
      where: { id: instanceId },
      select: { departmentId: true, isBackup: true },
    });
    return {
      departmentId: instance?.departmentId ?? null,
      isBackup: instance?.isBackup ?? false,
    };
  }

  private async syncChats(
    instanceId: string,
    organizationId: string,
    chats: ProviderChat[],
  ): Promise<void> {
    const { departmentId, isBackup } = await this.instanceDefaults(instanceId);
    for (const chat of chats) {
      const title = chat.name ?? chat.externalChatId.split("@")[0] ?? chat.externalChatId;
      await this.prisma.conversation.upsert({
        where: {
          whatsappInstanceId_externalChatId: {
            whatsappInstanceId: instanceId,
            externalChatId: chat.externalChatId,
          },
        },
        // O update NUNCA toca em archivedAt: o sync não desarquiva o que a
        // equipe arquivou, nem arquiva retroativamente o que já existia.
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
          departmentId,
          status: "open",
          // Número de backup: a carga inicial de chats também nasce
          // arquivada, senão a primeira conexão do chip encheria a Inbox.
          ...(isBackup ? { archivedAt: new Date() } : {}),
          // O não lido que vem do WhatsApp não é copiado: aqui a leitura é
          // por usuário, e um número do celular de outra pessoa não diz o que
          // cada atendente já leu. Conversa sincronizada nasce por ler para
          // todo mundo, que é o estado seguro.
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
        update: {
          ...(contact.name ? { name: contact.name } : {}),
          // Mesmo motivo dos participantes: o telefone pode só aparecer
          // numa sincronização posterior à criação do contato.
          ...(contact.phoneNumber ? { phoneNumber: contact.phoneNumber } : {}),
        },
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
    const { departmentId, isBackup } = await this.instanceDefaults(instanceId);
    for (const group of groups) {
      // Grupo é entidade de primeira classe: garante conversa + registro do grupo.
      const conversation = await this.prisma.conversation.upsert({
        where: {
          whatsappInstanceId_externalChatId: {
            whatsappInstanceId: instanceId,
            externalChatId: group.externalId,
          },
        },
        // O update não toca em archivedAt: sync não desarquiva nem arquiva
        // retroativamente — mesma regra do sync de chats.
        update: { title: group.name, type: "group" },
        create: {
          organizationId,
          whatsappInstanceId: instanceId,
          externalChatId: group.externalId,
          type: "group",
          title: group.name,
          departmentId,
          status: "open",
          // Número de backup: grupo sincronizado também nasce arquivado.
          ...(isBackup ? { archivedAt: new Date() } : {}),
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
            // O telefone precisa ser atualizado, e não só gravado na criação:
            // em grupos "@lid" ele costuma chegar em uma sincronização
            // posterior à que criou o participante.
            ...(participant.phoneNumber ? { phoneNumber: participant.phoneNumber } : {}),
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

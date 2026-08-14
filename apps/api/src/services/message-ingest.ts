import type { PrismaClient, Prisma } from "@azvchat/database";
import type { NormalizedMessage } from "@azvchat/shared";
import { stripWhatsAppFormatting } from "@azvchat/shared";
import type { Logger } from "pino";
import type { MediaStorage } from "../lib/media-storage.js";
import { extensionFromMime } from "../lib/media-storage.js";

export interface IngestResult {
  conversationId: string;
  messageId: string;
  isNewMessage: boolean;
}

/**
 * Gera o texto de preview exibido na lista de conversas.
 * Sem os marcadores de formatação: "*Fernanda:*" viraria ruído na prévia.
 */
export function buildPreview(message: Pick<NormalizedMessage, "type" | "content">): string {
  const content = message.content ? stripWhatsAppFormatting(message.content) : null;
  if (message.type === "text") return (content ?? "").slice(0, 120);
  const labels: Record<string, string> = {
    image: "📷 Imagem",
    audio: "🎤 Áudio",
    video: "🎬 Vídeo",
    document: "📄 Documento",
    sticker: "🩵 Figurinha",
    location: "📍 Localização",
    contact: "👤 Contato",
    other: "Mensagem",
  };
  const label = labels[message.type] ?? "Mensagem";
  return content ? `${label} — ${content}`.slice(0, 120) : label;
}

/**
 * Pipeline de ingestão: mensagem normalizada do provider →
 * persistência (conversa + mensagem + mídia) → resultado para publicação
 * em tempo real. Idempotente por (conversationId, externalMessageId).
 */
export class MessageIngestService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly storage: MediaStorage,
    private readonly logger: Logger,
  ) {}

  async ingest(
    message: NormalizedMessage,
    context: { organizationId: string },
  ): Promise<IngestResult | null> {
    const conversation = await this.upsertConversation(message, context.organizationId);

    // Mensagem recebida em conversa sem responsável cai para o responsável
    // padrão do departamento, se houver.
    if (message.direction === "inbound" && !conversation.assignedUserId) {
      await this.applyDefaultAssignee(conversation, context.organizationId);
    }

    // Deduplicação: eventos do WhatsApp podem chegar repetidos.
    const existing = await this.prisma.message.findUnique({
      where: {
        conversationId_externalMessageId: {
          conversationId: conversation.id,
          externalMessageId: message.externalMessageId,
        },
      },
      select: { id: true },
    });
    if (existing) {
      return { conversationId: conversation.id, messageId: existing.id, isNewMessage: false };
    }

    let mediaUrl: string | null = null;
    if (message.media) {
      try {
        const buffer = await message.media.download();
        mediaUrl = await this.storage.save(buffer, {
          instanceId: message.instanceId,
          extension: message.media.filename?.split(".").pop() ?? extensionFromMime(message.media.mimeType),
        });
      } catch (err) {
        this.logger.warn({
          instanceId: message.instanceId,
          messageId: message.externalMessageId,
          event: "media_download_failed",
          error: String(err),
        });
      }
    }

    const isInbound = message.direction === "inbound";
    const preview = buildPreview(message);

    // Em grupos que usam identificadores internos (@lid), o telefone pode
    // não vir na mensagem — buscamos o que já conhecemos do participante.
    // Quando vem, aproveitamos para gravá-lo: é assim que o cadastro de um
    // grupo anônimo aprende os números, conforme as pessoas escrevem.
    let senderPhone = message.senderPhone;
    if (message.chatType === "group" && message.senderExternalId) {
      const participant = await this.prisma.groupParticipant.findFirst({
        where: {
          externalContactId: message.senderExternalId,
          group: { whatsappInstanceId: message.instanceId, externalId: message.externalChatId },
        },
        select: { id: true, phoneNumber: true },
      });
      if (!senderPhone) {
        senderPhone = participant?.phoneNumber || null;
      } else if (participant && participant.phoneNumber !== senderPhone) {
        await this.prisma.groupParticipant.update({
          where: { id: participant.id },
          data: { phoneNumber: senderPhone },
        });
      }
    }

    const created = await this.prisma.message.create({
      data: {
        organizationId: context.organizationId,
        conversationId: conversation.id,
        externalMessageId: message.externalMessageId,
        senderExternalId: message.senderExternalId,
        senderName: message.senderName,
        senderPhone,
        direction: message.direction,
        type: message.type,
        content: message.content,
        mediaUrl,
        mimeType: message.media?.mimeType ?? null,
        filename: message.media?.filename ?? null,
        quotedMessageId: message.quotedExternalMessageId,
        timestamp: message.timestamp,
        status: isInbound ? "delivered" : "sent",
      },
    });

    await this.prisma.conversation.update({
      where: { id: conversation.id },
      data: {
        lastMessageAt: message.timestamp,
        lastMessagePreview: preview,
        ...(isInbound
          ? {
              unreadCount: { increment: 1 },
              // Mensagem do cliente devolve a conversa para a fila: concluída
              // reabre, e "AG. Cliente" deixa de fazer sentido — a espera
              // acabou no momento em que ele respondeu.
              ...(conversation.status === "resolved" || conversation.status === "waiting_client"
                ? { status: "open" as const }
                : {}),
            }
          : {}),
      },
    });

    this.logger.info({
      instanceId: message.instanceId,
      conversationId: conversation.id,
      messageId: created.id,
      event: "message_persisted",
      timestamp: message.timestamp.toISOString(),
    });

    return { conversationId: conversation.id, messageId: created.id, isNewMessage: true };
  }

  /**
   * Garante a conversa de um contato que ainda não mandou mensagem —
   * usado quando a primeira interação é uma ligação.
   */
  async ensureConversation(
    input: {
      instanceId: string;
      externalChatId: string;
      isGroup: boolean;
      callerName: string | null;
      callerPhone: string | null;
    },
    organizationId: string,
  ) {
    return this.upsertConversation(
      {
        instanceId: input.instanceId,
        externalChatId: input.externalChatId,
        chatType: input.isGroup ? "group" : "individual",
        chatName: null,
        direction: "inbound",
        senderName: input.callerName,
        senderPhone: input.callerPhone,
      },
      organizationId,
    );
  }

  /**
   * Atribui a conversa ao responsável padrão do departamento.
   *
   * Só age quando ninguém está responsável — nunca tira uma conversa de
   * quem já assumiu. O registro no histórico fica sem "performedBy", que é
   * o que distingue a atribuição automática da feita por uma pessoa.
   */
  private async applyDefaultAssignee(
    conversation: { id: string; departmentId: string | null },
    organizationId: string,
  ): Promise<void> {
    if (!conversation.departmentId) return;
    try {
      const department = await this.prisma.department.findUnique({
        where: { id: conversation.departmentId },
        select: { defaultAssigneeId: true },
      });
      const assigneeId = department?.defaultAssigneeId;
      if (!assigneeId) return;

      // Usuário desativado depois de configurado não recebe a conversa:
      // ela ficaria parada numa caixa que ninguém abre.
      const assignee = await this.prisma.user.findFirst({
        where: { id: assigneeId, organizationId, status: "active" },
        select: { id: true },
      });
      if (!assignee) return;

      await this.prisma.conversation.update({
        where: { id: conversation.id },
        data: { assignedUserId: assignee.id },
      });
      await this.prisma.conversationAssignmentHistory.create({
        data: {
          organizationId,
          conversationId: conversation.id,
          action: "assigned",
          toUserId: assignee.id,
          toDepartmentId: conversation.departmentId,
          note: "Responsável padrão do departamento",
        },
      });
    } catch (err) {
      // Falhar aqui não pode impedir a mensagem de ser gravada.
      this.logger.warn({
        conversationId: conversation.id,
        event: "default_assignee_failed",
        error: String(err),
      });
    }
  }

  private async upsertConversation(
    message: Pick<
      NormalizedMessage,
      | "instanceId"
      | "externalChatId"
      | "chatType"
      | "chatName"
      | "direction"
      | "senderName"
      | "senderPhone"
    >,
    organizationId: string,
  ) {
    const fallbackTitle =
      message.chatName ??
      (message.chatType === "group"
        ? "Grupo"
        : message.direction === "inbound"
          ? (message.senderName ?? message.senderPhone ?? message.externalChatId)
          : (message.senderPhone ?? message.externalChatId));

    const existing = await this.prisma.conversation.findUnique({
      where: {
        whatsappInstanceId_externalChatId: {
          whatsappInstanceId: message.instanceId,
          externalChatId: message.externalChatId,
        },
      },
    });
    if (existing) {
      // Melhora o título se antes só tínhamos o telefone/JID e agora temos nome.
      if (
        message.chatType === "individual" &&
        message.direction === "inbound" &&
        message.senderName &&
        (existing.title === existing.externalChatId || /^\d+$/.test(existing.title))
      ) {
        return this.prisma.conversation.update({
          where: { id: existing.id },
          data: { title: message.senderName },
        });
      }
      return existing;
    }

    // A conversa nasce no departamento padrão do número, para já entrar
    // classificada e respeitar o recorte por departamento desde a primeira
    // mensagem.
    const instance = await this.prisma.whatsAppInstance.findUnique({
      where: { id: message.instanceId },
      select: { departmentId: true },
    });
    const data: Prisma.ConversationUncheckedCreateInput = {
      organizationId,
      whatsappInstanceId: message.instanceId,
      externalChatId: message.externalChatId,
      type: message.chatType,
      title: fallbackTitle,
      departmentId: instance?.departmentId ?? null,
      status: "open",
    };
    return this.prisma.conversation.create({ data });
  }
}

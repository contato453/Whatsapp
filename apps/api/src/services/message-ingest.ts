import type { PrismaClient, Prisma } from "@zapdesk/database";
import type { NormalizedMessage } from "@zapdesk/shared";
import type { Logger } from "pino";
import type { MediaStorage } from "../lib/media-storage.js";
import { extensionFromMime } from "../lib/media-storage.js";

export interface IngestResult {
  conversationId: string;
  messageId: string;
  isNewMessage: boolean;
}

/** Gera o texto de preview exibido na lista de conversas. */
export function buildPreview(message: Pick<NormalizedMessage, "type" | "content">): string {
  if (message.type === "text") return (message.content ?? "").slice(0, 120);
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
  return message.content ? `${label} — ${message.content}`.slice(0, 120) : label;
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

    // Em grupos que usam identificadores internos (@lid), o telefone não vem
    // na mensagem — buscamos o que já conhecemos do participante.
    let senderPhone = message.senderPhone;
    if (!senderPhone && message.chatType === "group" && message.senderExternalId) {
      const participant = await this.prisma.groupParticipant.findFirst({
        where: {
          externalContactId: message.senderExternalId,
          group: { whatsappInstanceId: message.instanceId, externalId: message.externalChatId },
        },
        select: { phoneNumber: true },
      });
      senderPhone = participant?.phoneNumber || null;
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
              // Conversa resolvida que recebe mensagem nova volta para a fila.
              ...(conversation.status === "resolved" || conversation.status === "archived"
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

  private async upsertConversation(message: NormalizedMessage, organizationId: string) {
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

    const data: Prisma.ConversationUncheckedCreateInput = {
      organizationId,
      whatsappInstanceId: message.instanceId,
      externalChatId: message.externalChatId,
      type: message.chatType,
      title: fallbackTitle,
      status: "new",
    };
    return this.prisma.conversation.create({ data });
  }
}

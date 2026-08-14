import type { proto } from "@whiskeysockets/baileys";
import type { ConversationType, MessageDirection, MessageType } from "@azvchat/shared";

/**
 * Funções puras de normalização de mensagens do formato Baileys para o
 * formato neutro da aplicação. Mantidas separadas do provider para
 * serem testáveis sem abrir sockets.
 */

export interface ExtractedContent {
  type: MessageType;
  content: string | null;
  mimeType: string | null;
  filename: string | null;
  hasMedia: boolean;
  /** Opções da enquete, quando type === "poll" */
  pollOptions?: string[];
}

/** Extrai o número de telefone de um JID ("5511999@s.whatsapp.net" -> "5511999"). */
export function jidToPhone(jid: string | null | undefined): string | null {
  if (!jid) return null;
  const bare = jid.split("@")[0] ?? "";
  const withoutDevice = bare.split(":")[0] ?? "";
  const digits = withoutDevice.replace(/\D/g, "");
  return digits.length > 0 ? digits : null;
}

/** Um JID de grupo termina com "@g.us". */
export function isGroupJid(jid: string | null | undefined): boolean {
  return typeof jid === "string" && jid.endsWith("@g.us");
}

/**
 * JIDs "@lid" são identificadores internos e anônimos do WhatsApp — o
 * número neles NÃO é telefone. Precisamos ignorá-los ao exibir contatos.
 */
export function isLidJid(jid: string | null | undefined): boolean {
  return typeof jid === "string" && jid.endsWith("@lid");
}

/** Extrai o telefone somente quando o JID for de fato do tipo telefone. */
export function phoneFromJid(jid: string | null | undefined): string | null {
  if (!jid || isLidJid(jid) || isGroupJid(jid)) return null;
  return jidToPhone(jid);
}

export function chatTypeFromJid(jid: string): ConversationType {
  return isGroupJid(jid) ? "group" : "individual";
}

/** JIDs que não representam conversas de atendimento (status, newsletter etc.). */
export function isIgnorableJid(jid: string | null | undefined): boolean {
  if (!jid) return true;
  return (
    jid === "status@broadcast" ||
    jid.endsWith("@newsletter") ||
    jid.endsWith("@broadcast")
  );
}

/**
 * Desembrulha wrappers (ephemeral, viewOnce, documentWithCaption...) até
 * chegar ao conteúdo real da mensagem.
 */
export function unwrapMessage(
  message: proto.IMessage | null | undefined,
): proto.IMessage | null {
  if (!message) return null;
  const m = message as Record<string, unknown>;
  const wrappers = [
    "ephemeralMessage",
    "viewOnceMessage",
    "viewOnceMessageV2",
    "viewOnceMessageV2Extension",
    "documentWithCaptionMessage",
    "editedMessage",
  ] as const;
  for (const key of wrappers) {
    const wrapped = m[key] as { message?: proto.IMessage } | undefined;
    if (wrapped?.message) {
      return unwrapMessage(wrapped.message);
    }
  }
  return message;
}

/**
 * Classifica o conteúdo da mensagem e extrai texto/legenda e metadados de mídia.
 * Retorna null para mensagens que não devem ser exibidas (protocolo, reações...).
 */
export function extractContent(
  rawMessage: proto.IMessage | null | undefined,
): ExtractedContent | null {
  const message = unwrapMessage(rawMessage);
  if (!message) return null;

  if (message.conversation) {
    return {
      type: "text",
      content: message.conversation,
      mimeType: null,
      filename: null,
      hasMedia: false,
    };
  }
  if (message.extendedTextMessage?.text) {
    return {
      type: "text",
      content: message.extendedTextMessage.text,
      mimeType: null,
      filename: null,
      hasMedia: false,
    };
  }
  if (message.imageMessage) {
    return {
      type: "image",
      content: message.imageMessage.caption ?? null,
      mimeType: message.imageMessage.mimetype ?? "image/jpeg",
      filename: null,
      hasMedia: true,
    };
  }
  if (message.videoMessage) {
    return {
      type: "video",
      content: message.videoMessage.caption ?? null,
      mimeType: message.videoMessage.mimetype ?? "video/mp4",
      filename: null,
      hasMedia: true,
    };
  }
  if (message.audioMessage) {
    return {
      type: "audio",
      content: null,
      mimeType: message.audioMessage.mimetype ?? "audio/ogg",
      filename: null,
      hasMedia: true,
    };
  }
  if (message.documentMessage) {
    return {
      type: "document",
      content: message.documentMessage.caption ?? null,
      mimeType: message.documentMessage.mimetype ?? "application/octet-stream",
      filename: message.documentMessage.fileName ?? "documento",
      hasMedia: true,
    };
  }
  if (message.stickerMessage) {
    return {
      type: "sticker",
      content: null,
      mimeType: message.stickerMessage.mimetype ?? "image/webp",
      filename: null,
      hasMedia: true,
    };
  }
  if (message.locationMessage) {
    const { degreesLatitude, degreesLongitude, name } = message.locationMessage;
    const label = name ? `${name} — ` : "";
    return {
      type: "location",
      content: `${label}${degreesLatitude},${degreesLongitude}`,
      mimeType: null,
      filename: null,
      hasMedia: false,
    };
  }
  if (message.contactMessage) {
    return {
      type: "contact",
      content: message.contactMessage.displayName ?? "Contato",
      mimeType: null,
      filename: null,
      hasMedia: false,
    };
  }
  if (message.contactsArrayMessage) {
    return {
      type: "contact",
      content: message.contactsArrayMessage.displayName ?? "Contatos",
      mimeType: null,
      filename: null,
      hasMedia: false,
    };
  }
  const poll = message.pollCreationMessage ?? message.pollCreationMessageV3;
  if (poll) {
    return {
      type: "poll",
      content: poll.name ?? "Enquete",
      mimeType: null,
      filename: null,
      hasMedia: false,
      pollOptions: (poll.options ?? [])
        .map((option) => option.optionName ?? "")
        .filter((name) => name.length > 0),
    };
  }

  // Mensagens de protocolo, reações, enquetes etc. não entram na inbox.
  if (message.protocolMessage || message.reactionMessage) {
    return null;
  }

  return {
    type: "other",
    content: null,
    mimeType: null,
    filename: null,
    hasMedia: false,
  };
}

/** ID externo da mensagem citada (reply), quando houver. */
export function extractQuotedMessageId(
  rawMessage: proto.IMessage | null | undefined,
): string | null {
  const message = unwrapMessage(rawMessage);
  const contextInfo = message?.extendedTextMessage?.contextInfo
    ?? message?.imageMessage?.contextInfo
    ?? message?.videoMessage?.contextInfo
    ?? message?.audioMessage?.contextInfo
    ?? message?.documentMessage?.contextInfo;
  return contextInfo?.stanzaId ?? null;
}

export function directionFromKey(key: proto.IMessageKey | null | undefined): MessageDirection {
  return key?.fromMe ? "outbound" : "inbound";
}

/**
 * Identifica o remetente real da mensagem.
 * Em grupos o autor é `key.participant`; em conversas individuais é o
 * próprio chat (inbound) ou o número conectado (outbound).
 */
export function extractSender(
  key: proto.IMessageKey | null | undefined,
  ownJid: string | null,
): { senderExternalId: string | null; senderPhone: string | null } {
  // phoneFromJid retorna null para JIDs "@lid" — esses identificadores
  // internos não são telefone e não podem ser exibidos como tal.
  const remoteJid = key?.remoteJid ?? null;
  if (key?.fromMe) {
    return { senderExternalId: ownJid, senderPhone: phoneFromJid(ownJid) };
  }
  if (isGroupJid(remoteJid)) {
    const participant = key?.participant ?? null;
    return { senderExternalId: participant, senderPhone: phoneFromJid(participant) };
  }
  return { senderExternalId: remoteJid, senderPhone: phoneFromJid(remoteJid) };
}

/** Tipo estrutural compatível com Long (protobuf) sem depender do pacote "long". */
type LongLike = { toString(): string };

/** Converte o timestamp (segundos, número ou Long) do Baileys em Date. */
export function toDate(timestamp: number | LongLike | null | undefined): Date {
  if (timestamp == null) return new Date();
  const seconds = typeof timestamp === "number" ? timestamp : Number(timestamp.toString());
  if (!Number.isFinite(seconds) || seconds <= 0) return new Date();
  return new Date(seconds * 1000);
}

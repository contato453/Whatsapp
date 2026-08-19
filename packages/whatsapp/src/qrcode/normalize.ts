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
 * Remove o sufixo de aparelho de um JID ("...:51@lid" -> "...@lid"),
 * preservando o domínio.
 *
 * O ":51" identifica o dispositivo de quem ligou, não a pessoa — e os
 * cadastros (Contact, GroupParticipant, Conversation) guardam o JID sem
 * ele. Sem esta limpeza, a chamada de um segundo aparelho não casa com
 * nada do banco e ainda cria uma conversa duplicada para o mesmo contato.
 */
export function stripDeviceSuffix(jid: string): string {
  const [bare = "", domain] = jid.split("@");
  const user = bare.split(":")[0] ?? "";
  return domain ? `${user}@${domain}` : user;
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

/** O `contextInfo` do conteúdo, onde quer que ele esteja. */
function contextInfoOf(rawMessage: proto.IMessage | null | undefined) {
  const message = unwrapMessage(rawMessage);
  return (
    message?.extendedTextMessage?.contextInfo
    ?? message?.imageMessage?.contextInfo
    ?? message?.videoMessage?.contextInfo
    ?? message?.audioMessage?.contextInfo
    ?? message?.documentMessage?.contextInfo
    ?? null
  );
}

/** ID externo da mensagem citada (reply), quando houver. */
export function extractQuotedMessageId(
  rawMessage: proto.IMessage | null | undefined,
): string | null {
  return contextInfoOf(rawMessage)?.stanzaId ?? null;
}

/**
 * Quem a mensagem marcou.
 *
 * A marcação NÃO está no texto: o "@5511..." escrito na frase é só o que o
 * aplicativo destaca. Quem foi de fato notificado está no
 * `contextInfo.mentionedJid` — e é dele que a Inbox precisa para trocar o
 * número pelo nome do participante ao exibir a mensagem recebida.
 */
export function extractMentionedJids(
  rawMessage: proto.IMessage | null | undefined,
): string[] {
  const mentioned = contextInfoOf(rawMessage)?.mentionedJid ?? [];
  return mentioned.filter(
    (jid): jid is string => typeof jid === "string" && jid.length > 0 && !isIgnorableJid(jid),
  );
}

export function directionFromKey(key: proto.IMessageKey | null | undefined): MessageDirection {
  return key?.fromMe ? "outbound" : "inbound";
}

/**
 * Campos que o Baileys acrescenta à chave da mensagem além do protobuf.
 *
 * Quando o chat usa endereçamento anônimo, o WhatsApp manda o telefone de
 * verdade num atributo separado (`participant_pn` em grupos, `sender_pn`
 * em conversas individuais). É a única fonte confiável do número nesses
 * casos — os dígitos do "@lid" não são telefone.
 */
interface MessageKeyExtras {
  participantPn?: string | null;
  senderPn?: string | null;
}

/**
 * Identifica o remetente real da mensagem.
 * Em grupos o autor é `key.participant`; em conversas individuais é o
 * próprio chat (inbound) ou o número conectado (outbound).
 *
 * O identificador retornado é sempre o que o WhatsApp usa para endereçar
 * (podendo ser um "@lid"), porque é por ele que participantes e reações
 * são relacionados. O telefone é resolvido à parte.
 */
export function extractSender(
  key: proto.IMessageKey | null | undefined,
  ownJid: string | null,
): { senderExternalId: string | null; senderPhone: string | null } {
  const extras = (key ?? {}) as MessageKeyExtras;
  const remoteJid = key?.remoteJid ?? null;
  if (key?.fromMe) {
    return { senderExternalId: ownJid, senderPhone: phoneFromJid(ownJid) };
  }
  if (isGroupJid(remoteJid)) {
    const participant = key?.participant ?? null;
    return {
      senderExternalId: participant,
      senderPhone: phoneFromJid(participant) ?? phoneFromJid(extras.participantPn),
    };
  }
  return {
    senderExternalId: remoteJid,
    senderPhone: phoneFromJid(remoteJid) ?? phoneFromJid(extras.senderPn),
  };
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

/**
 * Valores de `proto.Message.ProtocolMessage.Type` que nos interessam.
 * Ficam como constante local para este módulo continuar puro (e testável
 * sem abrir socket): importar o enum do Baileys só para comparar dois
 * números traria a biblioteca inteira para dentro das funções de
 * normalização.
 */
const PROTOCOL_TYPE_REVOKE = 0;
const PROTOCOL_TYPE_MESSAGE_EDIT = 14;

/** O que um pacote de protocolo pede que façamos com uma mensagem JÁ existente. */
export interface ProtocolAction {
  kind: "revoke" | "edit";
  /** Id da mensagem ORIGINAL — a que precisa ser atualizada. */
  targetExternalMessageId: string;
  /** Texto ou legenda novos. Só em "edit". */
  newContent: string | null;
  /** Momento da edição informado pelo WhatsApp, quando ele manda. */
  editedAt: Date | null;
}

/**
 * Procura o `protocolMessage` DESEMBRULHANDO os invólucros à prova de
 * futuro no caminho.
 *
 * Editar e apagar não chegam como mensagem: chegam como pacote de
 * protocolo, e o aparelho do cliente costuma embrulhá-lo em
 * `editedMessage` (às vezes com um `message` no meio, às vezes sem). Ler
 * `message.protocolMessage` direto, sem desembrulhar, é o que fazia a
 * edição escapar do teste, cair no classificador de conteúdo e virar
 * mensagem nova do tipo "other" — a bolha "Mídia indisponível".
 */
function findProtocolMessage(
  rawMessage: proto.IMessage | null | undefined,
  depth = 0,
): proto.Message.IProtocolMessage | null {
  if (!rawMessage || depth > 5) return null;
  const message = rawMessage as Record<string, unknown>;
  const direct = message.protocolMessage as proto.Message.IProtocolMessage | undefined;
  if (direct) return direct;
  const wrappers = [
    "editedMessage",
    "ephemeralMessage",
    "viewOnceMessage",
    "viewOnceMessageV2",
    "viewOnceMessageV2Extension",
    "documentWithCaptionMessage",
  ] as const;
  for (const key of wrappers) {
    const wrapped = message[key] as { message?: proto.IMessage } | undefined;
    if (!wrapped) continue;
    // O invólucro pode trazer o conteúdo em `.message` ou já ser ele
    // próprio o conteúdo — as duas formas aparecem conforme a versão do
    // aplicativo, e recusar uma delas é perder a edição em silêncio.
    const inner = wrapped.message ?? (wrapped as proto.IMessage);
    const found = findProtocolMessage(inner, depth + 1);
    if (found) return found;
  }
  return null;
}

/**
 * Traduz um pacote de protocolo em ação sobre a mensagem original.
 * Devolve null para todo o resto (troca de chave, ajuste de efêmera,
 * sincronização), que não tem o que atualizar na Inbox.
 */
export function extractProtocolAction(
  rawMessage: proto.IMessage | null | undefined,
): ProtocolAction | null {
  const protocolMessage = findProtocolMessage(rawMessage);
  const targetExternalMessageId = protocolMessage?.key?.id;
  if (!protocolMessage || !targetExternalMessageId) return null;

  if (protocolMessage.type === PROTOCOL_TYPE_REVOKE) {
    return { kind: "revoke", targetExternalMessageId, newContent: null, editedAt: null };
  }

  // O tipo é conferido, mas a presença do conteúdo novo também vale por
  // si: versões diferentes do aplicativo já mandaram edição com outro
  // código, e recusá-la por causa do número deixaria o texto velho na tela.
  const edited = protocolMessage.editedMessage;
  if (protocolMessage.type === PROTOCOL_TYPE_MESSAGE_EDIT || edited) {
    return {
      kind: "edit",
      targetExternalMessageId,
      // Aqui o conteúdo novo JÁ está desembrulhado (veio de dentro do
      // protocolMessage), então classifica direto.
      newContent: extractContent(edited)?.content ?? null,
      editedAt: protocolMessage.timestampMs ? toEditDate(protocolMessage.timestampMs) : null,
    };
  }
  return null;
}

/**
 * Texto novo de uma edição entregue pelo `messages.update` do Baileys — do
 * texto puro ou da legenda da mídia. A edição do WhatsApp substitui a
 * mensagem inteira, então o conteúdo novo vem como uma mensagem completa;
 * aqui só nos interessa a parte escrita, porque o arquivo em si não muda.
 *
 * O envelope `editedMessage` é EXIGIDO de propósito. Aquele mesmo evento
 * também carrega a mensagem inteira em outras situações (o reenvio de
 * mídia, por exemplo), e aceitar qualquer conteúdo faria a legenda de uma
 * foto reaparecer como "edição" que ninguém fez.
 */
export function extractEditedContent(
  rawMessage: proto.IMessage | null | undefined,
): string | null {
  const envelope = (rawMessage as Record<string, unknown> | null | undefined)?.editedMessage as
    | { message?: proto.IMessage }
    | undefined;
  if (!envelope) return null;
  const inner = envelope.message ?? (envelope as proto.IMessage);
  return extractContent(inner)?.content ?? null;
}

/** Converte o `timestampMs` do pacote (número, string ou Long) em data. */
function toEditDate(value: number | string | { toString(): string }): Date | null {
  const millis = typeof value === "number" ? value : Number(value.toString());
  if (!Number.isFinite(millis) || millis <= 0) return null;
  return new Date(millis);
}

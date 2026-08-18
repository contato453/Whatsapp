import type { PrismaClient } from "@azvchat/database";
import type { QuotedPreview } from "./serialize.js";
import { resolveSenders } from "./sender-directory.js";

/**
 * Pré-visualização da mensagem citada (reply), em duas camadas:
 *
 * 1. a original está no banco → prévia completa, com id e timestamp para a
 *    tela navegar até ela;
 * 2. a original NÃO está (anterior à sincronização, enviada por outro canal)
 *    → prévia montada do resumo que a ingestão gravou em `metadata.quoted`,
 *    vindo do próprio payload do WhatsApp, sem navegação.
 *
 * A citação nunca é descartada por falta da original — era exatamente esse
 * descarte silencioso que fazia respostas aparecerem "soltas" na Inbox.
 */

/** Escopo mínimo da conversa para resolver nomes dos citados. */
export interface QuotedConversationScope {
  id: string;
  whatsappInstanceId: string;
  externalChatId: string;
  type: string;
}

/** Forma do resumo gravado em `Message.metadata.quoted` pela ingestão. */
interface QuotedMetadata {
  participantExternalId: string | null;
  fromMe: boolean;
  type: string;
  content: string | null;
}

/** Lê o resumo do Json com tolerância — metadado antigo pode não ter o campo. */
function quotedMetadataOf(metadata: unknown): QuotedMetadata | null {
  if (!metadata || typeof metadata !== "object") return null;
  const quoted = (metadata as { quoted?: unknown }).quoted;
  if (!quoted || typeof quoted !== "object") return null;
  const value = quoted as Partial<QuotedMetadata>;
  return {
    participantExternalId:
      typeof value.participantExternalId === "string" ? value.participantExternalId : null,
    fromMe: value.fromMe === true,
    type: typeof value.type === "string" ? value.type : "other",
    content: typeof value.content === "string" ? value.content : null,
  };
}

/**
 * Dígitos de um JID de telefone. Só "@s.whatsapp.net" é telefone — "@lid" é
 * identificador interno e nunca deve ser exibido como número.
 */
function phoneDigitsFromJid(jid: string | null): string | null {
  if (!jid || !jid.endsWith("@s.whatsapp.net")) return null;
  const digits = (jid.split("@")[0] ?? "").split(":")[0]?.replace(/\D/g, "") ?? "";
  return digits.length > 0 ? digits : null;
}

/** Prévia a partir da mensagem original persistida. */
export function previewFromMessage(original: {
  id: string;
  senderName: string | null;
  senderPhone: string | null;
  content: string | null;
  type: string;
  direction: string;
  timestamp: Date;
}): QuotedPreview {
  return {
    id: original.id,
    senderName:
      original.direction === "outbound"
        ? (original.senderName ?? "Você")
        : (original.senderName ?? original.senderPhone),
    content: original.content,
    type: original.type,
    timestamp: original.timestamp.toISOString(),
  };
}

/**
 * Resolve as citações de um lote de mensagens: duas consultas no total
 * (originais + nomes dos citados ausentes), nunca uma por mensagem.
 * O mapa é chaveado pelo id externo da mensagem citada.
 */
export async function loadQuotedPreviews(
  prisma: PrismaClient,
  conversation: QuotedConversationScope,
  messages: Array<{ quotedMessageId: string | null; metadata: unknown }>,
): Promise<Map<string, QuotedPreview>> {
  const quoting = messages.filter(
    (message): message is { quotedMessageId: string; metadata: unknown } =>
      !!message.quotedMessageId,
  );
  if (quoting.length === 0) return new Map();

  const ids = [...new Set(quoting.map((message) => message.quotedMessageId))];
  const originals = await prisma.message.findMany({
    where: { conversationId: conversation.id, externalMessageId: { in: ids } },
    select: {
      id: true,
      externalMessageId: true,
      senderName: true,
      senderPhone: true,
      content: true,
      type: true,
      direction: true,
      timestamp: true,
    },
  });
  const map = new Map(
    originals.map((original) => [
      original.externalMessageId as string,
      previewFromMessage(original),
    ]),
  );

  // Original fora do banco: cai para o resumo do payload.
  const fallbacks = quoting
    .filter((message) => !map.has(message.quotedMessageId))
    .map((message) => ({
      externalId: message.quotedMessageId,
      quoted: quotedMetadataOf(message.metadata),
    }))
    .filter((entry): entry is { externalId: string; quoted: QuotedMetadata } => !!entry.quoted);
  if (fallbacks.length === 0) return map;

  // Nome de quem foi citado, pelo mesmo diretório usado para o remetente —
  // o payload traz só o JID, e JID cru não é nome de gente.
  const senders = await resolveSenders(
    prisma,
    conversation,
    fallbacks.map((entry) => entry.quoted.participantExternalId),
  );
  for (const { externalId, quoted } of fallbacks) {
    if (map.has(externalId)) continue;
    const info = quoted.participantExternalId
      ? senders.get(quoted.participantExternalId)
      : undefined;
    map.set(externalId, {
      // Sem id nem timestamp: a original não está no banco, não há para onde navegar.
      id: null,
      senderName: quoted.fromMe
        ? "Você"
        : (info?.name ??
          info?.phoneNumber ??
          phoneDigitsFromJid(quoted.participantExternalId)),
      content: quoted.content,
      type: quoted.type,
      timestamp: null,
    });
  }
  return map;
}

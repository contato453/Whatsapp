/**
 * Resumo da mensagem citada (reply), gravado JUNTO com a resposta.
 *
 * A referência (`Message.quotedMessageId`, o id externo da original) sozinha
 * só desenha o bloco quando a original está no banco — e resposta a mensagem
 * anterior à conexão do número chegava sem bloco nenhum, descartada em
 * silêncio. O resumo (autor, trecho, tipo) é congelado no momento da
 * gravação, então o bloco aparece SEMPRE; quando a original existe, a leitura
 * ao vivo continua preferida (nome corrigido pela equipe, clique navega).
 *
 * Ele mora em `Message.metadata`, e não em coluna nova, pelo mesmo motivo do
 * histórico de versões: é dado de exibição de um caso minoritário, e o
 * `metadata` já viaja inteiro no DTO e nos eventos de tempo real — o resumo
 * chega à tela sem ampliar contrato nenhum.
 */

export const MESSAGE_QUOTE_METADATA_KEY = "quoted";

export interface QuotedSnapshot {
  /**
   * Id LOCAL da mensagem original, quando ela era conhecida no momento da
   * gravação — é ele que permite o clique navegar até a original. Nulo
   * quando a original nunca esteve no banco (histórico anterior à conexão):
   * o bloco aparece do mesmo jeito, só sem navegação.
   */
  id: string | null;
  senderName: string | null;
  /** Texto ou legenda da original. Nulo em mídia sem legenda. */
  content: string | null;
  type: string;
}

/**
 * Rótulo exibido no bloco de citação quando a original não tem texto —
 * citar um áudio precisa dizer "Áudio", nunca aparecer vazio.
 */
export const QUOTED_TYPE_LABELS: Record<string, string> = {
  image: "📷 Imagem",
  audio: "🎤 Áudio",
  video: "🎬 Vídeo",
  document: "📄 Documento",
  sticker: "🩵 Figurinha",
  location: "📍 Localização",
  contact: "👤 Contato",
  poll: "📊 Enquete",
  call: "📞 Ligação",
};

/** O que o bloco de citação mostra: o trecho, ou o tipo quando não há texto. */
export function quotedPreviewText(content: string | null, type: string): string {
  if (content) return content;
  return QUOTED_TYPE_LABELS[type] ?? "Mensagem";
}

/**
 * Nome exibido como autor da citação, a partir da mensagem original. A
 * mesma régua vale para a leitura ao vivo e para o resumo congelado — duas
 * réguas fariam o mesmo bloco trocar de nome entre o envio e o reload.
 */
export function quotedSenderLabel(original: {
  direction: string;
  senderName: string | null;
  senderPhone: string | null;
}): string | null {
  return original.direction === "outbound"
    ? (original.senderName ?? "Você")
    : (original.senderName ?? original.senderPhone);
}

/** Lê o resumo gravado no `metadata`, tolerando lixo e ausência. */
export function readQuotedSnapshot(metadata: unknown): QuotedSnapshot | null {
  if (!metadata || typeof metadata !== "object") return null;
  const raw = (metadata as Record<string, unknown>)[MESSAGE_QUOTE_METADATA_KEY];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const { id, senderName, content, type } = raw as {
    id?: unknown;
    senderName?: unknown;
    content?: unknown;
    type?: unknown;
  };
  if (typeof type !== "string") return null;
  return {
    id: typeof id === "string" ? id : null,
    senderName: typeof senderName === "string" ? senderName : null,
    content: typeof content === "string" ? content : null,
    type,
  };
}

/**
 * Grava o resumo preservando o resto do `metadata` — as marcações do "@" e
 * o histórico de versões moram no mesmo objeto e não podem ser perdidos.
 */
export function withQuotedSnapshot(
  metadata: unknown,
  snapshot: QuotedSnapshot,
): Record<string, unknown> {
  const base =
    metadata && typeof metadata === "object" && !Array.isArray(metadata)
      ? { ...(metadata as Record<string, unknown>) }
      : {};
  base[MESSAGE_QUOTE_METADATA_KEY] = { ...snapshot };
  return base;
}

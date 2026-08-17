/**
 * Regras do arquivo que a equipe anexa a uma conversa — as mesmas nas duas
 * pontas.
 *
 * Vive no shared porque a API decide o tipo da mensagem pelo mime type na
 * hora do envio e a tela precisa decidir a MESMA coisa antes de subir o
 * primeiro byte: miniatura ou ícone, e o que já pode ser recusado na prévia.
 * Régua duplicada aqui significaria arquivo aceito na tela e recusado no
 * servidor (ou pior, o contrário).
 */

/**
 * Tipo com que a mídia enviada é gravada. Não é o `MessageType` inteiro:
 * figurinha é decisão explícita de quem envia (não sai do mime type) e
 * localização, contato e enquete não são arquivo.
 */
export const OUTBOUND_MEDIA_TYPES = ["image", "audio", "video", "document"] as const;
export type OutboundMediaType = (typeof OUTBOUND_MEDIA_TYPES)[number];

export const OUTBOUND_MEDIA_TYPE_LABELS: Record<OutboundMediaType, string> = {
  image: "Imagem",
  audio: "Áudio",
  video: "Vídeo",
  document: "Documento",
};

/**
 * O que não é imagem, áudio nem vídeo vira documento — nenhum arquivo é
 * recusado por tipo. Boleto em PDF, planilha e XML de nota são metade do que
 * o escritório manda, e o WhatsApp aceita todos como documento.
 */
export function outboundMediaTypeFromMime(mimeType: string | null | undefined): OutboundMediaType {
  // "audio/ogg; codecs=opus" precisa contar como áudio: só a base decide.
  const base = (mimeType ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
  if (base.startsWith("image/")) return "image";
  if (base.startsWith("audio/")) return "audio";
  if (base.startsWith("video/")) return "video";
  return "document";
}

/**
 * Teto de tamanho por arquivo. É o padrão de `MEDIA_MAX_SIZE` na API — a
 * fonte única do número está aqui, e o `.env` da VPS pode apertar ou soltar
 * o valor real. A tela usa este padrão para barrar antes do upload: subir 40
 * MB para ouvir "arquivo muito grande" no fim é o que se quer evitar.
 */
export const DEFAULT_MEDIA_MAX_SIZE = 25 * 1024 * 1024;

/**
 * Quantos arquivos a prévia aceita de uma vez. Não é limite do WhatsApp nem
 * da API: é o ponto em que gerar miniatura de tudo travaria a tela e a
 * pessoa perderia a noção do que está mandando. Cada arquivo continua sendo
 * uma mensagem, então dez de uma vez já são dez mensagens no chat do cliente.
 */
export const ATTACHMENT_MAX_FILES = 10;

/** Motivo pelo qual um arquivo não entra na prévia. */
export type AttachmentRejectionReason = "folder" | "empty" | "too_large";

/**
 * Decide se o arquivo entra, sem tocar no conteúdo dele. Pasta é recusada
 * por não ser arquivo (percorrer diretório é outra conversa: o atendente
 * acha que mandou uma pasta e o cliente recebe trinta mensagens), e o
 * tamanho zero cobre o atalho quebrado e o arquivo que o sistema de origem
 * não terminou de escrever.
 */
export function attachmentRejection(
  file: { size: number; isFolder?: boolean },
  maxSize: number = DEFAULT_MEDIA_MAX_SIZE,
): AttachmentRejectionReason | null {
  if (file.isFolder) return "folder";
  if (file.size <= 0) return "empty";
  if (file.size > maxSize) return "too_large";
  return null;
}

/** Bytes em texto curto de tela: "0 KB", "1,4 MB", "25 MB". */
export function formatFileSize(bytes: number): string {
  if (bytes <= 0) return "0 KB";
  if (bytes < 1024) return `${bytes} B`;
  const kilobytes = bytes / 1024;
  if (kilobytes < 1024) return `${Math.round(kilobytes)} KB`;
  const megabytes = kilobytes / 1024;
  // Uma casa até 10 MB: "1,4 MB" ajuda a decidir, "9,8 MB" também; acima
  // disso a casa decimal é ruído.
  return megabytes < 10
    ? `${megabytes.toFixed(1).replace(".", ",")} MB`
    : `${Math.round(megabytes)} MB`;
}

/** Mensagem da recusa, com o limite em números — "não permitido" sozinho não ajuda. */
export function attachmentRejectionMessage(
  name: string,
  reason: AttachmentRejectionReason,
  options: { size?: number; maxSize?: number } = {},
): string {
  const maxSize = options.maxSize ?? DEFAULT_MEDIA_MAX_SIZE;
  const label = name.trim().length > 0 ? `“${name}”` : "O item arrastado";
  switch (reason) {
    case "folder":
      return `${label} é uma pasta. Arraste os arquivos de dentro dela, um a um ou vários juntos.`;
    case "empty":
      return `${label} está vazio (0 KB) e não pode ser enviado.`;
    case "too_large":
      return `${label} tem ${formatFileSize(options.size ?? 0)} e o limite por arquivo é ${formatFileSize(maxSize)}.`;
  }
}

/** Aviso de quando o arrasto passa do teto de arquivos. */
export function tooManyAttachmentsMessage(ignored: number, maxFiles = ATTACHMENT_MAX_FILES): string {
  return ignored === 1
    ? `Só dá para enviar ${maxFiles} arquivos por vez — 1 ficou de fora.`
    : `Só dá para enviar ${maxFiles} arquivos por vez — ${ignored} ficaram de fora.`;
}

/**
 * Extensão para nome gerado. Mapa curto de propósito: só os formatos que
 * saem da área de transferência sem nome de verdade. Não se confunde com o
 * `extensionFromMime` da API, que decide como o arquivo é guardado no disco.
 */
const EXTENSION_BY_MIME: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/bmp": "bmp",
  "image/svg+xml": "svg",
  "video/mp4": "mp4",
  "video/webm": "webm",
  "video/quicktime": "mov",
  "audio/mpeg": "mp3",
  "audio/ogg": "ogg",
  "audio/wav": "wav",
  "audio/webm": "webm",
  "application/pdf": "pdf",
};

const NAME_PREFIX_BY_TYPE: Record<OutboundMediaType, string> = {
  image: "imagem",
  audio: "audio",
  video: "video",
  document: "arquivo",
};

/**
 * Nome legível para o que vem da área de transferência: print de tela chega
 * como "image.png" (ou sem nome nenhum), e é esse nome que a equipe vai ver
 * na Inbox e no disco do cliente. Data e hora respondem "qual dos três
 * prints é este?"; id de mensagem ou número aleatório não responderiam nada.
 */
export function generatedAttachmentName(
  mimeType: string | null | undefined,
  at: Date,
  extensionFallback?: string,
): string {
  const base = (mimeType ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
  const extension = EXTENSION_BY_MIME[base] ?? extensionFallback ?? base.split("/")[1] ?? "bin";
  const pad = (value: number) => String(value).padStart(2, "0");
  const stamp = [
    at.getFullYear(),
    pad(at.getMonth() + 1),
    pad(at.getDate()),
    pad(at.getHours()),
    pad(at.getMinutes()),
  ].join("-");
  return `${NAME_PREFIX_BY_TYPE[outboundMediaTypeFromMime(base)]}-${stamp}.${extension}`;
}

/**
 * Nomes que o navegador inventa para conteúdo colado. Só eles são trocados
 * pelo nome gerado: arquivo copiado do explorador de arquivos chega com o
 * nome de verdade, e renomear "Guia DAS 08-2026.pdf" seria perder informação.
 */
const GENERIC_NAMES = new Set([
  "",
  "image",
  "imagem",
  "blob",
  "unknown",
  "untitled",
  "screenshot",
  "captura",
  "clipboard",
  "download",
]);

export function isGenericAttachmentName(name: string | null | undefined): boolean {
  const trimmed = (name ?? "").trim().toLowerCase();
  if (trimmed.length === 0) return true;
  const withoutExtension = trimmed.includes(".")
    ? trimmed.slice(0, trimmed.lastIndexOf("."))
    : trimmed;
  return GENERIC_NAMES.has(withoutExtension);
}

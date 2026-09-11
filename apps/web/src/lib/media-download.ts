"use client";

import { callsApi, fetchAudioMp3BlobUrl, fetchAuthedBlobUrl, fetchMediaBlobUrl } from "./api";
import type { CallLogDto, MessageDto } from "./types";

/**
 * Download de mídia de mensagem — caminho único usado pela bolha de documento
 * e pela lightbox.
 *
 * Um `<a href>` comum apontando para a API não serve: a rota de mídia exige o
 * header Authorization, que link não envia. O arquivo vem pelo fetch
 * autenticado já existente (`fetchMediaBlobUrl`) e só então o salvamento é
 * disparado no navegador, com a URL de blob revogada em seguida.
 */

/** Extensões dos tipos que mais chegam, para nomear arquivo sem nome original. */
const EXTENSION_BY_MIME: Record<string, string> = {
  "application/pdf": "pdf",
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
  "video/mp4": "mp4",
  "video/3gpp": "3gp",
  "audio/ogg": "ogg",
  "audio/mpeg": "mp3",
  "audio/mp4": "m4a",
  "text/plain": "txt",
};

const TYPE_BASE_NAME: Record<MessageDto["type"], string> = {
  text: "arquivo",
  image: "imagem",
  audio: "audio",
  video: "video",
  document: "documento",
  sticker: "figurinha",
  location: "arquivo",
  contact: "arquivo",
  poll: "arquivo",
  call: "arquivo",
  other: "arquivo",
};

/**
 * Rótulo curto do tipo de documento, para a bolha. Tamanho não existe no
 * banco (a ingestão não o grava), então a bolha mostra só o que há: nome e
 * tipo. Mime desconhecido sai cru — é o que existe, sem inventar.
 */
const DOCUMENT_KIND_LABELS: Record<string, string> = {
  "application/pdf": "PDF",
  "application/msword": "Word",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "Word",
  "application/vnd.ms-excel": "Excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "Excel",
  "application/vnd.ms-powerpoint": "PowerPoint",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": "PowerPoint",
  "text/plain": "Texto",
  "text/csv": "CSV",
  "application/zip": "ZIP",
  "application/x-rar-compressed": "RAR",
  "application/xml": "XML",
  "text/xml": "XML",
  "application/json": "JSON",
};

export function documentKindLabel(mimeType: string | null): string | null {
  if (!mimeType) return null;
  return DOCUMENT_KIND_LABELS[mimeType] ?? mimeType;
}

/**
 * Nome do arquivo salvo: o original quando existir; sem ele, um nome legível
 * por tipo e data — nunca o id cru da mensagem.
 */
export function mediaDownloadName(message: Pick<MessageDto, "filename" | "type" | "mimeType" | "timestamp">): string {
  if (message.filename) return message.filename;
  const date = new Date(message.timestamp);
  const stamp = Number.isNaN(date.getTime())
    ? "sem-data"
    : `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  const base = `${TYPE_BASE_NAME[message.type]}-${stamp}`;
  if (!message.mimeType) return base;
  const known = EXTENSION_BY_MIME[message.mimeType];
  // Subtipo simples e curto serve de extensão; "vnd.…" longo só sujaria o nome.
  const subtype = message.mimeType.split("/")[1]?.split(";")[0];
  const extension = known ?? (subtype && subtype.length <= 4 && !subtype.includes(".") ? subtype : null);
  return extension ? `${base}.${extension}` : base;
}

/** Baixa a mídia autenticada e dispara o salvamento no navegador. */
export async function downloadMessageMedia(message: MessageDto): Promise<void> {
  const blobUrl = await fetchMediaBlobUrl(message.id);
  triggerBlobDownload(blobUrl, mediaDownloadName(message));
  // A revogação espera o navegador terminar de ler o blob; revogar na hora
  // cancelaria downloads de arquivo grande.
  setTimeout(() => URL.revokeObjectURL(blobUrl), 10_000);
}

/** Salva um blob já carregado — a lightbox reusa o que está na tela. */
export function triggerBlobDownload(blobUrl: string, filename: string): void {
  const anchor = document.createElement("a");
  anchor.href = blobUrl;
  anchor.download = filename;
  anchor.click();
}

/**
 * Higieniza um texto para virar parte de nome de arquivo: sem acento, sem
 * barra, sem dois pontos e sem espaço. Windows recusa vários desses
 * caracteres, e barra no meio do nome vira diretório no Mac e no Linux — o
 * salvamento falharia, ou salvaria em lugar nenhum.
 */
function nomeSeguroDeArquivo(valor: string | null | undefined, padrao: string): string {
  const limpo = (valor ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "") // remove acentos
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase()
    // Nome de grupo é longo e o resto (data, hora, extensão) precisa caber.
    .slice(0, 60)
    .replace(/-+$/g, "");
  return limpo || padrao;
}

/** `2026-09-02-14-32` — data e hora locais, já prontas para nome de arquivo. */
function estampaDeDataHora(timestamp: string): string {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return "sem-data";
  const p = (valor: number) => String(valor).padStart(2, "0");
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}-${p(date.getHours())}-${p(date.getMinutes())}`;
}

/** Formatos em que o áudio da conversa pode ser baixado. */
export type AudioDownloadFormat = "mp3" | "original";

/**
 * Extensão do arquivo original do áudio, pelo mime type da mensagem. O áudio do
 * WhatsApp chega como "audio/ogg; codecs=opus", então o parâmetro do mime
 * precisa sair antes da busca. Sem mime conhecido sobra `ogg`, que é o que o
 * WhatsApp entrega na esmagadora maioria dos casos.
 */
export function audioOriginalExtension(mimeType: string | null): string {
  const limpo = mimeType?.split(";")[0]?.trim() ?? "";
  const conhecida = EXTENSION_BY_MIME[limpo];
  if (conhecida) return conhecida;
  const subtipo = limpo.split("/")[1];
  return subtipo && subtipo.length <= 4 && !subtipo.includes(".") ? subtipo : "ogg";
}

/**
 * Nome do arquivo de áudio baixado: `audio-nome-da-conversa-2026-09-02-14-32.mp3`.
 *
 * O nome da conversa entra porque a equipe baixa o áudio para anexar em e-mail
 * ou em processo, e um arquivo chamado pelo id da mensagem obrigaria a renomear
 * tudo à mão depois. A data e a hora separam os vários áudios do mesmo cliente.
 */
export function audioDownloadName(
  message: Pick<MessageDto, "timestamp" | "mimeType">,
  conversationTitle: string | null,
  format: AudioDownloadFormat,
): string {
  const extensao = format === "mp3" ? "mp3" : audioOriginalExtension(message.mimeType);
  return `audio-${nomeSeguroDeArquivo(conversationTitle, "conversa")}-${estampaDeDataHora(message.timestamp)}.${extensao}`;
}

/**
 * Baixa o áudio de uma mensagem e dispara o salvamento no navegador.
 *
 * MP3 É O PADRÃO porque o WhatsApp entrega áudio em OGG com Opus, e no Windows
 * o duplo clique nesse arquivo costuma não tocar: quem baixa está anexando o
 * áudio num e-mail ou num processo, e arquivo que o destinatário não abre não
 * serve de comprovante. A conversão é da API (e é guardada lá, para o segundo
 * download não convertê-lo de novo); o original fica no menu secundário, para
 * quem precisa exatamente do arquivo que o cliente mandou.
 *
 * A mídia NUNCA pode ser apontada direto por `href`: a rota exige o header
 * Authorization, que link comum não envia, e expor o arquivo sem autenticação
 * para facilitar entregaria áudio de cliente a quem tivesse a URL.
 */
export async function downloadMessageAudio(
  message: MessageDto,
  conversationTitle: string | null,
  format: AudioDownloadFormat,
): Promise<void> {
  const blobUrl =
    format === "mp3" ? await fetchAudioMp3BlobUrl(message.id) : await fetchMediaBlobUrl(message.id);
  triggerBlobDownload(blobUrl, audioDownloadName(message, conversationTitle, format));
  // Mesma folga dos outros downloads: o navegador precisa ler o blob antes da
  // revogação, e sem revogar a memória da aba cresce a cada áudio baixado.
  setTimeout(() => URL.revokeObjectURL(blobUrl), 10_000);
}

/**
 * Nome do arquivo da gravação de ligação: quem ligou (ou o telefone, sem
 * nome conhecido) + a data, sempre `.mp3` — a rota do AstraCalls é fixa em
 * `/recordings/{id}.mp3`, não há outro formato a considerar.
 */
export function callRecordingDownloadName(
  call: Pick<CallLogDto, "contactName" | "contactPhone" | "timestamp">,
): string {
  const date = new Date(call.timestamp);
  const stamp = Number.isNaN(date.getTime())
    ? "sem-data"
    : `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  return `ligacao-${nomeSeguroDeArquivo(call.contactName ?? call.contactPhone, "contato")}-${stamp}.mp3`;
}

/**
 * Baixa a gravação de uma ligação e dispara o salvamento no navegador. Mesmo
 * caminho autenticado do player (`fetchAuthedBlobUrl`) — a rota exige
 * Authorization, que um `<a href>` direto não envia.
 */
export async function downloadCallRecording(call: CallLogDto): Promise<void> {
  const blobUrl = await fetchAuthedBlobUrl(callsApi.recordingPath(call.id));
  triggerBlobDownload(blobUrl, callRecordingDownloadName(call));
  // Mesma folga do download de mídia de mensagem: dá tempo do navegador ler
  // o blob antes de revogar a URL.
  setTimeout(() => URL.revokeObjectURL(blobUrl), 10_000);
}

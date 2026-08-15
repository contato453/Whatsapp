"use client";

import { fetchMediaBlobUrl } from "./api";
import type { MessageDto } from "./types";

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

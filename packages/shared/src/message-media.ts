/**
 * Marca de "a mídia desta mensagem não foi baixada/guardada", no
 * `metadata`.
 *
 * Falha no download (o WhatsApp ainda não liberou o arquivo, um tropeço de
 * rede) ou no storage (disco cheio, permissão) não pode derrubar a
 * mensagem inteira — o texto/legenda que o cliente escreveu não pode se
 * perder por causa do anexo. A mensagem entra sem `mediaUrl`, com esta
 * marca, para a equipe achar depois o que ficou sem arquivo e reprocessar
 * (a fila de retentativa em si é item futuro — ver o CLAUDE.md, seção 14).
 */
export const MEDIA_DOWNLOAD_FAILED_METADATA_KEY = "mediaDownloadFailed";

export function isMediaDownloadFailed(metadata: unknown): boolean {
  if (!metadata || typeof metadata !== "object") return false;
  return (metadata as Record<string, unknown>)[MEDIA_DOWNLOAD_FAILED_METADATA_KEY] === true;
}

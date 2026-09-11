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

/**
 * Chave do storage do MP3 já convertido deste áudio, no `metadata`.
 *
 * Existe para o mesmo áudio não ser convertido a cada download: a equipe baixa
 * o comprovante, anexa no e-mail, o cliente cobra de novo e alguém baixa outra
 * vez. Converter é processo de ffmpeg e CPU da VPS; guardar a chave custa uma
 * linha de `metadata` que já viaja inteira no DTO.
 *
 * É chave de storage, não URL: só a rota autenticada de mídia sabe o que fazer
 * com ela, e quem não enxerga a conversa não chega nela de jeito nenhum.
 */
export const AUDIO_MP3_METADATA_KEY = "audioMp3Url";

export function readAudioMp3Key(metadata: unknown): string | null {
  if (!metadata || typeof metadata !== "object") return null;
  const value = (metadata as Record<string, unknown>)[AUDIO_MP3_METADATA_KEY];
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * Grava a chave PRESERVANDO o resto do `metadata`. O mesmo objeto guarda as
 * marcações do "@", o histórico de versões e o resumo da citação: um spread
 * descuidado aqui apagaria qualquer um deles.
 */
export function withAudioMp3Key(metadata: unknown, key: string): Record<string, unknown> {
  const base =
    metadata && typeof metadata === "object" ? { ...(metadata as Record<string, unknown>) } : {};
  base[AUDIO_MP3_METADATA_KEY] = key;
  return base;
}

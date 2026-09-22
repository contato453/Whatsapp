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

/**
 * TRANSCRIÇÃO DO ÁUDIO RECEBIDO, no `metadata` da mensagem.
 *
 * Existe porque a IA não ouve arquivo: o áudio do cliente vira TEXTO antes de
 * chegar ao modelo (ver `apps/api/src/services/ai/transcription.ts`). A
 * transcrição é guardada aqui, e não recalculada a cada turno, por três
 * motivos que valem para qualquer mexida: (1) cada transcrição é uma chamada
 * PAGA ao provedor, e o mesmo áudio entra no contexto de vários turnos
 * seguidos — transcrever a cada volta multiplicaria a conta pelo tamanho do
 * histórico; (2) o `metadata` já viaja inteiro no DTO e no `message:updated`,
 * então a equipe vê na bolha exatamente o que a IA ouviu, sem rota nova; e
 * (3) sobrevive a reinício, como todo o resto do estado do atendimento.
 *
 * O registro guarda o INSUCESSO também, de propósito: sem ele, áudio que não
 * dá para transcrever (arquivo que não baixou, áudio longo demais, provedor
 * fora do ar) seria tentado de novo a cada turno, e a IA seguiria respondendo
 * como se o cliente não tivesse dito nada. Com a marca, o motor sabe avisar ao
 * modelo "este áudio você não ouviu" e pedir que o cliente escreva.
 */
export const AUDIO_TRANSCRIPT_METADATA_KEY = "audioTranscript";

/**
 * `ok` é a única situação com texto. As demais são motivos de não ter:
 * `empty` = transcreveu e não havia fala; `no_file` = a mídia não foi baixada
 * (ver `mediaDownloadFailed`); `too_long` = passou do teto de duração/tamanho;
 * `failed` = o provedor recusou ou caiu.
 */
export const AUDIO_TRANSCRIPT_STATUSES = ["ok", "empty", "no_file", "too_long", "failed"] as const;
export type AudioTranscriptStatus = (typeof AUDIO_TRANSCRIPT_STATUSES)[number];

export interface AudioTranscriptMetadata {
  status: AudioTranscriptStatus;
  /** Só em `ok`; nos outros status é nulo, nunca string vazia. */
  text: string | null;
  /** Modelo que transcreveu, para o log e para a tela. */
  model: string | null;
  /** ISO da tentativa — é ela que diz "já tentei", mesmo sem texto. */
  at: string;
  /**
   * Quantas vezes já foi tentado. Existe por causa da falha TRANSITÓRIA: o
   * provedor fora do ar por um minuto não pode deixar o áudio sem transcrição
   * para sempre (é o mesmo defeito que a retentativa do download de mídia veio
   * consertar). Status determinístico — `no_file`, `too_long`, `empty` — nunca
   * é tentado de novo, porque tentar daria o mesmo resultado pago.
   */
  attempts: number;
}

/**
 * Teto do texto guardado. Áudio de dez minutos rende alguns milhares de
 * caracteres; acima disso o corte protege o contexto do modelo e o tamanho do
 * `metadata`, que viaja em todo evento da mensagem.
 */
export const AUDIO_TRANSCRIPT_MAX_CHARS = 6000;

/** Tentativas por áudio. Duas: a do turno em que ele chegou e mais uma. */
export const AUDIO_TRANSCRIPT_MAX_ATTEMPTS = 2;

export function readAudioTranscript(metadata: unknown): AudioTranscriptMetadata | null {
  if (!metadata || typeof metadata !== "object") return null;
  const raw = (metadata as Record<string, unknown>)[AUDIO_TRANSCRIPT_METADATA_KEY];
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Record<string, unknown>;
  const status = AUDIO_TRANSCRIPT_STATUSES.find((candidate) => candidate === value.status);
  if (!status) return null;
  return {
    status,
    text: typeof value.text === "string" && value.text.length > 0 ? value.text : null,
    model: typeof value.model === "string" && value.model.length > 0 ? value.model : null,
    at: typeof value.at === "string" ? value.at : new Date(0).toISOString(),
    attempts: typeof value.attempts === "number" && value.attempts > 0 ? value.attempts : 1,
  };
}

/** Grava PRESERVANDO o resto do `metadata` — ver `withAudioMp3Key`. */
export function withAudioTranscript(
  metadata: unknown,
  value: AudioTranscriptMetadata,
): Record<string, unknown> {
  const base =
    metadata && typeof metadata === "object" ? { ...(metadata as Record<string, unknown>) } : {};
  base[AUDIO_TRANSCRIPT_METADATA_KEY] = {
    status: value.status,
    text: value.text ? value.text.slice(0, AUDIO_TRANSCRIPT_MAX_CHARS) : null,
    model: value.model,
    at: value.at,
    attempts: value.attempts,
  };
  return base;
}

/**
 * Vale tentar de novo? Só a falha do provedor, e só dentro do teto — os
 * outros status são decisão fechada sobre aquele arquivo.
 */
export function audioTranscriptCanRetry(value: AudioTranscriptMetadata | null): boolean {
  if (!value) return true;
  return value.status === "failed" && value.attempts < AUDIO_TRANSCRIPT_MAX_ATTEMPTS;
}

/** Por que não há texto — frase curta, em português, para a bolha e o log. */
export const AUDIO_TRANSCRIPT_STATUS_LABELS: Record<AudioTranscriptStatus, string> = {
  ok: "Transcrito",
  empty: "Áudio sem fala reconhecida",
  no_file: "O arquivo do áudio não chegou ao sistema",
  too_long: "Áudio longo demais para transcrever",
  failed: "Não foi possível transcrever o áudio agora",
};

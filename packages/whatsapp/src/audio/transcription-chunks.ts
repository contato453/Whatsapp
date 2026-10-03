import { AudioConversionError, runFfmpeg } from "./ffmpeg.js";
import { detectAudioContainer } from "./container.js";

/**
 * Prepara uma gravação LONGA (a de uma ligação) para a API de transcrição.
 *
 * Dois problemas, uma passada só:
 *   1. **Tamanho.** A API de transcrição recusa arquivo acima de 25 MB, e a
 *      gravação vem em MP3 estéreo de qualidade de música. Reduzir para MP3
 *      MONO, 16 kHz, 32 kbps — que é mais do que fala de telefone carrega —
 *      deixa uma hora de ligação em uns 14 MB, sem perda que o reconhecimento
 *      de fala perceba.
 *   2. **Duração.** Os modelos de transcrição também têm teto de duração por
 *      arquivo, e um arquivo único significaria que um tropeço no minuto 40
 *      joga fora os 39 anteriores. Por isso o áudio sai em PEDAÇOS de
 *      `chunkSeconds`, transcritos um a um e emendados por quem chama.
 *
 * O corte é feito sobre o MP3 já compacto e com `-c copy` (sem recodificar),
 * então cada pedaço custa só a cópia dos bytes. Como a taxa é CONSTANTE, a
 * duração sai da conta `bytes × 8 / bitrate`, sem um segundo processo para
 * medir — e é ela que decide quantos pedaços existem.
 */

/** 32 kbps constante: é ele que permite medir a duração pelos bytes. */
export const TRANSCRIPTION_CHUNK_BITRATE_BPS = 32_000;

/** Teto do ffmpeg aqui: noventa minutos de MP3 recodificam bem abaixo disto. */
const LONG_FFMPEG_TIMEOUT_MS = 180_000;

/** Sobra no fim menor que isto é emendada no pedaço anterior, não vira um pedaço de silêncio. */
const MIN_TAIL_SECONDS = 20;

export interface TranscriptionChunk {
  data: Buffer;
  /** Onde o pedaço começa na gravação, para emendar na ordem certa. */
  startSeconds: number;
  /** Duração do pedaço — é ela que o custo por minuto usa. */
  seconds: number;
}

export async function splitAudioForTranscription(
  input: Buffer,
  options: { chunkSeconds: number },
): Promise<TranscriptionChunk[]> {
  if (input.length < 512) {
    throw new AudioConversionError("Gravação vazia ou truncada", "empty_input");
  }
  const compact = await runFfmpeg(
    [
      "-hide_banner", "-loglevel", "error",
      "-i", "pipe:0",
      "-vn",
      "-ac", "1",
      "-ar", "16000",
      "-c:a", "libmp3lame", "-b:a", `${TRANSCRIPTION_CHUNK_BITRATE_BPS / 1000}k`,
      "-f", "mp3",
      "pipe:1",
    ],
    input,
    LONG_FFMPEG_TIMEOUT_MS,
  );
  // Mesma régua do resto do pacote: quem prova a conversão são os BYTES.
  if (detectAudioContainer(compact) !== "mp3") {
    throw new AudioConversionError("Saída do ffmpeg não é MP3", "unexpected_output");
  }

  const totalSeconds = (compact.length * 8) / TRANSCRIPTION_CHUNK_BITRATE_BPS;
  const chunkSeconds = Math.max(60, options.chunkSeconds);
  if (totalSeconds <= chunkSeconds + MIN_TAIL_SECONDS) {
    return [{ data: compact, startSeconds: 0, seconds: Math.round(totalSeconds) }];
  }

  const starts: number[] = [];
  for (let start = 0; start < totalSeconds; start += chunkSeconds) starts.push(start);
  // A sobra curta vai junto com o último pedaço (`-t` maior no penúltimo).
  const lastStart = starts[starts.length - 1] ?? 0;
  if (starts.length > 1 && totalSeconds - lastStart < MIN_TAIL_SECONDS) starts.pop();

  const chunks: TranscriptionChunk[] = [];
  for (let index = 0; index < starts.length; index += 1) {
    const start = starts[index] ?? 0;
    const isLast = index === starts.length - 1;
    const length = isLast ? totalSeconds - start : chunkSeconds;
    const args = [
      "-hide_banner", "-loglevel", "error",
      "-i", "pipe:0",
      "-ss", String(start),
      ...(isLast ? [] : ["-t", String(chunkSeconds)]),
      "-c", "copy",
      "-f", "mp3",
      "pipe:1",
    ];
    const data = await runFfmpeg(args, compact, LONG_FFMPEG_TIMEOUT_MS);
    chunks.push({ data, startSeconds: Math.round(start), seconds: Math.max(1, Math.round(length)) });
  }
  return chunks;
}

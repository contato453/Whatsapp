import { spawn } from "node:child_process";
import type { Logger } from "pino";

/**
 * Áudios gravados no navegador saem em WebM/Opus. O WhatsApp espera
 * mensagens de voz em OGG/Opus — sem conversão, o áudio pode não tocar
 * em alguns aparelhos (principalmente iPhone).
 *
 * Converte com ffmpeg quando disponível. Se o ffmpeg não existir, retorna
 * null e o chamador envia como arquivo de áudio comum (fallback honesto,
 * em vez de mandar algo que talvez não toque).
 */
export async function transcodeToOpusOgg(
  input: Buffer,
  logger: Logger,
): Promise<Buffer | null> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: Buffer | null) => {
      if (!settled) {
        settled = true;
        resolve(value);
      }
    };

    const ffmpeg = spawn("ffmpeg", [
      "-hide_banner",
      "-loglevel", "error",
      "-i", "pipe:0",
      "-vn",
      "-c:a", "libopus",
      "-b:a", "32k",
      "-ar", "48000",
      "-ac", "1",
      "-f", "ogg",
      "pipe:1",
    ]);

    const chunks: Buffer[] = [];
    ffmpeg.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));

    ffmpeg.on("error", (err) => {
      logger.warn({ event: "ffmpeg_unavailable", error: String(err) });
      finish(null);
    });

    ffmpeg.on("close", (code) => {
      if (code === 0 && chunks.length > 0) {
        finish(Buffer.concat(chunks));
      } else {
        logger.warn({ event: "ffmpeg_transcode_failed", code });
        finish(null);
      }
    });

    ffmpeg.stdin.on("error", () => finish(null));
    ffmpeg.stdin.end(input);
  });
}

import { spawn } from "node:child_process";
import type { Logger } from "pino";

/**
 * Figurinhas do WhatsApp são WebP de 512x512 com fundo transparente.
 * Converte qualquer imagem para esse formato usando ffmpeg (já presente
 * na imagem para os áudios). Retorna null se a conversão não for possível
 * — o chamador então envia como imagem comum.
 */
export async function convertToSticker(input: Buffer, logger: Logger): Promise<Buffer | null> {
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
      // Redimensiona mantendo proporção e completa com transparência
      "-vf",
      "scale=512:512:force_original_aspect_ratio=decrease,pad=512:512:(ow-iw)/2:(oh-ih)/2:color=#00000000",
      "-vcodec", "libwebp",
      "-lossless", "1",
      "-qscale", "75",
      "-preset", "default",
      "-loop", "0",
      "-an",
      "-vsync", "0",
      "-f", "webp",
      "pipe:1",
    ]);

    const chunks: Buffer[] = [];
    ffmpeg.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    ffmpeg.on("error", (err) => {
      logger.warn({ event: "sticker_convert_unavailable", error: String(err) });
      finish(null);
    });
    ffmpeg.on("close", (code) => {
      if (code === 0 && chunks.length > 0) {
        finish(Buffer.concat(chunks));
      } else {
        logger.warn({ event: "sticker_convert_failed", code });
        finish(null);
      }
    });
    ffmpeg.stdin.on("error", () => finish(null));
    ffmpeg.stdin.end(input);
  });
}

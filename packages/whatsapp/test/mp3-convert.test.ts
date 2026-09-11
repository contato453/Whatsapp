import { execFileSync, spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import pino from "pino";
import { AudioConversionError } from "../src/audio/ffmpeg.js";
import { convertAudioToMp3 } from "../src/audio/mp3.js";
import { detectAudioContainer } from "../src/audio/container.js";

const logger = pino({ level: "silent" });
const temFfmpeg = spawnSync("ffmpeg", ["-version"]).status === 0;

/** Gera um arquivo pelo ffmpeg e devolve os bytes, sem tocar no disco. */
function gerar(args: string[]): Buffer {
  return execFileSync(
    "ffmpeg",
    ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", ...args, "pipe:1"],
    { maxBuffer: 64 * 1024 * 1024 },
  );
}

describe("convertAudioToMp3", () => {
  it("recusa entrada vazia sem nem abrir o ffmpeg", async () => {
    // Áudio truncado ou gravação de duração zero: erro claro em vez de um
    // "ffmpeg terminou com 1" que não diz nada a quem lê o log.
    await expect(convertAudioToMp3(Buffer.alloc(8), logger)).rejects.toBeInstanceOf(
      AudioConversionError,
    );
    await expect(convertAudioToMp3(Buffer.alloc(8), logger)).rejects.toMatchObject({
      reason: "empty_input",
    });
  });

  it.skipIf(!temFfmpeg)(
    "converte o OGG/Opus do WhatsApp em MP3 de verdade",
    async () => {
      // É este o formato que chega do WhatsApp, e é ele que no Windows costuma
      // não tocar no duplo clique — o motivo do MP3 ser o padrão do download.
      const ogg = gerar([
        "sine=frequency=440:duration=2",
        "-c:a", "libopus", "-ar", "48000", "-f", "ogg",
      ]);
      expect(detectAudioContainer(ogg)).toBe("ogg-opus");

      const mp3 = await convertAudioToMp3(ogg, logger);
      // Quem prova a conversão são os BYTES, não o código de saída do processo.
      expect(detectAudioContainer(mp3)).toBe("mp3");
      expect(mp3.length).toBeGreaterThan(1_000);
    },
    30_000,
  );

  it.skipIf(!temFfmpeg)(
    "converte também áudio anexado que não é OGG",
    async () => {
      const wav = gerar(["sine=frequency=300:duration=1", "-f", "wav"]);
      const mp3 = await convertAudioToMp3(wav, logger);
      expect(detectAudioContainer(mp3)).toBe("mp3");
    },
    30_000,
  );

  it.skipIf(!temFfmpeg)(
    "recusa bytes que não são áudio nenhum",
    async () => {
      const lixo = Buffer.alloc(4_096, 0x41);
      await expect(convertAudioToMp3(lixo, logger)).rejects.toBeInstanceOf(AudioConversionError);
    },
    30_000,
  );
});

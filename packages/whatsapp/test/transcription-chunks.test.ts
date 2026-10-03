import { execFileSync, spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { AudioConversionError } from "../src/audio/ffmpeg.js";
import { detectAudioContainer } from "../src/audio/container.js";
import { splitAudioForTranscription } from "../src/audio/transcription-chunks.js";

const temFfmpeg = spawnSync("ffmpeg", ["-version"]).status === 0;

/** Gera um MP3 estéreo "de música", como o que o AstraCalls grava. */
function gravacao(seconds: number): Buffer {
  return execFileSync(
    "ffmpeg",
    [
      "-hide_banner", "-loglevel", "error",
      "-f", "lavfi", "-i", `sine=frequency=440:duration=${seconds}`,
      "-ac", "2", "-ar", "44100", "-c:a", "libmp3lame", "-b:a", "128k", "-f", "mp3", "pipe:1",
    ],
    { maxBuffer: 64 * 1024 * 1024 },
  );
}

describe("splitAudioForTranscription", () => {
  it("recusa gravação vazia sem abrir o ffmpeg", async () => {
    await expect(splitAudioForTranscription(Buffer.alloc(10), { chunkSeconds: 600 })).rejects.toBeInstanceOf(
      AudioConversionError,
    );
  });

  it.skipIf(!temFfmpeg)(
    "ligação curta vira UM pedaço, compacto e ainda MP3",
    async () => {
      const original = gravacao(30);
      const chunks = await splitAudioForTranscription(original, { chunkSeconds: 600 });
      expect(chunks).toHaveLength(1);
      expect(detectAudioContainer(chunks[0]!.data)).toBe("mp3");
      // Mono 32 kbps contra estéreo 128 kbps: bem menor que o original.
      expect(chunks[0]!.data.length).toBeLessThan(original.length / 2);
      expect(chunks[0]!.seconds).toBeGreaterThanOrEqual(28);
      expect(chunks[0]!.seconds).toBeLessThanOrEqual(32);
    },
    60_000,
  );

  it.skipIf(!temFfmpeg)(
    "ligação longa é cortada em pedaços na ordem, cobrindo a gravação inteira",
    async () => {
      const chunks = await splitAudioForTranscription(gravacao(150), { chunkSeconds: 60 });
      expect(chunks.map((chunk) => chunk.startSeconds)).toEqual([0, 60, 120]);
      for (const chunk of chunks) expect(detectAudioContainer(chunk.data)).toBe("mp3");
      const total = chunks.reduce((sum, chunk) => sum + chunk.seconds, 0);
      expect(total).toBeGreaterThanOrEqual(145);
      expect(total).toBeLessThanOrEqual(155);
    },
    60_000,
  );

  it.skipIf(!temFfmpeg)(
    "sobra curta no fim é emendada no último pedaço, não vira pedaço de silêncio",
    async () => {
      const chunks = await splitAudioForTranscription(gravacao(130), { chunkSeconds: 60 });
      expect(chunks.map((chunk) => chunk.startSeconds)).toEqual([0, 60]);
      expect(chunks[1]!.seconds).toBeGreaterThanOrEqual(65);
    },
    60_000,
  );
});

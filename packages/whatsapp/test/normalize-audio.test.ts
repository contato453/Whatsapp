import { execFileSync, spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import pino from "pino";
import {
  AudioConversionError,
  normalizeAudioForWhatsApp,
} from "../src/audio/normalize-audio.js";
import { VOICE_NOTE_MIME_TYPE, detectAudioContainer, resolveAudioDeclaration } from "../src/audio/container.js";

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

describe("resolveAudioDeclaration", () => {
  it("recusa mensagem de voz com bytes que não são OGG/Opus", () => {
    const webm = Buffer.alloc(32);
    webm.set([0x1a, 0x45, 0xdf, 0xa3], 0);
    // Este é o defeito original: WebM anunciado como OGG chega quebrado no
    // celular do cliente, com o envio reportado como sucesso aqui.
    expect(() => resolveAudioDeclaration(webm, "audio/webm", true)).toThrow(/OGG\/Opus/);
  });

  it("sem flag de voz, WebM continua sendo anunciado como WebM", () => {
    const webm = Buffer.alloc(32);
    webm.set([0x1a, 0x45, 0xdf, 0xa3], 0);
    expect(resolveAudioDeclaration(webm, "audio/ogg; codecs=opus", false)).toEqual({
      mimetype: "audio/webm",
      ptt: false,
    });
  });
});

describe("normalizeAudioForWhatsApp", () => {
  it("entrada que não é áudio interrompe o envio em vez de degradar", async () => {
    await expect(
      normalizeAudioForWhatsApp(Buffer.from("isso não é áudio"), { profile: "voice", logger }),
    ).rejects.toBeInstanceOf(AudioConversionError);
  });

  it.skipIf(!temFfmpeg)(
    "WebM do navegador vira OGG/Opus com duração, e a declaração fica coerente",
    async () => {
      // Igual ao que o MediaRecorder do Chrome entrega: WebM ao vivo, sem
      // duração no cabeçalho.
      const webm = gerar([
        "sine=frequency=440:duration=3",
        "-c:a", "libopus", "-ar", "48000", "-ac", "1", "-f", "webm", "-live", "1",
      ]);
      expect(detectAudioContainer(webm)).toBe("webm");

      const saida = await normalizeAudioForWhatsApp(webm, { profile: "voice", logger });
      expect(detectAudioContainer(saida.data)).toBe("ogg-opus");
      expect(saida.mimeType).toBe(VOICE_NOTE_MIME_TYPE);
      expect(saida.converted).toBe(true);
      expect(saida.seconds).toBe(3);
      expect(saida.waveform?.length).toBe(64);
      expect(resolveAudioDeclaration(saida.data, saida.mimeType, true)).toEqual({
        mimetype: VOICE_NOTE_MIME_TYPE,
        ptt: true,
      });
    },
    30_000,
  );

  it.skipIf(!temFfmpeg)(
    "áudio de um segundo continua com duração de um segundo, e não zero",
    async () => {
      const webm = gerar([
        "sine=frequency=440:duration=1",
        "-c:a", "libopus", "-ar", "48000", "-ac", "1", "-f", "webm", "-live", "1",
      ]);
      const saida = await normalizeAudioForWhatsApp(webm, { profile: "voice", logger });
      expect(saida.seconds).toBe(1);
    },
    30_000,
  );

  it.skipIf(!temFfmpeg)(
    "arquivo anexado que o WhatsApp já toca não é recodificado",
    async () => {
      const mp3 = gerar(["sine=frequency=440:duration=2", "-c:a", "libmp3lame", "-f", "mp3"]);
      const saida = await normalizeAudioForWhatsApp(mp3, { profile: "file", logger });
      expect(saida.converted).toBe(false);
      expect(saida.data.equals(mp3)).toBe(true);
      expect(saida.mimeType).toBe("audio/mpeg");
    },
    30_000,
  );

  it.skipIf(!temFfmpeg)(
    "arquivo anexado em WAV é convertido, mas continua arquivo e não vira voz",
    async () => {
      const wav = gerar(["sine=frequency=440:duration=2", "-c:a", "pcm_s16le", "-f", "wav"]);
      const saida = await normalizeAudioForWhatsApp(wav, { profile: "file", logger });
      expect(saida.converted).toBe(true);
      expect(detectAudioContainer(saida.data)).toBe("ogg-opus");
      // Perfil de arquivo não desenha waveform: waveform é da mensagem de voz.
      expect(saida.waveform).toBeUndefined();
      expect(resolveAudioDeclaration(saida.data, saida.mimeType, false).ptt).toBe(false);
    },
    30_000,
  );

  it.skipIf(!temFfmpeg)(
    "OGG/Opus que já chega pronto (Firefox) não passa pelo ffmpeg de novo",
    async () => {
      const ogg = gerar([
        "sine=frequency=440:duration=2",
        "-c:a", "libopus", "-ar", "48000", "-ac", "1", "-f", "ogg",
      ]);
      const saida = await normalizeAudioForWhatsApp(ogg, { profile: "voice", logger });
      expect(saida.converted).toBe(false);
      expect(saida.data.equals(ogg)).toBe(true);
      expect(saida.seconds).toBe(2);
    },
    30_000,
  );
});

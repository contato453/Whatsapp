import { spawnSync } from "node:child_process";
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import pino from "pino";
import { detectAudioContainer } from "@azvchat/whatsapp";
import { AppError } from "../src/lib/errors.js";
import {
  AUDIO_PREPARE_FAILED_MESSAGE,
  VOICE_NOTE_ENABLED,
  prepareOutboundAudio,
} from "../src/lib/outbound-audio.js";

const logger = pino({ level: "silent" });
const temFfmpeg = spawnSync("ffmpeg", ["-version"]).status === 0;

/** Lê a taxa de amostragem do arquivo pronto, para comparar os dois caminhos. */
function taxaDeAmostragem(buffer: Buffer): number {
  const saida = execFileSync(
    "ffprobe",
    [
      "-hide_banner", "-loglevel", "error",
      "-select_streams", "a:0",
      "-show_entries", "stream=sample_rate",
      "-of", "csv=p=0",
      "pipe:0",
    ],
    { input: buffer, maxBuffer: 16 * 1024 * 1024 },
  );
  return Number(saida.toString().trim());
}

function gerar(args: string[]): Buffer {
  return execFileSync(
    "ffmpeg",
    ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", ...args, "pipe:1"],
    { maxBuffer: 64 * 1024 * 1024 },
  );
}

/**
 * A regra que este arquivo tranca: áudio que o WhatsApp não toca nunca sai
 * daqui. Antes, quando a conversão não acontecia, a mensagem era enviada
 * assim mesmo e chegava no celular do cliente como indisponível, pedindo
 * reenvio, com o atendente vendo sucesso na tela.
 */
describe("prepareOutboundAudio", () => {
  it("falha de conversão vira erro em português, e a mensagem não é enviada", async () => {
    await expect(
      prepareOutboundAudio(Buffer.from("isso não é áudio"), "audio/webm", true, logger),
    ).rejects.toMatchObject({
      message: AUDIO_PREPARE_FAILED_MESSAGE,
      statusCode: 422,
      code: "audio_conversion_failed",
    });
    await expect(
      prepareOutboundAudio(Buffer.from("isso não é áudio"), "audio/webm", true, logger),
    ).rejects.toBeInstanceOf(AppError);
  });

  it.skipIf(!temFfmpeg)(
    "gravação do microfone é normalizada para OGG/Opus com duração",
    async () => {
      const webm = gerar([
        "sine=frequency=440:duration=2",
        "-c:a", "libopus", "-ar", "48000", "-ac", "1", "-f", "webm", "-live", "1",
      ]);
      const pronto = await prepareOutboundAudio(webm, "audio/webm", true, logger);
      expect(detectAudioContainer(pronto.data)).toBe("ogg-opus");
      expect(pronto.mimeType).toBe("audio/ogg; codecs=opus");
      expect(pronto.seconds).toBe(2);
      expect(pronto.converted).toBe(true);
    },
    30_000,
  );

  it.skipIf(!temFfmpeg)(
    "a gravação e o arquivo anexado produzem bytes com a MESMA forma",
    async () => {
      // Os dois caminhos usam o perfil de arquivo, que é a forma de bytes
      // comprovadamente entregue. Vale mesmo com a mensagem de voz ligada:
      // ali muda a flag, e não a conversão. Perfil de voz produziria mono
      // 16 kHz e waveform, deixando a gravação diferente do anexo.
      const webm = gerar([
        "sine=frequency=440:duration=2",
        "-c:a", "libopus", "-ar", "48000", "-ac", "1", "-f", "webm", "-live", "1",
      ]);
      const gravado = await prepareOutboundAudio(webm, "audio/webm", true, logger);
      const anexado = await prepareOutboundAudio(webm, "audio/webm", false, logger);
      expect(gravado.waveform).toBeUndefined();
      expect(anexado.waveform).toBeUndefined();
      expect(taxaDeAmostragem(gravado.data)).toBe(taxaDeAmostragem(anexado.data));
      expect(taxaDeAmostragem(gravado.data)).toBe(48000);
    },
    60_000,
  );

  it.skipIf(!temFfmpeg)(
    "a gravação só vira mensagem de voz se VOICE_NOTE_ENABLED permitir",
    async () => {
      // A decisão e o porquê estão em lib/outbound-audio.ts: bytes idênticos
      // com ptt ligado chegam como "áudio indisponível" no celular do cliente,
      // e com ptt desligado tocam. Entre a bolha bonita que ninguém ouve e o
      // player comum que funciona, fica o que funciona.
      const webm = gerar([
        "sine=frequency=440:duration=2",
        "-c:a", "libopus", "-ar", "48000", "-ac", "1", "-f", "webm", "-live", "1",
      ]);
      const pronto = await prepareOutboundAudio(webm, "audio/webm", true, logger);
      // Quem manda é a constante, e não o "true" de quem chamou: a gravação
      // só vira mensagem de voz quando o sistema estiver com ela ligada.
      expect(pronto.asVoiceNote).toBe(VOICE_NOTE_ENABLED);
    },
    30_000,
  );

  it.skipIf(!temFfmpeg)(
    "arquivo anexado do computador continua arquivo: converte o container, não a natureza",
    async () => {
      const wav = gerar(["sine=frequency=440:duration=2", "-c:a", "pcm_s16le", "-f", "wav"]);
      const pronto = await prepareOutboundAudio(wav, "audio/wav", false, logger);
      expect(detectAudioContainer(pronto.data)).toBe("ogg-opus");
      expect(pronto.asVoiceNote).toBe(false);
      expect(pronto.converted).toBe(true);
    },
    30_000,
  );
});

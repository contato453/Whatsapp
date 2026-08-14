import { describe, expect, it } from "vitest";
import pino from "pino";
import { transcodeToOpusOgg } from "../src/lib/audio-transcode.js";

const logger = pino({ level: "silent" });

describe("transcodeToOpusOgg", () => {
  it("retorna null (sem lançar) quando o ffmpeg não está disponível ou a entrada é inválida", async () => {
    // Em ambientes sem ffmpeg o processo falha ao iniciar; com ffmpeg,
    // a entrada inválida faz a conversão falhar. Nos dois casos o
    // contrato é o mesmo: null, para o chamador aplicar o fallback.
    const result = await transcodeToOpusOgg(Buffer.from("não é um áudio"), logger);
    expect(result).toBeNull();
  });
});

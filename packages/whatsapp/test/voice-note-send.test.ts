import { execFileSync, spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import pino from "pino";
import type { MediaPayload } from "@azvchat/shared";
import { QrCodeWhatsAppProvider } from "../src/qrcode/qrcode-provider.js";
import { normalizeAudioForWhatsApp } from "../src/audio/normalize-audio.js";

const logger = pino({ level: "silent" });
const temFfmpeg = spawnSync("ffmpeg", ["-version"]).status === 0;

/**
 * A regra que este arquivo tranca.
 *
 * O Baileys, com `ptt` ligado, recalcula a waveform chamando `audio-decode`,
 * que ele não declara como dependência: a chamada falha em silêncio e devolve
 * `undefined`, apagando a waveform calculada aqui. Por isso a mensagem de voz
 * é montada e relayada por nós, e só ela: o resto da mídia continua no
 * `sendMessage` de sempre. Se alguém achar que o desvio é desnecessário e
 * voltar tudo para o `sendMessage`, estes testes ficam vermelhos.
 */
interface ConteudoAudio {
  waveform?: Uint8Array;
  ptt?: boolean;
  seconds?: number;
}

interface SocketFalso {
  chamadas: { relay: number; send: number };
  relayado: ConteudoAudio | null;
  /** O que foi entregue ao sendMessage do Baileys (áudio que não é voz). */
  enviado: ConteudoAudio | null;
}

function montarProvider(): { provider: QrCodeWhatsAppProvider; espiao: SocketFalso } {
  const espiao: SocketFalso = {
    chamadas: { relay: 0, send: 0 },
    relayado: null,
    enviado: null,
  };
  const socket = {
    user: { id: "5511999999999:1@s.whatsapp.net" },
    waUploadToServer: async () => ({
      mediaUrl: "https://mmg.whatsapp.net/teste",
      directPath: "/v/teste",
    }),
    relayMessage: async (_jid: string, message: { audioMessage?: unknown }) => {
      espiao.chamadas.relay += 1;
      const audio = message.audioMessage as
        | { waveform?: Uint8Array; ptt?: boolean; seconds?: number }
        | undefined;
      espiao.relayado = audio ?? null;
      return "id-relay";
    },
    sendMessage: async (_jid: string, content: ConteudoAudio) => {
      espiao.chamadas.send += 1;
      espiao.enviado = content;
      return { key: { id: "id-send" }, messageTimestamp: 1 };
    },
    ev: { emit: () => undefined },
  };
  const provider = new QrCodeWhatsAppProvider({ sessionDir: "/tmp/azvchat-teste", logger });
  (
    provider as unknown as {
      sessions: Map<string, { socket: unknown; status: string }>;
    }
  ).sessions.set("inst-1", { socket, status: "connected" });
  return { provider, espiao };
}

async function vozDeTeste(): Promise<MediaPayload> {
  const webm = execFileSync(
    "ffmpeg",
    [
      "-hide_banner", "-loglevel", "error",
      "-f", "lavfi", "-i", "sine=frequency=440:duration=3",
      "-c:a", "libopus", "-ar", "48000", "-ac", "1", "-f", "webm", "-live", "1",
      "pipe:1",
    ],
    { maxBuffer: 32 * 1024 * 1024 },
  );
  const pronto = await normalizeAudioForWhatsApp(webm, { profile: "voice", logger });
  return {
    data: pronto.data,
    mimeType: pronto.mimeType,
    type: "audio",
    asVoiceNote: true,
    ...(pronto.seconds !== undefined ? { seconds: pronto.seconds } : {}),
    ...(pronto.waveform !== undefined ? { waveform: pronto.waveform } : {}),
  };
}

describe("envio de mensagem de voz", () => {
  it.skipIf(!temFfmpeg)(
    "a waveform calculada aqui chega na mensagem relayada, em vez de ser apagada",
    async () => {
      const { provider, espiao } = montarProvider();
      const media = await vozDeTeste();
      expect(media.waveform?.length).toBe(64);

      await provider.sendMedia("inst-1", "5511888888888@s.whatsapp.net", media);

      expect(espiao.chamadas.relay).toBe(1);
      expect(espiao.chamadas.send).toBe(0);
      expect(espiao.relayado?.ptt).toBe(true);
      // O ponto do teste: sem o desvio isto voltaria undefined.
      expect(espiao.relayado?.waveform).toBeInstanceOf(Uint8Array);
      expect(espiao.relayado?.waveform?.length).toBe(64);
      expect(Number(espiao.relayado?.seconds)).toBe(3);
    },
    60_000,
  );

  it.skipIf(!temFfmpeg)(
    "áudio comum, sem flag de voz, continua saindo pelo sendMessage do Baileys",
    async () => {
      const { provider, espiao } = montarProvider();
      const media = await vozDeTeste();
      await provider.sendMedia("inst-1", "5511888888888@s.whatsapp.net", {
        ...media,
        asVoiceNote: false,
      });
      expect(espiao.chamadas.send).toBe(1);
      expect(espiao.chamadas.relay).toBe(0);
    },
    60_000,
  );

  it.skipIf(!temFfmpeg)(
    "áudio que não é mensagem de voz NUNCA leva waveform",
    async () => {
      // Waveform num áudio comum é combinação que nenhum cliente oficial
      // gera. O objetivo é o áudio comum sair idêntico ao arquivo anexado,
      // que é o que comprovadamente toca no celular do cliente.
      const { provider, espiao } = montarProvider();
      const media = await vozDeTeste();
      expect(media.waveform?.length).toBe(64);
      await provider.sendMedia("inst-1", "5511888888888@s.whatsapp.net", {
        ...media,
        asVoiceNote: false,
      });
      expect(espiao.enviado?.waveform).toBeUndefined();
      expect(espiao.enviado?.ptt).toBe(false);
    },
    60_000,
  );
});

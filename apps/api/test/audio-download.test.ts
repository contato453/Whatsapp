import { execFileSync, spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import pino from "pino";
import type { PrismaClient } from "@azvchat/database";
import { AUDIO_MP3_METADATA_KEY, readAudioMp3Key } from "@azvchat/shared";
import { resolveAudioMp3 } from "../src/lib/audio-download.js";
import type { MediaStorage } from "../src/lib/media-storage.js";

const logger = pino({ level: "silent" });
const temFfmpeg = spawnSync("ffmpeg", ["-version"]).status === 0;

function gerarOgg(): Buffer {
  return execFileSync(
    "ffmpeg",
    [
      "-hide_banner", "-loglevel", "error",
      "-f", "lavfi", "-i", "sine=frequency=440:duration=2",
      "-c:a", "libopus", "-ar", "48000", "-f", "ogg",
      "pipe:1",
    ],
    { maxBuffer: 64 * 1024 * 1024 },
  );
}

/** Storage de memória que CONTA as gravações — é o que denuncia reconversão. */
function storageFake(inicial: Record<string, Buffer> = {}) {
  const arquivos = new Map<string, Buffer>(Object.entries(inicial));
  let saves = 0;
  const storage: MediaStorage = {
    async save(data, options) {
      saves += 1;
      const key = `${options.instanceId}/${saves}.${options.extension ?? "bin"}`;
      arquivos.set(key, data);
      return key;
    },
    async read(key) {
      const achado = arquivos.get(key);
      if (!achado) throw new Error("Arquivo inexistente");
      return achado;
    },
  };
  return { storage, arquivos, saves: () => saves };
}

/** Só o `message.update` é exercido aqui — o resto do Prisma não entra. */
function prismaFake(destino: { metadata: unknown }) {
  return {
    message: {
      update: async ({ data }: { data: { metadata: unknown } }) => {
        destino.metadata = data.metadata;
        return destino;
      },
    },
  } as unknown as PrismaClient;
}

describe("resolveAudioMp3", () => {
  it("usa o MP3 já guardado e NÃO converte de novo", async () => {
    // O caso comum: a equipe baixa o comprovante, o cliente cobra e alguém
    // baixa outra vez. Converter a cada clique gastaria um ffmpeg por download.
    const { storage, saves } = storageFake({
      "inst-1/cache.mp3": Buffer.from("mp3-guardado"),
      "inst-1/original.ogg": Buffer.from("ogg-original"),
    });
    const mensagem = {
      id: "msg-1",
      mediaUrl: "inst-1/original.ogg",
      metadata: { durationSeconds: 12, [AUDIO_MP3_METADATA_KEY]: "inst-1/cache.mp3" },
    };
    const alvo = { metadata: mensagem.metadata };
    const mp3 = await resolveAudioMp3(
      { prisma: prismaFake(alvo), storage, logger },
      mensagem,
      "inst-1",
    );
    expect(mp3.toString()).toBe("mp3-guardado");
    expect(saves()).toBe(0);
  });

  it("recusa áudio vazio ou truncado com erro em português", async () => {
    const { storage } = storageFake({ "inst-1/vazio.ogg": Buffer.alloc(8) });
    const alvo = { metadata: null };
    await expect(
      resolveAudioMp3(
        { prisma: prismaFake(alvo), storage, logger },
        { id: "msg-2", mediaUrl: "inst-1/vazio.ogg", metadata: null },
        "inst-1",
      ),
    ).rejects.toMatchObject({ statusCode: 422, code: "audio_conversion_failed" });
  });

  it.skipIf(!temFfmpeg)(
    "converte uma vez, guarda a chave e reaproveita no segundo download",
    async () => {
      const ogg = gerarOgg();
      const { storage, saves } = storageFake({ "inst-1/original.ogg": ogg });
      // `metadata` já carrega outra chave: a gravação do MP3 não pode apagá-la.
      const alvo: { metadata: unknown } = { metadata: { durationSeconds: 2 } };
      const deps = { prisma: prismaFake(alvo), storage, logger };

      const primeiro = await resolveAudioMp3(
        deps,
        { id: "msg-3", mediaUrl: "inst-1/original.ogg", metadata: alvo.metadata },
        "inst-1",
      );
      expect(primeiro.subarray(0, 3).toString("latin1")).not.toBe("Ogg");
      expect(saves()).toBe(1);
      const chave = readAudioMp3Key(alvo.metadata);
      expect(chave).toBeTruthy();
      expect((alvo.metadata as Record<string, unknown>).durationSeconds).toBe(2);

      const segundo = await resolveAudioMp3(
        deps,
        { id: "msg-3", mediaUrl: "inst-1/original.ogg", metadata: alvo.metadata },
        "inst-1",
      );
      // Nenhuma gravação nova: o segundo download saiu do arquivo guardado.
      expect(saves()).toBe(1);
      expect(segundo.equals(primeiro)).toBe(true);
    },
    40_000,
  );

  it.skipIf(!temFfmpeg)(
    "chave guardada cujo arquivo sumiu do storage converte de novo",
    async () => {
      // Volume trocado ou storage limpo não pode deixar o áudio sem download
      // para sempre por causa de um arquivo de cache.
      const ogg = gerarOgg();
      const { storage, saves } = storageFake({ "inst-1/original.ogg": ogg });
      const alvo: { metadata: unknown } = {
        metadata: { [AUDIO_MP3_METADATA_KEY]: "inst-1/sumiu.mp3" },
      };
      const mp3 = await resolveAudioMp3(
        { prisma: prismaFake(alvo), storage, logger },
        { id: "msg-4", mediaUrl: "inst-1/original.ogg", metadata: alvo.metadata },
        "inst-1",
      );
      expect(mp3.length).toBeGreaterThan(1_000);
      expect(saves()).toBe(1);
      expect(readAudioMp3Key(alvo.metadata)).not.toBe("inst-1/sumiu.mp3");
    },
    40_000,
  );
});

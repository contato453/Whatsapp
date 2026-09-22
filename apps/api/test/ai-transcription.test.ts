import { describe, expect, it, vi } from "vitest";
import pino from "pino";
import type { Conversation } from "@azvchat/database";
import {
  AI_TRANSCRIPTION_LIMITS,
  estimateTranscriptionCostMicros,
  readAudioTranscript,
} from "@azvchat/shared";
import { AiProviderError, type AiProvider, type AiTranscriptionResult } from "../src/services/ai/provider.js";
import {
  ensureAudioTranscripts,
  resolveTranscriptionModel,
  type TranscribableMessage,
} from "../src/services/ai/transcription.js";
import { MemoryPrisma } from "./helpers/memory-prisma.js";

/**
 * A IA OUVINDO O ÁUDIO — a regra sozinha, sem provedor de verdade e sem banco.
 *
 * O que estes casos trancam:
 *   1. transcreve UMA vez e grava no `metadata`; o turno seguinte reaproveita
 *      em vez de pagar de novo;
 *   2. áudio sem arquivo, longo demais ou grande demais NÃO chega ao provedor
 *      — mas fica marcado, senão cada turno tentaria de novo;
 *   3. falha do PROVEDOR vale uma segunda tentativa, e só uma;
 *   4. nada disso lança: o turno segue mesmo sem entender o áudio;
 *   5. o consumo entra como `transcription`, com custo por minuto — nunca
 *      somado ao chat, e nunca zero quando o preço é desconhecido.
 */

const ORG = "org-1";
const CONVERSATION = {
  id: "conv-1",
  organizationId: ORG,
  whatsappInstanceId: "inst-1",
  departmentId: null,
  assignedUserId: null,
  assignedToAll: false,
} as unknown as Conversation;

function fakeProvider(
  result: () => Promise<AiTranscriptionResult>,
): { provider: AiProvider; calls: () => number } {
  let calls = 0;
  const provider = {
    kind: "openai" as const,
    transcribeAudio: async () => {
      calls += 1;
      return result();
    },
  } as unknown as AiProvider;
  return { provider, calls: () => calls };
}

function setup(options: { transcribe?: () => Promise<AiTranscriptionResult> } = {}) {
  const db = new MemoryPrisma();
  const files = new Map<string, Buffer>();
  const emitted: string[] = [];
  const { provider, calls } = fakeProvider(
    options.transcribe ??
      (async () => ({ text: "Bom dia, preciso de uma certidão", seconds: null, usage: { inputTokens: 30, outputTokens: 9 } })),
  );
  const deps = {
    prisma: db.client(),
    io: { to: () => ({ emit: (event: string) => emitted.push(event) }) } as never,
    logger: pino({ level: "silent" }),
    media: {
      save: async () => "nao-usado",
      read: async (key: string) => {
        const data = files.get(key);
        if (!data) throw new Error("arquivo inexistente");
        return data;
      },
    },
  };
  const ctx = {
    organizationId: ORG,
    conversation: CONVERSATION,
    credentials: { provider, kind: "openai" as const, apiKey: "sk-teste", defaultModel: "gpt-4.1-mini" },
    model: "gpt-4o-mini-transcribe",
    timeoutMs: 30_000,
    enabled: true,
    sessionId: null,
    agent: { id: "agent-1", name: "IA Comercial" },
  };
  return { db, files, emitted, deps, ctx, providerCalls: calls };
}

function audio(
  db: MemoryPrisma,
  files: Map<string, Buffer>,
  overrides: Partial<TranscribableMessage> & { durationSeconds?: number | null; bytes?: number } = {},
): TranscribableMessage {
  const mediaUrl = overrides.mediaUrl === undefined ? "inst-1/audio.ogg" : overrides.mediaUrl;
  if (mediaUrl) files.set(mediaUrl, Buffer.alloc(overrides.bytes ?? 2048, 1));
  const duration = overrides.durationSeconds === undefined ? 30 : overrides.durationSeconds;
  const row = db.seed("message", {
    organizationId: ORG,
    conversationId: CONVERSATION.id,
    direction: "inbound",
    type: "audio",
    content: null,
    mediaUrl,
    mimeType: "audio/ogg; codecs=opus",
    timestamp: new Date(),
    deletedAt: null,
    metadata: overrides.metadata ?? (duration == null ? null : { durationSeconds: duration }),
  });
  return {
    id: row.id as string,
    type: "audio",
    content: null,
    mediaUrl,
    mimeType: "audio/ogg; codecs=opus",
    metadata: row.metadata,
  };
}

describe("ensureAudioTranscripts", () => {
  it("transcreve uma vez, grava no metadata e reaproveita no turno seguinte", async () => {
    const s = setup();
    const message = audio(s.db, s.files, { durationSeconds: 30 });

    const first = await ensureAudioTranscripts(s.deps, s.ctx, [message]);
    expect(readAudioTranscript(first[0]?.metadata)).toMatchObject({
      status: "ok",
      text: "Bom dia, preciso de uma certidão",
      model: "gpt-4o-mini-transcribe",
      attempts: 1,
    });
    expect(s.providerCalls()).toBe(1);
    // Gravado na linha, não só no objeto devolvido.
    const stored = s.db.rows("message")[0];
    expect(readAudioTranscript(stored?.metadata)?.text).toBe("Bom dia, preciso de uma certidão");
    // A equipe é avisada: a bolha mostra o que a IA ouviu.
    expect(s.emitted).toContain("message:updated");

    // Segunda passada (o mesmo áudio no contexto do próximo turno): nada de
    // chamada nova — cada transcrição é paga.
    await ensureAudioTranscripts(s.deps, s.ctx, [{ ...message, metadata: stored?.metadata }]);
    expect(s.providerCalls()).toBe(1);

    const usage = s.db.rows("aiUsageLog");
    expect(usage).toHaveLength(1);
    expect(usage[0]).toMatchObject({ kind: "transcription", outcome: "ok", inputTokens: 30, outputTokens: 9 });
    expect(usage[0]?.costMicros).toBe(Math.round((30 / 60) * 0.003 * 1e6));
  });

  it("desligada, não lê arquivo, não chama o provedor e não marca nada", async () => {
    const s = setup();
    const message = audio(s.db, s.files);
    const result = await ensureAudioTranscripts(s.deps, { ...s.ctx, enabled: false }, [message]);
    expect(s.providerCalls()).toBe(0);
    expect(readAudioTranscript(result[0]?.metadata)).toBeNull();
    expect(s.db.rows("aiUsageLog")).toHaveLength(0);
  });

  it("mensagem que não é áudio passa intacta", async () => {
    const s = setup();
    const texto: TranscribableMessage = {
      id: "m-1",
      type: "text",
      content: "Oi",
      mediaUrl: null,
      mimeType: null,
      metadata: null,
    };
    const result = await ensureAudioTranscripts(s.deps, s.ctx, [texto]);
    expect(result[0]).toBe(texto);
    expect(s.providerCalls()).toBe(0);
  });

  it("sem arquivo no storage: marca no_file sem gastar chamada, e não tenta de novo", async () => {
    const s = setup();
    // Arquivo que sumiu do storage (a chave existe na mensagem, o binário não).
    const message = audio(s.db, s.files, { mediaUrl: "inst-1/perdido.ogg" });
    s.files.delete("inst-1/perdido.ogg");

    const first = await ensureAudioTranscripts(s.deps, s.ctx, [message]);
    expect(readAudioTranscript(first[0]?.metadata)).toMatchObject({ status: "no_file", text: null });
    expect(s.providerCalls()).toBe(0);

    const again = await ensureAudioTranscripts(s.deps, s.ctx, [{ ...message, metadata: first[0]?.metadata }]);
    expect(readAudioTranscript(again[0]?.metadata)?.attempts).toBe(1);
    expect(s.providerCalls()).toBe(0);
  });

  it("áudio mais longo que o teto não vai ao provedor", async () => {
    const s = setup();
    const message = audio(s.db, s.files, { durationSeconds: AI_TRANSCRIPTION_LIMITS.maxSeconds + 1 });
    const result = await ensureAudioTranscripts(s.deps, s.ctx, [message]);
    expect(readAudioTranscript(result[0]?.metadata)?.status).toBe("too_long");
    expect(s.providerCalls()).toBe(0);
  });

  it("arquivo acima do teto de tamanho não vai ao provedor", async () => {
    const s = setup();
    // O teto da API de transcrição existe do lado deles; barrar aqui evita
    // subir 25 MB para receber um 400.
    const message = audio(s.db, s.files, { bytes: AI_TRANSCRIPTION_LIMITS.maxBytes + 1, durationSeconds: 60 });
    const result = await ensureAudioTranscripts(s.deps, s.ctx, [message]);
    expect(readAudioTranscript(result[0]?.metadata)?.status).toBe("too_long");
    expect(s.providerCalls()).toBe(0);
  });

  it("transcrição vazia é `empty`, não `ok` sem texto", async () => {
    const s = setup({ transcribe: async () => ({ text: "   ", seconds: null, usage: { inputTokens: 5, outputTokens: 0 } }) });
    const message = audio(s.db, s.files);
    const result = await ensureAudioTranscripts(s.deps, s.ctx, [message]);
    expect(readAudioTranscript(result[0]?.metadata)).toMatchObject({ status: "empty", text: null });
  });

  it("falha do provedor: não lança, registra erro sem custo e vale UMA segunda tentativa", async () => {
    const s = setup({
      transcribe: async () => {
        throw new AiProviderError("provider_error", "instabilidade");
      },
    });
    const message = audio(s.db, s.files);

    const first = await ensureAudioTranscripts(s.deps, s.ctx, [message]);
    expect(readAudioTranscript(first[0]?.metadata)).toMatchObject({ status: "failed", attempts: 1 });
    expect(s.db.rows("aiUsageLog")[0]).toMatchObject({ kind: "transcription", outcome: "error" });
    // Chamada que falhou não custa: custo nulo, nunca zero silencioso.
    expect(s.db.rows("aiUsageLog")[0]?.costMicros).toBeNull();

    const second = await ensureAudioTranscripts(s.deps, s.ctx, [{ ...message, metadata: first[0]?.metadata }]);
    expect(readAudioTranscript(second[0]?.metadata)).toMatchObject({ status: "failed", attempts: 2 });
    expect(s.providerCalls()).toBe(2);

    // Esgotadas as tentativas, para de tentar: áudio que o provedor recusa
    // duas vezes não pode virar uma chamada paga por turno, para sempre.
    const third = await ensureAudioTranscripts(s.deps, s.ctx, [{ ...message, metadata: second[0]?.metadata }]);
    expect(readAudioTranscript(third[0]?.metadata)?.attempts).toBe(2);
    expect(s.providerCalls()).toBe(2);
  });

  it("timeout do provedor entra no consumo como timeout", async () => {
    const s = setup({
      transcribe: async () => {
        throw new AiProviderError("timeout", "demorou");
      },
    });
    await ensureAudioTranscripts(s.deps, s.ctx, [audio(s.db, s.files)]);
    expect(s.db.rows("aiUsageLog")[0]?.outcome).toBe("timeout");
  });

  it("dois áudios seguidos são transcritos na ordem da conversa", async () => {
    const falas = ["Primeiro áudio", "Segundo áudio"];
    const s = setup({
      transcribe: async () => ({ text: falas.shift() ?? "", seconds: null, usage: { inputTokens: 1, outputTokens: 1 } }),
    });
    const primeiro = audio(s.db, s.files, { mediaUrl: "inst-1/a1.ogg" });
    const segundo = audio(s.db, s.files, { mediaUrl: "inst-1/a2.ogg" });
    const result = await ensureAudioTranscripts(s.deps, s.ctx, [primeiro, segundo]);
    expect(result.map((message) => readAudioTranscript(message.metadata)?.text)).toEqual([
      "Primeiro áudio",
      "Segundo áudio",
    ]);
  });

  it("gravar o metadata falhando não derruba o turno — a transcrição volta mesmo assim", async () => {
    const s = setup();
    const message = audio(s.db, s.files);
    const client = s.deps.prisma;
    vi.spyOn(client.message, "update").mockRejectedValueOnce(new Error("banco fora"));
    const result = await ensureAudioTranscripts(s.deps, s.ctx, [message]);
    expect(readAudioTranscript(result[0]?.metadata)?.status).toBe("ok");
  });
});

describe("custo e modelo da transcrição", () => {
  it("custo é por minuto e nulo quando falta duração ou preço", () => {
    expect(estimateTranscriptionCostMicros("gpt-4o-mini-transcribe", 60)).toBe(3_000);
    expect(estimateTranscriptionCostMicros("whisper-1", 120)).toBe(12_000);
    // Sem duração conhecida e modelo fora do catálogo: nulo, nunca zero — é o
    // que faz a tela dizer "custo não estimado" em vez de mentir "de graça".
    expect(estimateTranscriptionCostMicros("gpt-4o-mini-transcribe", null)).toBeNull();
    expect(estimateTranscriptionCostMicros("modelo-novo-do-provedor", 60)).toBeNull();
  });

  it("modelo vazio cai no padrão do sistema", () => {
    expect(resolveTranscriptionModel(null)).toBe("gpt-4o-mini-transcribe");
    expect(resolveTranscriptionModel("  ")).toBe("gpt-4o-mini-transcribe");
    expect(resolveTranscriptionModel("whisper-1")).toBe("whisper-1");
  });
});

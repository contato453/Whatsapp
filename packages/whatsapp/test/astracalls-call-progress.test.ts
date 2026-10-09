import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import pino from "pino";
import { describe, expect, it } from "vitest";
import type { CallEvent } from "@azvchat/shared";
import { AstraCallsProvider } from "../src/astracalls/astracalls-provider.js";
import { AstraCallsHttpError } from "../src/astracalls/client.js";
import { CallStartError } from "../src/call-errors.js";

/**
 * Progresso e motivo de encerramento da ligação de SAÍDA. O provider é o único
 * que conhece o formato do AstraCalls; daqui para fora só sai `CallEvent`.
 */
interface Internals {
  mapping: { set(instanceId: string, sid: string): Promise<void>; preload(): Promise<void> };
  client: {
    startCall: (...args: unknown[]) => Promise<{ callId: string | null }>;
    endCall: (...args: unknown[]) => Promise<void>;
  };
  handleSseEvent(event: Record<string, unknown>): void;
}

async function setup(startResult: () => Promise<{ callId: string | null }> = async () => ({ callId: "C1" })) {
  const provider = new AstraCallsProvider({
    apiUrl: "http://astra.invalid",
    apiKey: "k",
    sessionDir: mkdtempSync(path.join(tmpdir(), "astra-")),
    logger: pino({ level: "silent" }),
  });
  const internals = provider as unknown as Internals;
  // O construtor dispara o preload sem esperar; espera aqui para o set não
  // ser sobrescrito pela leitura do arquivo vazio.
  await internals.mapping.preload();
  await internals.mapping.set("inst-1", "sid-1");
  internals.client.startCall = startResult;
  internals.client.endCall = async () => undefined;
  const events: CallEvent[] = [];
  provider.on("call", (event) => events.push(event));
  const sse = (event: Record<string, unknown>) =>
    internals.handleSseEvent({ sessionId: "sid-1", peer: "5511999990000@s.whatsapp.net", ...event });
  return { provider, events, sse };
}

describe("AstraCalls — progresso da ligação de saída", () => {
  it("call-status ringing da chamada que discamos vira 'tocando' de SAÍDA, sem cara de recebida", async () => {
    const { provider, events, sse } = await setup();
    await provider.startCall("inst-1", "5511999990000");
    sse({ type: "call-status", id: "C1", status: "ringing" });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ status: "ringing", direction: "outbound", remoteRinging: true });
  });

  it("encerrada sem atender e sem motivo: não atendeu (o 'perdida' de sempre)", async () => {
    const { provider, events, sse } = await setup();
    await provider.startCall("inst-1", "5511999990000");
    sse({ type: "call-ended", id: "C1" });
    expect(events.at(-1)).toMatchObject({ status: "missed", endReason: "no_answer", direction: "outbound" });
  });

  it("ocupado e recusa têm motivo próprio", async () => {
    const a = await setup();
    await a.provider.startCall("inst-1", "5511999990000");
    a.sse({ type: "call-ended", id: "C1", reason: "busy" });
    expect(a.events.at(-1)).toMatchObject({ status: "missed", endReason: "busy" });

    const b = await setup();
    await b.provider.startCall("inst-1", "5511999990000");
    b.sse({ type: "call-ended", id: "C1", reason: "rejected" });
    expect(b.events.at(-1)).toMatchObject({ status: "rejected", endReason: "rejected" });
  });

  it("nós desligamos antes de atender: cancelada por nós, nunca perdida do cliente", async () => {
    const { provider, events, sse } = await setup();
    await provider.startCall("inst-1", "5511999990000");
    await provider.endCall("inst-1", "C1");
    sse({ type: "call-ended", id: "C1", reason: "timeout" });
    expect(events.at(-1)).toMatchObject({ status: "missed", endReason: "canceled" });
  });

  it("atendida e encerrada: completed, mesmo se nós desligamos depois", async () => {
    const { provider, events, sse } = await setup();
    await provider.startCall("inst-1", "5511999990000");
    sse({ type: "call-status", id: "C1", status: "connected" });
    await provider.endCall("inst-1", "C1");
    sse({ type: "call-ended", id: "C1" });
    expect(events.at(-1)).toMatchObject({ status: "ended", endReason: "completed" });
  });

  it("motivo desconhecido vira falha (o texto cru fica no log, não no evento)", async () => {
    const { provider, events, sse } = await setup();
    await provider.startCall("inst-1", "5511999990000");
    sse({ type: "call-ended", id: "C1", reason: "xyz_internal_42" });
    expect(events.at(-1)).toMatchObject({ endReason: "failed" });
    expect(JSON.stringify(events.at(-1))).not.toContain("xyz_internal_42");
  });

  it("número sem WhatsApp ao discar: CallStartError not_found", async () => {
    const { provider } = await setup(async () => {
      throw new AstraCallsHttpError("x", 400, '{"error":"number not on whatsapp"}');
    });
    await expect(provider.startCall("inst-1", "5511999990000")).rejects.toMatchObject({
      name: "CallStartError",
      reason: "not_found",
    });
  });

  it("erro genérico ao discar: CallStartError failed", async () => {
    const { provider } = await setup(async () => {
      throw new AstraCallsHttpError("x", 500, "boom");
    });
    const err = await provider.startCall("inst-1", "5511999990000").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CallStartError);
    expect((err as CallStartError).reason).toBe("failed");
  });

  it("chamada RECEBIDA não muda: incoming continua 'tocando' de entrada, sem motivo", async () => {
    const { events, sse } = await setup();
    sse({ type: "incoming", id: "R1" });
    sse({ type: "call-ended", id: "R1" });
    expect(events[0]).toMatchObject({ status: "ringing", direction: "inbound" });
    expect(events[0]?.remoteRinging).toBeUndefined();
    expect(events.at(-1)).toMatchObject({ status: "missed", direction: "inbound", endReason: "no_answer" });
  });
});

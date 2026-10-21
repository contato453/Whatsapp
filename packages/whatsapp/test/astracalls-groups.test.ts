import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import pino from "pino";
import { describe, expect, it } from "vitest";
import type { ProviderGroup } from "@azvchat/shared";
import { AstraCallsProvider } from "../src/astracalls/astracalls-provider.js";

/**
 * O AstraCalls não manda grupo nenhum sozinho (o Baileys manda). Sem estes
 * gatilhos, todo grupo criado depois da troca de provider ficava sem
 * participantes no AZVCHAT — sem lista no painel e sem "@".
 */
interface Internals {
  mapping: { set(instanceId: string, sid: string): Promise<void>; preload(): Promise<void> };
  client: { getGroups: (sid: string) => Promise<unknown[]> };
  handleSseEvent(event: Record<string, unknown>): void;
}

const GROUP = {
  jid: "120363000000000001@g.us",
  name: "GRUPO DO ADRIANO SPE",
  participants: [
    { jid: "5521999990000@s.whatsapp.net", number: "5521999990000", isAdmin: true },
    { jid: "1234567890@lid", pn: "5521988887777" },
  ],
};

async function setup(getGroups: () => Promise<unknown[]> = async () => [GROUP]) {
  const provider = new AstraCallsProvider({
    apiUrl: "http://astra.invalid",
    apiKey: "k",
    sessionDir: mkdtempSync(path.join(tmpdir(), "astra-")),
    logger: pino({ level: "silent" }),
  });
  const internals = provider as unknown as Internals;
  await internals.mapping.preload();
  await internals.mapping.set("inst-1", "sid-1");
  let calls = 0;
  internals.client.getGroups = async () => {
    calls += 1;
    return getGroups();
  };
  const syncs: Array<{ instanceId: string; groups: ProviderGroup[] }> = [];
  provider.on("groups-sync", (event) => syncs.push(event));
  return { provider, internals, syncs, calls: () => calls };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("AstraCalls — sincronização de grupos", () => {
  it("ao conectar, emite groups-sync com os participantes (telefone vindo de number ou pn)", async () => {
    const { internals, syncs } = await setup();
    internals.handleSseEvent({ type: "auth-state", sessionId: "sid-1", paired: true, state: "open" });
    await tick();
    await tick();
    expect(syncs).toHaveLength(1);
    const group = syncs[0]!.groups[0]!;
    expect(group).toMatchObject({ externalId: GROUP.jid, name: GROUP.name, participantCount: 2 });
    expect(group.participants.map((p) => p.phoneNumber)).toEqual(["5521999990000", "5521988887777"]);
    expect(group.participants[0]!.isAdmin).toBe(true);
  });

  it("aviso de participante entrou/saiu relê os grupos em vez de ser descartado", async () => {
    const { provider, syncs } = await setup();
    provider.handleWebhook({ session: "sid-1", event: "group_participants", data: { chat: GROUP.jid } });
    await tick();
    await tick();
    expect(syncs).toHaveLength(1);
  });

  it("rajada de avisos vira uma leitura mais um reforço, não uma por aviso", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { provider, calls } = await setup(async () => {
      await gate;
      return [GROUP];
    });
    for (let i = 0; i < 5; i += 1) {
      provider.handleWebhook({ session: "sid-1", event: "group_participants", data: {} });
    }
    await tick();
    expect(calls()).toBe(1);
    release();
    await tick();
    await tick();
    await tick();
    expect(calls()).toBe(2);
  });

  it("AstraCalls fora do ar não emite lista vazia nem lança", async () => {
    const { provider, syncs } = await setup(async () => {
      throw new Error("ECONNREFUSED");
    });
    provider.handleWebhook({ session: "sid-1", event: "group_participants", data: {} });
    await tick();
    await tick();
    expect(syncs).toHaveLength(0);
  });
});

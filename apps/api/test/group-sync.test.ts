import { describe, expect, it } from "vitest";
import { GroupSyncCoordinator, MISSING_GROUP_RETRY_MS } from "../src/services/group-sync.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

describe("GroupSyncCoordinator — grupo novo ganha participantes sem virar busca por mensagem", () => {
  it("pedidos simultâneos do mesmo número viram uma execução mais UM reforço", async () => {
    const gates: Array<ReturnType<typeof deferred>> = [];
    let calls = 0;
    const sync = new GroupSyncCoordinator(async () => {
      calls += 1;
      const gate = deferred();
      gates.push(gate);
      await gate.promise;
    });

    const first = sync.request("inst-1");
    const second = sync.request("inst-1");
    const third = sync.request("inst-1");
    expect(calls).toBe(1);

    gates[0]!.resolve();
    await new Promise((r) => setTimeout(r, 0));
    // O reforço: a primeira leitura pode ter vindo antes do grupo existir.
    expect(calls).toBe(2);
    gates[1]!.resolve();
    await Promise.all([first, second, third]);
    expect(calls).toBe(2);
  });

  it("números diferentes sincronizam em paralelo", async () => {
    const seen: string[] = [];
    const sync = new GroupSyncCoordinator(async (id) => {
      seen.push(id);
    });
    await Promise.all([sync.request("a"), sync.request("b")]);
    expect(seen.sort()).toEqual(["a", "b"]);
  });

  it("falha do provider não rejeita quem pediu e não trava o próximo pedido", async () => {
    let calls = 0;
    const sync = new GroupSyncCoordinator(async () => {
      calls += 1;
      throw new Error("astracalls fora do ar");
    });
    await expect(sync.request("inst-1")).resolves.toBeUndefined();
    await sync.request("inst-1");
    expect(calls).toBe(2);
  });

  it("grupo desconhecido que a busca não trouxe não dispara a lista inteira a cada mensagem", async () => {
    let now = 1_000;
    let calls = 0;
    const sync = new GroupSyncCoordinator(
      async () => {
        calls += 1;
      },
      () => now,
    );
    await sync.requestForMissingGroup("inst-1", "123@g.us");
    expect(sync.requestForMissingGroup("inst-1", "123@g.us")).toBeNull();
    // Outro grupo desconhecido pede de novo normalmente.
    await sync.requestForMissingGroup("inst-1", "456@g.us");
    expect(calls).toBe(2);
    now += MISSING_GROUP_RETRY_MS;
    await sync.requestForMissingGroup("inst-1", "123@g.us");
    expect(calls).toBe(3);
  });
});

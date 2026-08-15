import { beforeEach, describe, expect, it } from "vitest";
import { pruneDrafts, readDraft, saveDraft } from "@/lib/drafts";

/**
 * O que estes testes fixam: o rascunho sobrevive ao fim do horário de uso,
 * volta na conversa certa, do usuário certo e no modo certo.
 *
 * O modo é o ponto delicado: nota interna restaurada como mensagem seria
 * enviada ao cliente — texto escrito para a equipe ler, na mão de quem não
 * devia.
 */

/** `localStorage` de mentira, suficiente para o módulo (que só usa isto). */
function fakeStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    key: (index: number) => [...map.keys()][index] ?? null,
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => void map.set(key, value),
    removeItem: (key: string) => void map.delete(key),
    clear: () => map.clear(),
  } as Storage;
}

const ANA = "user-ana";
const BRUNO = "user-bruno";
const CONVERSA = "conversa-1";

describe("rascunho do composer", () => {
  beforeEach(() => {
    // O módulo lê `window.localStorage`; em ambiente node ele não existe.
    globalThis.window = { localStorage: fakeStorage() } as unknown as Window & typeof globalThis;
  });

  it("guarda e devolve o texto da conversa", () => {
    saveDraft(ANA, CONVERSA, { text: "Bom dia, seguem os documentos", mode: "message" });
    expect(readDraft(ANA, CONVERSA)).toEqual({
      text: "Bom dia, seguem os documentos",
      mode: "message",
    });
  });

  it("conversa sem rascunho vem vazia, em modo mensagem", () => {
    expect(readDraft(ANA, "conversa-sem-nada")).toEqual({ text: "", mode: "message" });
  });

  it("não mistura conversas — o texto de um cliente não vai para o outro", () => {
    saveDraft(ANA, "conversa-1", { text: "para o cliente A", mode: "message" });
    saveDraft(ANA, "conversa-2", { text: "para o cliente B", mode: "message" });
    expect(readDraft(ANA, "conversa-1").text).toBe("para o cliente A");
    expect(readDraft(ANA, "conversa-2").text).toBe("para o cliente B");
  });

  it("não mistura usuários — máquina compartilhada é o caso normal", () => {
    saveDraft(ANA, CONVERSA, { text: "rascunho da Ana", mode: "message" });
    expect(readDraft(BRUNO, CONVERSA).text).toBe("");
  });

  it("preserva o modo nota — restaurar como mensagem mandaria ao cliente", () => {
    saveDraft(ANA, CONVERSA, { text: "cliente devendo há 3 meses", mode: "note" });
    expect(readDraft(ANA, CONVERSA).mode).toBe("note");
  });

  it("texto vazio apaga a entrada", () => {
    saveDraft(ANA, CONVERSA, { text: "quase mandei", mode: "message" });
    saveDraft(ANA, CONVERSA, { text: "", mode: "message" });
    expect(readDraft(ANA, CONVERSA).text).toBe("");
    expect(window.localStorage.length).toBe(0);
  });

  it("entrada corrompida não derruba a Inbox", () => {
    window.localStorage.setItem(`zapdesk.draft.${ANA}.${CONVERSA}`, "{isto não é json");
    expect(readDraft(ANA, CONVERSA)).toEqual({ text: "", mode: "message" });
  });

  it("apaga rascunho parado há mais de uma semana e mantém o de hoje", () => {
    saveDraft(ANA, "antigo", { text: "de outra era", mode: "message" });
    saveDraft(ANA, "hoje", { text: "de agora", mode: "message" });
    const oitoDias = Date.now() + 8 * 24 * 60 * 60 * 1000;
    // Só o "antigo" envelhece: reescrevemos o de hoje com a data futura.
    saveDraftAt("hoje", oitoDias);
    pruneDrafts(oitoDias);
    expect(readDraft(ANA, "antigo").text).toBe("");
    expect(readDraft(ANA, "hoje").text).toBe("de agora");
  });

  /** Reescreve a entrada com um `updatedAt` escolhido, sem esperar o tempo passar. */
  function saveDraftAt(conversationId: string, updatedAt: number): void {
    window.localStorage.setItem(
      `zapdesk.draft.${ANA}.${conversationId}`,
      JSON.stringify({ text: "de agora", mode: "message", updatedAt }),
    );
  }

  it("sem `window` (render no servidor) não estoura", () => {
    // @ts-expect-error — o teste apaga o global de propósito.
    delete globalThis.window;
    expect(() => saveDraft(ANA, CONVERSA, { text: "x", mode: "message" })).not.toThrow();
    expect(readDraft(ANA, CONVERSA)).toEqual({ text: "", mode: "message" });
  });
});

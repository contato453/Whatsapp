import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { downloadMessageAudio } from "@/lib/media-download";
import type { MessageDto } from "@/lib/types";

/**
 * O ciclo do download: fetch AUTENTICADO → blob → salvamento → revogação.
 *
 * A revogação é o que impede a memória da aba de crescer ao longo do dia — o
 * escritório baixa áudio de comprovante várias vezes por turno, e cada blob não
 * revogado fica preso até recarregar a página.
 */

const mensagem = {
  id: "11111111-1111-1111-1111-111111111111",
  timestamp: "2026-09-02T14:32:10.000Z",
  mimeType: "audio/ogg; codecs=opus",
} as unknown as MessageDto;

let criadas: string[] = [];
let revogadas: string[] = [];
let baixados: { href: string; download: string }[] = [];
let pedidos: string[] = [];

beforeEach(() => {
  vi.useFakeTimers();
  criadas = [];
  revogadas = [];
  baixados = [];
  pedidos = [];
  let contador = 0;
  globalThis.URL.createObjectURL = vi.fn(() => {
    contador += 1;
    const url = `blob:fake/${contador}`;
    criadas.push(url);
    return url;
  });
  globalThis.URL.revokeObjectURL = vi.fn((url: string) => {
    revogadas.push(url);
  });
  // Âncora de mentira: guarda o que o navegador receberia para salvar.
  globalThis.document = {
    createElement: () => {
      const anchor = { href: "", download: "", click: () => baixados.push({ ...anchor }) };
      return anchor;
    },
  } as unknown as Document;
  globalThis.fetch = vi.fn(async (url: string | URL | Request) => {
    pedidos.push(String(url));
    return new Response(new Blob([new Uint8Array([1, 2, 3])]), { status: 200 });
  }) as unknown as typeof fetch;
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("downloadMessageAudio", () => {
  it("pede o MP3 pela rota autenticada de mídia, sem URL montada à mão", async () => {
    await downloadMessageAudio(mensagem, "Empresa Teste", "mp3");
    expect(pedidos).toHaveLength(1);
    expect(pedidos[0]).toMatch(/\/messages\/11111111-1111-1111-1111-111111111111\/media\?format=mp3$/);
  });

  it("o original vai pela MESMA rota, sem o parâmetro de formato", async () => {
    await downloadMessageAudio(mensagem, "Empresa Teste", "original");
    expect(pedidos[0]).toMatch(/\/media$/);
    expect(pedidos[0]).not.toContain("format=");
  });

  it("salva com o nome legível e revoga o blob depois", async () => {
    await downloadMessageAudio(mensagem, "Empresa Teste", "mp3");
    expect(baixados).toHaveLength(1);
    expect(baixados[0]?.download).toMatch(/^audio-empresa-teste-2026-09-02-\d{2}-\d{2}\.mp3$/);
    expect(baixados[0]?.href).toBe(criadas[0]);
    // Antes do prazo o blob ainda vale: revogar na hora cortaria o salvamento
    // de um áudio grande no meio.
    expect(revogadas).toHaveLength(0);
    vi.advanceTimersByTime(10_000);
    expect(revogadas).toEqual(criadas);
  });

  it("dez downloads seguidos revogam dez blobs — nada fica preso na aba", async () => {
    for (let i = 0; i < 10; i += 1) {
      await downloadMessageAudio(mensagem, "Empresa Teste", "mp3");
    }
    expect(criadas).toHaveLength(10);
    vi.advanceTimersByTime(10_000);
    expect(revogadas).toHaveLength(10);
    expect(new Set(revogadas).size).toBe(10);
  });

  it("erro da API não é engolido: a falha sobe para a bolha avisar", async () => {
    globalThis.fetch = vi.fn(async () => new Response("", { status: 404 })) as unknown as typeof fetch;
    await expect(downloadMessageAudio(mensagem, "Empresa Teste", "mp3")).rejects.toThrow();
    expect(baixados).toHaveLength(0);
  });

  it("sessão expirada (401) também sobe, em vez de virar download silencioso", async () => {
    globalThis.fetch = vi.fn(
      async () => new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 }),
    ) as unknown as typeof fetch;
    await expect(downloadMessageAudio(mensagem, "Empresa Teste", "mp3")).rejects.toMatchObject({
      status: 401,
    });
  });
});

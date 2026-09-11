import { describe, expect, it } from "vitest";
import { audioDownloadName, audioOriginalExtension } from "@/lib/media-download";
import type { MessageDto } from "@/lib/types";

const base = {
  timestamp: "2026-09-02T14:32:10.000Z",
  mimeType: "audio/ogg; codecs=opus",
} satisfies Pick<MessageDto, "timestamp" | "mimeType">;

/**
 * O nome do arquivo importa porque a equipe anexa o áudio em e-mail e em
 * processo: id de mensagem obrigaria a renomear tudo à mão, e caractere que o
 * sistema de arquivos recusa faz o salvamento falhar.
 */
describe("audioDownloadName", () => {
  it("monta nome legível com a conversa, a data e a hora", () => {
    const nome = audioDownloadName(base, "Empresa Teste", "mp3");
    expect(nome).toMatch(/^audio-empresa-teste-2026-09-02-\d{2}-\d{2}\.mp3$/);
  });

  it("higieniza barra, dois pontos e acento", () => {
    const nome = audioDownloadName(base, "Contábil / Fiscal: João", "mp3");
    expect(nome).toContain("contabil-fiscal-joao");
    expect(nome).not.toMatch(/[/\\:áâãéíóúç]/);
  });

  it("sem nome de conversa cai em 'conversa', nunca em nome vazio", () => {
    expect(audioDownloadName(base, null, "mp3")).toMatch(/^audio-conversa-/);
    expect(audioDownloadName(base, "###", "mp3")).toMatch(/^audio-conversa-/);
  });

  it("o original sai com a extensão do mime, não com .mp3", () => {
    expect(audioDownloadName(base, "Cliente", "original")).toMatch(/\.ogg$/);
    expect(audioDownloadName({ ...base, mimeType: "audio/mpeg" }, "Cliente", "original")).toMatch(
      /\.mp3$/,
    );
  });

  it("data inválida não produz nome quebrado", () => {
    expect(audioDownloadName({ ...base, timestamp: "nao-e-data" }, "Cliente", "mp3")).toBe(
      "audio-cliente-sem-data.mp3",
    );
  });
});

describe("audioOriginalExtension", () => {
  it("ignora o parâmetro do mime do WhatsApp", () => {
    expect(audioOriginalExtension("audio/ogg; codecs=opus")).toBe("ogg");
  });

  it("mime desconhecido ou ausente cai em ogg, que é o que o WhatsApp entrega", () => {
    expect(audioOriginalExtension(null)).toBe("ogg");
    expect(audioOriginalExtension("application/vnd.coisa.estranha")).toBe("ogg");
  });

  it("mp4 e mpeg continuam valendo", () => {
    expect(audioOriginalExtension("audio/mp4")).toBe("m4a");
    expect(audioOriginalExtension("audio/mpeg")).toBe("mp3");
  });
});

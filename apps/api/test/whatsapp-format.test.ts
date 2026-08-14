import { describe, expect, it } from "vitest";
import { parseWhatsAppText, stripWhatsAppFormatting } from "@azvchat/shared";

/**
 * Formatação de texto do WhatsApp. O risco aqui é o falso positivo:
 * transformar em negrito um asterisco que o cliente escreveu por acaso.
 */

describe("parseWhatsAppText", () => {
  it("reconhece negrito", () => {
    expect(parseWhatsAppText("*Fernanda:*")).toEqual([
      { type: "mark", mark: "bold", children: [{ type: "text", value: "Fernanda:" }] },
    ]);
  });

  it("mantém o texto ao redor da marcação", () => {
    expect(parseWhatsAppText("oi *tudo bem* então")).toEqual([
      { type: "text", value: "oi " },
      { type: "mark", mark: "bold", children: [{ type: "text", value: "tudo bem" }] },
      { type: "text", value: " então" },
    ]);
  });

  it("reconhece itálico, tachado e monoespaçado", () => {
    expect(parseWhatsAppText("_i_")[0]).toMatchObject({ mark: "italic" });
    expect(parseWhatsAppText("~t~")[0]).toMatchObject({ mark: "strike" });
    expect(parseWhatsAppText("```cod```")[0]).toMatchObject({ mark: "mono" });
  });

  it("aceita marcação aninhada", () => {
    expect(parseWhatsAppText("*_ambos_*")).toEqual([
      {
        type: "mark",
        mark: "bold",
        children: [{ type: "mark", mark: "italic", children: [{ type: "text", value: "ambos" }] }],
      },
    ]);
  });

  it("não formata asterisco no meio de palavra ou conta", () => {
    expect(parseWhatsAppText("2*3*4")).toEqual([{ type: "text", value: "2*3*4" }]);
    expect(parseWhatsAppText("nome_do_arquivo")).toEqual([
      { type: "text", value: "nome_do_arquivo" },
    ]);
  });

  it("não formata marcador sem fechamento", () => {
    expect(parseWhatsAppText("valor de *R$ 100")).toEqual([
      { type: "text", value: "valor de *R$ 100" },
    ]);
  });

  it("não formata quando há espaço colado ao marcador", () => {
    expect(parseWhatsAppText("* item da lista")).toEqual([
      { type: "text", value: "* item da lista" },
    ]);
  });

  it("não interpreta marcação dentro do monoespaçado", () => {
    expect(parseWhatsAppText("```a *b* c```")).toEqual([
      { type: "mark", mark: "mono", children: [{ type: "text", value: "a *b* c" }] },
    ]);
  });

  it("preserva quebras de linha", () => {
    expect(parseWhatsAppText("*Fernanda:*\nBoa tarde")).toEqual([
      { type: "mark", mark: "bold", children: [{ type: "text", value: "Fernanda:" }] },
      { type: "text", value: "\nBoa tarde" },
    ]);
  });

  it("texto vazio não gera segmento", () => {
    expect(parseWhatsAppText("")).toEqual([]);
  });
});

describe("stripWhatsAppFormatting", () => {
  it("devolve o texto sem os marcadores", () => {
    expect(stripWhatsAppFormatting("*Fernanda:*\nBoa _tarde_")).toBe("Fernanda:\nBoa tarde");
  });

  it("não mexe em texto sem marcação", () => {
    expect(stripWhatsAppFormatting("2*3*4")).toBe("2*3*4");
  });
});

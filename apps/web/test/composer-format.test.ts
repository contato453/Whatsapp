import { describe, expect, it } from "vitest";
import {
  applyComposerFormat,
  isComposerFormatActive,
  parseWhatsAppBlocks,
  type ComposerFormat,
} from "@azvchat/shared";

/**
 * A barra do composer escreve a marcação do WhatsApp no texto puro. As duas
 * famílias de botão agem de forma DIFERENTE de propósito: negrito e companhia
 * ENVOLVEM a seleção, lista e citação PREFIXAM CADA LINHA. Tratar lista como
 * "envolver" produziria uma lista quebrada, com um item só.
 */

/** Atalho: aplica sobre o trecho delimitado por "[" e "]" no texto do teste. */
function aplicar(marcado: string, format: ComposerFormat): string {
  const start = marcado.indexOf("[");
  const end = marcado.indexOf("]") - 1;
  const text = marcado.replace("[", "").replace("]", "");
  const resultado = applyComposerFormat({ text, start, end }, format);
  return resultado ? resultado.text : text;
}

describe("applyComposerFormat — envolver", () => {
  it("envolve a seleção com o marcador do WhatsApp", () => {
    expect(aplicar("bom [dia] cliente", "bold")).toBe("bom *dia* cliente");
    expect(aplicar("bom [dia] cliente", "italic")).toBe("bom _dia_ cliente");
    expect(aplicar("bom [dia] cliente", "strike")).toBe("bom ~dia~ cliente");
    expect(aplicar("bom [dia] cliente", "mono")).toBe("bom ```dia``` cliente");
  });

  it("alterna: em cima de um trecho já formatado, remove em vez de empilhar", () => {
    expect(aplicar("bom [*dia*] cliente", "bold")).toBe("bom dia cliente");
    // Seleção da palavra no meio do trecho formatado também remove — nunca
    // abre um segundo par dentro do primeiro, que corromperia a marcação.
    expect(aplicar("bom *[dia]* cliente", "bold")).toBe("bom dia cliente");
  });

  it("não duplica marcação em texto colado que já vem formatado", () => {
    expect(aplicar("[*proposta enviada*]", "bold")).toBe("proposta enviada");
  });

  it("deixa o espaço das bordas FORA do marcador", () => {
    // "* texto *" não é negrito no WhatsApp: marcador colado em espaço não
    // fecha, e arrastar o mouse quase sempre pega o espaço da ponta.
    expect(aplicar("bom [dia ]cliente", "bold")).toBe("bom *dia* cliente");
  });

  it("aplica no trecho inteiro quando a seleção atravessa várias linhas", () => {
    expect(aplicar("[linha um\nlinha dois]", "bold")).toBe("*linha um\nlinha dois*");
  });

  it("acumula formatação: itálico por cima do negrito mantém os dois", () => {
    const negrito = applyComposerFormat({ text: "bom dia", start: 4, end: 7 }, "bold");
    expect(negrito?.text).toBe("bom *dia*");
    const italico = applyComposerFormat(
      { text: negrito!.text, start: negrito!.start, end: negrito!.end },
      "italic",
    );
    expect(italico?.text).toBe("bom *_dia_*");
  });

  it("não mexe no campo vazio nem na seleção só com espaço", () => {
    expect(applyComposerFormat({ text: "", start: 0, end: 0 }, "bold")).toBeNull();
    expect(applyComposerFormat({ text: "   ", start: 0, end: 3 }, "bold")).toBeNull();
  });

  it("preserva menção e variável de resposta rápida dentro da seleção", () => {
    expect(aplicar("[@5511999998888 confira]", "bold")).toBe("*@5511999998888 confira*");
    expect(aplicar("cliente [AZEVEDO CONTABIL LTDA]", "bold")).toBe(
      "cliente *AZEVEDO CONTABIL LTDA*",
    );
  });
});

describe("applyComposerFormat — prefixar cada linha", () => {
  it("numera as linhas selecionadas, em ordem", () => {
    expect(aplicar("[um\ndois\ntrês]", "ordered_list")).toBe("1. um\n2. dois\n3. três");
  });

  it("renumera do começo, ignorando o número que estava escrito", () => {
    expect(aplicar("[3. um\ndois]", "ordered_list")).toBe("1. um\n2. dois");
  });

  it("marca cada linha da lista com marcadores", () => {
    expect(aplicar("[um\ndois]", "bullet_list")).toBe("- um\n- dois");
  });

  it("prefixa cada linha da citação, e não só a primeira", () => {
    expect(aplicar("[um\ndois]", "quote")).toBe("> um\n> dois");
  });

  it("alterna: clicar de novo tira o prefixo de todas as linhas", () => {
    expect(aplicar("[1. um\n2. dois]", "ordered_list")).toBe("um\ndois");
    expect(aplicar("[- um\n- dois]", "bullet_list")).toBe("um\ndois");
    expect(aplicar("[> um\n> dois]", "quote")).toBe("um\ndois");
  });

  it("troca um tipo de lista pelo outro em vez de empilhar marcador", () => {
    expect(aplicar("[- um\n- dois]", "ordered_list")).toBe("1. um\n2. dois");
  });

  it("citação convive com a lista: o marcador de linha vai depois do '>'", () => {
    expect(aplicar("[- um\n- dois]", "quote")).toBe("> - um\n> - dois");
  });

  it("estica a seleção parcial até as bordas da linha", () => {
    expect(aplicar("prim[eira\nseg]unda", "bullet_list")).toBe("- primeira\n- segunda");
  });

  it("não marca linha em branco no meio da seleção", () => {
    expect(aplicar("[um\n\ndois]", "bullet_list")).toBe("- um\n\n- dois");
  });

  it("devolve a seleção cobrindo o bloco reescrito", () => {
    const resultado = applyComposerFormat({ text: "um\ndois", start: 0, end: 6 }, "bullet_list");
    expect(resultado).toEqual({ text: "- um\n- dois", start: 0, end: 11 });
  });
});

describe("isComposerFormatActive", () => {
  it("acende o botão do que já está aplicado", () => {
    expect(isComposerFormatActive({ text: "bom *dia*", start: 5, end: 8 }, "bold")).toBe(true);
    expect(isComposerFormatActive({ text: "bom *dia*", start: 5, end: 8 }, "italic")).toBe(false);
    expect(isComposerFormatActive({ text: "> um\n> dois", start: 0, end: 11 }, "quote")).toBe(true);
  });

  it("seleção vazia não acende nada", () => {
    expect(isComposerFormatActive({ text: "bom *dia*", start: 3, end: 3 }, "bold")).toBe(false);
  });
});

/**
 * A exibição precisa acompanhar: botão que produz símbolo que ninguém
 * interpreta é pior do que não ter botão.
 */
describe("parseWhatsAppBlocks", () => {
  it("mantém a mensagem comum como um parágrafo só", () => {
    expect(parseWhatsAppBlocks("bom dia\ntudo bem?")).toEqual([
      { type: "paragraph", value: "bom dia\ntudo bem?" },
    ]);
  });

  it("agrupa as linhas da lista num bloco, com o número escrito", () => {
    expect(parseWhatsAppBlocks("1. um\n2. dois")).toEqual([
      {
        type: "list",
        ordered: true,
        items: [
          { marker: "1.", value: "um" },
          { marker: "2.", value: "dois" },
        ],
      },
    ]);
  });

  it("agrupa a citação e devolve o texto sem o '>'", () => {
    expect(parseWhatsAppBlocks("> um\n> dois")).toEqual([{ type: "quote", value: "um\ndois" }]);
  });

  it("separa parágrafo, lista e citação na mesma mensagem", () => {
    const blocos = parseWhatsAppBlocks("Segue:\n- um\n- dois\n> observação");
    expect(blocos.map((bloco) => bloco.type)).toEqual(["paragraph", "list", "quote"]);
  });

  it("não quebra o monoespaçado de várias linhas em blocos de linha", () => {
    expect(parseWhatsAppBlocks("```\n- um\n- dois\n```")).toEqual([
      { type: "paragraph", value: "```\n- um\n- dois\n```" },
    ]);
  });
});

import { describe, expect, it } from "vitest";
import { matchQuickReply, quickReplySearchTerms } from "@/lib/quick-reply-search";

/**
 * O que estes testes fixam: a busca cobre atalho, título e CONTEÚDO ao mesmo
 * tempo (é por ele que a pessoa procura, mais do que pelo atalho decorado),
 * ignora acento e maiúscula, aceita várias palavras em qualquer campo e
 * marca o casamento no conteúdo — que é o sinal para abrir expandido.
 */

const RESPOSTA_CERTIFICADO = {
  shortcut: "alteracaocnpj",
  title: "Alteração de CNPJ",
  content: "Para emitir a nota, primeiro renove o certificado digital da empresa.",
};

describe("quickReplySearchTerms", () => {
  it("ignora a barra digitada por hábito", () => {
    expect(quickReplySearchTerms("/nota")).toEqual(quickReplySearchTerms("nota"));
  });

  it("quebra em palavras, sem acento e minúsculas", () => {
    expect(quickReplySearchTerms("Recibo PAGAMENTO")).toEqual(["recibo", "pagamento"]);
  });

  it("string vazia não gera termo nenhum", () => {
    expect(quickReplySearchTerms("   ")).toEqual([]);
  });
});

describe("matchQuickReply", () => {
  it("sem termo nenhum, casa tudo e não destaca nada", () => {
    const match = matchQuickReply(RESPOSTA_CERTIFICADO, []);
    expect(match).not.toBeNull();
    expect(match?.matchedContent).toBe(false);
    expect(match?.shortcut.every((segment) => !segment.highlighted)).toBe(true);
  });

  it("acha palavra que só existe no meio do conteúdo, e marca matchedContent", () => {
    const match = matchQuickReply(RESPOSTA_CERTIFICADO, quickReplySearchTerms("certificado"));
    expect(match).not.toBeNull();
    expect(match?.matchedContent).toBe(true);
    const destacado = match?.content.filter((segment) => segment.highlighted).map((s) => s.text);
    expect(destacado).toEqual(["certificado"]);
  });

  it("ignora acento e maiúscula", () => {
    // "Certificado" com maiúscula acha o "certificado" cadastrado em minúsculas.
    const semAcento = matchQuickReply(RESPOSTA_CERTIFICADO, quickReplySearchTerms("Certificado"));
    expect(semAcento?.matchedContent).toBe(true);

    // Buscar sem acento acha a palavra acentuada cadastrada no texto.
    const respostaComAcento = {
      shortcut: "renovacao",
      title: null,
      content: "Lembre-se de renovar o certificado antes da renovação vencer.",
    };
    const match = matchQuickReply(respostaComAcento, quickReplySearchTerms("renovacao"));
    expect(match?.matchedContent).toBe(true);
  });

  it("acha parte do atalho", () => {
    const match = matchQuickReply(RESPOSTA_CERTIFICADO, quickReplySearchTerms("cnpj"));
    expect(match).not.toBeNull();
    expect(match?.matchedContent).toBe(false);
    expect(match?.shortcut.some((segment) => segment.highlighted)).toBe(true);
  });

  it("várias palavras, em qualquer ordem e em campos diferentes", () => {
    const resposta = {
      shortcut: "recibo",
      title: null,
      content: "Segue o recibo de pagamento em anexo.",
    };
    // "pagamento" e "recibo" fora de ordem, ambas dentro do conteúdo.
    const match = matchQuickReply(resposta, quickReplySearchTerms("pagamento recibo"));
    expect(match).not.toBeNull();
    expect(match?.matchedContent).toBe(true);

    // "recibo" bate no atalho, "pagamento" só no conteúdo — ainda acha.
    const cruzado = matchQuickReply(resposta, quickReplySearchTerms("recibo pagamento"));
    expect(cruzado).not.toBeNull();
  });

  it("palavra que não aparece em campo nenhum derruba o item", () => {
    const match = matchQuickReply(RESPOSTA_CERTIFICADO, quickReplySearchTerms("boleto"));
    expect(match).toBeNull();
  });

  it("uma palavra presente e outra ausente também derruba o item", () => {
    const match = matchQuickReply(RESPOSTA_CERTIFICADO, quickReplySearchTerms("certificado boleto"));
    expect(match).toBeNull();
  });

  it("busca por nome de variável acha as respostas que a usam", () => {
    const resposta = {
      shortcut: "boasvindas",
      title: null,
      content: "Olá {{cliente.razao_social}}, seja bem-vindo!",
    };
    const match = matchQuickReply(resposta, quickReplySearchTerms("razao_social"));
    expect(match?.matchedContent).toBe(true);
  });

  it("título ausente não quebra e não casa nada", () => {
    const resposta = { shortcut: "boasvindas", title: null, content: "Olá!" };
    const match = matchQuickReply(resposta, quickReplySearchTerms("boasvindas"));
    expect(match).not.toBeNull();
    expect(match?.title).toEqual([{ text: "", highlighted: false }]);
  });
});

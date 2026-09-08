import { describe, expect, it } from "vitest";
import { chunkSource, retrieveKnowledge, tokenize } from "../src/services/ai/knowledge.js";

const SERVICOS = {
  id: "s1",
  title: "Serviços",
  kind: "text" as const,
  content: [
    "Abertura de empresa: cuidamos do registro na Junta Comercial, CNPJ, inscrição municipal e alvará. O prazo médio é de 15 dias úteis.",
    "Contabilidade mensal: escrituração, apuração de impostos e entrega das obrigações acessórias do Simples Nacional, Lucro Presumido e Lucro Real.",
    "Departamento pessoal: admissão, folha de pagamento, férias, rescisão e eSocial.",
  ].join("\n\n"),
};

const FAQ = {
  id: "s2",
  title: "FAQ Comercial",
  kind: "faq" as const,
  content: "P: Vocês atendem MEI?\nR: Sim, atendemos MEI com plano específico.\n\nP: Qual o horário de atendimento?\nR: De segunda a sexta, das 8h às 18h.",
};

describe("base de conhecimento — recuperação lexical", () => {
  it("normaliza acento e plural na tokenização", () => {
    expect(tokenize("Empresas contábeis e Impostos")).toEqual(["empresa", "contabei", "imposto"]);
  });

  it("FAQ vira um trecho por par pergunta/resposta", () => {
    const chunks = chunkSource(FAQ);
    expect(chunks).toHaveLength(2);
    expect(chunks[0]?.text).toContain("MEI");
  });

  it("devolve o trecho certo para a pergunta, com a fonte", () => {
    const hits = retrieveKnowledge([SERVICOS, FAQ], "quanto tempo demora para abrir uma empresa?");
    expect(hits[0]?.sourceTitle).toBe("Serviços");
    expect(hits[0]?.text).toContain("Abertura de empresa");
  });

  it("pergunta do FAQ acha a resposta do FAQ", () => {
    const hits = retrieveKnowledge([SERVICOS, FAQ], "vocês atendem mei?");
    expect(hits[0]?.sourceTitle).toBe("FAQ Comercial");
  });

  it("sem termo em comum não devolve nada — contexto errado é pior que nenhum", () => {
    expect(retrieveKnowledge([SERVICOS, FAQ], "xyzabc qwerty")).toEqual([]);
    expect(retrieveKnowledge([SERVICOS, FAQ], "olá bom dia")).toEqual([]);
  });

  it("respeita o teto de trechos e de caracteres", () => {
    const hits = retrieveKnowledge([SERVICOS, FAQ], "empresa impostos folha pagamento MEI", { topK: 2 });
    expect(hits.length).toBeLessThanOrEqual(2);
    const small = retrieveKnowledge([SERVICOS], "abertura empresa", { maxChars: 10 });
    expect(small).toEqual([]);
  });

  it("fonte extraída de link/documento é quebrada exatamente como texto livre", () => {
    // `url` e `document` só mudam COMO o campo `content` foi preenchido —
    // depois de salva, a fonte não tem tratamento especial nenhum aqui.
    const viaLink = { ...SERVICOS, id: "s3", kind: "url" as const };
    const viaArquivo = { ...SERVICOS, id: "s4", kind: "document" as const };
    expect(chunkSource(viaLink)).toEqual(chunkSource(SERVICOS).map((chunk) => ({ ...chunk, sourceId: "s3" })));
    expect(chunkSource(viaArquivo)).toEqual(chunkSource(SERVICOS).map((chunk) => ({ ...chunk, sourceId: "s4" })));
  });
});

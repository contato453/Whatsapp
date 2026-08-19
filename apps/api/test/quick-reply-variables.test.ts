import { describe, expect, it } from "vitest";
import {
  QUICK_REPLY_VARIABLES,
  buildQuickReplyConversationContext,
  detectManualPlaceholders,
  previewQuickReplyTemplate,
  quickReplyTemplateHasVariables,
  quickReplyVariableToken,
  resolveQuickReplyTemplate,
  unknownQuickReplyVariables,
  type AzevedoOsCompany,
  type QuickReplyVariableContext,
} from "@azvchat/shared";

/**
 * O catálogo de variáveis da resposta rápida.
 *
 * O que precisa ficar trancado aqui é o que só apareceria na mensagem já
 * entregue ao cliente: variável que não resolveu virando vazio, nome de
 * variável inexistente salvo em silêncio, e campo financeiro entrando no
 * catálogo por descuido.
 */

const AGORA = new Date(2026, 2, 5, 14, 30); // 05/03/2026, hora local

function empresa(overrides: Partial<AzevedoOsCompany> = {}): AzevedoOsCompany {
  return {
    id: "empresa-1",
    companyNumber: "1042",
    legalName: "Azevedo Comércio de Alimentos Ltda",
    tradeName: "Mercado Azevedo",
    cnpj: "12.345.678/0001-90",
    status: "active",
    statusLabel: "Ativo",
    taxRegime: "Simples Nacional",
    payrollInfo: "Com folha",
    contacts: [],
    ...overrides,
  };
}

function contexto(overrides: Partial<QuickReplyVariableContext> = {}): QuickReplyVariableContext {
  return {
    company: empresa(),
    conversation: buildQuickReplyConversationContext({
      customTitle: null,
      title: "Mercado Azevedo",
      externalChatId: "5511999998888@s.whatsapp.net",
      departmentName: "Fiscal",
      assigneeName: "Tatiana Ribeiro",
    }),
    agent: { name: "Camila Souza" },
    now: AGORA,
    ...overrides,
  };
}

describe("catálogo", () => {
  it("não expõe nenhum dado financeiro", () => {
    // Honorário, inadimplência e valor de contrato são do Financeiro e da
    // Diretoria no Azevedo-OS. Uma variável aqui entregaria o dado a
    // qualquer atendente com um atalho de duas letras.
    const proibidos = [
      "honorario",
      "honorário",
      "inadimpl",
      "contrato",
      "valor",
      "mensalidade",
      "financeiro",
      "faturamento",
      "cobranca",
      "cobrança",
    ];
    for (const variable of QUICK_REPLY_VARIABLES) {
      const texto = `${variable.name} ${variable.label} ${variable.description}`.toLowerCase();
      for (const proibido of proibidos) {
        expect(texto).not.toContain(proibido);
      }
    }
  });

  it("tem nome técnico único e no formato da sintaxe", () => {
    const nomes = QUICK_REPLY_VARIABLES.map((variable) => variable.name);
    expect(new Set(nomes).size).toBe(nomes.length);
    for (const nome of nomes) {
      expect(nome).toMatch(/^[a-z]+\.[a-z0-9_]+$/);
    }
  });
});

describe("resolução", () => {
  it("substitui as variáveis pelo dado da empresa vinculada", () => {
    const resultado = resolveQuickReplyTemplate(
      "Olá, {{empresa.razao_social}} (nº {{empresa.numero}}). Aqui é a {{atendente.primeiro_nome}}.",
      contexto(),
    );
    expect(resultado.text).toBe(
      "Olá, Azevedo Comércio de Alimentos Ltda (nº 1042). Aqui é a Camila.",
    );
    expect(resultado.unresolved).toEqual([]);
  });

  it("conversa SEM empresa vinculada deixa a variável destacada, nunca vazia", () => {
    const resultado = resolveQuickReplyTemplate(
      "CNPJ: {{empresa.cnpj}}",
      contexto({ company: null }),
    );
    expect(resultado.text).toBe("CNPJ: [CNPJ]");
    expect(resultado.unresolved.map((item) => item.name)).toEqual(["empresa.cnpj"]);
  });

  it("campo em branco no cadastro é tratado como não resolvido", () => {
    const resultado = resolveQuickReplyTemplate(
      "Regime: {{empresa.regime_tributario}}",
      contexto({ company: empresa({ taxRegime: "   " }) }),
    );
    expect(resultado.text).toBe("Regime: [Regime tributário]");
    expect(resultado.unresolved).toHaveLength(1);
  });

  it("nunca deixa a chave técnica no texto de uma variável conhecida", () => {
    const resultado = resolveQuickReplyTemplate("{{empresa.cnpj}}", contexto({ company: null }));
    expect(resultado.text).not.toContain("{{");
    expect(resultado.text).not.toContain("}}");
  });

  it("preserva a formatação do WhatsApp em volta da variável", () => {
    const resultado = resolveQuickReplyTemplate("*{{empresa.nome_fantasia}}*", contexto());
    expect(resultado.text).toBe("*Mercado Azevedo*");
  });

  it("conversa de grupo resolve a empresa igual, e fica sem telefone", () => {
    const resultado = resolveQuickReplyTemplate(
      "{{empresa.nome_fantasia}} — {{conversa.telefone}}",
      contexto({
        conversation: buildQuickReplyConversationContext({
          customTitle: "Mercado Azevedo — Fiscal",
          title: "Grupo do Mercado",
          externalChatId: "1203630001@g.us",
          departmentName: "Fiscal",
          assigneeName: null,
        }),
      }),
    );
    expect(resultado.text).toBe("Mercado Azevedo — [Telefone]");
  });

  it("o apelido da equipe vence o título vindo do WhatsApp", () => {
    const resultado = resolveQuickReplyTemplate(
      "{{conversa.nome}}",
      contexto({
        conversation: buildQuickReplyConversationContext({
          customTitle: "Mercado Azevedo — Fiscal",
          title: "Grupo do Mercado",
          externalChatId: "1203630001@g.us",
          departmentName: null,
          assigneeName: null,
        }),
      }),
    );
    expect(resultado.text).toBe("Mercado Azevedo — Fiscal");
  });

  it("LID não vira telefone", () => {
    const contexto_ = buildQuickReplyConversationContext({
      customTitle: null,
      title: "Contato",
      externalChatId: "182736451234567@lid",
      departmentName: null,
      assigneeName: null,
    });
    expect(contexto_.phone).toBeNull();
  });

  it("resposta sem variável nenhuma sai idêntica ao texto cadastrado", () => {
    const texto = "Bom dia! Já estamos verificando e retornamos ainda hoje.";
    const resultado = resolveQuickReplyTemplate(texto, contexto({ company: null, agent: null }));
    expect(resultado.text).toBe(texto);
    expect(resultado.unresolved).toEqual([]);
    expect(quickReplyTemplateHasVariables(texto)).toBe(false);
  });

  it("as datas são calculadas, e a competência anterior vira dezembro em janeiro", () => {
    expect(resolveQuickReplyTemplate("{{data.hoje}}", contexto()).text).toBe("05/03/2026");
    expect(resolveQuickReplyTemplate("{{data.competencia}}", contexto()).text).toBe("03/2026");
    expect(
      resolveQuickReplyTemplate(
        "{{data.competencia_anterior}}",
        contexto({ now: new Date(2026, 0, 9) }),
      ).text,
    ).toBe("12/2025");
  });
});

describe("validação do cadastro", () => {
  it("aponta o nome inexistente, com as chaves, e aceita o que existe", () => {
    expect(unknownQuickReplyVariables("Olá {{empresa.razao}} de {{empresa.cnpj}}")).toEqual([
      "{{empresa.razao}}",
    ]);
    expect(unknownQuickReplyVariables("Olá {{empresa.razao_social}}")).toEqual([]);
  });

  it("aceita espaço em volta do nome", () => {
    expect(unknownQuickReplyVariables("{{ empresa.cnpj }}")).toEqual([]);
    expect(resolveQuickReplyTemplate("{{ empresa.cnpj }}", contexto()).text).toBe(
      "12.345.678/0001-90",
    );
  });

  it("a pré-visualização usa o exemplo de cada variável", () => {
    expect(previewQuickReplyTemplate("Olá, {{empresa.razao_social}}!")).toContain("Azevedo");
  });

  it("escreve o token na sintaxe da casa", () => {
    expect(quickReplyVariableToken("empresa.cnpj")).toBe("{{empresa.cnpj}}");
  });
});

describe("marcador escrito à mão", () => {
  it("aponta o marcador antigo e sugere a variável, sem converter nada", () => {
    const achados = detectManualPlaceholders("Prezado [nome do cliente], segue o boleto.");
    expect(achados).toHaveLength(1);
    expect(achados[0]?.raw).toBe("[nome do cliente]");
    expect(achados[0]?.suggestion?.name).toBe("conversa.nome");
  });

  it("texto sem colchete não gera aviso nenhum", () => {
    expect(detectManualPlaceholders("Bom dia, tudo certo por aí?")).toEqual([]);
  });
});

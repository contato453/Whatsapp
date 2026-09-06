import { describe, expect, it } from "vitest";
import { defaultAiAgentConfig, agentAllowsTool } from "@azvchat/shared";
import { buildHandoffSummary, buildSystemPrompt, type PromptContext } from "../src/services/ai/prompt-builder.js";
import { buildToolDefinitions } from "../src/services/ai/tools.js";
import { aiAgentConfigSchema, parseStoredAgentConfig } from "../src/services/ai/config-schema.js";

/**
 * O prompt é MONTADO a partir dos campos estruturados: o que a tela mostra
 * como caixa de seleção precisa aparecer (ou sumir) nas instruções, e as
 * ferramentas oferecidas ao modelo têm de seguir as capacidades — não o
 * contrário.
 */

function context(overrides: Partial<PromptContext> = {}): PromptContext {
  return {
    agentName: "IA Comercial",
    organizationName: "Azevedo",
    customerName: "João Silva",
    conversationType: "individual",
    departmentName: "Comercial",
    tagNames: ["Lead"],
    collected: { nome: "João" },
    summary: null,
    company: null,
    knowledge: [{ sourceId: "s", sourceTitle: "Serviços", text: "Abertura de empresa leva 15 dias.", score: 1 }],
    today: "sábado, 6 de setembro de 2026",
    remainingAiMessages: 12,
    ...overrides,
  };
}

describe("buildSystemPrompt", () => {
  it("leva objetivo, regras proibidas, gatilhos e trechos da base", () => {
    const config = defaultAiAgentConfig();
    config.objective = "Qualificar leads de abertura de empresa.";
    config.cannotDo = "- não conceder descontos;";
    config.handoff.customTriggers = "Cliente perguntar sobre processo trabalhista.";
    config.dataCollection.fields = [
      { key: "nome", label: "Nome", required: true, hint: "" },
      { key: "cidade", label: "Cidade", required: false, hint: "" },
    ];
    const prompt = buildSystemPrompt(config, context());
    expect(prompt).toContain("Qualificar leads de abertura de empresa.");
    expect(prompt).toContain("não conceder descontos");
    expect(prompt).toContain("Cliente solicitar atendente humano");
    expect(prompt).toContain("processo trabalhista");
    expect(prompt).toContain("Abertura de empresa leva 15 dias.");
    // Dado já coletado é marcado para não ser perguntado de novo.
    expect(prompt).toMatch(/Nome \[nome\].*JÁ INFORMADO: "João"/);
    expect(prompt).toMatch(/Cidade \[cidade\].*ainda não informado/);
    expect(prompt).toContain("Trate o cliente pelo primeiro nome (João)");
    expect(prompt).toContain("Não use emojis.");
  });

  it("sem links autorizados o prompt proíbe links; com a capacidade, lista só os permitidos", () => {
    const config = defaultAiAgentConfig();
    expect(buildSystemPrompt(config, context())).toContain("Não envie links de nenhum tipo.");
    config.canDo.capabilities.send_links = true;
    config.canDo.allowedLinks = ["https://exemplo.com/formulario"];
    const prompt = buildSystemPrompt(config, context());
    expect(prompt).toContain("https://exemplo.com/formulario");
    expect(prompt).toContain("EXATAMENTE estes links");
  });

  it("conhecimento geral só entra quando permitido", () => {
    const config = defaultAiAgentConfig();
    expect(buildSystemPrompt(config, context())).toContain("Conhecimento geral NÃO é fonte");
    config.knowledge.allowGeneralKnowledge = true;
    expect(buildSystemPrompt(config, context())).toContain("5º conhecimento geral");
  });
});

describe("buildToolDefinitions — ferramenta segue a capacidade", () => {
  const toolContext = { hasKnowledge: true, canLookupCompany: true, tagNames: ["Lead"], collectFieldKeys: ["nome"] };

  it("padrão de fábrica: transferir, concluir, coletar, etiquetar e buscar; não remover etiqueta nem follow-up", () => {
    const config = defaultAiAgentConfig();
    const names = buildToolDefinitions(config, toolContext).map((tool) => tool.name);
    expect(names).toContain("transfer_to_human");
    expect(names).toContain("finish_conversation");
    expect(names).toContain("save_collected_data");
    expect(names).toContain("add_tag");
    expect(names).toContain("search_knowledge_base");
    expect(names).not.toContain("remove_tag");
    expect(names).not.toContain("schedule_followup");
    expect(names).not.toContain("lookup_company");
  });

  it("desligar a capacidade tira a ferramenta — e agentAllowsTool concorda", () => {
    const config = defaultAiAgentConfig();
    config.canDo.capabilities.transfer = false;
    config.canDo.capabilities.add_tags = false;
    const names = buildToolDefinitions(config, toolContext).map((tool) => tool.name);
    expect(names).not.toContain("transfer_to_human");
    expect(names).not.toContain("add_tag");
    expect(agentAllowsTool(config, "transfer_to_human")).toBe(false);
    expect(agentAllowsTool(config, "finish_conversation")).toBe(true);
  });

  it("sem fonte de conhecimento e sem etiqueta aplicável, as ferramentas nem aparecem", () => {
    const config = defaultAiAgentConfig();
    const names = buildToolDefinitions(config, { hasKnowledge: false, canLookupCompany: false, tagNames: [], collectFieldKeys: [] }).map((tool) => tool.name);
    expect(names).not.toContain("search_knowledge_base");
    expect(names).not.toContain("add_tag");
    expect(names).not.toContain("save_collected_data");
  });
});

describe("configuração do agente", () => {
  it("o padrão de fábrica passa no Zod da rota", () => {
    expect(aiAgentConfigSchema.safeParse(defaultAiAgentConfig()).success).toBe(true);
  });

  it("JSON gravado antes de um campo novo existir ganha o padrão do campo", () => {
    const stored = { objective: "x", canDo: { capabilities: { transfer: false } }, limits: { maxAiMessages: 5 } };
    const parsed = parseStoredAgentConfig(stored);
    expect(parsed.objective).toBe("x");
    expect(parsed.limits.maxAiMessages).toBe(5);
    expect(parsed.limits.maxFailedAttempts).toBe(3);
    expect(parsed.canDo.capabilities.transfer).toBe(false);
    expect(parsed.canDo.capabilities.finish).toBe(true);
  });

  it("campo repetido em dados a coletar é recusado", () => {
    const config = defaultAiAgentConfig();
    config.dataCollection.fields = [
      { key: "nome", label: "Nome", required: true, hint: "" },
      { key: "nome", label: "Nome 2", required: true, hint: "" },
    ];
    expect(aiAgentConfigSchema.safeParse(config).success).toBe(false);
  });
});

describe("buildHandoffSummary", () => {
  it("o atendente recebe cliente, assunto, dados coletados e motivo", () => {
    const summary = buildHandoffSummary({
      agentName: "IA Comercial",
      customerName: "João",
      subject: "Abertura de empresa",
      need: "Abrir empresa de serviços",
      summary: "Cliente quer abrir este mês.",
      reason: "Solicitou proposta comercial",
      collected: { cidade: "Niterói" },
      fields: [
        { key: "cnpj", label: "CNPJ", required: false, hint: "" },
        { key: "cidade", label: "Cidade", required: false, hint: "" },
      ],
      aiMessages: 4,
      customerMessages: 5,
    });
    expect(summary).toContain("RESUMO DO ATENDIMENTO POR IA (IA Comercial)");
    expect(summary).toContain("Cliente: João");
    expect(summary).toContain("Assunto: Abertura de empresa");
    expect(summary).toContain("- CNPJ: não informado");
    expect(summary).toContain("- Cidade: Niterói");
    expect(summary).toContain("Motivo da transferência: Solicitou proposta comercial");
  });
});

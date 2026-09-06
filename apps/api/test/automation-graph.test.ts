import { describe, expect, it } from "vitest";
import {
  AUTOMATION_TEMPLATES,
  emptyAutomationGraph,
  resolveAutomationTemplate,
  validateAutomationGraph,
  type AutomationGraph,
} from "@azvchat/shared";

/**
 * Validação do grafo do construtor visual (seção 25) e resolução das
 * variáveis de mensagem do fluxo — a parte que não depende de banco.
 *
 * O que precisa ficar trancado: um fluxo sem gatilho, com bloco solto, com
 * condição faltando um dos dois caminhos ou menu com opção sem destino não
 * pode publicar; e os templates prontos (seção 21/22), que a equipe usa
 * como ponto de partida, precisam nascer já válidos.
 */

function baseGraph(): AutomationGraph {
  return {
    nodes: [
      { id: "trigger", type: "trigger", position: { x: 0, y: 0 }, data: {} },
      { id: "send", type: "send_message", position: { x: 100, y: 0 }, data: { messageType: "text", text: "Olá" } },
    ],
    edges: [{ id: "e1", source: "trigger", target: "send" }],
  };
}

describe("validateAutomationGraph", () => {
  it("um fluxo com trigger e um bloco terminal implícito não sobra sem saída", () => {
    // "send" não é terminal e não tem saída — deve reclamar.
    const problems = validateAutomationGraph(baseGraph());
    expect(problems.some((p) => p.nodeId === "send")).toBe(true);
  });

  it("fluxo completo (trigger -> mensagem -> finalizar) não tem pendência", () => {
    const graph: AutomationGraph = {
      nodes: [...baseGraph().nodes, { id: "finish", type: "finish", position: { x: 200, y: 0 }, data: {} }],
      edges: [...baseGraph().edges, { id: "e2", source: "send", target: "finish" }],
    };
    expect(validateAutomationGraph(graph)).toEqual([]);
  });

  it("recusa fluxo sem gatilho", () => {
    const graph: AutomationGraph = { nodes: [], edges: [] };
    const problems = validateAutomationGraph(graph);
    expect(problems.some((p) => p.message.includes("Gatilho"))).toBe(true);
  });

  it("recusa dois gatilhos no mesmo fluxo", () => {
    const graph: AutomationGraph = {
      nodes: [
        { id: "t1", type: "trigger", position: { x: 0, y: 0 }, data: {} },
        { id: "t2", type: "trigger", position: { x: 0, y: 100 }, data: {} },
      ],
      edges: [],
    };
    const problems = validateAutomationGraph(graph);
    expect(problems.some((p) => p.message.includes("Só pode haver um"))).toBe(true);
  });

  it("bloco solto (não conectado ao gatilho) é sinalizado", () => {
    const graph: AutomationGraph = {
      nodes: [
        { id: "trigger", type: "trigger", position: { x: 0, y: 0 }, data: {} },
        { id: "finish1", type: "finish", position: { x: 100, y: 0 }, data: {} },
        { id: "orphan", type: "finish", position: { x: 100, y: 200 }, data: {} },
      ],
      edges: [{ id: "e1", source: "trigger", target: "finish1" }],
    };
    const problems = validateAutomationGraph(graph);
    expect(problems.some((p) => p.nodeId === "orphan")).toBe(true);
  });

  it("condição sem os dois caminhos (Sim/Não) é recusada", () => {
    const graph: AutomationGraph = {
      nodes: [
        { id: "trigger", type: "trigger", position: { x: 0, y: 0 }, data: {} },
        { id: "cond", type: "condition", position: { x: 100, y: 0 }, data: { combinator: "and", clauses: [] } },
        { id: "finish", type: "finish", position: { x: 200, y: 0 }, data: {} },
      ],
      edges: [
        { id: "e1", source: "trigger", target: "cond" },
        // só o caminho "true" — falta "false"
        { id: "e2", source: "cond", sourceHandle: "true", target: "finish" },
      ],
    };
    const problems = validateAutomationGraph(graph);
    expect(problems.some((p) => p.message.includes("Sim e Não"))).toBe(true);
  });

  it("condição com os dois caminhos passa limpa", () => {
    const graph: AutomationGraph = {
      nodes: [
        { id: "trigger", type: "trigger", position: { x: 0, y: 0 }, data: {} },
        { id: "cond", type: "condition", position: { x: 100, y: 0 }, data: { combinator: "and", clauses: [] } },
        { id: "f1", type: "finish", position: { x: 200, y: 0 }, data: {} },
        { id: "f2", type: "finish", position: { x: 200, y: 100 }, data: {} },
      ],
      edges: [
        { id: "e1", source: "trigger", target: "cond" },
        { id: "e2", source: "cond", sourceHandle: "true", target: "f1" },
        { id: "e3", source: "cond", sourceHandle: "false", target: "f2" },
      ],
    };
    expect(validateAutomationGraph(graph)).toEqual([]);
  });

  it("opção de menu sem conexão é recusada", () => {
    const graph: AutomationGraph = {
      nodes: [
        { id: "trigger", type: "trigger", position: { x: 0, y: 0 }, data: {} },
        {
          id: "menu",
          type: "menu",
          position: { x: 100, y: 0 },
          data: { question: "Escolha", options: [{ id: "a", label: "A" }, { id: "b", label: "B" }] },
        },
        { id: "finish", type: "finish", position: { x: 200, y: 0 }, data: {} },
      ],
      edges: [
        { id: "e1", source: "trigger", target: "menu" },
        // só a opção "a" está conectada
        { id: "e2", source: "menu", sourceHandle: "a", target: "finish" },
      ],
    };
    const problems = validateAutomationGraph(graph);
    expect(problems.some((p) => p.message.includes('"B"'))).toBe(true);
  });

  it("aguardar com retomada por resposta exige as duas saídas", () => {
    const graph: AutomationGraph = {
      nodes: [
        { id: "trigger", type: "trigger", position: { x: 0, y: 0 }, data: {} },
        {
          id: "wait",
          type: "wait",
          position: { x: 100, y: 0 },
          data: { mode: "duration", amount: 2, unit: "hours", resumeOnReply: true },
        },
        { id: "finish", type: "finish", position: { x: 200, y: 0 }, data: {} },
      ],
      edges: [
        { id: "e1", source: "trigger", target: "wait" },
        { id: "e2", source: "wait", sourceHandle: "timeout", target: "finish" },
        // falta a saída "reply"
      ],
    };
    const problems = validateAutomationGraph(graph);
    expect(problems.some((p) => p.message.includes("Tempo esgotado e Cliente respondeu"))).toBe(true);
  });

  it("grafo vazio recém-criado (emptyAutomationGraph) só reclama de faltar destino do gatilho", () => {
    const problems = validateAutomationGraph(emptyAutomationGraph());
    // O gatilho sozinho, sem nada depois, não tem para onde seguir — é
    // exatamente o estado de um fluxo recém-criado, ainda por montar.
    expect(problems.some((p) => p.message.includes("não tem para onde seguir"))).toBe(true);
  });
});

describe("templates prontos", () => {
  it("todos os templates do catálogo publicam sem pendência", () => {
    for (const template of AUTOMATION_TEMPLATES) {
      const problems = validateAutomationGraph(template.graph);
      expect(problems, `template "${template.key}" tem pendência: ${JSON.stringify(problems)}`).toEqual([]);
    }
  });

  it("o template Atendimento Geral tem o menu de quatro opções da seção 22", () => {
    const template = AUTOMATION_TEMPLATES.find((item) => item.key === "atendimento_geral");
    expect(template).toBeDefined();
    const menu = template?.graph.nodes.find((node) => node.type === "menu");
    expect(menu).toBeDefined();
    const options = (menu?.data as { options: { id: string }[] }).options;
    expect(options.map((option) => option.id).sort()).toEqual(["comercial", "financeiro", "humano", "suporte"]);
  });
});

describe("resolveAutomationTemplate — variáveis de mensagem do fluxo", () => {
  const context = {
    contactName: "Maria Souza",
    contactPhone: "5511999998888",
    agentName: "Camila Ferreira",
    departmentName: "Financeiro",
    protocol: "AZV-123-ABCD",
    answers: { servico_comercial: "Abertura de empresa" },
    now: new Date(2026, 2, 5, 14, 30),
  };

  it("resolve as variáveis fixas", () => {
    const { text } = resolveAutomationTemplate("Olá, {{primeiro_nome}}! Departamento: {{departamento}}.", context);
    expect(text).toBe("Olá, Maria! Departamento: Financeiro.");
  });

  it("resolve variável dinâmica de resposta coletada ({{campo.*}})", () => {
    const { text } = resolveAutomationTemplate("Você procura: {{campo.servico_comercial}}", context);
    expect(text).toBe("Você procura: Abertura de empresa");
  });

  it("variável sem valor ou desconhecida vira string vazia, nunca literal", () => {
    const { text, unresolved } = resolveAutomationTemplate("Protocolo antigo: {{campo.inexistente}} / {{variavel_invalida}}", context);
    expect(text).toBe("Protocolo antigo:  / ");
    expect(unresolved).toContain("campo.inexistente");
    expect(unresolved).toContain("variavel_invalida");
  });

  it("data e hora saem formatadas", () => {
    const { text } = resolveAutomationTemplate("{{data}} às {{hora}}", context);
    expect(text).toBe("05/03/2026 às 14:30");
  });
});

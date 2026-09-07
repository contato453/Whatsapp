import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AutomationGraph } from "@azvchat/shared";
import { AutomationEngine } from "../src/services/automation/engine.js";

/**
 * O MOTOR de execução — o coração da automação. Nada aqui abre conexão de
 * banco: como o resto da suíte (ver `test/message-ingest-pipeline.test.ts`),
 * é um Prisma FAKE, em memória, cobrindo só as operações que o motor usa de
 * verdade. `matches()` é um casador de `where` bem pequeno — o suficiente
 * para `OR`, `in`, `some` (elegibilidade de responsável) e `lte` (cooldown,
 * espera vencida) — nunca um Prisma de brinquedo genérico.
 *
 * Cenário de aceitação da seção 40 do pedido, ponta a ponta: mensagem nova
 * → verifica expediente → saudação → menu → pergunta (CPF/CNPJ) → salva →
 * etiqueta → encaminha → conclui com protocolo. Mais: fora do expediente,
 * atendente assumindo (a automação para), cooldown (não repete à toa) e
 * o guarda contra laço entre blocos.
 */

function matches(row: Record<string, unknown>, where: Record<string, unknown> | undefined): boolean {
  if (!where) return true;
  for (const [key, cond] of Object.entries(where)) {
    if (key === "OR") {
      if (!(cond as Record<string, unknown>[]).some((sub) => matches(row, sub))) return false;
      continue;
    }
    if (key === "AND") {
      if (!(cond as Record<string, unknown>[]).every((sub) => matches(row, sub))) return false;
      continue;
    }
    if (cond !== null && typeof cond === "object" && !(cond instanceof Date)) {
      const condObj = cond as Record<string, unknown>;
      if ("some" in condObj) {
        const arr = Array.isArray(row[key]) ? (row[key] as Record<string, unknown>[]) : [];
        if (!arr.some((item) => matches(item, condObj.some as Record<string, unknown>))) return false;
        continue;
      }
      if ("in" in condObj) {
        if (!(condObj.in as unknown[]).includes(row[key])) return false;
        continue;
      }
      if ("not" in condObj) {
        if (row[key] === condObj.not) return false;
        continue;
      }
      if ("lte" in condObj) {
        const value = row[key] instanceof Date ? (row[key] as Date).getTime() : (row[key] as number);
        const bound = condObj.lte instanceof Date ? condObj.lte.getTime() : (condObj.lte as number);
        if (!(value <= bound)) return false;
        continue;
      }
      continue; // forma não reconhecida: fake permissivo, é só para teste
    }
    if (row[key] !== cond) return false;
  }
  return true;
}

function buildFakeEnvironment(opts?: {
  aiRuntime?: { startSessionForFlow: (input: Record<string, unknown>) => Promise<{ id: string } | null> };
}) {
  const conversations = new Map<string, Record<string, unknown>>();
  const messages = new Map<string, Record<string, unknown>>();
  const instances = new Map<string, Record<string, unknown>>();
  const departments = new Map<string, Record<string, unknown>>();
  const users = new Map<string, Record<string, unknown>>();
  const tags = new Map<string, Record<string, unknown>>();
  const conversationTags: { conversationId: string; tagId: string }[] = [];
  const flows = new Map<string, Record<string, unknown>>();
  const flowVersions = new Map<string, Record<string, unknown>>();
  const executions = new Map<string, Record<string, unknown>>();
  const aiSessions = new Map<string, Record<string, unknown>>();
  const executionLogs: Record<string, unknown>[] = [];
  const assignmentHistory: Record<string, unknown>[] = [];
  const sentMessages: { instanceId: string; chatId: string; text: string }[] = [];
  const emitted: { event: string; payload: unknown }[] = [];
  let counter = 0;
  const nextId = (prefix: string) => `${prefix}-${++counter}`;

  function populateConversation(row: Record<string, unknown>) {
    return {
      ...row,
      instance: instances.get(row.whatsappInstanceId as string) ?? null,
      assignedUser: row.assignedUserId ? (users.get(row.assignedUserId as string) ?? null) : null,
      department: row.departmentId ? (departments.get(row.departmentId as string) ?? null) : null,
      archivedBy: null,
      tags: conversationTags
        .filter((entry) => entry.conversationId === row.id)
        .map((entry) => ({ tag: tags.get(entry.tagId) })),
    };
  }

  const prisma = {
    conversation: {
      findUnique: async ({ where, include }: { where: { id: string }; include?: unknown }) => {
        const row = conversations.get(where.id);
        if (!row) return null;
        return include ? populateConversation(row) : { ...row };
      },
      update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const row = conversations.get(where.id);
        if (!row) throw new Error("conversa não existe no fake");
        Object.assign(row, data);
        return { ...row };
      },
      findMany: async () => [],
    },
    message: {
      count: async ({ where }: { where: Record<string, unknown> }) =>
        [...messages.values()].filter((row) => matches(row, where)).length,
      create: async ({ data }: { data: Record<string, unknown> }) => {
        const id = nextId("msg");
        const row = { id, createdAt: new Date(), deletedAt: null, ...data };
        messages.set(id, row);
        return { ...row };
      },
      findUnique: async ({ where }: { where: { id: string } }) => {
        const row = messages.get(where.id);
        return row ? { ...row } : null;
      },
      findFirst: async ({
        where,
        orderBy,
        select,
      }: {
        where: Record<string, unknown>;
        orderBy?: { timestamp?: string };
        select?: Record<string, boolean>;
      }) => {
        let rows = [...messages.values()].filter((row) => matches(row, where));
        rows = rows.sort((a, b) => {
          const diff = (a.timestamp as Date).getTime() - (b.timestamp as Date).getTime();
          return orderBy?.timestamp === "desc" ? -diff : diff;
        });
        const row = rows[0];
        if (!row) return null;
        if (select) {
          const out: Record<string, unknown> = {};
          for (const key of Object.keys(select)) out[key] = row[key];
          return out;
        }
        return { ...row };
      },
    },
    conversationTag: {
      upsert: async ({ create }: { create: { conversationId: string; tagId: string } }) => {
        if (!conversationTags.some((t) => t.conversationId === create.conversationId && t.tagId === create.tagId)) {
          conversationTags.push({ conversationId: create.conversationId, tagId: create.tagId });
        }
        return create;
      },
      deleteMany: async ({ where }: { where: { conversationId: string; tagId: string } }) => {
        const before = conversationTags.length;
        const kept = conversationTags.filter(
          (t) => !(t.conversationId === where.conversationId && t.tagId === where.tagId),
        );
        conversationTags.length = 0;
        conversationTags.push(...kept);
        return { count: before - kept.length };
      },
      findFirst: async ({ where }: { where: { conversationId: string; tagId: string } }) =>
        conversationTags.find((t) => t.conversationId === where.conversationId && t.tagId === where.tagId) ?? null,
    },
    department: {
      findFirst: async ({ where }: { where: Record<string, unknown> }) =>
        [...departments.values()].find((row) => matches(row, where)) ?? null,
      findUnique: async ({ where, select }: { where: { id: string }; select?: Record<string, boolean> }) => {
        const row = departments.get(where.id);
        if (!row) return null;
        return select ? { name: row.name } : { ...row };
      },
    },
    user: {
      findFirst: async ({ where }: { where: Record<string, unknown> }) =>
        [...users.values()].find((row) => matches(row, where)) ?? null,
      findUnique: async ({ where, select }: { where: { id: string }; select?: Record<string, boolean> }) => {
        const row = users.get(where.id);
        if (!row) return null;
        return select ? { name: row.name } : { ...row };
      },
    },
    attendanceSettings: { findUnique: async () => null },
    personProfile: { findMany: async () => [] },
    automationFlow: {
      findMany: async ({
        where,
        orderBy,
      }: {
        where: Record<string, unknown>;
        orderBy?: { priority?: string };
      }) => {
        let rows = [...flows.values()].filter((row) => matches(row, where));
        if (orderBy?.priority === "asc") rows = rows.sort((a, b) => (a.priority as number) - (b.priority as number));
        return rows.map((row) => ({
          ...row,
          publishedVersion: row.publishedVersionId ? (flowVersions.get(row.publishedVersionId as string) ?? null) : null,
        }));
      },
    },
    automationFlowVersion: {
      findUnique: async ({ where }: { where: { id: string } }) => {
        const row = flowVersions.get(where.id);
        return row ? { ...row } : null;
      },
    },
    automationExecution: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        const active = [...executions.values()].some(
          (row) => row.conversationId === data.conversationId && ["running", "waiting"].includes(row.status as string),
        );
        if (active) {
          const error = new Error("unique violation") as Error & { code: string };
          error.code = "P2002";
          throw error;
        }
        const id = nextId("exec");
        const row = {
          id,
          currentNodeId: null,
          waitingReason: null,
          waitingUntil: null,
          resultSummary: null,
          error: null,
          finishedAt: null,
          startedAt: new Date(),
          updatedAt: new Date(),
          ...data,
        };
        executions.set(id, row);
        return { ...row };
      },
      update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const row = executions.get(where.id);
        if (!row) throw new Error("execução não existe no fake");
        Object.assign(row, data, { updatedAt: new Date() });
        return { ...row };
      },
      findFirst: async ({
        where,
        orderBy,
      }: {
        where: Record<string, unknown>;
        orderBy?: { startedAt?: string };
      }) => {
        let rows = [...executions.values()].filter((row) => matches(row, where));
        if (orderBy?.startedAt === "desc") {
          rows = rows.sort((a, b) => (b.startedAt as Date).getTime() - (a.startedAt as Date).getTime());
        }
        return rows[0] ? { ...rows[0] } : null;
      },
      findMany: async ({ where, take }: { where: Record<string, unknown>; take?: number }) => {
        let rows = [...executions.values()].filter((row) => matches(row, where));
        if (take) rows = rows.slice(0, take);
        return rows.map((row) => ({ ...row }));
      },
    },
    automationExecutionLog: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        const row = { id: nextId("log"), at: new Date(), ...data };
        executionLogs.push(row);
        return row;
      },
    },
    conversationAssignmentHistory: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        const row = { id: nextId("hist"), createdAt: new Date(), ...data };
        assignmentHistory.push(row);
        return row;
      },
    },
    aiSession: {
      findUnique: async ({
        where,
        select,
      }: {
        where: { id: string };
        select?: Record<string, boolean>;
      }) => {
        const row = aiSessions.get(where.id);
        if (!row) return null;
        if (!select) return { ...row };
        const out: Record<string, unknown> = {};
        for (const key of Object.keys(select)) out[key] = row[key];
        return out;
      },
    },
    $transaction: async (ops: Promise<unknown>[]) => Promise.all(ops),
  };

  const provider = {
    sendText: async (instanceId: string, chatId: string, text: string) => {
      sentMessages.push({ instanceId, chatId, text });
      return { externalMessageId: nextId("wamid"), timestamp: new Date() };
    },
  };

  const io = {
    to: () => ({ emit: (event: string, payload: unknown) => emitted.push({ event, payload }) }),
  };

  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

  const engine = new AutomationEngine(
    prisma as never,
    provider as never,
    io as never,
    logger as never,
    opts?.aiRuntime as never,
  );

  const ORG = "org-1";
  const INSTANCE_ID = "instance-1";
  instances.set(INSTANCE_ID, { id: INSTANCE_ID, name: "Número Principal", status: "connected" });

  function createConversation(overrides: Partial<Record<string, unknown>> = {}) {
    const id = nextId("conv");
    const row = {
      id,
      organizationId: ORG,
      whatsappInstanceId: INSTANCE_ID,
      externalChatId: "120000000@g.us",
      type: "group",
      title: "Cliente Teste",
      customTitle: null,
      profilePicture: null,
      status: "open",
      assignedUserId: null,
      assignedToAll: false,
      departmentId: null,
      archivedAt: null,
      lastMessageAt: null,
      lastMessagePreview: null,
      externalReference: null,
      externalSource: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      ...overrides,
    };
    conversations.set(id, row);
    return row;
  }

  function createFlow(input: {
    name: string;
    triggerType: string;
    triggerConfig?: Record<string, unknown> | null;
    whatsappInstanceId?: string | null;
    priority?: number;
    cooldownMinutes?: number;
    scheduleMode?: string;
    graph: AutomationGraph;
    status?: string;
  }) {
    const flowId = nextId("flow");
    const versionId = nextId("ver");
    flowVersions.set(versionId, { id: versionId, flowId, version: 1, graph: input.graph });
    flows.set(flowId, {
      id: flowId,
      organizationId: ORG,
      name: input.name,
      description: null,
      status: input.status ?? "active",
      triggerType: input.triggerType,
      triggerConfig: input.triggerConfig ?? null,
      whatsappInstanceId: input.whatsappInstanceId ?? null,
      priority: input.priority ?? 100,
      cooldownMinutes: input.cooldownMinutes ?? 0,
      // Mesmo padrão da coluna real: NOT NULL DEFAULT 'always'.
      scheduleMode: input.scheduleMode ?? "always",
      draftGraph: input.graph,
      publishedVersionId: versionId,
      updatedAt: new Date(),
    });
    return flowId;
  }

  function addTag(name: string) {
    const id = nextId("tag");
    tags.set(id, { id, name, color: "#000", isGeneral: true });
    return id;
  }

  function addDepartment(name: string) {
    const id = nextId("dept");
    departments.set(id, { id, name, organizationId: ORG });
    return id;
  }

  async function inbound(conversationId: string, content: string) {
    const conversation = conversations.get(conversationId) as Record<string, unknown>;
    const message = await prisma.message.create({
      data: {
        organizationId: ORG,
        conversationId,
        direction: "inbound",
        type: "text",
        content,
        timestamp: new Date(),
        status: "delivered",
      },
    });
    conversation.lastMessageAt = (message as unknown as { timestamp: Date }).timestamp;
    await engine.handleIncomingMessage({ organizationId: ORG, conversationId, content });
  }

  return {
    engine,
    ORG,
    INSTANCE_ID,
    conversations,
    executions,
    aiSessions,
    conversationTags,
    sentMessages,
    logger,
    flows,
    createConversation,
    createFlow,
    addTag,
    addDepartment,
    inbound,
  };
}

describe("AutomationEngine", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("fora do expediente: envia o aviso e conclui, sem apresentar o menu", async () => {
      const env = buildFakeEnvironment();
      // Domingo de madrugada — fora de qualquer expediente padrão.
      vi.setSystemTime(new Date("2026-03-01T03:00:00-03:00"));
      const conversation = env.createConversation();
      const graph: AutomationGraph = {
        nodes: [
          { id: "trigger", type: "trigger", position: { x: 0, y: 0 }, data: {} },
          {
            id: "hours",
            type: "condition",
            position: { x: 100, y: 0 },
            data: { combinator: "and", clauses: [{ field: "business_hours", value: "true" }] },
          },
          {
            id: "out",
            type: "send_message",
            position: { x: 200, y: 0 },
            data: { messageType: "text", text: "Fora do expediente." },
          },
          { id: "finish", type: "finish", position: { x: 300, y: 0 }, data: {} },
        ],
        edges: [
          { id: "e1", source: "trigger", target: "hours" },
          { id: "e2", source: "hours", sourceHandle: "false", target: "out" },
          { id: "e3", source: "out", target: "finish" },
        ],
      };
      env.createFlow({ name: "Geral", triggerType: "first_message", graph });

      await env.inbound(conversation.id as string, "Oi");

      expect(env.sentMessages).toHaveLength(1);
      expect(env.sentMessages[0]?.text).toBe("Fora do expediente.");
      const execution = [...env.executions.values()][0];
      expect(execution?.status).toBe("completed");
  });

  describe("scheduleMode — quando o FLUXO pode ser escolhido, não o que ele faz por dentro", () => {
    // Grafo mínimo: só precisa provar se a execução COMEÇOU ou não — o que
    // o fluxo faria depois não é o que este bloco testa.
    const minimalGraph: AutomationGraph = {
      nodes: [
        { id: "trigger", type: "trigger", position: { x: 0, y: 0 }, data: {} },
        { id: "finish", type: "finish", position: { x: 100, y: 0 }, data: {} },
      ],
      edges: [{ id: "e1", source: "trigger", target: "finish" }],
    };

    it("'business_hours': só vira candidato DENTRO do expediente", async () => {
      const env = buildFakeEnvironment();
      env.createFlow({ name: "Só de dia", triggerType: "first_message", scheduleMode: "business_hours", graph: minimalGraph });

      vi.setSystemTime(new Date("2026-03-01T03:00:00-03:00")); // domingo de madrugada
      await env.inbound(env.createConversation().id as string, "Oi");
      expect(env.executions.size).toBe(0);

      vi.setSystemTime(new Date("2026-03-05T10:00:00-03:00")); // quinta às 10h
      await env.inbound(env.createConversation().id as string, "Oi");
      expect(env.executions.size).toBe(1);
    });

    it("'outside_business_hours': só vira candidato FORA do expediente — o inverso do padrão", async () => {
      const env = buildFakeEnvironment();
      env.createFlow({ name: "Plantão noturno", triggerType: "first_message", scheduleMode: "outside_business_hours", graph: minimalGraph });

      vi.setSystemTime(new Date("2026-03-05T10:00:00-03:00")); // quinta às 10h — expediente
      await env.inbound(env.createConversation().id as string, "Oi");
      expect(env.executions.size).toBe(0);

      vi.setSystemTime(new Date("2026-03-01T03:00:00-03:00")); // domingo de madrugada
      await env.inbound(env.createConversation().id as string, "Oi");
      expect(env.executions.size).toBe(1);
    });

    it("fluxo de plantão (prioridade melhor) cede a vez ao fluxo 'always' durante o expediente", async () => {
      const env = buildFakeEnvironment();
      env.createFlow({
        name: "Plantão noturno",
        triggerType: "first_message",
        scheduleMode: "outside_business_hours",
        priority: 50, // número menor = mais forte — venceria se a hora não desqualificasse
        graph: minimalGraph,
      });
      const dayFlowId = env.createFlow({ name: "Atendimento geral", triggerType: "first_message", scheduleMode: "always", priority: 100, graph: minimalGraph });

      vi.setSystemTime(new Date("2026-03-05T10:00:00-03:00")); // quinta às 10h — expediente
      await env.inbound(env.createConversation().id as string, "Oi");

      // A execução tem que ser do fluxo "Atendimento geral" — o de plantão
      // foi descartado pela hora, mesmo com prioridade melhor.
      expect(env.executions.size).toBe(1);
      const [execution] = [...env.executions.values()];
      expect(execution?.flowId).toBe(dayFlowId);
    });

    it("campo ausente (fake antigo/linha sem o valor) equivale a 'always', nunca a uma restrição", async () => {
      const env = buildFakeEnvironment();
      const flowId = env.createFlow({ name: "Legado", triggerType: "first_message", graph: minimalGraph });
      // Simula uma linha sem o campo — o que uma migration futura NUNCA
      // produziria (a coluna é NOT NULL DEFAULT 'always'), mas é o estado de
      // qualquer fake que ainda não conhece esta coluna.
      delete env.flows.get(flowId)?.scheduleMode;

      vi.setSystemTime(new Date("2026-03-01T03:00:00-03:00")); // domingo de madrugada
      await env.inbound(env.createConversation().id as string, "Oi");
      expect(env.executions.size).toBe(1);
    });
  });

  it("cenário de aceitação: saudação, menu, pergunta, etiqueta, encaminhamento e protocolo", async () => {
      const env = buildFakeEnvironment();
      // Quinta-feira às 10h — dentro do expediente padrão (seg-sex 08-18).
      vi.setSystemTime(new Date("2026-03-05T10:00:00-03:00"));
      const conversation = env.createConversation();
      const tagFinanceiro = env.addTag("Financeiro");
      const deptFinanceiro = env.addDepartment("Financeiro");

      const graph: AutomationGraph = {
        nodes: [
          { id: "trigger", type: "trigger", position: { x: 0, y: 0 }, data: {} },
          {
            id: "hours",
            type: "condition",
            position: { x: 100, y: 0 },
            data: { combinator: "and", clauses: [{ field: "business_hours", value: "true" }] },
          },
          {
            id: "greeting",
            type: "send_message",
            position: { x: 200, y: 0 },
            data: { messageType: "text", text: "Olá, {{primeiro_nome}}! Como podemos ajudar?" },
          },
          {
            id: "menu",
            type: "menu",
            position: { x: 300, y: 0 },
            data: {
              question: "1 - Comercial\n2 - Financeiro",
              options: [
                { id: "comercial", label: "Comercial" },
                { id: "financeiro", label: "Financeiro" },
              ],
            },
          },
          {
            id: "ask",
            type: "ask_question",
            position: { x: 400, y: 0 },
            data: { question: "Informe seu CPF ou CNPJ.", answerType: "text", saveKey: "documento" },
          },
          { id: "tag", type: "tag_add", position: { x: 500, y: 0 }, data: { tagId: tagFinanceiro } },
          {
            id: "forward",
            type: "forward_department",
            position: { x: 600, y: 0 },
            data: { departmentId: deptFinanceiro },
          },
          {
            id: "finish",
            type: "finish",
            position: { x: 700, y: 0 },
            data: { message: "Encaminhado! Protocolo {{protocolo}}.", generateProtocol: true },
          },
          { id: "outOfHours", type: "finish", position: { x: 200, y: 200 }, data: {} },
        ],
        edges: [
          { id: "e1", source: "trigger", target: "hours" },
          { id: "e2", source: "hours", sourceHandle: "true", target: "greeting" },
          { id: "e2b", source: "hours", sourceHandle: "false", target: "outOfHours" },
          { id: "e3", source: "greeting", target: "menu" },
          { id: "e4", source: "menu", sourceHandle: "financeiro", target: "ask" },
          { id: "e5", source: "ask", target: "tag" },
          { id: "e6", source: "tag", target: "forward" },
          { id: "e7", source: "forward", target: "finish" },
        ],
      };
      env.createFlow({ name: "Atendimento Geral", triggerType: "first_message", graph });

      await env.inbound(conversation.id as string, "Oi, preciso de ajuda");
      expect(env.sentMessages.map((m) => m.text)).toEqual([
        "Olá, Cliente! Como podemos ajudar?",
        "1 - Comercial\n2 - Financeiro",
      ]);
      let execution = [...env.executions.values()][0] as Record<string, unknown>;
      expect(execution.status).toBe("waiting");
      expect(execution.waitingReason).toBe("reply");

      // Escolhe "Financeiro" pelo número da opção.
      await env.inbound(conversation.id as string, "2");
      execution = [...env.executions.values()][0] as Record<string, unknown>;
      expect(execution.status).toBe("waiting");
      expect(env.sentMessages[2]?.text).toBe("Informe seu CPF ou CNPJ.");

      // Responde a pergunta — encerra a automação com etiqueta e encaminhamento.
      await env.inbound(conversation.id as string, "123.456.789-00");
      execution = [...env.executions.values()][0] as Record<string, unknown>;
      expect(execution.status).toBe("completed");
      expect((execution.context as { answers: Record<string, string> }).answers.documento).toBe("123.456.789-00");
      expect(env.sentMessages[3]?.text).toMatch(/^Encaminhado! Protocolo AZV-.+\.$/);

      const conversationRow = env.conversations.get(conversation.id as string) as Record<string, unknown>;
      expect(conversationRow.departmentId).toBe(deptFinanceiro);
      expect(env.conversationTags).toContainEqual({ conversationId: conversation.id, tagId: tagFinanceiro });
  });

  it("atendente assume: a automação para de interferir na execução em andamento", async () => {
      const env = buildFakeEnvironment();
      vi.setSystemTime(new Date("2026-03-05T10:00:00-03:00"));
      const conversation = env.createConversation();
      const graph: AutomationGraph = {
        nodes: [
          { id: "trigger", type: "trigger", position: { x: 0, y: 0 }, data: {} },
          {
            id: "menu",
            type: "menu",
            position: { x: 100, y: 0 },
            data: { question: "Escolha uma opção", options: [{ id: "a", label: "A" }] },
          },
          { id: "finish", type: "finish", position: { x: 200, y: 0 }, data: {} },
        ],
        edges: [
          { id: "e1", source: "trigger", target: "menu" },
          { id: "e2", source: "menu", sourceHandle: "a", target: "finish" },
        ],
      };
      env.createFlow({ name: "Menu simples", triggerType: "first_message", graph });

      await env.inbound(conversation.id as string, "Oi");
      let execution = [...env.executions.values()][0] as Record<string, unknown>;
      expect(execution.status).toBe("waiting");

      await env.engine.handleHumanTakeover(conversation.id as string);
      execution = [...env.executions.values()][0] as Record<string, unknown>;
      expect(execution.status).toBe("handed_off");

      const sentBefore = env.sentMessages.length;
      // Mensagem depois do handoff: não é mais a primeira mensagem da
      // conversa, então o gatilho `first_message` não dispara de novo — e
      // não há execução ativa para capturar a resposta.
      await env.inbound(conversation.id as string, "Alguém aí?");
      expect(env.sentMessages).toHaveLength(sentBefore);
  });

  it("cooldown: o mesmo fluxo não repete para a mesma conversa antes do intervalo configurado", async () => {
      const env = buildFakeEnvironment();
      vi.setSystemTime(new Date("2026-03-05T10:00:00-03:00"));
      const conversation = env.createConversation();
      const graph: AutomationGraph = {
        nodes: [
          { id: "trigger", type: "trigger", position: { x: 0, y: 0 }, data: {} },
          { id: "send", type: "send_message", position: { x: 100, y: 0 }, data: { messageType: "text", text: "Olá de novo!" } },
          { id: "finish", type: "finish", position: { x: 200, y: 0 }, data: {} },
        ],
        edges: [
          { id: "e1", source: "trigger", target: "send" },
          { id: "e2", source: "send", target: "finish" },
        ],
      };
      env.createFlow({ name: "Saudação", triggerType: "new_message", cooldownMinutes: 60, graph });

      await env.inbound(conversation.id as string, "Mensagem 1");
      expect(env.sentMessages).toHaveLength(1);

      await env.inbound(conversation.id as string, "Mensagem 2");
      expect(env.sentMessages).toHaveLength(1); // ainda em cooldown

      vi.setSystemTime(new Date("2026-03-05T11:05:00-03:00")); // 65 minutos depois
      await env.inbound(conversation.id as string, "Mensagem 3");
      expect(env.sentMessages).toHaveLength(2);
      expect(env.executions.size).toBe(2);
  });

  it("laço entre blocos é detectado e a execução falha, sem travar o processo", async () => {
      const env = buildFakeEnvironment();
      vi.setSystemTime(new Date("2026-03-05T10:00:00-03:00"));
      const conversation = env.createConversation();
      const tagId = env.addTag("Loop");
      const graph: AutomationGraph = {
        nodes: [
          { id: "trigger", type: "trigger", position: { x: 0, y: 0 }, data: {} },
          { id: "a", type: "tag_add", position: { x: 100, y: 0 }, data: { tagId } },
          { id: "b", type: "tag_remove", position: { x: 200, y: 0 }, data: { tagId } },
        ],
        edges: [
          { id: "e1", source: "trigger", target: "a" },
          { id: "e2", source: "a", target: "b" },
          { id: "e3", source: "b", target: "a" }, // ciclo entre "a" e "b"
        ],
      };
      env.createFlow({ name: "Laço", triggerType: "first_message", graph });

      await env.inbound(conversation.id as string, "Oi");
      const execution = [...env.executions.values()][0] as Record<string, unknown>;
      expect(execution.status).toBe("failed");
      expect(execution.error).toMatch(/limite de passos/);
  });

  it("prioridade: com dois fluxos ativos disputando o mesmo gatilho, só o de menor número roda", async () => {
      const env = buildFakeEnvironment();
      vi.setSystemTime(new Date("2026-03-05T10:00:00-03:00"));
      const conversation = env.createConversation();
      const simpleGraph = (text: string): AutomationGraph => ({
        nodes: [
          { id: "trigger", type: "trigger", position: { x: 0, y: 0 }, data: {} },
          { id: "send", type: "send_message", position: { x: 100, y: 0 }, data: { messageType: "text", text } },
          { id: "finish", type: "finish", position: { x: 200, y: 0 }, data: {} },
        ],
        edges: [
          { id: "e1", source: "trigger", target: "send" },
          { id: "e2", source: "send", target: "finish" },
        ],
      });
      env.createFlow({ name: "Baixa prioridade", triggerType: "new_message", priority: 200, graph: simpleGraph("B") });
      env.createFlow({ name: "Alta prioridade", triggerType: "new_message", priority: 10, graph: simpleGraph("A") });

      await env.inbound(conversation.id as string, "Oi");

      expect(env.sentMessages).toHaveLength(1);
      expect(env.sentMessages[0]?.text).toBe("A");
      expect(env.executions.size).toBe(1);
  });

  describe("bloco 'Atendimento por IA'", () => {
    function aiGraph(agentId: string): AutomationGraph {
      return {
        nodes: [
          { id: "trigger", type: "trigger", position: { x: 0, y: 0 }, data: {} },
          { id: "ai", type: "ai_agent", position: { x: 100, y: 0 }, data: { agentId } },
          { id: "resolved-msg", type: "send_message", position: { x: 200, y: 0 }, data: { messageType: "text", text: "Resolvido!" } },
          { id: "resolved-finish", type: "finish", position: { x: 300, y: 0 }, data: {} },
          { id: "transfer-msg", type: "send_message", position: { x: 200, y: 100 }, data: { messageType: "text", text: "Transferido!" } },
          { id: "transfer-finish", type: "finish", position: { x: 300, y: 100 }, data: {} },
        ],
        edges: [
          { id: "e1", source: "trigger", target: "ai" },
          { id: "e2", source: "ai", sourceHandle: "resolvido", target: "resolved-msg" },
          { id: "e3", source: "resolved-msg", target: "resolved-finish" },
          { id: "e4", source: "ai", sourceHandle: "transferido", target: "transfer-msg" },
          { id: "e5", source: "transfer-msg", target: "transfer-finish" },
        ],
      };
    }

    it("entrega a conversa à IA e a execução fica esperando a sessão terminar", async () => {
      const startSessionForFlow = vi.fn(async (input: Record<string, unknown>) => ({ id: "ai-session-1" }));
      const env = buildFakeEnvironment({ aiRuntime: { startSessionForFlow } });
      vi.setSystemTime(new Date("2026-03-05T10:00:00-03:00"));
      const conversation = env.createConversation();
      env.createFlow({ name: "Com IA", triggerType: "first_message", graph: aiGraph("agent-1") });

      await env.inbound(conversation.id as string, "Oi");

      expect(startSessionForFlow).toHaveBeenCalledTimes(1);
      const call = startSessionForFlow.mock.calls[0]?.[0] as Record<string, unknown>;
      expect(call.agentId).toBe("agent-1");
      expect(call.conversationId).toBe(conversation.id);
      const execution = [...env.executions.values()][0] as Record<string, unknown>;
      expect(execution.status).toBe("waiting");
      expect(execution.waitingReason).toBe("ai_session");
      expect((execution.context as Record<string, unknown>).aiSessionId).toBe("ai-session-1");
      // Nenhuma das duas mensagens de saída do bloco de IA sai agora — só
      // depois que a sessão terminar de verdade.
      expect(env.sentMessages).toHaveLength(0);
    });

    it("sem motor de IA disponível, segue direto pela saída 'Transferido'", async () => {
      const env = buildFakeEnvironment(); // sem aiRuntime — mesma situação dos testes que não usam IA
      vi.setSystemTime(new Date("2026-03-05T10:00:00-03:00"));
      const conversation = env.createConversation();
      env.createFlow({ name: "Com IA", triggerType: "first_message", graph: aiGraph("agent-1") });

      await env.inbound(conversation.id as string, "Oi");

      expect(env.sentMessages).toHaveLength(1);
      expect(env.sentMessages[0]?.text).toBe("Transferido!");
      const execution = [...env.executions.values()][0] as Record<string, unknown>;
      expect(execution.status).toBe("completed");
    });

    it("agente indisponível (orçamento, inativo, etc.) também segue por 'Transferido', sem travar", async () => {
      const startSessionForFlow = vi.fn(async () => null);
      const env = buildFakeEnvironment({ aiRuntime: { startSessionForFlow } });
      vi.setSystemTime(new Date("2026-03-05T10:00:00-03:00"));
      const conversation = env.createConversation();
      env.createFlow({ name: "Com IA", triggerType: "first_message", graph: aiGraph("agent-1") });

      await env.inbound(conversation.id as string, "Oi");

      expect(env.sentMessages).toHaveLength(1);
      expect(env.sentMessages[0]?.text).toBe("Transferido!");
    });

    it("tick() retoma pela saída 'Resolvido' quando a sessão de IA termina resolvida", async () => {
      const startSessionForFlow = vi.fn(async () => ({ id: "ai-session-1" }));
      const env = buildFakeEnvironment({ aiRuntime: { startSessionForFlow } });
      vi.setSystemTime(new Date("2026-03-05T10:00:00-03:00"));
      const conversation = env.createConversation();
      env.createFlow({ name: "Com IA", triggerType: "first_message", graph: aiGraph("agent-1") });
      await env.inbound(conversation.id as string, "Oi");

      env.aiSessions.set("ai-session-1", { id: "ai-session-1", status: "resolved" });
      await env.engine.tick();

      expect(env.sentMessages).toHaveLength(1);
      expect(env.sentMessages[0]?.text).toBe("Resolvido!");
      const execution = [...env.executions.values()][0] as Record<string, unknown>;
      expect(execution.status).toBe("completed");
    });

    it("tick() retoma pela saída 'Transferido' quando a sessão de IA termina de qualquer outro jeito", async () => {
      const startSessionForFlow = vi.fn(async () => ({ id: "ai-session-1" }));
      const env = buildFakeEnvironment({ aiRuntime: { startSessionForFlow } });
      vi.setSystemTime(new Date("2026-03-05T10:00:00-03:00"));
      const conversation = env.createConversation();
      env.createFlow({ name: "Com IA", triggerType: "first_message", graph: aiGraph("agent-1") });
      await env.inbound(conversation.id as string, "Oi");

      // "stopped" (Encerrar IA), "transferred", "limit_reached", "error",
      // "expired" — qualquer um que não seja "resolved" cai na mesma saída.
      env.aiSessions.set("ai-session-1", { id: "ai-session-1", status: "stopped" });
      await env.engine.tick();

      expect(env.sentMessages).toHaveLength(1);
      expect(env.sentMessages[0]?.text).toBe("Transferido!");
    });

    it("tick() não mexe na execução enquanto a sessão de IA continua ativa", async () => {
      const startSessionForFlow = vi.fn(async () => ({ id: "ai-session-1" }));
      const env = buildFakeEnvironment({ aiRuntime: { startSessionForFlow } });
      vi.setSystemTime(new Date("2026-03-05T10:00:00-03:00"));
      const conversation = env.createConversation();
      env.createFlow({ name: "Com IA", triggerType: "first_message", graph: aiGraph("agent-1") });
      await env.inbound(conversation.id as string, "Oi");

      env.aiSessions.set("ai-session-1", { id: "ai-session-1", status: "active" });
      await env.engine.tick();

      expect(env.sentMessages).toHaveLength(0);
      const execution = [...env.executions.values()][0] as Record<string, unknown>;
      expect(execution.status).toBe("waiting");
    });
  });
});

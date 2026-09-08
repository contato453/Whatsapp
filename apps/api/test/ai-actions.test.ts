import { describe, expect, it } from "vitest";
import type { PrismaClient } from "@azvchat/database";
import type { Server } from "socket.io";
import pino from "pino";
import { defaultAiAgentConfig, estimateCostMicros, resolveModelPricing } from "@azvchat/shared";
import { executeTool, type ActionEnvironment } from "../src/services/ai/actions.js";
import { automationMatches } from "../src/services/ai/runtime.js";
import { readSessionState } from "../src/services/ai/session.js";
import type { AzevedoOsClient } from "../src/services/azevedo-os-client.js";

/**
 * O modelo PEDE, o backend DECIDE. Estes testes fixam as três portas da
 * execução de ferramenta: capacidade desligada recusa, argumento inválido
 * recusa, alvo fora da conversa recusa — e nada disso depende do prompt.
 */

interface Recorded {
  tagUpserts: unknown[];
  tagDeletes: unknown[];
  notes: unknown[];
  conversationUpdates: unknown[];
  scheduled: unknown[];
}

function fakePrisma(recorded: Recorded): PrismaClient {
  return {
    conversationTag: {
      upsert: async (args: unknown) => {
        recorded.tagUpserts.push(args);
        return {};
      },
      deleteMany: async (args: unknown) => {
        recorded.tagDeletes.push(args);
        return { count: 1 };
      },
    },
    internalNote: {
      create: async (args: unknown) => {
        recorded.notes.push(args);
        return {};
      },
    },
    conversation: {
      update: async (args: unknown) => {
        recorded.conversationUpdates.push(args);
        return {};
      },
      // O motor de follow-up relê a conversa antes de decidir. Devolve o
      // último status gravado, como o banco faria.
      findUnique: async () => ({
        id: "conv-1",
        organizationId: "org-1",
        whatsappInstanceId: "inst-1",
        departmentId: null,
        status: (recorded.conversationUpdates.at(-1) as { data?: { status?: string } } | undefined)?.data?.status ?? "open",
        archivedAt: null,
      }),
    },
    // O follow-up automático é consultado ao entrar em "aguardando cliente":
    // sem regra cadastrada, nada começa.
    followUpExecution: { findFirst: async () => null },
    followUpRule: { findMany: async () => [] },
    $transaction: async (ops: Promise<unknown>[]) => Promise.all(ops),
  } as unknown as PrismaClient;
}

function env(overrides: Partial<ActionEnvironment> = {}): ActionEnvironment {
  const config = defaultAiAgentConfig();
  config.dataCollection.fields = [{ key: "cidade", label: "Cidade", required: false, hint: "" }];
  return {
    agent: { id: "agent-1", name: "IA Comercial" },
    config,
    conversation: {
      id: "conv-1",
      organizationId: "org-1",
      type: "individual",
      title: "5511999998888",
      customTitle: null,
      departmentId: null,
      externalReference: null,
      externalSource: null,
    },
    state: readSessionState(null),
    tags: [{ id: "tag-lead", name: "Lead" }],
    knowledgeSources: [],
    quickReplies: [],
    azevedoOsEnabled: false,
    ...overrides,
  };
}

const deps = {
  logger: pino({ level: "silent" }),
  io: { to: () => ({ emit: () => undefined }) } as unknown as Server,
  azevedoOs: {} as AzevedoOsClient,
};

describe("executeTool — as três portas", () => {
  it("capacidade desligada recusa mesmo com argumentos perfeitos", async () => {
    const recorded: Recorded = { tagUpserts: [], tagDeletes: [], notes: [], conversationUpdates: [], scheduled: [] };
    const environment = env();
    environment.config.canDo.capabilities.add_tags = false;
    const outcome = await executeTool({ ...deps, prisma: fakePrisma(recorded) }, environment, { id: "c1", name: "add_tag", arguments: { name: "Lead" } }, "live");
    expect(outcome.executed).toBe(false);
    expect(outcome.blockedReason).toContain("não está liberada");
    expect(recorded.tagUpserts).toHaveLength(0);
  });

  it("ferramenta desconhecida e argumento inválido são recusados", async () => {
    const recorded: Recorded = { tagUpserts: [], tagDeletes: [], notes: [], conversationUpdates: [], scheduled: [] };
    const prisma = fakePrisma(recorded);
    const unknown = await executeTool({ ...deps, prisma }, env(), { id: "c1", name: "drop_database", arguments: {} }, "live");
    expect(unknown.executed).toBe(false);
    const invalid = await executeTool({ ...deps, prisma }, env(), { id: "c2", name: "add_internal_note", arguments: {} }, "live");
    expect(invalid.executed).toBe(false);
    expect(invalid.blockedReason).toContain("argumentos inválidos");
    expect(recorded.notes).toHaveLength(0);
  });

  it("etiqueta fora da conversa e campo fora da lista são recusados", async () => {
    const recorded: Recorded = { tagUpserts: [], tagDeletes: [], notes: [], conversationUpdates: [], scheduled: [] };
    const prisma = fakePrisma(recorded);
    const tag = await executeTool({ ...deps, prisma }, env(), { id: "c1", name: "add_tag", arguments: { name: "Financeiro" } }, "live");
    expect(tag.executed).toBe(false);
    const field = await executeTool({ ...deps, prisma }, env(), { id: "c2", name: "save_collected_data", arguments: { field: "faturamento", value: "10k" } }, "live");
    expect(field.executed).toBe(false);
    expect(recorded.tagUpserts).toHaveLength(0);
  });

  it("ação permitida executa e muta a memória do atendimento", async () => {
    const recorded: Recorded = { tagUpserts: [], tagDeletes: [], notes: [], conversationUpdates: [], scheduled: [] };
    const environment = env();
    const prisma = fakePrisma(recorded);
    const tag = await executeTool({ ...deps, prisma }, environment, { id: "c1", name: "add_tag", arguments: { name: "lead" } }, "live");
    expect(tag.executed).toBe(true);
    expect(recorded.tagUpserts).toHaveLength(1);
    const data = await executeTool({ ...deps, prisma }, environment, { id: "c2", name: "save_collected_data", arguments: { field: "cidade", value: "Niterói" } }, "live");
    expect(data.executed).toBe(true);
    expect(environment.state.collected.cidade).toBe("Niterói");
    const name = await executeTool({ ...deps, prisma }, environment, { id: "c3", name: "update_contact_name", arguments: { name: "João Silva" } }, "live");
    expect(name.executed).toBe(true);
    expect(recorded.conversationUpdates).toHaveLength(1);
    expect(environment.state.actions.map((action) => action.tool)).toEqual(["add_tag", "save_collected_data", "update_contact_name"]);
  });

  it("não sobrescreve nome que a equipe definiu", async () => {
    const recorded: Recorded = { tagUpserts: [], tagDeletes: [], notes: [], conversationUpdates: [], scheduled: [] };
    const environment = env({ conversation: { ...env().conversation, customTitle: "Cliente VIP" } });
    const outcome = await executeTool({ ...deps, prisma: fakePrisma(recorded) }, environment, { id: "c1", name: "update_contact_name", arguments: { name: "Outro" } }, "live");
    expect(outcome.executed).toBe(false);
    expect(recorded.conversationUpdates).toHaveLength(0);
  });

  it("dryRun (testador) aplica as mesmas regras e NÃO grava nada", async () => {
    const recorded: Recorded = { tagUpserts: [], tagDeletes: [], notes: [], conversationUpdates: [], scheduled: [] };
    const environment = env();
    const prisma = fakePrisma(recorded);
    const tag = await executeTool({ ...deps, prisma }, environment, { id: "c1", name: "add_tag", arguments: { name: "Lead" } }, "dryRun");
    const note = await executeTool({ ...deps, prisma }, environment, { id: "c2", name: "add_internal_note", arguments: { content: "Lead quente" } }, "dryRun");
    expect(tag.executed).toBe(true);
    expect(note.executed).toBe(true);
    expect(recorded.tagUpserts).toHaveLength(0);
    expect(recorded.notes).toHaveLength(0);
  });

  it("transferir e concluir são terminais; follow-up põe em aguardando cliente e encerra", async () => {
    const recorded: Recorded = { tagUpserts: [], tagDeletes: [], notes: [], conversationUpdates: [], scheduled: [] };
    const environment = env();
    environment.config.canDo.capabilities.schedule_followup = true;
    const prisma = fakePrisma(recorded);
    const transfer = await executeTool({ ...deps, prisma }, environment, { id: "c1", name: "transfer_to_human", arguments: { reason: "Pediu proposta", subject: "Abertura", need: "Abrir empresa", summary: "Resumo" } }, "live");
    expect(transfer.terminal?.kind).toBe("transfer");
    const finish = await executeTool({ ...deps, prisma }, environment, { id: "c2", name: "finish_conversation", arguments: { summary: "Resolvido" } }, "live");
    expect(finish.terminal?.kind).toBe("finish");
    const followup = await executeTool({ ...deps, prisma }, environment, { id: "c3", name: "schedule_followup", arguments: { reason: "Vai verificar com o sócio" } }, "live");
    expect(followup.terminal).toEqual({ kind: "followup", ruleName: null });
    // Sem regra de follow-up cadastrada: a conversa fica aguardando o cliente
    // e o modelo é avisado para não prometer lembrete.
    expect(recorded.conversationUpdates.at(-1)).toMatchObject({ data: { status: "waiting_client" } });
    expect(followup.result).toContain("Não há regra de follow-up");
    expect(recorded.scheduled).toHaveLength(0);
  });

  it("consulta de empresa é recusada sem vínculo, sem chamar o Azevedo-OS", async () => {
    const recorded: Recorded = { tagUpserts: [], tagDeletes: [], notes: [], conversationUpdates: [], scheduled: [] };
    const environment = env({ azevedoOsEnabled: true });
    environment.config.canDo.capabilities.lookup_company = true;
    const outcome = await executeTool({ ...deps, prisma: fakePrisma(recorded) }, environment, { id: "c1", name: "lookup_company", arguments: {} }, "live");
    expect(outcome.executed).toBe(false);
    expect(outcome.blockedReason).toContain("não está vinculada");
  });
});

describe("automationMatches — o gatilho do bloco de IA", () => {
  const base = {
    whatsappInstanceId: null as string | null,
    departmentId: null as string | null,
    onlyWithoutDepartment: false,
    conversationType: "any",
    onlyUnassigned: true,
    onlyNewConversations: false,
  };
  const conversation = {
    whatsappInstanceId: "inst-1",
    departmentId: "dep-1",
    type: "individual" as const,
    assignedUserId: null as string | null,
    assignedToAll: false,
    archivedAt: null as Date | null,
  };

  it("sem restrição casa com tudo que está sem responsável", () => {
    expect(automationMatches(base, conversation, { isFirstInbound: false })).toBe(true);
  });

  it("a IA não toma conversa de gente nem coletiva", () => {
    expect(automationMatches(base, { ...conversation, assignedUserId: "u1" }, { isFirstInbound: false })).toBe(false);
    expect(automationMatches(base, { ...conversation, assignedToAll: true }, { isFirstInbound: false })).toBe(false);
    expect(automationMatches({ ...base, onlyUnassigned: false }, { ...conversation, assignedUserId: "u1" }, { isFirstInbound: false })).toBe(true);
  });

  it("número, departamento, tipo e primeira mensagem restringem", () => {
    expect(automationMatches({ ...base, whatsappInstanceId: "inst-2" }, conversation, { isFirstInbound: false })).toBe(false);
    expect(automationMatches({ ...base, departmentId: "dep-2" }, conversation, { isFirstInbound: false })).toBe(false);
    expect(automationMatches({ ...base, onlyWithoutDepartment: true }, conversation, { isFirstInbound: false })).toBe(false);
    expect(automationMatches({ ...base, onlyWithoutDepartment: true }, { ...conversation, departmentId: null }, { isFirstInbound: false })).toBe(true);
    expect(automationMatches({ ...base, conversationType: "group" }, conversation, { isFirstInbound: false })).toBe(false);
    expect(automationMatches({ ...base, onlyNewConversations: true }, conversation, { isFirstInbound: false })).toBe(false);
    expect(automationMatches({ ...base, onlyNewConversations: true }, conversation, { isFirstInbound: true })).toBe(true);
  });

  it("arquivada nunca entra", () => {
    expect(automationMatches(base, { ...conversation, archivedAt: new Date() }, { isFirstInbound: true })).toBe(false);
  });
});

describe("custo estimado — nunca inventado", () => {
  it("modelo do catálogo tem custo; modelo desconhecido devolve null", () => {
    expect(estimateCostMicros("gpt-4.1-mini", 1_000_000, 1_000_000)).toBe(2_000_000);
    expect(estimateCostMicros("modelo-inexistente", 1000, 1000)).toBeNull();
  });

  it("preço sobreposto pela organização vence o catálogo", () => {
    const overrides = { "gpt-4.1-mini": { inputPerMillion: 1, outputPerMillion: 1 } };
    expect(resolveModelPricing("gpt-4.1-mini", overrides)).toEqual({ inputPerMillion: 1, outputPerMillion: 1 });
    expect(estimateCostMicros("modelo-inexistente", 1_000_000, 0, { "modelo-inexistente": { inputPerMillion: 3, outputPerMillion: 3 } })).toBe(3_000_000);
  });
});

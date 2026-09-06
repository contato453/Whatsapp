import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@azvchat/database";
import type { WhatsAppProvider } from "@azvchat/whatsapp";
import {
  cancelExecution,
  getActiveExecution,
  handleInboundMessage,
  handleOutboundMessage,
  pauseExecution,
  pickApplicableRule,
  postponeExecution,
  processDueExecutions,
  reconcileConversation,
  resumeExecution,
  startExecution,
  type FollowUpDeps,
} from "../src/lib/follow-up-engine.js";

/**
 * Cenário A/B/C do pedido (seção 45), na régua de menor nível: sem HTTP,
 * sem worker de verdade — só o motor (`follow-up-engine.ts`) contra um
 * banco de mentira, na mesma linha dos testes de `department-resources.ts`.
 *
 * O banco de mentira é um punhado de mapas em memória com só as operações
 * que o motor realmente chama — não é um Prisma completo, é o suficiente
 * para o motor não notar a diferença.
 */

const ORG = "org-1";
const COMERCIAL = "dept-comercial";
const FINANCEIRO = "dept-financeiro";
const SUPORTE = "dept-suporte";
const CONV = "conv-1";
const INSTANCE = "instance-1";

interface FakeDb {
  conversations: Map<string, Record<string, unknown>>;
  rules: Map<string, Record<string, unknown>>;
  ruleDepartments: Array<{ ruleId: string; departmentId: string }>;
  steps: Map<string, Array<Record<string, unknown>>>; // ruleId -> steps
  executions: Map<string, Record<string, unknown>>;
  logs: Array<Record<string, unknown>>;
  tags: Map<string, Record<string, unknown>>;
  conversationTags: Set<string>; // `${conversationId}:${tagId}`
  messages: Array<Record<string, unknown>>;
  history: Array<Record<string, unknown>>;
}

function freshDb(): FakeDb {
  return {
    conversations: new Map(),
    rules: new Map(),
    ruleDepartments: [],
    steps: new Map(),
    executions: new Map(),
    logs: [],
    tags: new Map(),
    conversationTags: new Set(),
    messages: [],
    history: [],
  };
}

let db: FakeDb;
let executionSeq: number;

function onlyExecution(): Record<string, unknown> & { id: string } {
  const execution = [...db.executions.values()][0];
  if (!execution) throw new Error("nenhuma execução encontrada no banco de mentira");
  return execution as Record<string, unknown> & { id: string };
}

/** Simula o worker achando a etapa vencida: força `nextRunAt` para o passado. */
function makeExecutionDue(execution: Record<string, unknown> & { id: string }): void {
  db.executions.set(execution.id, { ...execution, nextRunAt: new Date(Date.now() - 1000) });
}

function makeConversation(overrides: Record<string, unknown> = {}) {
  return {
    id: CONV,
    organizationId: ORG,
    whatsappInstanceId: INSTANCE,
    externalChatId: "5511999999999@s.whatsapp.net",
    departmentId: null,
    status: "open",
    archivedAt: null,
    externalReference: null,
    externalSource: null,
    customTitle: null,
    title: "Cliente",
    type: "individual",
    profilePicture: null,
    assignedUserId: null,
    assignedToAll: false,
    lastMessageAt: null,
    lastMessagePreview: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function makeRule(
  id: string,
  overrides: Record<string, unknown> = {},
  departmentIds: string[] = [],
) {
  db.rules.set(id, {
    id,
    organizationId: ORG,
    name: id,
    status: "active",
    isGeneral: departmentIds.length === 0,
    whatsappInstanceId: null,
    respectBusinessHours: false,
    finalizeOnComplete: true,
    finalizeReason: "Sem retorno do cliente",
    finalizeTagId: null,
    updatedAt: new Date(),
    ...overrides,
  });
  for (const departmentId of departmentIds) db.ruleDepartments.push({ ruleId: id, departmentId });
  return db.rules.get(id)!;
}

function addStep(ruleId: string, step: Record<string, unknown>) {
  const list = db.steps.get(ruleId) ?? [];
  list.push({ ruleId, tagId: null, newStatus: null, messageContent: null, ...step });
  db.steps.set(ruleId, list);
}

/** Anexa `rule`/`conversation` quando o `include` da chamada pede. */
function withIncludes(row: Record<string, unknown>, include: any): Record<string, unknown> {
  if (!include) return row;
  const result: Record<string, unknown> = { ...row };
  if (include.rule && row.ruleId) result.rule = db.rules.get(row.ruleId as string) ?? null;
  if (include.conversation && row.conversationId) {
    const conv = db.conversations.get(row.conversationId as string) as any;
    result.conversation = conv
      ? { ...conv, department: conv.departmentId ? { id: conv.departmentId, name: conv.departmentId } : null }
      : null;
  }
  return result;
}

function fakePrisma(): PrismaClient {
  return {
    conversation: {
      findUnique: async ({ where, include }: any) => {
        const conv = db.conversations.get(where.id);
        if (!conv) return null;
        if (!include) return conv;
        return {
          ...conv,
          assignedUser: null,
          department: (conv as any).departmentId
            ? { id: (conv as any).departmentId, name: (conv as any).departmentId, color: null }
            : null,
          instance: null,
          tags: [],
        };
      },
      update: async ({ where, data }: any) => {
        const current = db.conversations.get(where.id);
        const updated = { ...current, ...data };
        db.conversations.set(where.id, updated);
        return updated;
      },
    },
    followUpRule: {
      findMany: async ({ where }: any) => {
        return [...db.rules.values()].filter(
          (rule) => rule.organizationId === where.organizationId && rule.status === where.status,
        ).map((rule) => ({
          ...rule,
          departments: db.ruleDepartments.filter((link) => link.ruleId === rule.id),
          steps: (db.steps.get(rule.id as string) ?? []).slice().sort((a: any, b: any) => a.order - b.order),
        }));
      },
      findUnique: async ({ where, include }: any) => {
        const rule = db.rules.get(where.id);
        if (!rule) return null;
        if (!include) return rule;
        return {
          ...rule,
          departments: db.ruleDepartments.filter((link) => link.ruleId === rule.id),
          steps: (db.steps.get(rule.id as string) ?? []).slice().sort((a: any, b: any) => a.order - b.order),
        };
      },
    },
    followUpRuleStep: {
      findFirst: async ({ where }: any) => {
        const list = db.steps.get(where.ruleId) ?? [];
        return list.find((step: any) => step.order === where.order) ?? null;
      },
      count: async ({ where }: any) => (db.steps.get(where.ruleId) ?? []).length,
    },
    followUpExecution: {
      create: async ({ data }: any) => {
        executionSeq += 1;
        const id = `exec-${executionSeq}`;
        const row = {
          id,
          status: "active",
          pauseUntil: null,
          finishedAt: null,
          finishReason: null,
          messagesSentCount: 0,
          startedAt: new Date(),
          ...data,
        };
        db.executions.set(id, row);
        return row;
      },
      update: async ({ where, data }: any) => {
        const current = db.executions.get(where.id);
        const updated = { ...current, ...data };
        db.executions.set(where.id, updated);
        return updated;
      },
      findFirst: async ({ where, include }: any) => {
        const list = [...db.executions.values()].filter((e: any) => {
          if (where.conversationId && e.conversationId !== where.conversationId) return false;
          if (where.status?.in && !where.status.in.includes(e.status)) return false;
          if (where.status && typeof where.status === "string" && e.status !== where.status) return false;
          return true;
        });
        const found = list[0];
        if (!found) return null;
        return withIncludes(found, include);
      },
      findMany: async ({ where }: any) => {
        return [...db.executions.values()].filter((e: any) => {
          if (where.status?.in && !where.status.in.includes(e.status)) return false;
          if (where.status && typeof where.status === "string" && e.status !== where.status) return false;
          if (where.nextRunAt?.lte && !(e.nextRunAt && e.nextRunAt.getTime() <= where.nextRunAt.lte.getTime())) {
            return false;
          }
          if (where.pauseUntil?.lte && !(e.pauseUntil && e.pauseUntil.getTime() <= where.pauseUntil.lte.getTime())) {
            return false;
          }
          return true;
        });
      },
    },
    followUpExecutionLog: {
      create: async ({ data }: any) => {
        db.logs.push(data);
        return data;
      },
    },
    tag: {
      findFirst: async ({ where }: any) => db.tags.get(where.id) ?? null,
    },
    conversationTag: {
      upsert: async ({ where }: any) => {
        db.conversationTags.add(`${where.conversationId_tagId.conversationId}:${where.conversationId_tagId.tagId}`);
        return {};
      },
      delete: async ({ where }: any) => {
        db.conversationTags.delete(`${where.conversationId_tagId.conversationId}:${where.conversationId_tagId.tagId}`);
        return {};
      },
    },
    conversationAssignmentHistory: {
      create: async ({ data }: any) => {
        db.history.push(data);
        return data;
      },
    },
    message: {
      create: async ({ data }: any) => {
        const message = { id: `msg-${db.messages.length + 1}`, createdAt: new Date(), reactions: [], ...data };
        db.messages.push(message);
        return message;
      },
    },
    attendanceSettings: {
      findUnique: async () => null,
    },
    $transaction: async (ops: any[]) => Promise.all(ops),
  } as unknown as PrismaClient;
}

function fakeIo() {
  return { to: () => ({ emit: () => undefined }) };
}

function fakeLogger() {
  return { info: () => undefined, warn: () => undefined, error: () => undefined } as any;
}

function fakeProvider(sendText = vi.fn(async () => ({ externalMessageId: "wa-1", timestamp: new Date() }))) {
  return { sendText } as unknown as WhatsAppProvider;
}

function fakeAzevedoOs() {
  return { getCompany: vi.fn(async () => null) } as any;
}

function buildDeps(overrides: Partial<FollowUpDeps> = {}): FollowUpDeps {
  return {
    prisma: fakePrisma(),
    io: fakeIo() as any,
    logger: fakeLogger(),
    provider: fakeProvider(),
    azevedoOs: fakeAzevedoOs(),
    ...overrides,
  };
}

beforeEach(() => {
  db = freshDb();
  executionSeq = 0;
});

describe("pickApplicableRule — vínculo com departamento (seções 3-6)", () => {
  it("regra vinculada a um único departamento", async () => {
    makeRule("r-comercial", {}, [COMERCIAL]);
    const prisma = fakePrisma();
    const found = await pickApplicableRule(prisma, ORG, { departmentId: COMERCIAL, whatsappInstanceId: INSTANCE });
    expect(found?.id).toBe("r-comercial");
    expect(
      await pickApplicableRule(prisma, ORG, { departmentId: FINANCEIRO, whatsappInstanceId: INSTANCE }),
    ).toBeNull();
  });

  it("regra vinculada a dois departamentos — UMA regra serve os dois (cenário B)", async () => {
    makeRule("r-padrao", {}, [COMERCIAL, FINANCEIRO]);
    const prisma = fakePrisma();
    expect(
      (await pickApplicableRule(prisma, ORG, { departmentId: COMERCIAL, whatsappInstanceId: INSTANCE }))?.id,
    ).toBe("r-padrao");
    expect(
      (await pickApplicableRule(prisma, ORG, { departmentId: FINANCEIRO, whatsappInstanceId: INSTANCE }))?.id,
    ).toBe("r-padrao");
    expect(
      await pickApplicableRule(prisma, ORG, { departmentId: SUPORTE, whatsappInstanceId: INSTANCE }),
    ).toBeNull();
  });

  it("regra vinculada a vários departamentos (três ou mais)", async () => {
    makeRule("r-tres", {}, [COMERCIAL, FINANCEIRO, SUPORTE]);
    const prisma = fakePrisma();
    for (const dep of [COMERCIAL, FINANCEIRO, SUPORTE]) {
      expect((await pickApplicableRule(prisma, ORG, { departmentId: dep, whatsappInstanceId: INSTANCE }))?.id).toBe(
        "r-tres",
      );
    }
  });

  it("regra vinculada a todos os departamentos (isGeneral) — e conversa sem departamento também aceita", async () => {
    makeRule("r-geral", { isGeneral: true });
    const prisma = fakePrisma();
    expect(
      (await pickApplicableRule(prisma, ORG, { departmentId: SUPORTE, whatsappInstanceId: INSTANCE }))?.id,
    ).toBe("r-geral");
    expect(
      (await pickApplicableRule(prisma, ORG, { departmentId: null, whatsappInstanceId: INSTANCE }))?.id,
    ).toBe("r-geral");
  });

  it("regra específica do departamento vence a geral (prioridade — seção 18)", async () => {
    makeRule("r-geral", { isGeneral: true });
    makeRule("r-financeiro", {}, [FINANCEIRO]);
    const prisma = fakePrisma();
    expect(
      (await pickApplicableRule(prisma, ORG, { departmentId: FINANCEIRO, whatsappInstanceId: INSTANCE }))?.id,
    ).toBe("r-financeiro");
  });

  it("editar a regra compartilhada e remover um departamento tira só aquele departamento", async () => {
    makeRule("r-padrao", {}, [COMERCIAL, FINANCEIRO]);
    // "Editar" aqui é reaplicar o vínculo, como a rota faz (apaga e recria).
    db.ruleDepartments = db.ruleDepartments.filter((link) => link.departmentId !== FINANCEIRO);
    const prisma = fakePrisma();
    expect(
      (await pickApplicableRule(prisma, ORG, { departmentId: COMERCIAL, whatsappInstanceId: INSTANCE }))?.id,
    ).toBe("r-padrao");
    expect(
      await pickApplicableRule(prisma, ORG, { departmentId: FINANCEIRO, whatsappInstanceId: INSTANCE }),
    ).toBeNull();
  });
});

describe("ciclo de vida do timer (seções 7-16)", () => {
  it("status vira 'aguardando cliente' → timer é criado", async () => {
    db.conversations.set(CONV, makeConversation({ departmentId: FINANCEIRO, status: "waiting_client" }));
    makeRule("r-financeiro", {}, [FINANCEIRO]);
    addStep("r-financeiro", { order: 1, waitAmount: 2, waitUnit: "hours", action: "send_message", messageContent: "Oi" });
    const deps = buildDeps();
    await reconcileConversation(deps, CONV);
    const execution = await getActiveExecution(deps.prisma, CONV);
    expect(execution?.status).toBe("active");
    expect(execution?.ruleId).toBe("r-financeiro");
    expect(execution?.currentStepOrder).toBe(1);
  });

  it("cliente responde antes do prazo → timer é cancelado", async () => {
    db.conversations.set(CONV, makeConversation({ departmentId: FINANCEIRO, status: "waiting_client" }));
    makeRule("r-financeiro", {}, [FINANCEIRO]);
    addStep("r-financeiro", { order: 1, waitAmount: 2, waitUnit: "hours", action: "send_message", messageContent: "Oi" });
    const deps = buildDeps();
    await reconcileConversation(deps, CONV);
    expect((await getActiveExecution(deps.prisma, CONV))?.status).toBe("active");

    await handleInboundMessage(deps, CONV);

    expect(await getActiveExecution(deps.prisma, CONV)).toBeNull();
    const execution = onlyExecution();
    expect(execution.status).toBe("canceled");
    expect(execution.finishReason).toBe("client_replied");
  });

  it("cliente não responde → follow-up é enviado (primeira etapa)", async () => {
    db.conversations.set(CONV, makeConversation({ departmentId: FINANCEIRO, status: "waiting_client" }));
    makeRule("r-financeiro", {}, [FINANCEIRO]);
    addStep("r-financeiro", {
      order: 1,
      waitAmount: 2,
      waitUnit: "hours",
      action: "send_message",
      messageContent: "Olá, {{primeiro_nome}}!",
    });
    const sendText = vi.fn(async () => ({ externalMessageId: "wa-1", timestamp: new Date() }));
    const deps = buildDeps({ provider: fakeProvider(sendText) });
    await reconcileConversation(deps, CONV);

    // Vence o prazo: força `nextRunAt` para o passado, como o worker acharia.
    const execution = onlyExecution();
    makeExecutionDue(execution);

    await processDueExecutions(deps, 10);

    expect(sendText).toHaveBeenCalledTimes(1);
    expect(db.messages).toHaveLength(1);
    expect(db.messages[0]?.direction).toBe("outbound");
  });

  it("cliente responde DEPOIS do primeiro follow-up → etapas seguintes são canceladas", async () => {
    db.conversations.set(CONV, makeConversation({ departmentId: FINANCEIRO, status: "waiting_client" }));
    makeRule("r-financeiro", {}, [FINANCEIRO]);
    addStep("r-financeiro", { order: 1, waitAmount: 2, waitUnit: "hours", action: "send_message", messageContent: "Oi" });
    addStep("r-financeiro", { order: 2, waitAmount: 24, waitUnit: "hours", action: "send_message", messageContent: "Ainda aguardando" });
    const deps = buildDeps();
    await reconcileConversation(deps, CONV);
    let execution = onlyExecution();
    makeExecutionDue(execution);
    await processDueExecutions(deps, 10);

    execution = onlyExecution();
    expect(execution.status).toBe("active");
    expect(execution.currentStepOrder).toBe(2);

    await handleInboundMessage(deps, CONV);

    execution = onlyExecution();
    expect(execution.status).toBe("canceled");
    // A segunda etapa nunca chega a rodar: só uma mensagem foi enviada.
    expect(db.messages).toHaveLength(1);
  });

  it("cliente nunca responde → todas as etapas rodam e o atendimento é encerrado (cenário C)", async () => {
    db.conversations.set(CONV, makeConversation({ departmentId: FINANCEIRO, status: "waiting_client" }));
    makeRule("r-financeiro", { finalizeOnComplete: true, finalizeReason: "Sem retorno do cliente" }, [FINANCEIRO]);
    addStep("r-financeiro", { order: 1, waitAmount: 2, waitUnit: "hours", action: "send_message", messageContent: "1" });
    addStep("r-financeiro", { order: 2, waitAmount: 24, waitUnit: "hours", action: "send_message", messageContent: "2" });
    addStep("r-financeiro", { order: 3, waitAmount: 24, waitUnit: "hours", action: "send_message", messageContent: "3" });
    const deps = buildDeps();
    await reconcileConversation(deps, CONV);

    for (let volta = 0; volta < 3; volta += 1) {
      const execution = onlyExecution();
      makeExecutionDue(execution);
      await processDueExecutions(deps, 10);
    }

    expect(db.messages).toHaveLength(3);
    const execution = onlyExecution();
    expect(execution.status).toBe("completed");
    expect(execution.finishReason).toBe("completed_no_reply");
    expect(db.conversations.get(CONV)?.status).toBe("resolved");
    expect(db.history).toHaveLength(1);
    expect(db.history[0]?.note).toContain("Sem retorno do cliente");
  });

  it("nova mensagem do atendente reinicia o timer (não cria um segundo)", async () => {
    db.conversations.set(CONV, makeConversation({ departmentId: FINANCEIRO, status: "waiting_client" }));
    makeRule("r-financeiro", {}, [FINANCEIRO]);
    addStep("r-financeiro", { order: 1, waitAmount: 2, waitUnit: "hours", action: "send_message", messageContent: "Oi" });
    const deps = buildDeps();
    await reconcileConversation(deps, CONV);
    const before = (await getActiveExecution(deps.prisma, CONV))!;
    const originalNextRunAt = before.nextRunAt as Date;

    await new Promise((resolve) => setTimeout(resolve, 5));
    await handleOutboundMessage(deps, CONV);

    expect(db.executions.size).toBe(1);
    const after = await getActiveExecution(deps.prisma, CONV);
    expect(after?.id).toBe(before.id);
    expect((after?.nextRunAt as Date).getTime()).toBeGreaterThan(originalNextRunAt.getTime());
  });

  it("mudança de departamento reavalia a regra (seção 17)", async () => {
    db.conversations.set(CONV, makeConversation({ departmentId: COMERCIAL, status: "waiting_client" }));
    makeRule("r-comercial", {}, [COMERCIAL]);
    addStep("r-comercial", { order: 1, waitAmount: 2, waitUnit: "hours", action: "send_message", messageContent: "Oi" });
    makeRule("r-financeiro", {}, [FINANCEIRO]);
    addStep("r-financeiro", { order: 1, waitAmount: 1, waitUnit: "hours", action: "send_message", messageContent: "Oi 2" });
    const deps = buildDeps();
    await reconcileConversation(deps, CONV);
    expect((await getActiveExecution(deps.prisma, CONV))?.ruleId).toBe("r-comercial");

    db.conversations.set(CONV, { ...db.conversations.get(CONV), departmentId: FINANCEIRO });
    await reconcileConversation(deps, CONV);

    const active = await getActiveExecution(deps.prisma, CONV);
    expect(active?.ruleId).toBe("r-financeiro");
    // A execução do Comercial some (é cancelada), não fica pendurada.
    const canceled = [...db.executions.values()].find((e: any) => e.ruleId === "r-comercial");
    expect(canceled?.status).toBe("canceled");
    expect(canceled?.finishReason).toBe("canceled_department_change");
  });

  it("mudança de status para fora de 'aguardando cliente' cancela a régua", async () => {
    db.conversations.set(CONV, makeConversation({ departmentId: FINANCEIRO, status: "waiting_client" }));
    makeRule("r-financeiro", {}, [FINANCEIRO]);
    addStep("r-financeiro", { order: 1, waitAmount: 2, waitUnit: "hours", action: "send_message", messageContent: "Oi" });
    const deps = buildDeps();
    await reconcileConversation(deps, CONV);
    db.conversations.set(CONV, { ...db.conversations.get(CONV), status: "resolved" });
    await reconcileConversation(deps, CONV);
    expect(await getActiveExecution(deps.prisma, CONV)).toBeNull();
  });

  it("reinício do processo não perde timer — o estado inteiro vive no banco", async () => {
    db.conversations.set(CONV, makeConversation({ departmentId: FINANCEIRO, status: "waiting_client" }));
    makeRule("r-financeiro", {}, [FINANCEIRO]);
    addStep("r-financeiro", { order: 1, waitAmount: 2, waitUnit: "hours", action: "send_message", messageContent: "Oi" });
    const deps = buildDeps();
    await reconcileConversation(deps, CONV);
    const before = await getActiveExecution(deps.prisma, CONV);
    // "Reiniciar o processo" aqui é só instanciar um FollowUpDeps novo — o
    // motor não guarda NADA de estado próprio em memória, só lê o banco.
    const depsAfterRestart = buildDeps();
    depsAfterRestart.prisma = deps.prisma;
    const after = await getActiveExecution(depsAfterRestart.prisma, CONV);
    expect(after?.id).toBe(before?.id);
    expect(after?.nextRunAt).toEqual(before?.nextRunAt);
  });

  it("erro de envio fica registrado (log de falha, execução marcada e não trava)", async () => {
    db.conversations.set(CONV, makeConversation({ departmentId: FINANCEIRO, status: "waiting_client" }));
    makeRule("r-financeiro", {}, [FINANCEIRO]);
    addStep("r-financeiro", { order: 1, waitAmount: 2, waitUnit: "hours", action: "send_message", messageContent: "Oi" });
    const sendText = vi.fn(async () => {
      throw new Error("instância desconectada");
    });
    const deps = buildDeps({ provider: fakeProvider(sendText) });
    await reconcileConversation(deps, CONV);
    const execution = onlyExecution();
    makeExecutionDue(execution);

    await processDueExecutions(deps, 10);

    const failedLog = db.logs.find((entry) => entry.eventType === "step_failed");
    expect(failedLog?.detail).toContain("instância desconectada");
  });
});

describe("adiar, pausar e retomar (seções 27-29)", () => {
  async function withActiveExecution(deps: FollowUpDeps) {
    db.conversations.set(CONV, makeConversation({ departmentId: FINANCEIRO, status: "waiting_client" }));
    makeRule("r-financeiro", {}, [FINANCEIRO]);
    addStep("r-financeiro", { order: 1, waitAmount: 2, waitUnit: "hours", action: "send_message", messageContent: "Oi" });
    await reconcileConversation(deps, CONV);
    return (await getActiveExecution(deps.prisma, CONV))!;
  }

  it("atendente adia para um horário específico", async () => {
    const deps = buildDeps();
    await withActiveExecution(deps);
    const until = new Date(Date.now() + 60 * 60_000);
    await postponeExecution(deps, CONV, { until, actorUserId: "user-1" });
    const execution = await getActiveExecution(deps.prisma, CONV);
    expect(execution?.nextRunAt).toEqual(until);
    expect(db.logs.some((entry) => entry.eventType === "postponed" && entry.actorUserId === "user-1")).toBe(true);
  });

  it("atendente pausa sem prazo — nenhuma etapa roda enquanto pausado", async () => {
    const deps = buildDeps();
    const before = await withActiveExecution(deps);
    db.executions.set(before.id, { ...before, nextRunAt: new Date(Date.now() - 1000) });
    await pauseExecution(deps, CONV, { untilAt: null, actorUserId: "user-1" });

    await processDueExecutions(deps, 10);

    expect(db.messages).toHaveLength(0);
    const execution = db.executions.get(before.id);
    expect(execution?.status).toBe("paused");
  });

  it("atendente retoma manualmente", async () => {
    const deps = buildDeps();
    const before = await withActiveExecution(deps);
    await pauseExecution(deps, CONV, { untilAt: null, actorUserId: "user-1" });
    await resumeExecution(deps, CONV, { actorUserId: "user-1" });
    const execution = db.executions.get(before.id);
    expect(execution?.status).toBe("active");
  });

  it("pausa COM prazo volta a rodar sozinha quando o prazo vence", async () => {
    const deps = buildDeps();
    const before = await withActiveExecution(deps);
    await pauseExecution(deps, CONV, { untilAt: new Date(Date.now() - 1000), actorUserId: "user-1" });
    // O tick também precisa achar a etapa vencida para efetivamente rodar.
    const paused = db.executions.get(before.id)!;
    db.executions.set(before.id, { ...paused, nextRunAt: new Date(Date.now() - 1000) });

    await processDueExecutions(deps, 10);

    expect(db.messages).toHaveLength(1);
  });
});

describe("proteção contra duplicidade (seção 36)", () => {
  it("reavaliar duas vezes seguidas não cria uma segunda execução", async () => {
    db.conversations.set(CONV, makeConversation({ departmentId: FINANCEIRO, status: "waiting_client" }));
    makeRule("r-financeiro", {}, [FINANCEIRO]);
    addStep("r-financeiro", { order: 1, waitAmount: 2, waitUnit: "hours", action: "send_message", messageContent: "Oi" });
    const deps = buildDeps();
    await reconcileConversation(deps, CONV);
    await reconcileConversation(deps, CONV);
    await reconcileConversation(deps, CONV);
    expect(db.executions.size).toBe(1);
  });

  it("cancelar quando não há execução nenhuma é inofensivo (idempotente)", async () => {
    db.conversations.set(CONV, makeConversation({ status: "open" }));
    const deps = buildDeps();
    await expect(cancelExecution(deps, CONV, { reason: "canceled_manual" })).resolves.toBeUndefined();
  });

  it("quem garante 'nunca duas ao mesmo tempo' de verdade é o índice parcial do banco", async () => {
    // `startExecution` sozinho NÃO checa se já existe uma ativa — quem checa
    // é `reconcileConversation` (teste acima). Chamá-lo direto duas vezes,
    // como só a corrida entre dois gatilhos quase simultâneos faria, mostra
    // por que a proteção de verdade é a constraint
    // `follow_up_executions_one_active_per_conversation` da migration: sem
    // banco real por trás, este banco de mentira aceita as duas.
    db.conversations.set(CONV, makeConversation({ departmentId: FINANCEIRO, status: "waiting_client" }));
    const rule = makeRule("r-financeiro", {}, [FINANCEIRO]);
    addStep("r-financeiro", { order: 1, waitAmount: 2, waitUnit: "hours", action: "send_message", messageContent: "Oi" });
    const deps = buildDeps();
    const conversation = db.conversations.get(CONV)! as any;
    const ruleWithRelations = {
      ...rule,
      departments: [{ ruleId: "r-financeiro", departmentId: FINANCEIRO }],
      steps: db.steps.get("r-financeiro"),
    };
    await startExecution(deps, conversation, ruleWithRelations as any);
    await startExecution(deps, conversation, ruleWithRelations as any);
    expect(db.executions.size).toBe(2);
  });
});

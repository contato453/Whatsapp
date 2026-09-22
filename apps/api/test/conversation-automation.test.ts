import { beforeEach, describe, expect, it } from "vitest";
import type { PrismaClient } from "@azvchat/database";
import type { Server } from "socket.io";
import {
  emitConversationAutomation,
  loadConversationAutomation,
  loadConversationAutomations,
} from "../src/lib/conversation-automation.js";

/**
 * O que estes testes fixam sobre o sinal de atendimento automático:
 *
 * 1. IA ativa e fluxo em andamento saem no MESMO estado, e podem valer ao
 *    mesmo tempo (é o que acontece no bloco "Atendimento por IA" de um
 *    fluxo, que fica esperando a sessão terminar);
 * 2. só conta o que ainda está no controle da conversa — sessão `active` e
 *    execução `running`/`waiting`. Encerrada não acende chip, senão o card
 *    diria "IA" para sempre depois do primeiro atendimento;
 * 3. conversa sem nada automático NÃO entra no mapa — ausência é o "nada
 *    aqui" que a lista e a tela já tratam;
 * 4. a página inteira sai em DUAS consultas, nunca duas por conversa;
 * 5. o evento vai para a `conversationAudience()` de sempre (nunca para a
 *    organização inteira) e carrega o estado inteiro, inclusive o VAZIO —
 *    é assim que o chip apaga sozinho quando a IA encerra.
 */

const CONV_IA = "11111111-1111-4111-8111-111111111111";
const CONV_FLUXO = "22222222-2222-4222-8222-222222222222";
const CONV_LIMPA = "33333333-3333-4333-8333-333333333333";
const INSTANCE_ID = "44444444-4444-4444-8444-444444444444";
const DEPT_ID = "55555555-5555-4555-8555-555555555555";
const USER_ID = "66666666-6666-4666-8666-666666666666";

interface Recorded {
  sessionQueries: Array<Record<string, unknown>>;
  executionQueries: Array<Record<string, unknown>>;
  emits: Array<{ rooms: string[]; event: string; payload: unknown }>;
}

let recorded: Recorded;

beforeEach(() => {
  recorded = { sessionQueries: [], executionQueries: [], emits: [] };
});

interface FakeOptions {
  /** Sessões de IA ATIVAS que o banco devolveria (o `where` já filtra). */
  sessions?: Array<{ id: string; conversationId: string; agentId: string; agent: { name: string } }>;
  executions?: Array<{ id: string; conversationId: string; flowId: string; flow: { name: string } }>;
  /** Conversa que a emissão encontra; `null` = fora da organização. */
  conversation?: { whatsappInstanceId: string; departmentId: string | null; assignedUserId: string | null } | null;
}

function fakePrisma(options: FakeOptions = {}): PrismaClient {
  return {
    aiSession: {
      findMany: async (args: Record<string, unknown>) => {
        recorded.sessionQueries.push(args);
        return options.sessions ?? [];
      },
    },
    automationExecution: {
      findMany: async (args: Record<string, unknown>) => {
        recorded.executionQueries.push(args);
        return options.executions ?? [];
      },
    },
    conversation: {
      findFirst: async () => options.conversation ?? null,
    },
  } as unknown as PrismaClient;
}

const fakeIo = {
  to: (rooms: string[]) => ({
    emit: (event: string, payload: unknown) => {
      recorded.emits.push({ rooms, event, payload });
    },
  }),
} as unknown as Server;

describe("estado de atendimento automático da conversa", () => {
  it("junta IA e fluxo no mesmo estado e ignora quem não tem nada", async () => {
    const prisma = fakePrisma({
      sessions: [
        { id: "sess-1", conversationId: CONV_IA, agentId: "agent-1", agent: { name: "IA Comercial" } },
        { id: "sess-2", conversationId: CONV_FLUXO, agentId: "agent-2", agent: { name: "IA Suporte" } },
      ],
      executions: [
        { id: "exec-1", conversationId: CONV_FLUXO, flowId: "flow-1", flow: { name: "Atendimento Geral" } },
      ],
    });

    const states = await loadConversationAutomations(prisma, [CONV_IA, CONV_FLUXO, CONV_LIMPA]);

    expect(states.get(CONV_IA)).toEqual({
      ai: { sessionId: "sess-1", agentId: "agent-1", agentName: "IA Comercial" },
      flow: null,
    });
    // As duas coisas ao mesmo tempo: o bloco de IA dentro de um fluxo.
    expect(states.get(CONV_FLUXO)).toEqual({
      ai: { sessionId: "sess-2", agentId: "agent-2", agentName: "IA Suporte" },
      flow: { executionId: "exec-1", flowId: "flow-1", flowName: "Atendimento Geral" },
    });
    // Conversa sem nada automático não vira linha: ausência é o estado vazio.
    expect(states.has(CONV_LIMPA)).toBe(false);
  });

  it("consulta só o que ainda está no controle, e uma vez por página", async () => {
    const prisma = fakePrisma();
    await loadConversationAutomations(prisma, [CONV_IA, CONV_FLUXO, CONV_LIMPA]);

    // Duas consultas para três conversas — nunca duas por linha.
    expect(recorded.sessionQueries).toHaveLength(1);
    expect(recorded.executionQueries).toHaveLength(1);

    const sessionWhere = recorded.sessionQueries[0]?.where as Record<string, unknown>;
    expect(sessionWhere.status).toBe("active");
    expect(sessionWhere.conversationId).toEqual({ in: [CONV_IA, CONV_FLUXO, CONV_LIMPA] });

    const executionWhere = recorded.executionQueries[0]?.where as Record<string, unknown>;
    // Encerrada (`completed`, `failed`, `handed_off`) fica de fora: o chip
    // some quando a automação larga a conversa.
    expect(executionWhere.status).toEqual({ in: ["running", "waiting"] });
  });

  it("não consulta nada quando a página está vazia", async () => {
    const prisma = fakePrisma();
    const states = await loadConversationAutomations(prisma, []);
    expect(states.size).toBe(0);
    expect(recorded.sessionQueries).toHaveLength(0);
    expect(recorded.executionQueries).toHaveLength(0);
  });

  it("uma conversa sem nada rodando devolve as duas pontas nulas", async () => {
    const state = await loadConversationAutomation(fakePrisma(), CONV_LIMPA);
    expect(state).toEqual({ ai: null, flow: null });
  });
});

describe("publicação do estado", () => {
  it("vai para a audiência da conversa, e o estado vazio também é publicado", async () => {
    const prisma = fakePrisma({
      conversation: { whatsappInstanceId: INSTANCE_ID, departmentId: DEPT_ID, assignedUserId: USER_ID },
    });

    await emitConversationAutomation({ prisma, io: fakeIo }, "org-1", CONV_IA);

    expect(recorded.emits).toHaveLength(1);
    const [emitted] = recorded.emits;
    expect(emitted?.event).toBe("conversation:automation");
    // A mesma audiência de qualquer evento de conversa: organização,
    // supervisão do número/departamento e a sala de quem é responsável.
    expect(emitted?.rooms).toEqual([
      "org:org-1",
      `sup:${INSTANCE_ID}:${DEPT_ID}`,
      `mine:${INSTANCE_ID}:${DEPT_ID}:${USER_ID}`,
    ]);
    // Estado vazio publicado de propósito: é o evento que APAGA o chip.
    expect(emitted?.payload).toEqual({
      conversationId: CONV_IA,
      automation: { ai: null, flow: null },
    });
  });

  it("conversa de outra organização não publica nada", async () => {
    const prisma = fakePrisma({ conversation: null });
    await emitConversationAutomation({ prisma, io: fakeIo }, "org-2", CONV_IA);
    expect(recorded.emits).toHaveLength(0);
  });
});

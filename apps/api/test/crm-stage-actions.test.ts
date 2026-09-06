import { beforeEach, describe, expect, it } from "vitest";
import type { CrmStageAction, PrismaClient } from "@azvchat/database";
import { RealtimeEvents } from "@azvchat/shared";
import { runStageActions } from "../src/lib/crm-stage-actions.js";
import { cancelCrmFollowUps, handleCrmClientReply } from "../src/lib/crm-follow-up.js";

/**
 * AS AUTOMAÇÕES DE ETAPA E O FOLLOW-UP.
 *
 * O que estes testes trancam:
 *
 * 1. **o follow-up é `ScheduledMessage`** — o CRM não tem agendador próprio.
 *    Dois agendadores discordando sobre o que já saiu é o pior defeito
 *    possível aqui: o cliente recebe a mesma cobrança duas vezes;
 * 2. **o cliente respondendo PARA a régua.** Mandar "ainda tem interesse?"
 *    depois de a pessoa ter respondido é o erro que faz o cliente perder a
 *    confiança no escritório;
 * 3. **agendamento feito por uma PESSOA nunca é cancelado pelo CRM** — o
 *    filtro é sempre `crmOpportunityId`;
 * 4. **automação não derruba a movimentação do card.** Arrastar é o trabalho;
 *    automação é conveniência;
 * 5. **quem recebe atribuição automática precisa enxergar a conversa** — a
 *    mesma régua da transferência manual, senão o card some da tela de todos.
 */

const ORG = "org-1";
const OPORTUNIDADE = "op-1";
const CONVERSA = "conv-1";
const ETIQUETA = "tag-1";

interface Gravado {
  conversationTags: Array<Record<string, unknown>>;
  opportunityTags: Array<Record<string, unknown>>;
  scheduled: Array<Record<string, unknown>>;
  scheduledCanceled: Array<Record<string, unknown>>;
  activities: Array<Record<string, unknown>>;
  notes: Array<Record<string, unknown>>;
  events: Array<Record<string, unknown>>;
  emitidos: Array<{ evento: string; payload: unknown }>;
  logs: Array<Record<string, unknown>>;
  opportunityUpdates: Array<Record<string, unknown>>;
}
let gravado: Gravado;

beforeEach(() => {
  gravado = {
    conversationTags: [],
    opportunityTags: [],
    scheduled: [],
    scheduledCanceled: [],
    activities: [],
    notes: [],
    events: [],
    emitidos: [],
    logs: [],
    opportunityUpdates: [],
  };
});

function acao(overrides: Partial<CrmStageAction>): CrmStageAction {
  return {
    id: "acao-1",
    stageId: "etapa-1",
    trigger: "enter",
    type: "add_tag",
    tagId: null,
    userId: null,
    departmentId: null,
    delayMinutes: 0,
    content: null,
    position: 0,
    createdAt: new Date(),
    ...overrides,
  } as CrmStageAction;
}

/** Prisma de mentira com o mínimo que cada caminho toca. */
function fakePrisma(options: { usuarioAlcanca?: boolean; pendentes?: Array<{ id: string; conversationId: string }> } = {}): PrismaClient {
  const pendentes = options.pendentes ?? [];
  return {
    conversationTag: {
      createMany: async (args: Record<string, unknown>) => {
        gravado.conversationTags.push(args);
        return { count: 1 };
      },
      deleteMany: async (args: Record<string, unknown>) => {
        gravado.conversationTags.push({ delete: args });
        return { count: 1 };
      },
    },
    crmOpportunityTag: {
      createMany: async (args: Record<string, unknown>) => {
        gravado.opportunityTags.push(args);
        return { count: 1 };
      },
      deleteMany: async () => ({ count: 1 }),
    },
    crmOpportunityEvent: {
      create: async (args: { data: Record<string, unknown> }) => {
        gravado.events.push(args.data);
        return args.data;
      },
    },
    crmActivity: {
      create: async (args: { data: Record<string, unknown> }) => {
        gravado.activities.push(args.data);
        return { id: "atividade-1", title: args.data.title };
      },
      updateMany: async () => ({ count: 0 }),
    },
    crmOpportunity: {
      findMany: async () => [{ id: OPORTUNIDADE }],
      updateMany: async (args: Record<string, unknown>) => {
        gravado.opportunityUpdates.push(args);
        return { count: 1 };
      },
      findFirst: async () => null,
    },
    scheduledMessage: {
      create: async (args: { data: Record<string, unknown> }) => {
        gravado.scheduled.push(args.data);
        return args.data;
      },
      findMany: async () => pendentes,
      updateMany: async (args: Record<string, unknown>) => {
        gravado.scheduledCanceled.push(args);
        return { count: pendentes.length };
      },
      count: async () => 0,
    },
    internalNote: {
      create: async (args: { data: Record<string, unknown> }) => {
        gravado.notes.push(args.data);
        return { ...args.data, id: "nota-1", createdAt: new Date(), user: null };
      },
    },
    conversation: {
      findUnique: async () => ({
        id: CONVERSA,
        whatsappInstanceId: "inst-1",
        departmentId: "dep-1",
        assignedUserId: null,
      }),
      findFirst: async () => ({
        id: CONVERSA,
        whatsappInstanceId: "inst-1",
        departmentId: "dep-1",
        assignedUserId: null,
      }),
    },
    user: {
      findFirst: async () =>
        options.usuarioAlcanca === false
          ? null
          : { id: "user-2", name: "Marina", role: "agent", status: "active", avatarUrl: null },
    },
    department: {
      findFirst: async () => ({ id: "dep-2", name: "Comercial" }),
    },
  } as unknown as PrismaClient;
}

function fakeDeps(prisma: PrismaClient) {
  return {
    prisma,
    io: {
      to: () => ({
        emit: (evento: string, payload: unknown) => {
          gravado.emitidos.push({ evento, payload });
        },
      }),
    },
    logger: {
      warn: (dados: Record<string, unknown>) => gravado.logs.push(dados),
      info: (dados: Record<string, unknown>) => gravado.logs.push(dados),
    },
  } as unknown as Parameters<typeof runStageActions>[0];
}

const contexto = {
  organizationId: ORG,
  opportunityId: OPORTUNIDADE,
  conversationId: CONVERSA,
  performedByUserId: "user-1",
};

describe("automações de entrada na etapa", () => {
  it("etiqueta da automação é a MESMA `Tag` da conversa — não existe lista paralela", () => {
    // Se o CRM tivesse etiqueta própria, o escritório manteria duas listas com
    // os mesmos nomes e elas divergiriam na primeira semana.
    return runStageActions(
      fakeDeps(fakePrisma()),
      [acao({ type: "add_tag", tagId: ETIQUETA })],
      contexto,
      "enter",
    ).then(() => {
      expect(gravado.conversationTags[0]).toMatchObject({
        data: [{ conversationId: CONVERSA, tagId: ETIQUETA }],
        skipDuplicates: true,
      });
      expect(gravado.opportunityTags[0]).toMatchObject({
        data: [{ opportunityId: OPORTUNIDADE, tagId: ETIQUETA }],
      });
      expect(gravado.events.map((evento) => evento.type)).toContain("tag_added");
    });
  });

  it("follow-up cria uma ScheduledMessage de verdade, amarrada à oportunidade", async () => {
    await runStageActions(
      fakeDeps(fakePrisma()),
      [acao({ type: "schedule_message", delayMinutes: 2880, content: "Conseguiu ver a proposta?" })],
      contexto,
      "enter",
    );
    const agendada = gravado.scheduled[0];
    expect(agendada).toMatchObject({
      organizationId: ORG,
      conversationId: CONVERSA,
      content: "Conseguiu ver a proposta?",
      // A amarração é o que permite cancelar só o que o CRM criou.
      crmOpportunityId: OPORTUNIDADE,
    });
    // Sem autor: não foi uma pessoa que marcou.
    expect(agendada?.createdById).toBeUndefined();
    expect(gravado.events.map((evento) => evento.type)).toContain("follow_up_scheduled");
  });

  it("nota interna da automação sai sem autor e avisa a conversa em tempo real", async () => {
    await runStageActions(
      fakeDeps(fakePrisma()),
      [acao({ type: "internal_note", content: "Proposta enviada pelo funil" })],
      contexto,
      "enter",
    );
    expect(gravado.notes[0]).toMatchObject({ conversationId: CONVERSA, userId: null });
    expect(gravado.emitidos.map((item) => item.evento)).toContain(RealtimeEvents.InternalNote);
  });

  it("atribuição automática só vale para quem ENXERGA a conversa", async () => {
    const deps = fakeDeps(fakePrisma({ usuarioAlcanca: false }));
    const resultado = await runStageActions(
      deps,
      [acao({ type: "assign_user", userId: "user-2" })],
      contexto,
      "enter",
    );
    // A automação não pode fazer em silêncio o que a rota de atribuição
    // recusa: mandar o atendimento para quem nunca vai abri-lo.
    expect(resultado.assignedUserId).toBeUndefined();
    expect(gravado.logs.some((log) => log.event === "crm_stage_action_failed")).toBe(true);
  });

  it("atribuição de quem enxerga a conversa é aplicada e registrada", async () => {
    const resultado = await runStageActions(
      fakeDeps(fakePrisma()),
      [acao({ type: "assign_user", userId: "user-2" })],
      contexto,
      "enter",
    );
    expect(resultado.assignedUserId).toBe("user-2");
    expect(gravado.events.map((evento) => evento.type)).toContain("assignee_changed");
  });

  it("ação que precisa de conversa é PULADA na oportunidade avulsa, sem erro", async () => {
    await runStageActions(
      fakeDeps(fakePrisma()),
      [
        acao({ type: "schedule_message", content: "Oi" }),
        acao({ id: "acao-2", type: "create_activity", content: "Ligar" }),
      ],
      { ...contexto, conversationId: null },
      "enter",
    );
    // Lead que ainda não escreveu não tem onde receber mensagem; a atividade,
    // que é interna, continua valendo.
    expect(gravado.scheduled).toHaveLength(0);
    expect(gravado.activities).toHaveLength(1);
    expect(gravado.logs.some((log) => log.event === "crm_stage_action_failed")).toBe(false);
  });

  it("ação com gatilho de SAÍDA não roda na entrada", async () => {
    await runStageActions(
      fakeDeps(fakePrisma()),
      [acao({ type: "add_tag", tagId: ETIQUETA, trigger: "leave" })],
      contexto,
      "enter",
    );
    expect(gravado.conversationTags).toHaveLength(0);
  });

  it("automação que falha NÃO derruba a movimentação — vira log e a fila segue", async () => {
    const prisma = fakePrisma();
    // A primeira ação estoura; a segunda precisa acontecer mesmo assim.
    (prisma as unknown as { conversationTag: { createMany: () => Promise<never> } }).conversationTag.createMany =
      async () => {
        throw new Error("etiqueta sumiu no meio do caminho");
      };
    await runStageActions(
      fakeDeps(prisma),
      [
        acao({ type: "add_tag", tagId: ETIQUETA }),
        acao({ id: "acao-2", type: "create_activity", content: "Ligar para o cliente" }),
      ],
      contexto,
      "enter",
    );
    expect(gravado.activities).toHaveLength(1);
    expect(gravado.logs.some((log) => log.event === "crm_stage_action_failed")).toBe(true);
  });
});

describe("cliente respondeu: a régua para", () => {
  it("cancela os follow-ups pendentes DESTA oportunidade e registra o motivo", async () => {
    const prisma = fakePrisma({
      pendentes: [
        { id: "sched-1", conversationId: CONVERSA },
        { id: "sched-2", conversationId: CONVERSA },
      ],
    });
    const cancelados = await cancelCrmFollowUps(
      fakeDeps(prisma) as never,
      ORG,
      OPORTUNIDADE,
      "cliente respondeu",
    );
    expect(cancelados).toBe(2);
    expect(gravado.scheduledCanceled[0]).toMatchObject({
      where: { id: { in: ["sched-1", "sched-2"] }, status: "pending" },
      data: { status: "canceled" },
    });
    expect(gravado.events.map((evento) => evento.type)).toContain("follow_up_canceled");
  });

  it("a mensagem recebida marca a última interação e interrompe o follow-up", async () => {
    const prisma = fakePrisma({ pendentes: [{ id: "sched-1", conversationId: CONVERSA }] });
    const quando = new Date("2026-09-06T12:00:00Z");
    await handleCrmClientReply(fakeDeps(prisma) as never, ORG, CONVERSA, quando);

    expect(gravado.opportunityUpdates[0]).toMatchObject({
      data: { lastInteractionAt: quando },
    });
    expect(gravado.scheduledCanceled).toHaveLength(1);
    expect(gravado.events.map((evento) => evento.type)).toContain("client_replied");
  });

  it("NUNCA lança: falha no CRM não pode transformar mensagem recebida em mensagem perdida", async () => {
    const prisma = fakePrisma();
    (prisma as unknown as { crmOpportunity: { findMany: () => Promise<never> } }).crmOpportunity.findMany =
      async () => {
        throw new Error("banco fora do ar");
      };
    await expect(
      handleCrmClientReply(fakeDeps(prisma) as never, ORG, CONVERSA, new Date()),
    ).resolves.toBeUndefined();
    expect(gravado.logs.some((log) => log.event === "crm_client_reply_failed")).toBe(true);
  });

  it("conversa sem oportunidade aberta não cancela nada", async () => {
    const prisma = fakePrisma();
    (prisma as unknown as { crmOpportunity: { findMany: () => Promise<unknown[]> } }).crmOpportunity.findMany =
      async () => [];
    await handleCrmClientReply(fakeDeps(prisma) as never, ORG, CONVERSA, new Date());
    expect(gravado.scheduledCanceled).toHaveLength(0);
    expect(gravado.opportunityUpdates).toHaveLength(0);
  });

  it("o cancelamento SÓ alcança o que o CRM agendou — nunca o compromisso de uma pessoa", async () => {
    // O filtro de leitura é `crmOpportunityId`; agendamento manual tem essa
    // coluna nula e por isso nunca entra na lista.
    const consultas: Array<Record<string, unknown>> = [];
    const prisma = fakePrisma({ pendentes: [{ id: "sched-1", conversationId: CONVERSA }] });
    (prisma as unknown as {
      scheduledMessage: { findMany: (args: Record<string, unknown>) => Promise<unknown[]> };
    }).scheduledMessage.findMany = async (args) => {
      consultas.push(args.where as Record<string, unknown>);
      return [{ id: "sched-1", conversationId: CONVERSA }];
    };
    await cancelCrmFollowUps(fakeDeps(prisma) as never, ORG, OPORTUNIDADE, "teste");
    expect(consultas[0]).toEqual({ crmOpportunityId: OPORTUNIDADE, status: "pending" });
  });
});

/**
 * A ORDEM DAS OPERAÇÕES AO MOVER O CARD.
 *
 * Este caso existe porque o defeito ACONTECEU: na primeira verificação de
 * ponta a ponta, o follow-up agendado pela etapa de destino era cancelado no
 * mesmo instante pelo cancelamento da própria movimentação, que rodava depois
 * das ações de entrada. Nada estourava — a mensagem simplesmente nunca saía
 * para o cliente, que é a pior forma de falha que este módulo pode ter.
 */
describe("mover o card: cancelar o follow-up ANTES de agendar o novo", () => {
  it("o cancelamento da etapa anterior não pode apagar o follow-up da etapa nova", async () => {
    const { moveCrmOpportunity } = await import("../src/lib/crm-move.js");
    const ordem: string[] = [];

    const etapaDestino = {
      id: "etapa-2",
      organizationId: ORG,
      pipelineId: "funil-1",
      name: "Proposta Enviada",
      position: 2000,
      color: "#64748b",
      probability: 60,
      type: "in_progress",
      slaDays: null,
      actions: [
        acao({
          id: "acao-followup",
          stageId: "etapa-2",
          type: "schedule_message",
          delayMinutes: 2880,
          content: "Conseguiu ver a proposta?",
        }),
      ],
    };

    const prisma = {
      crmOpportunity: {
        findFirst: async () => ({
          id: OPORTUNIDADE,
          organizationId: ORG,
          pipelineId: "funil-1",
          stageId: "etapa-1",
          status: "open",
          conversationId: CONVERSA,
          stage: { id: "etapa-1", name: "Novo Lead", type: "open", actions: [] },
          value: 0,
          discount: null,
          probability: null,
          stageEnteredAt: new Date(),
          createdAt: new Date(),
          updatedAt: new Date(),
          tags: [],
          activities: [],
          conversation: null,
          assignedUser: null,
          department: null,
          product: null,
          lossReason: null,
          createdBy: null,
          pipeline: {},
        }),
        update: async () => ({}),
      },
      crmStage: { findFirst: async () => etapaDestino },
      crmOpportunityEvent: { create: async () => ({}) },
      crmActivity: { updateMany: async () => ({ count: 0 }) },
      conversation: { findUnique: async () => null, findFirst: async () => null },
      scheduledMessage: {
        findMany: async () => {
          ordem.push("procura-pendentes");
          return [];
        },
        updateMany: async () => {
          ordem.push("cancela");
          return { count: 0 };
        },
        create: async () => {
          ordem.push("agenda-novo");
          return {};
        },
        count: async () => 0,
      },
    } as unknown as PrismaClient;

    await moveCrmOpportunity(fakeDeps(prisma) as never, {
      organizationId: ORG,
      opportunityId: OPORTUNIDADE,
      toStageId: "etapa-2",
      fromStageId: "etapa-1",
      performedByUserId: "user-1",
    });

    // O que importa: o "agenda-novo" vem DEPOIS da varredura de cancelamento.
    // Invertido, o follow-up da coluna nova nasceria e morreria na mesma
    // movimentação, sem erro nenhum na tela.
    expect(ordem).toContain("agenda-novo");
    expect(ordem.indexOf("procura-pendentes")).toBeLessThan(ordem.indexOf("agenda-novo"));
  });
});

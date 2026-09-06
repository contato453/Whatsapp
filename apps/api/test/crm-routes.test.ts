import { beforeEach, describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import jwt from "@fastify/jwt";
import type { PrismaClient } from "@azvchat/database";
import { RealtimeEvents } from "@azvchat/shared";
import type { AuthTokenPayload } from "../src/lib/auth.js";
import { registerErrorHandler } from "../src/lib/errors.js";
import { clearPermissionCache } from "../src/lib/permissions.js";
import { crmRoutes } from "../src/modules/crm/routes.js";
import type { AppDeps } from "../src/types.js";

/**
 * AS ROTAS DO CRM, pelo caminho de verdade (Fastify + Zod + permissões).
 *
 * O que estes testes trancam, e por quê:
 *
 * 1. **a oportunidade nasce da CONVERSA, sem cadastro novo** — contato,
 *    departamento e responsável são herdados. Um cadastro de cliente aqui
 *    seria uma segunda base divergindo da primeira no dia seguinte;
 * 2. **duplicidade não vira erro na cara de quem clicou duas vezes** — o
 *    banco recusa (índice parcial) e a rota devolve a que já existe;
 * 3. **dois usuários movendo o mesmo card**: quem chega com a etapa errada é
 *    recusado com 409 em vez de gravar por cima do trabalho do colega;
 * 4. **perda exige motivo**, senão o relatório de motivos nasce furado;
 * 5. **reabrir tem chave própria**: mexe em número já contado no mês;
 * 6. **o recorte de acesso entra POR CIMA dos filtros**, nunca no lugar —
 *    filtro nenhum vira porta de saída do controle de acesso.
 */

const ORG = "org-1";
const CONVERSA = "11111111-1111-4111-8111-111111111111";
const FUNIL = "22222222-2222-4222-8222-222222222222";
const ETAPA_1 = "33333333-3333-4333-8333-333333333333";
const ETAPA_2 = "44444444-4444-4444-8444-444444444444";
const ETAPA_GANHO = "55555555-5555-4555-8555-555555555555";
const ETAPA_PERDA = "66666666-6666-4666-8666-666666666666";
const OPORTUNIDADE = "77777777-7777-4777-8777-777777777777";
const MOTIVO = "88888888-8888-4888-8888-888888888888";
const INSTANCIA = "99999999-9999-4999-8999-999999999999";
const DEPTO = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

interface Gravado {
  criadas: Array<Record<string, unknown>>;
  atualizacoes: Array<Record<string, unknown>>;
  eventos: Array<Record<string, unknown>>;
  emitidos: Array<{ evento: string; payload: unknown }>;
  buscas: Array<Record<string, unknown>>;
  auditoria: string[];
  agendamentosCancelados: Array<Record<string, unknown>>;
  atividadesCanceladas: Array<Record<string, unknown>>;
}
let gravado: Gravado;
/** Estado mutável da "tabela" de oportunidades entre chamadas de um caso. */
let estado: { stageId: string; status: "open" | "won" | "lost"; falharCreate: boolean };

beforeEach(() => {
  gravado = {
    criadas: [],
    atualizacoes: [],
    eventos: [],
    emitidos: [],
    buscas: [],
    auditoria: [],
    agendamentosCancelados: [],
    atividadesCanceladas: [],
  };
  estado = { stageId: ETAPA_1, status: "open", falharCreate: false };
  clearPermissionCache();
});

function etapa(id: string, nome: string, tipo: string, posicao: number, probabilidade: number) {
  return {
    id,
    organizationId: ORG,
    pipelineId: FUNIL,
    name: nome,
    position: posicao,
    color: "#64748b",
    probability: probabilidade,
    type: tipo,
    slaDays: null,
    actions: [],
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

const ETAPAS = [
  etapa(ETAPA_1, "Novo Lead", "open", 1000, 10),
  etapa(ETAPA_2, "Negociação", "in_progress", 2000, 80),
  etapa(ETAPA_GANHO, "Fechado", "won", 3000, 100),
  etapa(ETAPA_PERDA, "Perdido", "lost", 4000, 0),
];

const FUNIL_COMPLETO = {
  id: FUNIL,
  organizationId: ORG,
  name: "Comercial",
  description: null,
  color: "#102a4c",
  isActive: true,
  isGeneral: true,
  position: 0,
  isDefault: true,
  autoCreateTagId: null,
  createdById: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  departments: [],
  stages: ETAPAS,
};

function oportunidade(overrides: Record<string, unknown> = {}) {
  const stage = ETAPAS.find((item) => item.id === estado.stageId) ?? ETAPAS[0];
  return {
    id: OPORTUNIDADE,
    organizationId: ORG,
    pipelineId: FUNIL,
    stageId: estado.stageId,
    title: "Abertura de empresa",
    conversationId: CONVERSA,
    contactName: null,
    contactPhone: "5521999999999",
    assignedUserId: null,
    departmentId: DEPTO,
    productId: null,
    value: 10_000,
    discount: null,
    probability: null,
    expectedCloseDate: null,
    origin: "whatsapp",
    status: estado.status,
    lossReasonId: null,
    lossNote: null,
    closedValue: null,
    closedAt: null,
    notes: null,
    position: 1000,
    stageEnteredAt: new Date("2026-09-01T12:00:00Z"),
    lastInteractionAt: null,
    createdById: "user-1",
    createdAt: new Date("2026-09-01T12:00:00Z"),
    updatedAt: new Date("2026-09-01T12:00:00Z"),
    pipeline: FUNIL_COMPLETO,
    stage,
    assignedUser: null,
    department: { id: DEPTO, name: "Comercial", color: null, isInternal: false },
    product: null,
    lossReason: null,
    createdBy: null,
    tags: [],
    conversation: {
      id: CONVERSA,
      title: "Cliente X",
      customTitle: null,
      profilePicture: null,
      whatsappInstanceId: INSTANCIA,
      externalChatId: "5521999999999@s.whatsapp.net",
      departmentId: DEPTO,
      assignedUserId: "user-atendente",
      externalReference: null,
      externalSource: null,
      lastMessageAt: new Date("2026-09-05T12:00:00Z"),
      instance: { id: INSTANCIA, name: "Comercial", status: "connected" },
    },
    activities: [],
    ...overrides,
  };
}

function fakePrisma(): PrismaClient {
  return {
    // Acesso: supervisor com UM número e UM departamento.
    userWhatsAppInstance: { findMany: async () => [{ whatsappInstanceId: INSTANCIA }] },
    userDepartment: { findMany: async () => [{ departmentId: DEPTO }] },
    rolePermission: { findMany: async () => [] },

    crmPipeline: {
      count: async () => 1,
      findMany: async () => [FUNIL_COMPLETO],
      findFirst: async () => FUNIL_COMPLETO,
    },
    crmLossReason: {
      count: async () => 5,
      findMany: async () => [{ id: MOTIVO, name: "Preço", active: true, position: 0 }],
      findFirst: async () => ({ id: MOTIVO, name: "Preço" }),
    },
    crmStage: {
      findFirst: async (args: { where?: Record<string, unknown> }) => {
        const where = args.where ?? {};
        if (typeof where.id === "string") {
          return ETAPAS.find((item) => item.id === where.id) ?? null;
        }
        const tipo = where.type as string | { in?: string[] } | undefined;
        if (typeof tipo === "string") {
          return ETAPAS.find((item) => item.type === tipo) ?? null;
        }
        if (tipo?.in) return ETAPAS.find((item) => tipo.in?.includes(item.type)) ?? null;
        return ETAPAS[0];
      },
      findMany: async () => ETAPAS,
    },
    crmOpportunity: {
      findFirst: async (args: { where?: Record<string, unknown> }) => {
        gravado.buscas.push(args.where ?? {});
        return oportunidade();
      },
      findMany: async (args: { where?: Record<string, unknown> }) => {
        gravado.buscas.push(args.where ?? {});
        return [oportunidade()];
      },
      count: async () => 1,
      create: async (args: { data: Record<string, unknown> }) => {
        if (estado.falharCreate) {
          // É a violação do índice parcial que impede duas oportunidades
          // ABERTAS da mesma conversa no mesmo funil.
          throw Object.assign(new Error("unique"), { code: "P2002" });
        }
        gravado.criadas.push(args.data);
        return { id: OPORTUNIDADE };
      },
      update: async (args: { data: Record<string, unknown> }) => {
        gravado.atualizacoes.push(args.data);
        if (typeof args.data.stageId === "string") estado.stageId = args.data.stageId;
        if (typeof args.data.status === "string") {
          estado.status = args.data.status as "open" | "won" | "lost";
        }
        return oportunidade();
      },
      updateMany: async () => ({ count: 1 }),
    },
    crmOpportunityEvent: {
      create: async (args: { data: Record<string, unknown> }) => {
        gravado.eventos.push(args.data);
        return args.data;
      },
      findMany: async () => [],
    },
    crmOpportunityTag: { createMany: async () => ({ count: 1 }), deleteMany: async () => ({ count: 1 }) },
    crmActivity: {
      findMany: async () => [],
      create: async (args: { data: Record<string, unknown> }) => ({
        ...args.data,
        id: "atividade-1",
        createdAt: new Date(),
      }),
      updateMany: async (args: Record<string, unknown>) => {
        gravado.atividadesCanceladas.push(args);
        return { count: 1 };
      },
      findFirst: async () => null,
    },
    crmProduct: { findMany: async () => [] },
    scheduledMessage: {
      findMany: async () => [],
      updateMany: async (args: Record<string, unknown>) => {
        gravado.agendamentosCancelados.push(args);
        return { count: 0 };
      },
      count: async () => 0,
      create: async () => ({}),
    },
    conversation: {
      findFirst: async (args: { where?: Record<string, unknown> }) => {
        gravado.buscas.push(args.where ?? {});
        return oportunidade().conversation;
      },
      findUnique: async () => oportunidade().conversation,
    },
    user: {
      findFirst: async () => ({ id: "user-2", name: "Marina", status: "active" }),
      findMany: async () => [],
    },
    tag: { findFirst: async () => ({ id: "tag-1", name: "Urgente" }) },
    department: { findMany: async () => [{ id: DEPTO }] },
    $transaction: async (arg: unknown) => {
      if (typeof arg === "function") {
        return (arg as (tx: unknown) => Promise<unknown>)(fakePrisma());
      }
      return arg;
    },
  } as unknown as PrismaClient;
}

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify();
  await app.register(jwt, { secret: "segredo-de-teste" });
  app.decorate("verifySession", async (payload: AuthTokenPayload) => payload);
  registerErrorHandler(app);
  const deps = {
    prisma: fakePrisma(),
    logger: { warn: () => undefined, info: () => undefined, error: () => undefined },
    io: {
      to: () => ({
        emit: (evento: string, payload: unknown) => gravado.emitidos.push({ evento, payload }),
      }),
    },
    audit: {
      record: (entrada: { action: string }) => gravado.auditoria.push(entrada.action),
    },
  } as unknown as AppDeps;
  await crmRoutes(app, deps);
  await app.ready();
  return app;
}

function token(app: FastifyInstance, role: AuthTokenPayload["role"] = "supervisor"): string {
  return app.jwt.sign({
    sub: "user-1",
    organizationId: ORG,
    role,
    name: "Supervisora",
    email: "sup@example.com",
  });
}

function chamar(
  app: FastifyInstance,
  method: "GET" | "POST" | "PATCH",
  url: string,
  payload?: Record<string, unknown>,
  role: AuthTokenPayload["role"] = "supervisor",
) {
  return app.inject({
    method,
    url,
    headers: { authorization: `Bearer ${token(app, role)}` },
    payload,
  });
}

describe("criar oportunidade a partir da conversa", () => {
  it("herda contato, telefone, departamento e responsável — sem cadastro novo", async () => {
    const app = await buildApp();
    const resposta = await chamar(app, "POST", "/crm/opportunities", {
      pipelineId: FUNIL,
      conversationId: CONVERSA,
      value: 5000,
    });

    expect(resposta.statusCode).toBe(201);
    const criada = gravado.criadas[0];
    expect(criada).toMatchObject({
      conversationId: CONVERSA,
      // Título e telefone saem da conversa; ninguém digita de novo.
      title: "Cliente X",
      contactPhone: "5521999999999",
      departmentId: DEPTO,
      assignedUserId: "user-atendente",
      origin: "whatsapp",
    });
    expect(gravado.eventos.map((evento) => evento.type)).toContain("created");
    expect(gravado.emitidos.map((item) => item.evento)).toContain(RealtimeEvents.CrmOpportunity);
    expect(gravado.auditoria).toContain("crm.opportunity_created");
  });

  it("card novo vai para o TOPO da coluna — quem criou precisa vê-lo sem rolar", async () => {
    const app = await buildApp();
    await chamar(app, "POST", "/crm/opportunities", { pipelineId: FUNIL, conversationId: CONVERSA });
    // O primeiro da coluna está em 1000; o novo entra antes dele.
    expect(Number(gravado.criadas[0]?.position)).toBeLessThan(1000);
  });

  it("clique duplo devolve a oportunidade que JÁ existe, com 200 e aviso", async () => {
    const app = await buildApp();
    estado.falharCreate = true;
    const resposta = await chamar(app, "POST", "/crm/opportunities", {
      pipelineId: FUNIL,
      conversationId: CONVERSA,
    });
    // 409 faria a tela mostrar erro numa situação em que está tudo certo: o
    // card existe. A pessoa tentaria de novo e criaria a terceira.
    expect(resposta.statusCode).toBe(200);
    const corpo = resposta.json() as { duplicated: boolean; opportunity: { id: string } };
    expect(corpo.duplicated).toBe(true);
    expect(corpo.opportunity.id).toBe(OPORTUNIDADE);
  });

  it("conversa fora do alcance responde 404 antes de criar qualquer coisa", async () => {
    const app = await buildApp();
    const deps = (app as unknown as { prisma?: PrismaClient }).prisma;
    void deps;
    // A rota chama `findAccessibleConversation`, que aplica o escopo de
    // `access.ts`. Aqui simulamos a conversa fora do recorte.
    const prisma = fakePrisma();
    (prisma as unknown as { conversation: { findFirst: () => Promise<null> } }).conversation.findFirst =
      async () => null;
    const outroApp = Fastify();
    await outroApp.register(jwt, { secret: "segredo-de-teste" });
    outroApp.decorate("verifySession", async (payload: AuthTokenPayload) => payload);
    registerErrorHandler(outroApp);
    await crmRoutes(outroApp, {
      prisma,
      logger: { warn: () => undefined, info: () => undefined, error: () => undefined },
      io: { to: () => ({ emit: () => undefined }) },
      audit: { record: () => undefined },
    } as unknown as AppDeps);
    await outroApp.ready();

    const resposta = await chamar(outroApp, "POST", "/crm/opportunities", {
      pipelineId: FUNIL,
      conversationId: CONVERSA,
    });
    expect(resposta.statusCode).toBe(404);
    expect(gravado.criadas).toHaveLength(0);
  });
});

describe("mover o card", () => {
  it("grava a etapa nova, marca a entrada e registra o movimento", async () => {
    const app = await buildApp();
    const resposta = await chamar(app, "POST", `/crm/opportunities/${OPORTUNIDADE}/move`, {
      stageId: ETAPA_2,
      fromStageId: ETAPA_1,
    });
    expect(resposta.statusCode).toBe(200);
    expect(gravado.atualizacoes[0]).toMatchObject({ stageId: ETAPA_2 });
    expect(gravado.atualizacoes[0]?.stageEnteredAt).toBeInstanceOf(Date);
    expect(gravado.eventos.map((evento) => evento.type)).toContain("stage_changed");
    expect(gravado.emitidos.map((item) => item.evento)).toContain(RealtimeEvents.CrmOpportunity);
  });

  it("DOIS USUÁRIOS MOVENDO O MESMO CARD: o segundo é recusado com 409", async () => {
    const app = await buildApp();
    // A tela acredita que o card está em ETAPA_2, mas o banco diz ETAPA_1 —
    // é o colega que moveu primeiro. Sem esta recusa, o último arrasto vence
    // sempre e o primeiro some sem ninguém ver.
    const resposta = await chamar(app, "POST", `/crm/opportunities/${OPORTUNIDADE}/move`, {
      stageId: ETAPA_GANHO,
      fromStageId: ETAPA_2,
    });
    expect(resposta.statusCode).toBe(409);
    expect(resposta.json()).toMatchObject({ error: "crm_stage_conflict" });
    expect(gravado.atualizacoes).toHaveLength(0);
  });

  it("oportunidade encerrada não se move: precisa ser reaberta antes", async () => {
    const app = await buildApp();
    estado.status = "won";
    const resposta = await chamar(app, "POST", `/crm/opportunities/${OPORTUNIDADE}/move`, {
      stageId: ETAPA_2,
    });
    expect(resposta.statusCode).toBe(409);
    expect(resposta.json()).toMatchObject({ error: "crm_opportunity_closed" });
  });

  it("mover para a etapa de PERDA sem motivo é recusado", async () => {
    const app = await buildApp();
    const resposta = await chamar(app, "POST", `/crm/opportunities/${OPORTUNIDADE}/move`, {
      stageId: ETAPA_PERDA,
      fromStageId: ETAPA_1,
    });
    // Sem motivo, o relatório de motivos nasce com um buraco que ninguém
    // preenche depois.
    expect(resposta.statusCode).toBe(400);
    expect(resposta.json()).toMatchObject({ error: "crm_loss_reason_required" });
  });
});

describe("ganho e perda", () => {
  it("ganhar fecha a oportunidade, guarda o valor fechado e limpa a agenda", async () => {
    const app = await buildApp();
    const resposta = await chamar(app, "POST", `/crm/opportunities/${OPORTUNIDADE}/win`, {
      closedValue: 9500,
    });
    expect(resposta.statusCode).toBe(200);
    expect(gravado.atualizacoes[0]).toMatchObject({
      status: "won",
      stageId: ETAPA_GANHO,
      closedValue: 9500,
    });
    expect(gravado.eventos.map((evento) => evento.type)).toContain("won");
    // Atividade pendente vira ruído na agenda depois do fechamento.
    expect(gravado.atividadesCanceladas[0]).toMatchObject({
      where: { opportunityId: OPORTUNIDADE, status: "pending" },
      data: { status: "canceled" },
    });
    expect(gravado.auditoria).toContain("crm.opportunity_won");
  });

  it("perder exige motivo e grava o que foi informado", async () => {
    const app = await buildApp();
    const semMotivo = await chamar(app, "POST", `/crm/opportunities/${OPORTUNIDADE}/lose`, {});
    expect(semMotivo.statusCode).toBe(400);

    const comMotivo = await chamar(app, "POST", `/crm/opportunities/${OPORTUNIDADE}/lose`, {
      lossReasonId: MOTIVO,
      lossNote: "Fechou com o contador do primo",
    });
    expect(comMotivo.statusCode).toBe(200);
    expect(gravado.atualizacoes[0]).toMatchObject({
      status: "lost",
      lossReasonId: MOTIVO,
      lossNote: "Fechou com o contador do primo",
    });
    expect(gravado.eventos.map((evento) => evento.type)).toContain("lost");
  });
});

describe("reabrir", () => {
  it("o atendente é recusado pela chave própria", async () => {
    const app = await buildApp();
    estado.status = "lost";
    const resposta = await chamar(
      app,
      "POST",
      `/crm/opportunities/${OPORTUNIDADE}/reopen`,
      {},
      "agent",
    );
    // Reabrir mexe em conversão e receita já contadas no mês — por isso é
    // chave separada de mover card (padrão: só supervisor).
    expect(resposta.statusCode).toBe(403);
    expect(resposta.json()).toMatchObject({ error: "permission_denied" });
  });

  it("supervisor reabre, limpa o motivo da perda e registra no histórico", async () => {
    const app = await buildApp();
    estado.status = "lost";
    const resposta = await chamar(app, "POST", `/crm/opportunities/${OPORTUNIDADE}/reopen`, {});
    expect(resposta.statusCode).toBe(200);
    expect(gravado.atualizacoes[0]).toMatchObject({
      status: "open",
      // Manter o motivo faria o card reaberto continuar aparecendo como
      // perdido no relatório de motivos.
      lossReasonId: null,
      lossNote: null,
    });
    expect(gravado.eventos.map((evento) => evento.type)).toContain("reopened");
  });

  it("reabrir o que já está aberto é recusado, sem mexer em nada", async () => {
    const app = await buildApp();
    const resposta = await chamar(app, "POST", `/crm/opportunities/${OPORTUNIDADE}/reopen`, {});
    expect(resposta.statusCode).toBe(400);
    expect(gravado.atualizacoes).toHaveLength(0);
  });
});

describe("filtros e recorte", () => {
  function fragmentos(where: Record<string, unknown> | undefined): Array<Record<string, unknown>> {
    const and = where?.AND;
    return Array.isArray(and) ? (and as Array<Record<string, unknown>>) : [];
  }

  it("O ESCOPO DE ACESSO ENTRA POR CIMA DO FILTRO, nunca no lugar dele", async () => {
    const app = await buildApp();
    await chamar(
      app,
      "GET",
      `/crm/board?pipelineId=${FUNIL}&assignedUserId=none&tagId=aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa`,
    );
    const consulta = gravado.buscas.find((where) => fragmentos(where).length > 0);
    const partes = fragmentos(consulta);
    const texto = JSON.stringify(partes);
    // O recorte de acesso continua presente junto dos filtros — é ele que
    // impede o filtro de virar porta de saída do controle de acesso.
    expect(texto).toContain("departmentId");
    expect(texto).toContain("conversation");
    expect(texto).toContain("assignedUserId");
  });

  it("valores do MESMO filtro somam (OU), filtros diferentes cruzam (E)", async () => {
    const app = await buildApp();
    await chamar(
      app,
      "GET",
      `/crm/board?pipelineId=${FUNIL}&assignedUserId=user-a&assignedUserId=none&origin=whatsapp`,
    );
    const consulta = gravado.buscas.find((where) => fragmentos(where).length > 0);
    const partes = fragmentos(consulta);

    // Dentro do filtro de responsável: um OR com os dois valores marcados.
    const porResponsavel = partes.find((parte) => {
      const or = (parte as { OR?: Array<Record<string, unknown>> }).OR;
      return or?.some((item) => "assignedUserId" in item);
    });
    expect(JSON.stringify(porResponsavel)).toContain("user-a");
    expect(JSON.stringify(porResponsavel)).toContain("null");

    // Entre filtros: origem é OUTRO item do AND, não um ramo do mesmo OR.
    const porOrigem = partes.find((parte) => "origin" in parte);
    expect(porOrigem).toEqual({ origin: { in: ["whatsapp"] } });
  });

  it("a busca cobre título, contato, telefone e o nome da conversa", async () => {
    const app = await buildApp();
    await chamar(app, "GET", `/crm/board?pipelineId=${FUNIL}&search=silva`);
    const consulta = gravado.buscas.find((where) => fragmentos(where).length > 0);
    const texto = JSON.stringify(fragmentos(consulta));
    expect(texto).toContain("contactPhone");
    expect(texto).toContain("customTitle");
  });

  it("o quadro devolve totais da coluna INTEIRA junto dos cards", async () => {
    const app = await buildApp();
    const resposta = await chamar(app, "GET", `/crm/board?pipelineId=${FUNIL}`);
    expect(resposta.statusCode).toBe(200);
    const corpo = resposta.json() as {
      columns: Array<{ stage: { id: string }; totals: { count: number; value: number } }>;
      totals: { count: number; value: number; weightedValue: number };
    };
    expect(corpo.columns).toHaveLength(4);
    // Uma oportunidade de R$ 10.000 na primeira etapa (10% de chance).
    const primeira = corpo.columns.find((coluna) => coluna.stage.id === ETAPA_1);
    expect(primeira?.totals).toEqual({ count: 1, value: 10_000, weightedValue: 1000 });
    expect(corpo.totals.count).toBe(1);
  });
});

describe("a conversa e o CRM", () => {
  it("o painel do chat lista as oportunidades da conversa, dentro do recorte", async () => {
    const app = await buildApp();
    const resposta = await chamar(app, "GET", `/conversations/${CONVERSA}/crm`);
    expect(resposta.statusCode).toBe(200);
    const corpo = resposta.json() as { opportunities: Array<{ id: string; conversationId: string }> };
    expect(corpo.opportunities[0]?.conversationId).toBe(CONVERSA);
    const consulta = gravado.buscas.find((where) =>
      JSON.stringify(where).includes(`"conversationId":"${CONVERSA}"`),
    );
    expect(JSON.stringify(consulta)).toContain("departmentId");
  });
});

describe("permissões das telas de configuração", () => {
  it("atendente não cria funil", async () => {
    const app = await buildApp();
    const resposta = await chamar(
      app,
      "POST",
      "/crm/pipelines",
      { name: "Cobrança", isGeneral: true, departmentIds: [] },
      "agent",
    );
    expect(resposta.statusCode).toBe(403);
  });

  it("atendente enxerga o quadro (crm.view é liberada por padrão)", async () => {
    const app = await buildApp();
    const resposta = await chamar(app, "GET", `/crm/board?pipelineId=${FUNIL}`, undefined, "agent");
    expect(resposta.statusCode).toBe(200);
  });
});

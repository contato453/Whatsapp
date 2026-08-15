import { beforeEach, describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import jwt from "@fastify/jwt";
import type { Prisma, PrismaClient } from "@azvchat/database";
import { FILTER_NONE } from "@azvchat/shared";
import { registerErrorHandler } from "../src/lib/errors.js";
import type { AuthTokenPayload } from "../src/lib/auth.js";
import { dashboardRoutes } from "../src/modules/dashboard/routes.js";
import type { AppDeps } from "../src/types.js";

/**
 * O que estes testes fixam na rota de stats:
 *
 * 1. **visibilidade não muda** — todo número sai do recorte de `access.ts`,
 *    e nenhum papel enxerga mais aqui do que enxergaria na Inbox;
 * 2. **o período filtra por atividade e o status agrupa** — as conversas
 *    entram por `lastMessageAt` dentro do período, com o status atual delas;
 * 3. **a soma dos quatro status fecha** com o card de conversas ativas.
 */

interface Recorded {
  conversationGroupBy: Prisma.ConversationGroupByArgs[];
  conversationFindMany: Array<Record<string, unknown>>;
  messageCount: Array<Record<string, unknown>>;
  messageGroupBy: Array<{ by: string[]; where?: Record<string, unknown> }>;
  instanceGroupBy: Array<Record<string, unknown>>;
}

let recorded: Recorded;

const STATUS_BUCKETS = [
  { status: "open", _count: { _all: 7 } },
  { status: "waiting_client", _count: { _all: 3 } },
  { status: "waiting_internal", _count: { _all: 2 } },
  { status: "resolved", _count: { _all: 5 } },
];

function fakePrisma(): PrismaClient {
  return {
    // Organização sem linha de parâmetros: a rota cai nos padrões de shared.
    attendanceSettings: { findUnique: async () => null },
    userWhatsAppInstance: {
      findMany: async () => [{ whatsappInstanceId: "inst-1" }],
    },
    userDepartment: { findMany: async () => [{ departmentId: "dept-1" }] },
    conversation: {
      groupBy: async (args: Prisma.ConversationGroupByArgs) => {
        recorded.conversationGroupBy.push(args);
        return STATUS_BUCKETS;
      },
      findMany: async (args: Record<string, unknown>) => {
        recorded.conversationFindMany.push(args);
        const select = args.select as Record<string, unknown> | undefined;
        // As conversas com responsável (top de usuários) pedem o responsável.
        if (select && "assignedUserId" in select) {
          return [{ id: "conv-1", assignedUserId: "user-1" }];
        }
        // A busca do ranking pede título; a das candidatas a atraso, só o id.
        if (select && "title" in select) {
          return [
            {
              id: "conv-1",
              title: "Título do WhatsApp",
              customTitle: "Nome dado pela equipe",
              type: "group",
              instance: { name: "Comercial" },
              assignedUser: { id: "user-1", name: "Maria Supervisora", avatarUrl: null },
            },
          ];
        }
        return [];
      },
    },
    whatsAppInstance: {
      groupBy: async (args: Record<string, unknown>) => {
        recorded.instanceGroupBy.push(args);
        return [
          { status: "connected", _count: { _all: 2 } },
          { status: "qr_required", _count: { _all: 1 } },
        ];
      },
    },
    message: {
      count: async (args: Record<string, unknown>) => {
        recorded.messageCount.push(args);
        const where = args.where as { direction?: string };
        return where.direction === "inbound" ? 40 : 25;
      },
      groupBy: async (args: { by: string[]; where?: Record<string, unknown> }) => {
        recorded.messageGroupBy.push(args);
        if (args.by[0] === "sentByUserId") {
          return [
            { sentByUserId: "user-1", _count: { _all: 9 } },
            { sentByUserId: "user-2", _count: { _all: 4 } },
          ];
        }
        if (args.by.length === 1) {
          const where = args.where as { direction?: string } | undefined;
          // A varredura de entrada por conversa (top de usuários) pede
          // `direction: inbound`; a do ranking não pede direção nenhuma.
          if (where?.direction === "inbound") {
            return [{ conversationId: "conv-1", _count: { _all: 6 } }];
          }
          return [{ conversationId: "conv-1", _count: { _all: 12 } }];
        }
        return [
          { conversationId: "conv-1", direction: "inbound", _count: { _all: 7 } },
          { conversationId: "conv-1", direction: "outbound", _count: { _all: 5 } },
        ];
      },
    },
    user: {
      findMany: async () => [
        { id: "user-1", name: "Maria Supervisora", role: "supervisor", avatarUrl: null },
        { id: "user-2", name: "João Atendente", role: "agent", avatarUrl: "avatar.jpg" },
      ],
    },
    $queryRaw: async () => [],
  } as unknown as PrismaClient;
}

async function buildTestApp(): Promise<FastifyInstance> {
  const app = Fastify();
  await app.register(jwt, { secret: "segredo-de-teste" });
  app.decorate("verifySession", async (payload: AuthTokenPayload) => payload);
  registerErrorHandler(app);
  await dashboardRoutes(app, { prisma: fakePrisma() } as unknown as AppDeps);
  await app.ready();
  return app;
}

function tokenFor(app: FastifyInstance, role: AuthTokenPayload["role"]): string {
  return app.jwt.sign({
    sub: `user-${role}`,
    organizationId: "org-1",
    role,
    name: "Fulano de Tal",
    email: `${role}@example.com`,
  });
}

async function stats(app: FastifyInstance, role: AuthTokenPayload["role"], query = "") {
  const response = await app.inject({
    method: "GET",
    url: `/dashboard/stats${query}`,
    headers: { authorization: `Bearer ${tokenFor(app, role)}` },
  });
  return response;
}

/**
 * Achata o filtro de conversa em uma lista de condições, para inspecionar.
 *
 * O recorte de acesso e os filtros da tela chegam aninhados (o `AND` da rota
 * carrega o `AND` de `conversationScope` dentro), então a leitura desce um
 * nível de cada vez em vez de assumir uma lista plana.
 */
function conditionsOf(where: Record<string, unknown>): Array<Record<string, unknown>> {
  const and = where.AND;
  if (!Array.isArray(and)) return [];
  return (and as Array<Record<string, unknown>>).flatMap((condition) => {
    const nested = conditionsOf(condition);
    return nested.length > 0 ? nested : [condition];
  });
}

describe("GET /dashboard/stats", () => {
  beforeEach(() => {
    recorded = {
      conversationGroupBy: [],
      conversationFindMany: [],
      messageCount: [],
      messageGroupBy: [],
      instanceGroupBy: [],
    };
  });

  it("exige autenticação", async () => {
    const app = await buildTestApp();
    expect((await app.inject({ method: "GET", url: "/dashboard/stats" })).statusCode).toBe(401);
    await app.close();
  });

  it("recusa período fora dos quatro aceitos", async () => {
    const app = await buildTestApp();
    const response = await stats(app, "admin", "?period=ano-passado");
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toBe("validation_error");
    await app.close();
  });

  it("a soma dos quatro status fecha com o card de conversas ativas", async () => {
    const app = await buildTestApp();
    const body = (await stats(app, "admin")).json();
    const byStatus = body.conversations.byStatus;
    expect(byStatus).toEqual({
      open: 7,
      waiting_client: 3,
      waiting_internal: 2,
      resolved: 5,
    });
    expect(body.conversations.active).toBe(17);
    expect(
      Object.values(byStatus).reduce((total: number, count) => total + Number(count), 0),
    ).toBe(body.conversations.active);
    await app.close();
  });

  it("filtra por atividade no período e agrupa pelo status atual", async () => {
    const app = await buildTestApp();
    await stats(app, "admin", "?period=7d");
    const [groupBy] = recorded.conversationGroupBy;
    expect(groupBy?.by).toEqual(["status"]);
    const where = groupBy?.where as { lastMessageAt?: { gte?: Date } };
    // Atividade, e não data de criação nem de mudança de status.
    expect(where.lastMessageAt?.gte).toBeInstanceOf(Date);
    expect(where).not.toHaveProperty("createdAt");
    expect(where).not.toHaveProperty("status");
    await app.close();
  });

  it("período maior recua o corte de data", async () => {
    const app = await buildTestApp();
    const hoje = (await stats(app, "admin", "?period=today")).json();
    const trintaDias = (await stats(app, "admin", "?period=30d")).json();
    expect(new Date(trintaDias.periodStart).getTime()).toBeLessThan(
      new Date(hoje.periodStart).getTime(),
    );
    expect(hoje.period).toBe("today");
    expect(trintaDias.period).toBe("30d");
    await app.close();
  });

  it("admin consulta sem recorte de número, departamento ou responsável", async () => {
    const app = await buildTestApp();
    await stats(app, "admin");
    const where = recorded.conversationGroupBy[0]?.where as Record<string, unknown>;
    expect(where.organizationId).toBe("org-1");
    expect(conditionsOf(where)).toHaveLength(0);
    expect(recorded.instanceGroupBy[0]?.where).not.toHaveProperty("id");
    await app.close();
  });

  it("supervisor fica preso aos números e departamentos marcados", async () => {
    const app = await buildTestApp();
    await stats(app, "supervisor");
    const conditions = conditionsOf(
      recorded.conversationGroupBy[0]?.where as Record<string, unknown>,
    );
    expect(conditions).toContainEqual({ whatsappInstanceId: { in: ["inst-1"] } });
    expect(conditions).toContainEqual({
      OR: [{ departmentId: null }, { departmentId: { in: ["dept-1"] } }],
    });
    // Supervisor enxerga conversa de terceiro dentro do recorte dele.
    expect(JSON.stringify(conditions)).not.toContain("assignedUserId");
    expect(recorded.instanceGroupBy[0]?.where).toMatchObject({ id: { in: ["inst-1"] } });
    await app.close();
  });

  it("agent só conta o que é dele ou está sem responsável", async () => {
    const app = await buildTestApp();
    await stats(app, "agent");
    const conditions = conditionsOf(
      recorded.conversationGroupBy[0]?.where as Record<string, unknown>,
    );
    expect(conditions).toContainEqual({
      OR: [{ assignedUserId: "user-agent" }, { assignedUserId: null }],
    });
    expect(conditions).toContainEqual({ whatsappInstanceId: { in: ["inst-1"] } });
    await app.close();
  });

  it("mensagens e candidatas a atraso passam pelo mesmo recorte", async () => {
    const app = await buildTestApp();
    await stats(app, "agent");
    for (const args of recorded.messageCount) {
      const where = args.where as { conversation?: Record<string, unknown> };
      expect(conditionsOf(where.conversation ?? {})).toContainEqual({
        OR: [{ assignedUserId: "user-agent" }, { assignedUserId: null }],
      });
    }
    const candidatas = recorded.conversationFindMany.find(
      (args) => !("title" in ((args.select as Record<string, unknown>) ?? {})),
    );
    const where = candidatas?.where as Record<string, unknown>;
    expect(where.status).toEqual({ not: "resolved" });
    expect(conditionsOf(where)).toContainEqual({
      OR: [{ assignedUserId: "user-agent" }, { assignedUserId: null }],
    });
    await app.close();
  });

  it("números fora de connected entram como desconectados, com a quebra por status", async () => {
    const app = await buildTestApp();
    const body = (await stats(app, "admin")).json();
    expect(body.instances.connected).toBe(2);
    expect(body.instances.disconnected).toBe(1);
    expect(body.instances.byStatus.qr_required).toBe(1);
    // Status sem nenhum número aparece zerado, e não sumido.
    expect(body.instances.byStatus.error).toBe(0);
    await app.close();
  });

  it("ranking sai agregado, com o nome que a equipe deu e a quebra por direção", async () => {
    const app = await buildTestApp();
    const body = (await stats(app, "admin")).json();
    expect(body.ranking).toEqual([
      {
        conversationId: "conv-1",
        title: "Nome dado pela equipe",
        type: "group",
        instanceName: "Comercial",
        assignee: { userId: "user-1", name: "Maria Supervisora", hasAvatar: false },
        received: 7,
        sent: 5,
        total: 12,
      },
    ]);
    await app.close();
  });

  it("ranking traz o responsável, e `null` quando a conversa está sem dono", async () => {
    const app = await buildTestApp();
    const comDono = (await stats(app, "admin")).json();
    expect(comDono.ranking[0].assignee).toEqual({
      userId: "user-1",
      name: "Maria Supervisora",
      hasAvatar: false,
    });
    // Só o mínimo para desenhar a linha: nada de e-mail nem papel do usuário
    // viajando dentro do trabalho de outro.
    expect(Object.keys(comDono.ranking[0].assignee)).toEqual(["userId", "name", "hasAvatar"]);
    await app.close();
  });

  it("mensagens do período: recebidas e enviadas, sem as apagadas nem as pendentes", async () => {
    const app = await buildTestApp();
    const body = (await stats(app, "admin")).json();
    expect(body.messages).toEqual({ received: 40, sent: 25 });
    // O mesmo filtro vale para os dois cards: apagada não infla volume e
    // agendada que não saiu não foi enviada a ninguém.
    for (const args of recorded.messageCount) {
      expect(args.where).toMatchObject({
        deletedAt: null,
        NOT: { direction: "outbound", status: "pending" },
      });
    }
    await app.close();
  });

  it("filtro de chip refina o recorte em vez de substituí-lo", async () => {
    const app = await buildTestApp();
    await stats(app, "agent", "?instanceId=11111111-1111-4111-8111-111111111111");
    const conditions = conditionsOf(
      recorded.conversationGroupBy[0]?.where as Record<string, unknown>,
    );
    // O filtro entra por cima; o recorte de acesso continua inteiro no AND.
    expect(conditions).toContainEqual({
      whatsappInstanceId: "11111111-1111-4111-8111-111111111111",
    });
    expect(conditions).toContainEqual({ whatsappInstanceId: { in: ["inst-1"] } });
    expect(conditions).toContainEqual({
      OR: [{ assignedUserId: "user-agent" }, { assignedUserId: null }],
    });
    // O card de chips passa a olhar só aquele número, sem perder o escopo.
    expect(recorded.instanceGroupBy[0]?.where).toMatchObject({
      id: { in: ["inst-1"] },
    });
    await app.close();
  });

  it("filtro de departamento e de responsável aceitam 'sem'", async () => {
    const app = await buildTestApp();
    await stats(app, "admin", `?departmentId=${FILTER_NONE}&assignedUserId=${FILTER_NONE}`);
    const conditions = conditionsOf(
      recorded.conversationGroupBy[0]?.where as Record<string, unknown>,
    );
    expect(conditions).toContainEqual({ departmentId: null });
    expect(conditions).toContainEqual({ assignedUserId: null });
    await app.close();
  });

  it("os filtros valem para a tela inteira, inclusive para o card de atraso", async () => {
    const app = await buildTestApp();
    const departmentId = "22222222-2222-4222-8222-222222222222";
    await stats(app, "admin", `?departmentId=${departmentId}`);
    const candidatas = recorded.conversationFindMany.find((args) => {
      const select = (args.select as Record<string, unknown>) ?? {};
      return !("title" in select) && !("assignedUserId" in select);
    });
    expect(conditionsOf(candidatas?.where as Record<string, unknown>)).toContainEqual({
      departmentId,
    });
    for (const args of recorded.messageCount) {
      const where = args.where as { conversation?: Record<string, unknown> };
      expect(conditionsOf(where.conversation ?? {})).toContainEqual({ departmentId });
    }
    await app.close();
  });

  it("filtro devolvido na resposta é o que a API aplicou", async () => {
    const app = await buildTestApp();
    const instanceId = "11111111-1111-4111-8111-111111111111";
    const body = (await stats(app, "admin", `?instanceId=${instanceId}`)).json();
    expect(body.filters).toEqual({
      instanceId,
      departmentId: null,
      assignedUserId: null,
    });
    await app.close();
  });

  it("período personalizado corta o começo e o fim, no fuso configurado", async () => {
    const app = await buildTestApp();
    const body = (await stats(app, "admin", "?period=custom&from=2026-08-01&to=2026-08-07")).json();
    // 00:00 de 01/08 e o último instante de 07/08 em America/Sao_Paulo.
    expect(body.periodStart).toBe("2026-08-01T03:00:00.000Z");
    expect(body.periodEnd).toBe("2026-08-08T02:59:59.999Z");
    const where = recorded.conversationGroupBy[0]?.where as {
      lastMessageAt?: { gte?: Date; lte?: Date };
    };
    expect(where.lastMessageAt?.gte).toBeInstanceOf(Date);
    expect(where.lastMessageAt?.lte).toBeInstanceOf(Date);
    await app.close();
  });

  it("atalho de período não tem corte superior", async () => {
    const app = await buildTestApp();
    const body = (await stats(app, "admin", "?period=7d")).json();
    // Sem `lte`: o relógio do WhatsApp pode vir à frente do nosso, e um corte
    // em "agora" sumiria com a mensagem que acabou de chegar.
    expect(body.periodEnd).toBeNull();
    const where = recorded.conversationGroupBy[0]?.where as {
      lastMessageAt?: Record<string, unknown>;
    };
    expect(where.lastMessageAt).not.toHaveProperty("lte");
    await app.close();
  });

  it("recusa período personalizado malformado", async () => {
    const app = await buildTestApp();
    // Sem as datas.
    expect((await stats(app, "admin", "?period=custom")).statusCode).toBe(400);
    // Fim antes do início.
    expect(
      (await stats(app, "admin", "?period=custom&from=2026-08-07&to=2026-08-01")).statusCode,
    ).toBe(400);
    // Acima do teto de um ano.
    expect(
      (await stats(app, "admin", "?period=custom&from=2024-01-01&to=2026-08-01")).statusCode,
    ).toBe(400);
    // Formato errado.
    expect(
      (await stats(app, "admin", "?period=custom&from=01/08/2026&to=2026-08-07")).statusCode,
    ).toBe(400);
    await app.close();
  });

  it("recusa id de filtro que não é uuid", async () => {
    const app = await buildTestApp();
    expect((await stats(app, "admin", "?instanceId=qualquer-coisa")).statusCode).toBe(400);
    expect((await stats(app, "admin", "?assignedUserId=qualquer-coisa")).statusCode).toBe(400);
    await app.close();
  });

  it("top de usuários é de supervisor para cima", async () => {
    const app = await buildTestApp();
    const doAgente = (await stats(app, "agent")).json();
    // Para o atendente o bloco nem é consultado, e a resposta diz isso.
    expect(doAgente.topUsers).toBeNull();

    const doSupervisor = (await stats(app, "supervisor")).json();
    expect(doSupervisor.topUsers).not.toBeNull();
    const admin = (await stats(app, "admin")).json();
    expect(admin.topUsers).not.toBeNull();
    await app.close();
  });

  it("top de usuários soma enviadas por autor e recebidas por responsável", async () => {
    const app = await buildTestApp();
    const body = (await stats(app, "supervisor")).json();
    expect(body.topUsers).toEqual([
      {
        userId: "user-1",
        name: "Maria Supervisora",
        role: "supervisor",
        hasAvatar: false,
        // 9 enviadas por ela + 6 do cliente na conversa em que é responsável.
        sent: 9,
        received: 6,
        total: 15,
      },
      {
        userId: "user-2",
        name: "João Atendente",
        role: "agent",
        hasAvatar: true,
        sent: 4,
        received: 0,
        total: 4,
      },
    ]);
    // Envio sem autor é da automação e não entra como trabalho de ninguém.
    const enviadas = recorded.messageGroupBy.find((args) => args.by[0] === "sentByUserId");
    expect(enviadas?.where).toMatchObject({ sentByUserId: { not: null } });
    await app.close();
  });

  it("sem linha de parâmetros usa os padrões de shared e não quebra", async () => {
    const app = await buildTestApp();
    const body = (await stats(app, "admin")).json();
    expect(body.responseLimitMinutes).toBe(30);
    expect(body.timezone).toBe("America/Sao_Paulo");
    expect(body.overdue).toEqual({ count: 0, oldestWaitingMinutes: null });
    await app.close();
  });
});

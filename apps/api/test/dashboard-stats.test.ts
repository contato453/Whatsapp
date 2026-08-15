import { beforeEach, describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import jwt from "@fastify/jwt";
import type { Prisma, PrismaClient } from "@azvchat/database";
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
        // A busca do ranking pede título; a das candidatas a atraso, só o id.
        if (select && "title" in select) {
          return [
            {
              id: "conv-1",
              title: "Título do WhatsApp",
              customTitle: "Nome dado pela equipe",
              type: "group",
              instance: { name: "Comercial" },
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
      groupBy: async (args: { by: string[] }) => {
        if (args.by.length === 1) {
          return [{ conversationId: "conv-1", _count: { _all: 12 } }];
        }
        return [
          { conversationId: "conv-1", direction: "inbound", _count: { _all: 7 } },
          { conversationId: "conv-1", direction: "outbound", _count: { _all: 5 } },
        ];
      },
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

/** Achata o filtro de conversa em uma lista de condições, para inspecionar. */
function conditionsOf(where: Record<string, unknown>): Array<Record<string, unknown>> {
  const and = where.AND;
  return Array.isArray(and) ? (and as Array<Record<string, unknown>>) : [];
}

describe("GET /dashboard/stats", () => {
  beforeEach(() => {
    recorded = {
      conversationGroupBy: [],
      conversationFindMany: [],
      messageCount: [],
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
        received: 7,
        sent: 5,
        total: 12,
      },
    ]);
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

  it("sem linha de parâmetros usa os padrões de shared e não quebra", async () => {
    const app = await buildTestApp();
    const body = (await stats(app, "admin")).json();
    expect(body.responseLimitMinutes).toBe(30);
    expect(body.timezone).toBe("America/Sao_Paulo");
    expect(body.overdue).toEqual({ count: 0, oldestWaitingMinutes: null });
    await app.close();
  });
});

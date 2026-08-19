import { beforeEach, describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import jwt from "@fastify/jwt";
import type { Prisma, PrismaClient } from "@azvchat/database";
import { FILTER_ALL_USERS, FILTER_NONE } from "@azvchat/shared";
import { registerErrorHandler } from "../src/lib/errors.js";
import type { AuthTokenPayload } from "../src/lib/auth.js";
import { dashboardRoutes } from "../src/modules/dashboard/routes.js";
import type { AppDeps } from "../src/types.js";
import { rolePermissionStub } from "./helpers/permissions.js";

/**
 * O que estes testes fixam na rota de stats:
 *
 * 1. **visibilidade não muda** — todo número sai do recorte de `access.ts`,
 *    e nenhum papel enxerga mais aqui do que enxergaria na Inbox;
 * 2. **o período filtra por atividade e o status agrupa** — as conversas
 *    entram por `lastMessageAt` dentro do período, com o status atual delas;
 * 3. **a soma dos quatro status fecha** com o card de conversas ativas.
 */

/** Dia de hoje no fuso padrão, para a série bater com o período "today". */
const TODAY = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/Sao_Paulo",
}).format(new Date());

interface Recorded {
  rawQueries: string[];
  conversationGroupBy: Prisma.ConversationGroupByArgs[];
  conversationFindMany: Array<Record<string, unknown>>;
  conversationCount: Array<Record<string, unknown>>;
  messageCount: Array<Record<string, unknown>>;
  messageGroupBy: Array<{ by: string[]; where?: Record<string, unknown> }>;
  instanceGroupBy: Array<Record<string, unknown>>;
}

let recorded: Recorded;

/**
 * Ids que "existem" na organização de teste. A rota confere cada id marcado
 * antes de consultar, então o falso Prisma precisa saber quais são — e o que
 * não estiver aqui é justamente o id desconhecido que deve levar 400.
 */
const INSTANCE_A = "11111111-1111-4111-8111-111111111111";
const INSTANCE_B = "1111aaaa-1111-4111-8111-111111111111";
const DEPARTMENT_A = "22222222-2222-4222-8222-222222222222";
const DEPARTMENT_B = "2222bbbb-2222-4222-8222-222222222222";
const USER_A = "33333333-3333-4333-8333-333333333333";
const USER_B = "3333cccc-3333-4333-8333-333333333333";
const DESCONHECIDO = "99999999-9999-4999-8999-999999999999";

/** Devolve só os ids pedidos que existem — é o que a conferência compara. */
function existentes(conhecidos: string[], args: Record<string, unknown>): Array<{ id: string }> {
  const where = (args.where ?? {}) as { id?: { in?: string[] } };
  const pedidos = where.id?.in ?? [];
  return pedidos.filter((id) => conhecidos.includes(id)).map((id) => ({ id }));
}

const STATUS_BUCKETS = [
  { status: "open", _count: { _all: 7 } },
  { status: "waiting_client", _count: { _all: 3 } },
  { status: "waiting_internal", _count: { _all: 2 } },
  { status: "resolved", _count: { _all: 5 } },
];

function fakePrisma(): PrismaClient {
  return {
    rolePermission: rolePermissionStub,
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
      // O card de conversas arquivadas é a única contagem direta da rota.
      count: async (args: Record<string, unknown>) => {
        recorded.conversationCount.push(args);
        return 4;
      },
      findMany: async (args: Record<string, unknown>) => {
        recorded.conversationFindMany.push(args);
        const select = args.select as Record<string, unknown> | undefined;
        // As conversas com responsável (top de usuários) pedem o responsável.
        if (select && "assignedUserId" in select) {
          return [{ id: "conv-1", assignedUserId: "user-1" }];
        }
        // Só o id, sem `status` no filtro: é a janela fixa do mapa de calor.
        // A das candidatas a atraso pede o mesmo id, mas filtra por status.
        const where = (args.where ?? {}) as { status?: unknown };
        if (select && "id" in select && !("title" in select) && where.status === undefined) {
          return [{ id: "conv-1" }];
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
    department: {
      findMany: async (args: Record<string, unknown>) =>
        existentes([DEPARTMENT_A, DEPARTMENT_B], args),
    },
    tag: { findMany: async () => [] },
    whatsAppInstance: {
      findMany: async (args: Record<string, unknown>) =>
        existentes([INSTANCE_A, INSTANCE_B], args),
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
      findMany: async (args: Record<string, unknown>) => {
        // Duas consultas diferentes caem aqui: a conferência dos ids do filtro
        // (que pede só `id`) e a busca de nomes do top de usuários.
        const select = (args.select ?? {}) as Record<string, unknown>;
        if (!("name" in select)) return existentes([USER_A, USER_B], args);
        return [
          { id: "user-1", name: "Maria Supervisora", role: "supervisor", avatarUrl: null },
          { id: "user-2", name: "João Atendente", role: "agent", avatarUrl: "avatar.jpg" },
        ];
      },
    },
    $queryRaw: async (query: { text?: string; sql?: string }) => {
      // Duas consultas cruas na rota: a da última mensagem (atraso) e a da
      // agregação por dia/hora. O texto distingue sem precisar de ordem.
      const text = String(query.sql ?? query.text ?? "");
      recorded.rawQueries.push(text);
      if (text.includes("EXTRACT")) {
        return [
          { day: TODAY, weekday: 5, hour: 9, direction: "inbound", total: 7 },
          { day: TODAY, weekday: 5, hour: 9, direction: "outbound", total: 3 },
          { day: TODAY, weekday: 5, hour: 15, direction: "inbound", total: 2 },
        ];
      }
      return [];
    },
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
      rawQueries: [],
      conversationGroupBy: [],
      conversationFindMany: [],
      conversationCount: [],
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
    // Única condição para o admin: excluir arquivadas — não é recorte de
    // acesso, é a regra da tela inteira.
    expect(conditionsOf(where)).toEqual([{ archivedAt: null }]);
    expect(recorded.instanceGroupBy[0]?.where).not.toHaveProperty("id");
    await app.close();
  });

  it("arquivada não conta em bloco nenhum: todo filtro de conversa a exclui", async () => {
    const app = await buildTestApp();
    await stats(app, "supervisor");
    // O groupBy dos cards de status, as buscas por atividade (série, mapa,
    // atraso) e as contagens de mensagem carregam todos o mesmo recorte.
    expect(conditionsOf(recorded.conversationGroupBy[0]?.where as Record<string, unknown>))
      .toContainEqual({ archivedAt: null });
    // A busca do ranking por ids fica de fora: os ids já saíram de uma
    // consulta escopada, e ali não há filtro para inspecionar.
    const scopedSearches = recorded.conversationFindMany.filter(
      (args) => !("id" in ((args.where ?? {}) as Record<string, unknown>)),
    );
    expect(scopedSearches.length).toBeGreaterThan(0);
    for (const args of scopedSearches) {
      expect(conditionsOf(args.where as Record<string, unknown>)).toContainEqual({
        archivedAt: null,
      });
    }
    for (const args of recorded.messageCount) {
      const where = args.where as { conversation?: Record<string, unknown> };
      expect(conditionsOf(where.conversation ?? {})).toContainEqual({ archivedAt: null });
    }
    await app.close();
  });

  it("o card de arquivadas conta só arquivadas e ignora o período", async () => {
    const app = await buildTestApp();
    const body = (await stats(app, "admin", "?period=7d")).json();
    expect(body.conversations.archived).toBe(4);
    // Fora da soma de ativas: arquivada não é atendimento.
    expect(body.conversations.active).toBe(17);
    const where = recorded.conversationCount[0]?.where as Record<string, unknown>;
    expect(conditionsOf(where)).toContainEqual({ archivedAt: { not: null } });
    // Estado de agora: nada de lastMessageAt no filtro do card.
    expect(JSON.stringify(where)).not.toContain("lastMessageAt");
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
    await stats(app, "agent", `?instanceId=${INSTANCE_A}`);
    const conditions = conditionsOf(
      recorded.conversationGroupBy[0]?.where as Record<string, unknown>,
    );
    // O filtro entra por cima; o recorte de acesso continua inteiro no AND.
    expect(conditions).toContainEqual({ whatsappInstanceId: { in: [INSTANCE_A] } });
    expect(conditions).toContainEqual({ whatsappInstanceId: { in: ["inst-1"] } });
    expect(conditions).toContainEqual({
      OR: [{ assignedUserId: "user-agent" }, { assignedUserId: null }],
    });
    /**
     * O card de infraestrutura passa a respeitar o número escolhido — e sem
     * perder o escopo. Antes o escopo era espalhado por cima do filtro, os
     * dois escreviam em `id`, e o card ignorava a escolha de todo mundo que
     * não é admin: filtrar por um chip e continuar vendo todos os números
     * fora do ar é número que não fecha com o resto da tela.
     */
    expect(recorded.instanceGroupBy[0]?.where).toMatchObject({
      AND: [{ id: { in: ["inst-1"] } }, { id: { in: [INSTANCE_A] } }],
    });
    await app.close();
  });

  it("cada filtro aceita LISTA, e os valores marcados dentro dele somam", async () => {
    const app = await buildTestApp();
    await stats(
      app,
      "admin",
      `?instanceId=${INSTANCE_A}&instanceId=${INSTANCE_B}` +
        `&status=open&status=waiting_client` +
        `&departmentId=${DEPARTMENT_A}&departmentId=${DEPARTMENT_B}` +
        `&assignedUserId=${USER_A}&assignedUserId=${USER_B}`,
    );
    const conditions = conditionsOf(
      recorded.conversationGroupBy[0]?.where as Record<string, unknown>,
    );
    // OU DENTRO do filtro: um `in` por filtro, e não um item por valor.
    expect(conditions).toContainEqual({ whatsappInstanceId: { in: [INSTANCE_A, INSTANCE_B] } });
    expect(conditions).toContainEqual({ status: { in: ["open", "waiting_client"] } });
    expect(conditions).toContainEqual({ departmentId: { in: [DEPARTMENT_A, DEPARTMENT_B] } });
    expect(conditions).toContainEqual({ assignedUserId: { in: [USER_A, USER_B] } });
    await app.close();
  });

  it("aceita a lista separada por vírgula, como um link colado à mão", async () => {
    const app = await buildTestApp();
    await stats(app, "admin", `?status=open,resolved`);
    expect(
      conditionsOf(recorded.conversationGroupBy[0]?.where as Record<string, unknown>),
    ).toContainEqual({ status: { in: ["open", "resolved"] } });
    await app.close();
  });

  it("E ENTRE filtros: departamento e responsável cruzam, e não somam", async () => {
    const app = await buildTestApp();
    await stats(app, "admin", `?departmentId=${DEPARTMENT_A}&assignedUserId=${USER_A}`);
    const conditions = conditionsOf(
      recorded.conversationGroupBy[0]?.where as Record<string, unknown>,
    );
    /**
     * DOIS itens do mesmo `AND`, e não um `OR` juntando os dois: aqui a
     * pergunta é "os números DELA dentro do CS". É a divergência proposital
     * em relação à Inbox, onde os dois viraram um filtro só que soma —
     * somar recortes diferentes num total produz número sem significado.
     * Trocar isto por um `OR` deixa este teste vermelho.
     */
    expect(conditions).toContainEqual({ departmentId: { in: [DEPARTMENT_A] } });
    expect(conditions).toContainEqual({ assignedUserId: { in: [USER_A] } });
    const juntos = JSON.stringify(conditions);
    expect(juntos).not.toContain('"OR":[{"departmentId"');
    await app.close();
  });

  it("dentro de um filtro, id e sentinela somam num OU só", async () => {
    const app = await buildTestApp();
    await stats(
      app,
      "admin",
      `?departmentId=${FILTER_NONE}&departmentId=${DEPARTMENT_A}` +
        `&assignedUserId=${FILTER_NONE}&assignedUserId=${FILTER_ALL_USERS}&assignedUserId=${USER_A}`,
    );
    const conditions = conditionsOf(
      recorded.conversationGroupBy[0]?.where as Record<string, unknown>,
    );
    expect(conditions).toContainEqual({
      OR: [{ departmentId: null }, { departmentId: { in: [DEPARTMENT_A] } }],
    });
    expect(conditions).toContainEqual({
      OR: [
        { assignedUserId: null, assignedToAll: false },
        { assignedToAll: true },
        { assignedUserId: { in: [USER_A] } },
      ],
    });
    await app.close();
  });

  it("recusa id que não existe na organização, em vez de ignorar em silêncio", async () => {
    const app = await buildTestApp();
    for (const query of [
      `?departmentId=${DESCONHECIDO}`,
      `?assignedUserId=${DESCONHECIDO}`,
      `?instanceId=${DESCONHECIDO}`,
      // Um id bom e um ruim: a lista inteira é recusada, senão a tela
      // mostraria um recorte diferente do que a pessoa marcou.
      `?departmentId=${DEPARTMENT_A}&departmentId=${DESCONHECIDO}`,
    ]) {
      const response = await stats(app, "admin", query);
      expect(response.statusCode).toBe(400);
      expect(response.json().error).toBe("validation_error");
      // A mensagem diz qual filtro, e nunca o id.
      expect(response.json().message).not.toContain(DESCONHECIDO);
    }
    await app.close();
  });

  it("recusa lista absurdamente longa em vez de estourar no driver", async () => {
    const app = await buildTestApp();
    // Link forjado: milhares de valores viram `IN (...)` e passam do limite de
    // parâmetros do Postgres. 400 diz o que aconteceu; erro de driver, não.
    const query = Array.from({ length: 300 }, () => `status=open`).join("&");
    expect((await stats(app, "admin", `?${query}`)).statusCode).toBe(400);
    await app.close();
  });

  it("recusa item fora do enum no meio de uma lista válida", async () => {
    const app = await buildTestApp();
    const response = await stats(app, "admin", "?status=open&status=arquivado");
    expect(response.statusCode).toBe(400);
    await app.close();
  });

  it("o filtro é aplicado DEPOIS do escopo de acesso, nunca no lugar dele", async () => {
    const app = await buildTestApp();
    // O atendente pede um número e uma pessoa: o recorte dele continua
    // inteiro no AND, e o filtro só pode tirar conversa da conta.
    await stats(app, "agent", `?instanceId=${INSTANCE_A}&assignedUserId=${USER_A}`);
    for (const where of [
      recorded.conversationGroupBy[0]?.where as Record<string, unknown>,
      ...recorded.conversationFindMany.map((args) => args.where as Record<string, unknown>),
      ...recorded.conversationCount.map((args) => args.where as Record<string, unknown>),
    ]) {
      const conditions = conditionsOf(where ?? {});
      if (conditions.length === 0) continue;
      expect(conditions).toContainEqual({
        OR: [{ assignedUserId: "user-agent" }, { assignedUserId: null }],
      });
      expect(conditions).toContainEqual({ whatsappInstanceId: { in: ["inst-1"] } });
    }
    await app.close();
  });

  it("filtro de departamento e de responsável aceitam 'sem'", async () => {
    const app = await buildTestApp();
    await stats(app, "admin", `?departmentId=${FILTER_NONE}&assignedUserId=${FILTER_NONE}`);
    // Sozinhos, os sentinelas entram como condição direta: um ramo só não
    // precisa virar `OR`.
    const conditions = conditionsOf(
      recorded.conversationGroupBy[0]?.where as Record<string, unknown>,
    );
    expect(conditions).toContainEqual({ departmentId: null });
    // "Sem responsável" conta só as verdadeiramente órfãs: a conversa marcada
    // como @todos também tem `assignedUserId` nulo, mas já tem destino.
    expect(conditions).toContainEqual({ assignedUserId: null, assignedToAll: false });
    await app.close();
  });

  it("o atendimento coletivo tem filtro próprio, separado de 'sem responsável'", async () => {
    const app = await buildTestApp();
    await stats(app, "admin", `?assignedUserId=${FILTER_ALL_USERS}`);
    const conditions = conditionsOf(
      recorded.conversationGroupBy[0]?.where as Record<string, unknown>,
    );
    expect(conditions).toContainEqual({ assignedToAll: true });
    await app.close();
  });

  it("os filtros valem para a tela inteira, inclusive para o card de atraso", async () => {
    const app = await buildTestApp();
    const departmentId = DEPARTMENT_A;
    await stats(app, "admin", `?departmentId=${departmentId}`);
    const candidatas = recorded.conversationFindMany.find((args) => {
      const select = (args.select as Record<string, unknown>) ?? {};
      return !("title" in select) && !("assignedUserId" in select);
    });
    expect(conditionsOf(candidatas?.where as Record<string, unknown>)).toContainEqual({
      departmentId: { in: [departmentId] },
    });
    for (const args of recorded.messageCount) {
      const where = args.where as { conversation?: Record<string, unknown> };
      expect(conditionsOf(where.conversation ?? {})).toContainEqual({
        departmentId: { in: [departmentId] },
      });
    }
    await app.close();
  });

  it("filtro devolvido na resposta é o que a API aplicou, em lista", async () => {
    const app = await buildTestApp();
    const body = (
      await stats(app, "admin", `?instanceId=${INSTANCE_A}&instanceId=${INSTANCE_B}&status=open`)
    ).json();
    expect(body.filters).toEqual({
      instanceIds: [INSTANCE_A, INSTANCE_B],
      statuses: ["open"],
      departmentIds: [],
      assignedUserIds: [],
    });
    // Filtro não usado volta como lista vazia, que é o "todos" — nunca nulo.
    expect(body.filters.departmentIds).toEqual([]);
    await app.close();
  });

  it("filtro de status refina a tela inteira, sem substituir o recorte de acesso", async () => {
    const app = await buildTestApp();
    await stats(app, "agent", "?status=open");
    const conditions = conditionsOf(
      recorded.conversationGroupBy[0]?.where as Record<string, unknown>,
    );
    // O filtro entra no AND junto com o escopo, nunca no lugar dele.
    expect(conditions).toContainEqual({ status: { in: ["open"] } });
    expect(conditions).toContainEqual({
      OR: [{ assignedUserId: "user-agent" }, { assignedUserId: null }],
    });
    // As contagens de mensagem seguem o mesmo recorte, senão os cards de
    // mensagens contariam conversas que os cards de status esconderam.
    for (const args of recorded.messageCount) {
      const where = args.where as { conversation?: Record<string, unknown> };
      expect(conditionsOf(where.conversation ?? {})).toContainEqual({ status: { in: ["open"] } });
    }
    await app.close();
  });

  it("nenhum filtro revela ao agent número que ele não enxerga", async () => {
    const app = await buildTestApp();
    // Ele pede um número que não está vinculado ao login dele. A consulta sai
    // com as DUAS condições, e a interseção é vazia: o filtro só sabe tirar
    // conversa da conta, nunca trazer uma de volta.
    await stats(app, "agent", `?instanceId=${INSTANCE_B}`);
    const conditions = conditionsOf(
      recorded.conversationGroupBy[0]?.where as Record<string, unknown>,
    );
    expect(conditions).toContainEqual({ whatsappInstanceId: { in: ["inst-1"] } });
    expect(conditions).toContainEqual({ whatsappInstanceId: { in: [INSTANCE_B] } });
    // O card de infraestrutura também: o escopo continua no AND ao lado do
    // filtro, e não pode ser sobrescrito por ele.
    expect(recorded.instanceGroupBy[0]?.where).toMatchObject({
      AND: [{ id: { in: ["inst-1"] } }, { id: { in: [INSTANCE_B] } }],
    });
    await app.close();
  });

  it("recusa status fora dos quatro do atendimento", async () => {
    const app = await buildTestApp();
    const response = await stats(app, "admin", "?status=qualquer");
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toBe("validation_error");
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

  it("série por dia traz todos os dias do período, com o que veio do banco", async () => {
    const app = await buildTestApp();
    const hoje = (await stats(app, "admin", "?period=today")).json();
    expect(hoje.timeline).toEqual([{ date: TODAY, received: 9, sent: 3 }]);

    const semana = (await stats(app, "admin", "?period=7d")).json();
    // Sete pontos, um por dia civil — inclusive os seis sem mensagem nenhuma.
    expect(semana.timeline).toHaveLength(7);
    expect(semana.timeline.filter((p: { received: number }) => p.received === 0)).toHaveLength(6);
    await app.close();
  });

  it("mapa dia × hora soma as células e sai ordenado", async () => {
    const app = await buildTestApp();
    const body = (await stats(app, "admin")).json();
    expect(body.hourly).toEqual([
      { weekday: 5, hour: 9, received: 7, sent: 3 },
      { weekday: 5, hour: 15, received: 2, sent: 0 },
    ]);
    await app.close();
  });

  it("o mapa dia × hora usa sempre 30 dias, mesmo com o período em hoje", async () => {
    const app = await buildTestApp();
    await stats(app, "admin", "?period=today");
    // Duas buscas de conversa por atividade: a do período (hoje) e a da
    // janela fixa do mapa. A do mapa começa bem antes.
    const janelas = recorded.conversationFindMany
      .map((args) => (args.where as { lastMessageAt?: { gte?: Date } }).lastMessageAt?.gte)
      .filter((value): value is Date => value instanceof Date)
      .map((value) => value.getTime());
    expect(janelas.length).toBeGreaterThanOrEqual(2);
    const maisAntiga = Math.min(...janelas);
    const maisRecente = Math.max(...janelas);
    const diasDeDiferenca = (maisRecente - maisAntiga) / 86_400_000;
    // Hoje contra 30 dias: a diferença fica em torno de 29 dias civis.
    expect(diasDeDiferenca).toBeGreaterThan(28);
    await app.close();
  });

  it("com o período já em 30 dias, não repete a consulta do mapa", async () => {
    const app = await buildTestApp();
    await stats(app, "admin", "?period=30d");
    // A janela é a mesma: uma agregação crua basta para os dois blocos.
    const agregacoes = recorded.rawQueries.filter((text) => text.includes("EXTRACT"));
    expect(agregacoes).toHaveLength(1);
    await app.close();
  });

  it("os filtros da tela continuam valendo no mapa de 30 dias", async () => {
    const app = await buildTestApp();
    const departmentId = DEPARTMENT_A;
    await stats(app, "admin", `?period=today&departmentId=${departmentId}`);
    // Toda busca por atividade — a do período e a do mapa — carrega o filtro.
    const porAtividade = recorded.conversationFindMany.filter(
      (args) => (args.where as { lastMessageAt?: unknown }).lastMessageAt !== undefined,
    );
    expect(porAtividade.length).toBeGreaterThanOrEqual(2);
    for (const args of porAtividade) {
      expect(conditionsOf(args.where as Record<string, unknown>)).toContainEqual({
        departmentId: { in: [departmentId] },
      });
    }
    await app.close();
  });

  it("a agregação por dia e hora corta no fuso configurado, não em UTC", async () => {
    const app = await buildTestApp();
    await stats(app, "admin");
    const agregacao = recorded.rawQueries.find((text) => text.includes("EXTRACT"));
    expect(agregacao).toBeDefined();
    // O corte usa AT TIME ZONE com o fuso dos parâmetros; sem isso "hoje"
    // seria o dia UTC do container.
    expect(agregacao).toContain("AT TIME ZONE");
    // Os mesmos descartes dos cards, senão o gráfico conta outra história.
    expect(agregacao).toContain('"deletedAt" IS NULL');
    expect(agregacao).toContain("'pending'");
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

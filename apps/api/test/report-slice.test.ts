import { beforeEach, describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import jwt from "@fastify/jwt";
import type { PrismaClient } from "@azvchat/database";
import {
  ASSIGNMENT_ALL_USERS,
  ASSIGNMENT_UNASSIGNED,
  FILTER_NONE,
  departmentAssignmentToken,
  userAssignmentToken,
} from "@azvchat/shared";
import { registerErrorHandler } from "../src/lib/errors.js";
import type { AuthTokenPayload } from "../src/lib/auth.js";
import { clearPermissionCache } from "../src/lib/permissions.js";
import { conversationRoutes } from "../src/modules/conversations/routes.js";
import { reportRoutes } from "../src/modules/reports/routes.js";
import { bucketQueueEntries } from "../src/modules/reports/metrics.js";
import {
  REPORT_QUEUE_STATUSES,
  reportFilterConditions,
  reportQueueCellWhere,
  reportRowWhere,
  resolvedHistoryWhere,
  resolvedInPeriodWhere,
} from "../src/lib/report-slice.js";
import { clearAzevedoOsFilterCache } from "../src/lib/azevedo-os-company-filter.js";
import { AzevedoOsError, type AzevedoOsClient } from "../src/services/azevedo-os-client.js";
import type { AppDeps } from "../src/types.js";

/**
 * O que estes testes trancam:
 *
 * 1. **a célula e o painel usam o MESMO critério.** O número da célula sai de
 *    um `groupBy` e a lista do painel sai de `GET /conversations`; se os dois
 *    montarem o recorte por conta própria, a célula diz "4" e o painel lista
 *    3 — e o relatório inteiro perde a credibilidade;
 * 2. **o painel respeita o escopo de acesso**, que continua vindo de
 *    `lib/access.ts`. O recorte da célula entra POR CIMA, nunca no lugar
 *    dele: supervisor nenhum pode ver pelo relatório uma conversa que não
 *    veria na Inbox;
 * 3. **arquivada fica fora dos dois lados**, igual.
 */

const INSTANCIA = "44444444-4444-4444-8444-444444444444";
const DEPTO = "55555555-5555-4555-8555-555555555555";
const DEPTO_2 = "66666666-6666-4666-8666-666666666666";
const PESSOA = "77777777-7777-4777-8777-777777777777";
const DESDE = "2026-08-01T00:00:00.000Z";
const ATE = "2026-08-19T23:59:59.000Z";

interface Gravado {
  listWhere: Array<Record<string, unknown>>;
  queueGroupBy: Array<Record<string, unknown>>;
  resolvedGroupBy: Array<Record<string, unknown>>;
}
let gravado: Gravado;

beforeEach(() => {
  gravado = { listWhere: [], queueGroupBy: [], resolvedGroupBy: [] };
  clearAzevedoOsFilterCache();
  clearPermissionCache();
});

/** Supervisor ligado a UM número e UM departamento: escopo restrito de verdade. */
function fakePrisma(): PrismaClient {
  return {
    userWhatsAppInstance: { findMany: async () => [{ whatsappInstanceId: INSTANCIA }] },
    userDepartment: { findMany: async () => [{ departmentId: DEPTO }] },
    rolePermission: { findMany: async () => [] },
    department: {
      findMany: async (args: { where?: { id?: { in: string[] } } }) => {
        const pedidos = args.where?.id?.in;
        const existentes = [{ id: DEPTO }, { id: DEPTO_2 }];
        return pedidos ? existentes.filter((row) => pedidos.includes(row.id)) : existentes;
      },
    },
    user: {
      findMany: async (args: { where?: { id?: { in: string[] } } }) => {
        const pedidos = args.where?.id?.in;
        if (pedidos) return pedidos.filter((id) => id === PESSOA).map((id) => ({ id }));
        return [
          {
            id: PESSOA,
            name: "Fulana",
            email: "fulana@example.com",
            role: "agent",
            status: "active",
            avatarUrl: null,
            signMessages: false,
            notificationSound: "sound_1",
            notificationVolume: "medium",
            lastLoginAt: null,
            createdAt: new Date(DESDE),
          },
        ];
      },
    },
    tag: { findMany: async () => [] },
    whatsAppInstance: {
      findMany: async (args: { where?: { id?: { in: string[] } } }) => {
        const pedidos = args.where?.id?.in;
        return pedidos ? pedidos.filter((id) => id === INSTANCIA).map((id) => ({ id })) : [];
      },
    },
    conversationRead: { findMany: async () => [] },
    message: {
      findMany: async () => [],
      count: async () => 0,
    },
    conversationAssignmentHistory: {
      groupBy: async (args: Record<string, unknown>) => {
        gravado.resolvedGroupBy.push(args.where as Record<string, unknown>);
        return [];
      },
    },
    conversation: {
      findMany: async (args: Record<string, unknown>) => {
        gravado.listWhere.push(args.where as Record<string, unknown>);
        return [];
      },
      count: async () => 0,
      groupBy: async (args: Record<string, unknown>) => {
        gravado.queueGroupBy.push(args.where as Record<string, unknown>);
        return [];
      },
    },
  } as unknown as PrismaClient;
}

function fakeAzevedoOs(): AzevedoOsClient {
  return {
    enabled: false,
    missingVars: ["AZEVEDO_OS_API_URL", "AZEVEDO_OS_API_TOKEN"],
    lastSuccessAt: null,
    searchCompanies: async () => [],
    getCompany: async () => {
      throw new AzevedoOsError("not_found");
    },
    companyFacets: async () => ({
      taxRegime: { options: [], noneCount: 0 },
      payroll: { options: [], noneCount: 0 },
    }),
    companyIds: async () => ({ ids: [], truncated: false }),
    companyWebUrl: () => null,
  };
}

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify();
  await app.register(jwt, { secret: "segredo-de-teste" });
  app.decorate("verifySession", async (payload: AuthTokenPayload) => payload);
  registerErrorHandler(app);
  const deps = {
    prisma: fakePrisma(),
    azevedoOs: fakeAzevedoOs(),
    logger: { warn: () => undefined, info: () => undefined },
    io: { to: () => ({ emit: () => undefined }) },
    audit: { record: () => undefined },
  } as unknown as AppDeps;
  await conversationRoutes(app, deps);
  await reportRoutes(app, deps);
  await app.ready();
  return app;
}

function token(app: FastifyInstance, role: AuthTokenPayload["role"] = "supervisor"): string {
  return app.jwt.sign({
    sub: "user-sup",
    organizationId: "org-1",
    role,
    name: "Supervisora",
    email: "sup@example.com",
  });
}

function pedir(app: FastifyInstance, url: string, role: AuthTokenPayload["role"] = "supervisor") {
  return app.inject({ method: "GET", url, headers: { authorization: `Bearer ${token(app, role)}` } });
}

function fragmentos(where: Record<string, unknown> | undefined): Array<Record<string, unknown>> {
  const and = where?.AND;
  return Array.isArray(and) ? (and as Array<Record<string, unknown>>) : [];
}

describe("recorte da célula: a contagem e a listagem falam a mesma língua", () => {
  it.each(REPORT_QUEUE_STATUSES)(
    "o painel de '%s' manda para a lista exatamente o predicado da célula",
    async (status) => {
      const app = await buildApp();
      const resposta = await pedir(
        app,
        `/conversations?status=${status}&assignment=${encodeURIComponent(userAssignmentToken(PESSOA))}`,
      );
      expect(resposta.statusCode).toBe(200);
      const partes = fragmentos(gravado.listWhere[0]);
      const esperado = reportQueueCellWhere({ kind: "user", userId: PESSOA }, status);
      // O predicado da célula chega inteiro, item por item, ao `AND` da lista.
      expect(partes).toContainEqual({ status: esperado.status });
      expect(partes).toContainEqual({ assignedUserId: esperado.assignedUserId });
      await app.close();
    },
  );

  it("'sem responsável' no painel é a mesma órfã que a célula conta", async () => {
    const app = await buildApp();
    await pedir(app, `/conversations?status=open&assignment=${ASSIGNMENT_UNASSIGNED}`);
    expect(fragmentos(gravado.listWhere[0])).toContainEqual(reportRowWhere({ kind: "unassigned" }));
    await app.close();
  });

  it("'@todos' no painel é o coletivo, e não a órfã", async () => {
    const app = await buildApp();
    await pedir(app, `/conversations?status=open&assignment=${ASSIGNMENT_ALL_USERS}`);
    const partes = fragmentos(gravado.listWhere[0]);
    expect(partes).toContainEqual(reportRowWhere({ kind: "all_users" }));
    expect(partes).not.toContainEqual(reportRowWhere({ kind: "unassigned" }));
    await app.close();
  });

  it("concluídas leva o intervalo e NÃO filtra por responsável de agora", async () => {
    const app = await buildApp();
    const resposta = await pedir(
      app,
      `/conversations?resolvedBy=${PESSOA}&resolvedFrom=${DESDE}&resolvedTo=${ATE}`,
    );
    expect(resposta.statusCode).toBe(200);
    const partes = fragmentos(gravado.listWhere[0]);
    expect(partes).toContainEqual(
      resolvedInPeriodWhere(PESSOA, new Date(DESDE), new Date(ATE)),
    );
    // A conversa pode ter trocado de mão depois de concluída: filtrar pelo
    // responsável atual devolveria menos do que a célula mostra.
    expect(partes.some((parte) => "assignedUserId" in parte)).toBe(false);
    await app.close();
  });

  it("o relatório conta concluídas pelo MESMO critério de histórico", async () => {
    const app = await buildApp();
    const resposta = await pedir(app, `/reports/agents?from=${DESDE}&to=${ATE}`);
    expect(resposta.statusCode).toBe(200);
    const where = gravado.resolvedGroupBy[0] as Record<string, unknown>;
    const esperado = resolvedHistoryWhere(new Date(DESDE), new Date(ATE));
    expect(where.action).toEqual(esperado.action);
    expect(where.createdAt).toEqual(esperado.createdAt);
    await app.close();
  });

  it("os três status de fila são de AGORA: o relatório não corta por data", async () => {
    const app = await buildApp();
    await pedir(app, `/reports/agents?from=${DESDE}&to=${ATE}`);
    const where = gravado.queueGroupBy[0] as Record<string, unknown>;
    expect(where.status).toEqual({ not: "resolved" });
    expect(where).not.toHaveProperty("lastMessageAt");
    await app.close();
  });
});

describe("o painel respeita o escopo de acesso", () => {
  it("o recorte da célula entra POR CIMA do escopo, nunca no lugar dele", async () => {
    const app = await buildApp();
    await pedir(
      app,
      `/conversations?status=open&assignment=${encodeURIComponent(userAssignmentToken(PESSOA))}`,
    );
    const partes = fragmentos(gravado.listWhere[0]);
    // O supervisor do teste só enxerga UM número e UM departamento: os dois
    // fragmentos continuam no `AND` ao lado do recorte da célula.
    expect(partes).toContainEqual({ whatsappInstanceId: { in: [INSTANCIA] } });
    expect(
      partes.some((parte) => JSON.stringify(parte).includes(DEPTO)),
    ).toBe(true);
    await app.close();
  });

  it("arquivada fica de fora do painel", async () => {
    const app = await buildApp();
    await pedir(app, "/conversations?status=open");
    expect(gravado.listWhere[0]?.archivedAt).toBeNull();
    await app.close();
  });

  it("arquivada fica de fora da contagem da célula, do mesmo jeito", async () => {
    const app = await buildApp();
    await pedir(app, `/reports/agents?from=${DESDE}&to=${ATE}`);
    expect(gravado.queueGroupBy[0]?.archivedAt).toBeNull();
    expect(
      (gravado.resolvedGroupBy[0]?.conversation as Record<string, unknown>).archivedAt,
    ).toBeNull();
    await app.close();
  });

  it("id de responsável que não existe é RECUSADO no recorte de concluídas", async () => {
    const app = await buildApp();
    const resposta = await pedir(
      app,
      `/conversations?resolvedBy=aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa&resolvedFrom=${DESDE}&resolvedTo=${ATE}`,
    );
    expect(resposta.statusCode).toBe(400);
    await app.close();
  });

  it("concluídas sem o intervalo é recusado — 'de sempre' é outro recorte", async () => {
    const app = await buildApp();
    const resposta = await pedir(app, `/conversations?resolvedBy=${PESSOA}`);
    expect(resposta.statusCode).toBe(400);
    await app.close();
  });
});

describe("bucketQueueEntries — a mesma partição de report-slice", () => {
  it("separa pessoa, coletivo e órfã sem misturar nenhum dos três", () => {
    const buckets = bucketQueueEntries([
      { assignedUserId: PESSOA, assignedToAll: false, status: "open", count: 4 },
      { assignedUserId: PESSOA, assignedToAll: false, status: "waiting_client", count: 1 },
      { assignedUserId: null, assignedToAll: true, status: "open", count: 7 },
      { assignedUserId: null, assignedToAll: false, status: "open", count: 9 },
      { assignedUserId: null, assignedToAll: false, status: "waiting_internal", count: 2 },
    ]);
    expect(buckets.byUser.get(PESSOA)).toEqual({ open: 4, waitingClient: 1, waitingInternal: 0 });
    // O coletivo NÃO entra na conta das órfãs: ele é sem dono por decisão.
    expect(buckets.allUsers).toEqual({ open: 7, waitingClient: 0, waitingInternal: 0 });
    expect(buckets.unassigned).toEqual({ open: 9, waitingClient: 0, waitingInternal: 2 });
  });

  it("cada balde corresponde ao predicado que o painel manda", () => {
    // A partição do `groupBy` e os predicados de `report-slice` descrevem os
    // mesmos três conjuntos — é esta correspondência que faz a célula e a
    // lista baterem.
    expect(reportRowWhere({ kind: "user", userId: PESSOA })).toEqual({
      assignedUserId: { in: [PESSOA] },
    });
    expect(reportRowWhere({ kind: "all_users" })).toEqual({ assignedToAll: true });
    expect(reportRowWhere({ kind: "unassigned" })).toEqual({
      assignedUserId: null,
      assignedToAll: false,
    });
  });
});

describe("filtros da barra do relatório: departamento e conexão", () => {
  it("os dois CRUZAM entre si e somam dentro de si", () => {
    const conditions = reportFilterConditions({
      departmentId: [DEPTO, DEPTO_2],
      instanceId: [INSTANCIA],
    });
    // Dois itens no `AND`: um por filtro. Dentro do de departamento, os dois
    // ids somam num `in` só.
    expect(conditions).toHaveLength(2);
    expect(conditions).toContainEqual({ whatsappInstanceId: { in: [INSTANCIA] } });
    expect(conditions).toContainEqual({ departmentId: { in: [DEPTO, DEPTO_2] } });
  });

  it("'sem departamento' é mais um ramo do OU, e não a ausência de filtro", () => {
    const conditions = reportFilterConditions({
      departmentId: [FILTER_NONE, DEPTO],
      instanceId: [],
    });
    expect(conditions).toEqual([
      { OR: [{ departmentId: null }, { departmentId: { in: [DEPTO] } }] },
    ]);
  });

  it("lista vazia não gera condição — é 'todos', nunca 'nenhum'", () => {
    expect(reportFilterConditions({ departmentId: [], instanceId: [] })).toEqual([]);
  });

  it("o relatório aplica os filtros POR CIMA do escopo de acesso", async () => {
    const app = await buildApp();
    const resposta = await pedir(
      app,
      `/reports/agents?from=${DESDE}&to=${ATE}&departmentId=${DEPTO}&instanceId=${INSTANCIA}`,
    );
    expect(resposta.statusCode).toBe(200);
    const partes = fragmentos(gravado.queueGroupBy[0]);
    // O escopo do supervisor continua inteiro ao lado dos filtros: o recorte
    // refina, nunca amplia.
    expect(partes).toContainEqual({ whatsappInstanceId: { in: [INSTANCIA] } });
    expect(partes).toContainEqual({ departmentId: { in: [DEPTO] } });
    expect(partes.some((parte) => "OR" in parte)).toBe(true);
    await app.close();
  });

  it("o painel leva os MESMOS filtros, com o departamento que CRUZA", async () => {
    const app = await buildApp();
    const resposta = await pedir(
      app,
      `/conversations?status=open&assignment=${encodeURIComponent(userAssignmentToken(PESSOA))}&departmentId=${DEPTO}&instanceId=${INSTANCIA}`,
    );
    expect(resposta.statusCode).toBe(200);
    const partes = fragmentos(gravado.listWhere[0]);
    // Item PRÓPRIO no `AND`, e não um ramo dentro do `assignment`: fundido
    // ali ele SOMARIA com o responsável, e o painel listaria o departamento
    // inteiro em vez das conversas daquela pessoa dentro dele.
    expect(partes).toContainEqual({ departmentId: { in: [DEPTO] } });
    expect(partes).toContainEqual({ assignedUserId: { in: [PESSOA] } });
    await app.close();
  });

  it("o `dept:` de assignment continua SOMANDO — as duas formas não se misturam", async () => {
    const app = await buildApp();
    await pedir(
      app,
      `/conversations?assignment=${encodeURIComponent(departmentAssignmentToken(DEPTO))},${encodeURIComponent(userAssignmentToken(PESSOA))}`,
    );
    const partes = fragmentos(gravado.listWhere[0]);
    // O da triagem vira UM item com `OR` dentro; o que cruza seria dois itens.
    expect(partes).toContainEqual({
      OR: [{ departmentId: { in: [DEPTO] } }, { assignedUserId: { in: [PESSOA] } }],
    });
    await app.close();
  });

  it("departamento que não existe é RECUSADO no relatório, não ignorado", async () => {
    const app = await buildApp();
    const resposta = await pedir(
      app,
      `/reports/agents?from=${DESDE}&to=${ATE}&departmentId=aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa`,
    );
    expect(resposta.statusCode).toBe(400);
    await app.close();
  });
});

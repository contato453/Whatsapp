import { beforeEach, describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import jwt from "@fastify/jwt";
import type { PrismaClient } from "@azvchat/database";
import {
  ASSIGNMENT_ALL_USERS,
  ASSIGNMENT_NO_DEPARTMENT,
  ASSIGNMENT_UNASSIGNED,
  departmentAssignmentToken,
  userAssignmentToken,
} from "@azvchat/shared";
import { registerErrorHandler } from "../src/lib/errors.js";
import type { AuthTokenPayload } from "../src/lib/auth.js";
import { conversationRoutes } from "../src/modules/conversations/routes.js";
import { assignmentFilterWhere } from "../src/lib/conversation-assignment.js";
import { clearAzevedoOsFilterCache } from "../src/lib/azevedo-os-company-filter.js";
import { AzevedoOsError, type AzevedoOsClient } from "../src/services/azevedo-os-client.js";
import type { AppDeps } from "../src/types.js";

/**
 * O que estes testes fixam sobre a multisseleção:
 *
 * 1. **OU dentro do filtro, E entre filtros diferentes.** É a regra que
 *    alguém vai inverter um dia, e invertê-la deixa a Inbox vazia em quase
 *    toda marcação múltipla;
 * 2. **departamento e responsável somam**, atravessando os blocos: marcar o
 *    Contábil junto com alguém de outro departamento devolve os dois
 *    conjuntos, e não a interseção. É o motivo de eles serem um filtro só;
 * 3. **o filtro entra DEPOIS do escopo de acesso**, nunca no lugar dele;
 * 4. item inválido é RECUSADO, não ignorado em silêncio.
 */

const INSTANCIA = "44444444-4444-4444-8444-444444444444";
const INSTANCIA_2 = "88888888-8888-4888-8888-888888888888";
const DEPTO = "55555555-5555-4555-8555-555555555555";
const DEPTO_2 = "66666666-6666-4666-8666-666666666666";
const PESSOA = "77777777-7777-4777-8777-777777777777";
const ETIQUETA = "99999999-9999-4999-8999-999999999999";
const INEXISTENTE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

interface Gravado {
  findManyWhere: Array<Record<string, unknown>>;
}
let gravado: Gravado;

beforeEach(() => {
  gravado = { findManyWhere: [] };
  clearAzevedoOsFilterCache();
});

/** Agente ligado a um número e a um departamento: escopo restrito de verdade. */
function fakePrisma(): PrismaClient {
  const existentes = {
    department: [{ id: DEPTO }, { id: DEPTO_2 }],
    user: [{ id: PESSOA }],
    tag: [{ id: ETIQUETA }],
    whatsAppInstance: [{ id: INSTANCIA }, { id: INSTANCIA_2 }],
  };
  const catalogo = (chave: keyof typeof existentes) => ({
    findMany: async (args: { where: { id?: { in: string[] } } }) => {
      const pedidos = args.where.id?.in ?? [];
      return existentes[chave].filter((linha) => pedidos.includes(linha.id));
    },
  });
  return {
    userWhatsAppInstance: { findMany: async () => [{ whatsappInstanceId: INSTANCIA }] },
    userDepartment: { findMany: async () => [{ departmentId: DEPTO }] },
    department: catalogo("department"),
    user: catalogo("user"),
    tag: catalogo("tag"),
    whatsAppInstance: catalogo("whatsAppInstance"),
    conversationRead: { findMany: async () => [] },
    conversation: {
      findMany: async (args: Record<string, unknown>) => {
        gravado.findManyWhere.push(args.where as Record<string, unknown>);
        return [];
      },
      count: async () => 0,
    },
  } as unknown as PrismaClient;
}

function fakeAzevedoOs(): AzevedoOsClient {
  return {
    enabled: true,
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
  await conversationRoutes(app, {
    prisma: fakePrisma(),
    azevedoOs: fakeAzevedoOs(),
    logger: { warn: () => undefined, info: () => undefined },
    io: { to: () => ({ emit: () => undefined }) },
    audit: { record: () => undefined },
  } as unknown as AppDeps);
  await app.ready();
  return app;
}

function listar(app: FastifyInstance, query: string, role: AuthTokenPayload["role"] = "agent") {
  return app.inject({
    method: "GET",
    url: `/conversations${query}`,
    headers: {
      authorization: `Bearer ${app.jwt.sign({
        sub: "user-agent",
        organizationId: "org-1",
        role,
        name: "Fulano de Tal",
        email: "fulano@example.com",
      })}`,
    },
  });
}

function fragmentos(where: Record<string, unknown> | undefined): Array<Record<string, unknown>> {
  const and = where?.AND;
  return Array.isArray(and) ? (and as Array<Record<string, unknown>>) : [];
}

describe("GET /conversations — OU dentro do filtro", () => {
  it("dois status marcados viram um `in`, não duas condições", async () => {
    const app = await buildApp();
    const resposta = await listar(app, "?status=open&status=resolved");
    expect(resposta.statusCode).toBe(200);
    expect(fragmentos(gravado.findManyWhere[0])).toContainEqual({
      status: { in: ["open", "resolved"] },
    });
    await app.close();
  });

  it("aceita a lista separada por vírgula também", async () => {
    const app = await buildApp();
    await listar(app, "?status=open,waiting_client");
    expect(fragmentos(gravado.findManyWhere[0])).toContainEqual({
      status: { in: ["open", "waiting_client"] },
    });
    await app.close();
  });

  it("dois números e duas etiquetas somam dentro do próprio filtro", async () => {
    const app = await buildApp();
    await listar(app, `?instanceId=${INSTANCIA}&instanceId=${INSTANCIA_2}&tagId=${ETIQUETA}`);
    const partes = fragmentos(gravado.findManyWhere[0]);
    expect(partes).toContainEqual({ whatsappInstanceId: { in: [INSTANCIA, INSTANCIA_2] } });
    expect(partes).toContainEqual({ tags: { some: { tagId: { in: [ETIQUETA] } } } });
    await app.close();
  });

  it("filtro sem nada marcado não gera condição — é 'todos'", async () => {
    const app = await buildApp();
    await listar(app, "");
    // O `AND` fica só com os três fragmentos do escopo de acesso do agente:
    // número liberado, departamento e "só as minhas". Nenhum filtro entrou.
    const partes = fragmentos(gravado.findManyWhere[0]);
    expect(partes).toHaveLength(3);
    expect(partes.some((parte) => "status" in parte)).toBe(false);
    expect(partes.some((parte) => "tags" in parte)).toBe(false);
    await app.close();
  });
});

describe("GET /conversations — o filtro unificado SOMA", () => {
  it("O CASO DECISIVO: departamento mais pessoa vira OU, não interseção", async () => {
    const app = await buildApp();
    await listar(app, `?assignment=${departmentAssignmentToken(DEPTO)}&assignment=${userAssignmentToken(PESSOA)}`);
    const partes = fragmentos(gravado.findManyWhere[0]);
    // Um ÚNICO fragmento, com OR dentro. Se isto virasse dois fragmentos
    // separados no AND, o resultado seria a interseção — as conversas do
    // departamento que também são da pessoa — e a lista viria vazia.
    expect(partes).toContainEqual({
      OR: [{ departmentId: { in: [DEPTO] } }, { assignedUserId: { in: [PESSOA] } }],
    });
    expect(partes.some((parte) => "departmentId" in parte)).toBe(false);
    await app.close();
  });

  it("'sem responsável' soma com uma pessoa marcada", async () => {
    const app = await buildApp();
    await listar(app, `?assignment=${ASSIGNMENT_UNASSIGNED}&assignment=${userAssignmentToken(PESSOA)}`);
    expect(fragmentos(gravado.findManyWhere[0])).toContainEqual({
      OR: [
        { assignedUserId: null, assignedToAll: false },
        { assignedUserId: { in: [PESSOA] } },
      ],
    });
    await app.close();
  });

  it("um item marcado sozinho não vira OR de um ramo só", async () => {
    const app = await buildApp();
    await listar(app, `?assignment=${departmentAssignmentToken(DEPTO)}`);
    expect(fragmentos(gravado.findManyWhere[0])).toContainEqual({ departmentId: { in: [DEPTO] } });
    await app.close();
  });

  it("os cinco tipos de item convivem no mesmo OU", () => {
    const where = assignmentFilterWhere({
      unassigned: true,
      allUsers: true,
      noDepartment: true,
      departmentIds: [DEPTO],
      userIds: [PESSOA],
    });
    expect(where).toEqual({
      OR: [
        { assignedUserId: null, assignedToAll: false },
        { assignedToAll: true },
        { departmentId: null },
        { departmentId: { in: [DEPTO] } },
        { assignedUserId: { in: [PESSOA] } },
      ],
    });
  });

  it("nada marcado devolve nulo, e não um OR vazio que não casaria nada", () => {
    expect(
      assignmentFilterWhere({
        unassigned: false,
        allUsers: false,
        noDepartment: false,
        departmentIds: [],
        userIds: [],
      }),
    ).toBeNull();
  });

  it("OR sobre a mesma tabela não repete linha — sem `distinct`", () => {
    // A conversa do Contábil atribuída à fulana casa com dois ramos e mesmo
    // assim aparece uma vez só: é assim que `OR` funciona em SQL, e é por
    // isso que não há deduplicação em lugar nenhum.
    const where = assignmentFilterWhere({
      unassigned: false,
      allUsers: false,
      noDepartment: false,
      departmentIds: [DEPTO],
      userIds: [PESSOA],
    });
    expect(where).not.toHaveProperty("distinct");
  });
});

describe("GET /conversations — E entre filtros diferentes", () => {
  it("departamento e status cruzam", async () => {
    const app = await buildApp();
    await listar(app, `?assignment=${departmentAssignmentToken(DEPTO)}&status=open`);
    const partes = fragmentos(gravado.findManyWhere[0]);
    // Os dois entram no MESMO AND, como itens separados: isso é o E.
    expect(partes).toContainEqual({ status: { in: ["open"] } });
    expect(partes).toContainEqual({ departmentId: { in: [DEPTO] } });
    await app.close();
  });
});

describe("GET /conversations — o filtro vem DEPOIS do escopo de acesso", () => {
  it("o recorte do agente sobrevive a toda a multisseleção", async () => {
    const app = await buildApp();
    await listar(
      app,
      `?assignment=${userAssignmentToken(PESSOA)}&status=open&instanceId=${INSTANCIA}&tagId=${ETIQUETA}`,
    );
    const partes = fragmentos(gravado.findManyWhere[0]);
    // Número liberado, departamento e "só as minhas ou as sem responsável".
    // Sem estes três, filtrar por outra pessoa revelaria a conversa dela.
    expect(partes).toContainEqual({ whatsappInstanceId: { in: [INSTANCIA] } });
    expect(partes).toContainEqual({
      OR: [{ departmentId: null }, { departmentId: { in: [DEPTO] } }],
    });
    expect(partes).toContainEqual({
      OR: [{ assignedUserId: "user-agent" }, { assignedUserId: null }],
    });
    await app.close();
  });

  it("marcar um colega não tira a restrição 'só as minhas'", async () => {
    const app = await buildApp();
    await listar(app, `?assignment=${userAssignmentToken(PESSOA)}`);
    const partes = fragmentos(gravado.findManyWhere[0]);
    const soAsMinhas = partes.find((parte) => {
      const or = parte.OR as Array<Record<string, unknown>> | undefined;
      return or?.some((item) => item.assignedUserId === "user-agent") ?? false;
    });
    expect(soAsMinhas).toBeDefined();
    await app.close();
  });
});

describe("GET /conversations — item inválido é recusado", () => {
  it("status fora do enum não passa pelo Zod", async () => {
    const app = await buildApp();
    expect((await listar(app, "?status=open&status=inventado")).statusCode).toBe(400);
    await app.close();
  });

  it("token de atendimento malformado não passa pelo Zod", async () => {
    const app = await buildApp();
    expect((await listar(app, "?assignment=dept:nao-e-uuid")).statusCode).toBe(400);
    expect((await listar(app, "?assignment=coisa-torta")).statusCode).toBe(400);
    await app.close();
  });

  it("id bem formado que não existe na organização é recusado, não ignorado", async () => {
    const app = await buildApp();
    // Ignorar em silêncio devolveria uma lista plausível recortada por um
    // critério diferente do que a pessoa marcou.
    expect((await listar(app, `?assignment=${departmentAssignmentToken(INEXISTENTE)}`)).statusCode).toBe(400);
    expect((await listar(app, `?tagId=${INEXISTENTE}`)).statusCode).toBe(400);
    await app.close();
  });

  it("id que existe passa, e o que existe junto com um inexistente não", async () => {
    const app = await buildApp();
    expect((await listar(app, `?tagId=${ETIQUETA}`)).statusCode).toBe(200);
    expect((await listar(app, `?tagId=${ETIQUETA}&tagId=${INEXISTENTE}`)).statusCode).toBe(400);
    await app.close();
  });

  it("os itens fixos do primeiro bloco continuam válidos", async () => {
    const app = await buildApp();
    const query = `?assignment=${ASSIGNMENT_UNASSIGNED}&assignment=${ASSIGNMENT_ALL_USERS}&assignment=${ASSIGNMENT_NO_DEPARTMENT}`;
    expect((await listar(app, query)).statusCode).toBe(200);
    await app.close();
  });
});

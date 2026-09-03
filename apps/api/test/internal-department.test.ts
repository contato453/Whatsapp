import { beforeEach, describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import jwt from "@fastify/jwt";
import type { PrismaClient } from "@azvchat/database";
import { registerErrorHandler } from "../src/lib/errors.js";
import type { AuthTokenPayload } from "../src/lib/auth.js";
import { conversationRoutes } from "../src/modules/conversations/routes.js";
import { excludeInternalDepartments } from "../src/lib/internal-department.js";
import { clearAzevedoOsFilterCache } from "../src/lib/azevedo-os-company-filter.js";
import { AzevedoOsError, type AzevedoOsClient } from "../src/services/azevedo-os-client.js";
import type { AppDeps } from "../src/types.js";

/**
 * O que estes testes trancam sobre o departamento INTERNO:
 *
 * 1. **Interno não é arquivado.** A lista de conversas continua trazendo o
 *    grupo interno — ele é trabalho do dia a dia da equipe, com badge de não
 *    lidas, som e piscada no título. Só os NÚMEROS deixam de contá-lo. Se
 *    alguém "uniformizar" as duas coisas, este teste fica vermelho antes de
 *    a equipe descobrir que os grupos internos sumiram da tela;
 * 2. **conversa sem departamento continua contando** — em SQL, um `NOT IN`
 *    sozinho descartaria a coluna nula, e ela é justamente a conversa que o
 *    número não classificou e que ninguém está olhando;
 * 3. **o recorte é ACRESCENTADO ao `AND`, nunca posto no lugar dele**: ali
 *    mora `conversationScope`, e sobrescrevê-lo faria a exclusão do interno
 *    virar porta de saída do controle de acesso.
 */

const INSTANCIA = "44444444-4444-4444-8444-444444444444";
const DEPTO = "55555555-5555-4555-8555-555555555555";
const DEPTO_INTERNO = "22222222-2222-4222-8222-222222222222";
const ATRASADA = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

interface Gravado {
  findManyWhere: Array<Record<string, unknown>>;
}
let gravado: Gravado;

beforeEach(() => {
  gravado = { findManyWhere: [] };
  clearAzevedoOsFilterCache();
});

function fakePrisma(): PrismaClient {
  return {
    userWhatsAppInstance: { findMany: async () => [{ whatsappInstanceId: INSTANCIA }] },
    userDepartment: {
      // A pessoa enxerga o interno: a exclusão precisa vir da MARCA do
      // departamento, e nunca de falta de acesso.
      findMany: async () => [{ departmentId: DEPTO }, { departmentId: DEPTO_INTERNO }],
    },
    department: {
      findMany: async (args: { where?: { isInternal?: boolean; id?: { in: string[] } } }) => {
        if (args.where?.isInternal) return [{ id: DEPTO_INTERNO }];
        const pedidos = args.where?.id?.in ?? [];
        return [{ id: DEPTO }, { id: DEPTO_INTERNO }].filter((linha) =>
          pedidos.includes(linha.id),
        );
      },
    },
    user: { findMany: async () => [] },
    tag: { findMany: async () => [] },
    whatsAppInstance: { findMany: async () => [] },
    conversationRead: { findMany: async () => [] },
    attendanceSettings: { findUnique: async () => null },
    conversation: {
      findMany: async (args: Record<string, unknown>) => {
        gravado.findManyWhere.push(args.where as Record<string, unknown>);
        const where = (args.where ?? {}) as { status?: unknown };
        // A varredura de atraso é a única que filtra por status != resolved.
        if (where.status !== undefined) return [{ id: ATRASADA }];
        return [];
      },
      count: async () => 0,
    },
    $queryRaw: async () => [
      {
        conversationId: ATRASADA,
        direction: "inbound",
        timestamp: new Date(Date.now() - 30 * 86_400_000),
      },
    ],
  } as unknown as PrismaClient;
}

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify();
  await app.register(jwt, { secret: "segredo-de-teste" });
  app.decorate("verifySession", async (payload: AuthTokenPayload) => payload);
  registerErrorHandler(app);
  await conversationRoutes(app, {
    prisma: fakePrisma(),
    azevedoOs: {
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
    } as AzevedoOsClient,
    logger: { warn: () => undefined, info: () => undefined },
    io: { to: () => ({ emit: () => undefined }) },
    audit: { record: () => undefined },
  } as unknown as AppDeps);
  await app.ready();
  return app;
}

function listar(app: FastifyInstance, query: string) {
  return app.inject({
    method: "GET",
    url: `/conversations${query}`,
    headers: {
      authorization: `Bearer ${app.jwt.sign({
        sub: "user-agent",
        organizationId: "org-1",
        role: "agent",
        name: "Fulano de Tal",
        email: "fulano@example.com",
      })}`,
    },
  });
}

/** O recorte do interno, do jeito que ele aparece dentro do `AND`. */
const RECORTE = {
  OR: [{ departmentId: null }, { departmentId: { notIn: [DEPTO_INTERNO] } }],
};

function fragmentos(where: Record<string, unknown> | undefined): Array<Record<string, unknown>> {
  const and = where?.AND;
  return Array.isArray(and) ? (and as Array<Record<string, unknown>>) : [];
}

describe("excludeInternalDepartments", () => {
  it("sem departamento interno não gera condição nenhuma", () => {
    // Um `AND` com objeto vazio dentro não filtra nada e só polui a consulta.
    expect(excludeInternalDepartments([])).toEqual([]);
  });

  it("mantém a conversa SEM departamento, que continua contando", () => {
    const [condicao] = excludeInternalDepartments([DEPTO_INTERNO]);
    expect(condicao).toEqual(RECORTE);
    // O ramo do `null` é o ponto: sem ele, `departmentId NOT IN (...)` seria
    // nulo para a conversa não classificada e ela sumiria dos números sem
    // ninguém pedir.
    expect(JSON.stringify(condicao)).toContain('"departmentId":null');
  });
});

describe("GET /conversations", () => {
  it("a lista NÃO esconde o grupo interno — interno não é arquivado", async () => {
    const app = await buildApp();
    const resposta = await listar(app, "?limit=10");
    expect(resposta.statusCode).toBe(200);
    const where = gravado.findManyWhere.at(-1);
    expect(fragmentos(where)).not.toContainEqual(RECORTE);
    await app.close();
  });

  it("`excludeInternal=true` tira o interno — é o painel do relatório", async () => {
    const app = await buildApp();
    const resposta = await listar(app, "?limit=10&excludeInternal=true");
    expect(resposta.statusCode).toBe(200);
    const where = gravado.findManyWhere.at(-1);
    expect(fragmentos(where)).toContainEqual(RECORTE);
    // E o escopo de acesso continua inteiro no mesmo `AND`: o recorte é
    // acrescentado, nunca posto no lugar dele.
    expect(JSON.stringify(fragmentos(where))).toContain(INSTANCIA);
    await app.close();
  });

  it("a lista de ATRASADAS já exclui o interno, sem parâmetro nenhum", async () => {
    const app = await buildApp();
    // O card do dashboard e esta lista saem da mesma função; se a exclusão
    // dependesse de quem chama, o clique no card abriria uma lista que não
    // fecha com o número dele.
    const resposta = await listar(app, "?limit=10&overdue=true");
    expect(resposta.statusCode).toBe(200);
    const varredura = gravado.findManyWhere.find(
      (where) => (where as { status?: unknown }).status !== undefined,
    );
    expect(fragmentos(varredura)).toContainEqual(RECORTE);
    expect(JSON.stringify(fragmentos(varredura))).toContain(INSTANCIA);
    await app.close();
  });
});

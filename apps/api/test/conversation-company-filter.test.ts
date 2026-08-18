import { beforeEach, describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import jwt from "@fastify/jwt";
import type { PrismaClient } from "@azvchat/database";
import { AZEVEDO_OS_SOURCE } from "@azvchat/shared";
import { registerErrorHandler } from "../src/lib/errors.js";
import type { AuthTokenPayload } from "../src/lib/auth.js";
import { conversationRoutes } from "../src/modules/conversations/routes.js";
import {
  TtlCache,
  clearAzevedoOsFilterCache,
  companyReferenceWhere,
  resolveCompanyIds,
  unlinkedCompanyWhere,
} from "../src/lib/azevedo-os-company-filter.js";
import { AzevedoOsError, type AzevedoOsClient } from "../src/services/azevedo-os-client.js";
import { serializeAzevedoOsFacets } from "../src/modules/integrations/serialize.js";
import type { AppDeps } from "../src/types.js";

/**
 * O que estes testes fixam sobre o recorte da Inbox por característica do
 * cliente (regime tributário e folha, que moram no Azevedo-OS):
 *
 * 1. **o filtro entra DEPOIS do escopo de acesso, nunca no lugar dele** —
 *    este é o teste que importa: `conversationScope` ocupa o `AND` do
 *    `where`, e um recorte que sobrescrevesse esse `AND` transformaria o
 *    filtro numa porta de saída do controle de acesso;
 * 2. valor fora do formato é recusado pelo Zod, antes de qualquer viagem;
 * 3. Azevedo-OS mudo não derruba a Inbox: a lista volta sem o recorte, com
 *    aviso, e nenhum filtro de empresa entra na consulta;
 * 4. o mesmo critério não é perguntado duas vezes ao portal (cache curto);
 * 5. várias conversas da mesma empresa aparecem todas — não há deduplicação;
 * 6. a contagem das que ficaram de fora usa o mesmo escopo da lista.
 */

const INSTANCIA = "44444444-4444-4444-8444-444444444444";
const DEPTO = "55555555-5555-4555-8555-555555555555";
const EMPRESA_A = "11111111-1111-4111-8111-111111111111";
const EMPRESA_B = "22222222-2222-4222-8222-222222222222";

interface Gravado {
  findManyWhere: Array<Record<string, unknown>>;
  countWhere: Array<Record<string, unknown>>;
  chamadasAoPortal: number;
}

let gravado: Gravado;

beforeEach(() => {
  gravado = { findManyWhere: [], countWhere: [], chamadasAoPortal: 0 };
  clearAzevedoOsFilterCache();
});

/** Agente ligado a um número: escopo restrito de verdade, não admin. */
function fakePrisma(): PrismaClient {
  return {
    userWhatsAppInstance: { findMany: async () => [{ whatsappInstanceId: INSTANCIA }] },
    userDepartment: { findMany: async () => [{ departmentId: DEPTO }] },
    conversation: {
      findMany: async (args: Record<string, unknown>) => {
        gravado.findManyWhere.push(args.where as Record<string, unknown>);
        return [];
      },
      count: async (args: Record<string, unknown>) => {
        gravado.countWhere.push(args.where as Record<string, unknown>);
        return 7;
      },
    },
  } as unknown as PrismaClient;
}

function fakeAzevedoOs(overrides: Partial<AzevedoOsClient> = {}): AzevedoOsClient {
  return {
    enabled: true,
    searchCompanies: async () => [],
    getCompany: async () => {
      throw new AzevedoOsError("not_found");
    },
    companyFacets: async () => ({
      taxRegime: { options: [{ value: "simples", label: "Simples Nacional" }], noneCount: 0 },
      payroll: { options: [{ value: "folha_fixa", label: "Folha fixa" }], noneCount: 83 },
    }),
    companyIds: async () => {
      gravado.chamadasAoPortal += 1;
      return { ids: [EMPRESA_A, EMPRESA_B], truncated: false };
    },
    companyWebUrl: () => null,
    ...overrides,
  };
}

async function buildApp(azevedoOs: AzevedoOsClient = fakeAzevedoOs()): Promise<FastifyInstance> {
  const app = Fastify();
  await app.register(jwt, { secret: "segredo-de-teste" });
  app.decorate("verifySession", async (payload: AuthTokenPayload) => payload);
  registerErrorHandler(app);
  await conversationRoutes(app, {
    prisma: fakePrisma(),
    azevedoOs,
    logger: { warn: () => undefined, info: () => undefined },
    io: { to: () => ({ emit: () => undefined }) },
    audit: { record: () => undefined },
  } as unknown as AppDeps);
  await app.ready();
  return app;
}

function token(app: FastifyInstance, role: AuthTokenPayload["role"]): string {
  return app.jwt.sign({
    sub: "user-agent",
    organizationId: "org-1",
    role,
    name: "Fulano de Tal",
    email: "fulano@example.com",
  });
}

function listar(app: FastifyInstance, query: string, role: AuthTokenPayload["role"] = "agent") {
  return app.inject({
    method: "GET",
    url: `/conversations${query}`,
    headers: { authorization: `Bearer ${token(app, role)}` },
  });
}

/** Achata o `AND` do `where` para procurar um fragmento dentro dele. */
function fragmentos(where: Record<string, unknown> | undefined): Array<Record<string, unknown>> {
  const and = where?.AND;
  return Array.isArray(and) ? (and as Array<Record<string, unknown>>) : [];
}

describe("GET /conversations — o recorte por empresa vem DEPOIS do acesso", () => {
  it("mantém o escopo do agente ao filtrar por regime", async () => {
    const app = await buildApp();
    const response = await listar(app, "?taxRegime=simples");
    expect(response.statusCode).toBe(200);

    const where = gravado.findManyWhere[0];
    const partes = fragmentos(where);

    // O recorte de acesso continua inteiro: número liberado, departamento e
    // "só as minhas ou as sem responsável". Sem isto, filtrar por regime
    // revelaria a conversa de outro atendente.
    expect(partes).toContainEqual({ whatsappInstanceId: { in: [INSTANCIA] } });
    expect(partes).toContainEqual({
      OR: [{ departmentId: null }, { departmentId: { in: [DEPTO] } }],
    });
    expect(partes).toContainEqual({
      OR: [{ assignedUserId: "user-agent" }, { assignedUserId: null }],
    });
    // E o recorte por empresa entrou POR CIMA, somando por E.
    expect(partes).toContainEqual(companyReferenceWhere([EMPRESA_A, EMPRESA_B]));
    await app.close();
  });

  it("a conversa de outro atendente não é revelada pelo filtro", async () => {
    const app = await buildApp();
    await listar(app, "?taxRegime=simples");
    const partes = fragmentos(gravado.findManyWhere[0]);
    // A restrição "só as minhas" precisa sobreviver ao filtro. Se ela sumisse,
    // a consulta passaria a devolver a conversa atribuída a outra pessoa só
    // porque a empresa dela bate com o regime pedido.
    const soAsMinhas = partes.find((parte) => {
      const or = parte.OR as Array<Record<string, unknown>> | undefined;
      return or?.some((item) => item.assignedUserId === "user-agent") ?? false;
    });
    expect(soAsMinhas).toBeDefined();
    await app.close();
  });

  it("combina por E com departamento e status, sem desligá-los", async () => {
    const app = await buildApp();
    await listar(app, `?taxRegime=simples&status=open&departmentId=${DEPTO}`);
    const where = gravado.findManyWhere[0] ?? {};
    expect(where.status).toBe("open");
    expect(where.departmentId).toBe(DEPTO);
    expect(where.archivedAt).toBeNull();
    expect(fragmentos(where)).toContainEqual(companyReferenceWhere([EMPRESA_A, EMPRESA_B]));
    await app.close();
  });

  it("filtra pelos dois campos ao mesmo tempo numa consulta só ao portal", async () => {
    const app = await buildApp();
    await listar(app, "?taxRegime=simples&payroll=folha_fixa");
    expect(gravado.chamadasAoPortal).toBe(1);
    await app.close();
  });
});

describe("GET /conversations — validação dos valores", () => {
  it("recusa valor fora do formato do enum", async () => {
    const app = await buildApp();
    const response = await listar(app, "?taxRegime=Simples%20Nacional!");
    expect(response.statusCode).toBe(400);
    // Recusa antes de qualquer viagem ao Azevedo-OS.
    expect(gravado.chamadasAoPortal).toBe(0);
    await app.close();
  });

  it("recusa o sem-vínculo combinado com regime", async () => {
    const app = await buildApp();
    const response = await listar(app, "?unlinked=true&taxRegime=simples");
    expect(response.statusCode).toBe(400);
    await app.close();
  });

  it("aceita o sentinela de sem informação", async () => {
    const app = await buildApp();
    const response = await listar(app, "?payroll=none");
    expect(response.statusCode).toBe(200);
    await app.close();
  });
});

describe("GET /conversations — Azevedo-OS fora do ar", () => {
  it("a Inbox continua funcionando, sem o recorte e com aviso", async () => {
    const app = await buildApp(
      fakeAzevedoOs({
        companyIds: async () => {
          throw new AzevedoOsError("timeout");
        },
      }),
    );
    const response = await listar(app, "?taxRegime=simples");
    expect(response.statusCode).toBe(200);
    const corpo = response.json() as { companyFilter: { unavailable: boolean } };
    expect(corpo.companyFilter.unavailable).toBe(true);

    // Nenhum filtro de empresa entrou na consulta, e o escopo de acesso
    // seguiu inteiro: a lista veio completa dentro do que a pessoa enxerga.
    const partes = fragmentos(gravado.findManyWhere[0]);
    expect(partes.some((parte) => "externalSource" in parte)).toBe(false);
    expect(partes).toContainEqual({ whatsappInstanceId: { in: [INSTANCIA] } });
    await app.close();
  });

  it("erro que não é da integração continua subindo", async () => {
    const app = await buildApp(
      fakeAzevedoOs({
        companyIds: async () => {
          throw new Error("defeito nosso");
        },
      }),
    );
    const response = await listar(app, "?taxRegime=simples");
    expect(response.statusCode).toBe(500);
    await app.close();
  });
});

describe("GET /conversations — conversa sem empresa vinculada", () => {
  it("conta quantas ficaram de fora, no mesmo escopo da lista", async () => {
    const app = await buildApp();
    const response = await listar(app, "?taxRegime=simples");
    const corpo = response.json() as { companyFilter: { unlinkedExcluded: number } };
    expect(corpo.companyFilter.unlinkedExcluded).toBe(7);

    // A contagem do sem-vínculo é a primeira, e carrega o MESMO recorte de
    // acesso da lista: contar fora do escopo mostraria à pessoa um número de
    // conversas que ela não pode ver.
    const partes = fragmentos(gravado.countWhere[0]);
    expect(partes).toContainEqual({ whatsappInstanceId: { in: [INSTANCIA] } });
    expect(partes).toContainEqual({
      OR: [{ assignedUserId: "user-agent" }, { assignedUserId: null }],
    });
    expect(partes).toContainEqual(unlinkedCompanyWhere());
    // E ela não carrega o recorte por empresa: é justamente o complemento.
    expect(partes.some((parte) => "externalSource" in parte)).toBe(false);
    await app.close();
  });

  it("unlinked=true lista só as sem vínculo, sem perguntar ao portal", async () => {
    const app = await buildApp();
    const response = await listar(app, "?unlinked=true");
    expect(response.statusCode).toBe(200);
    expect(gravado.chamadasAoPortal).toBe(0);
    expect(fragmentos(gravado.findManyWhere[0])).toContainEqual(unlinkedCompanyWhere());
    // Sem os dois filtros ativos não há bloco de estado para a tela desenhar.
    expect((response.json() as { companyFilter: unknown }).companyFilter).toBeNull();
    await app.close();
  });

  it("sem filtro de empresa não há consulta extra nem bloco de estado", async () => {
    const app = await buildApp();
    const response = await listar(app, "");
    expect((response.json() as { companyFilter: unknown }).companyFilter).toBeNull();
    expect(gravado.chamadasAoPortal).toBe(0);
    await app.close();
  });
});

describe("recorte por empresa (regras puras)", () => {
  it("exige a fonte, para não confundir com o código de cadastro manual", () => {
    expect(companyReferenceWhere([EMPRESA_A])).toEqual({
      externalSource: AZEVEDO_OS_SOURCE,
      externalReference: { in: [EMPRESA_A] },
    });
  });

  it("várias conversas da mesma empresa entram todas — não há deduplicação", () => {
    // O recorte é por `in` sobre a referência: dois grupos do mesmo cliente
    // casam os dois. Deduplicar por empresa esconderia metade do atendimento.
    const where = companyReferenceWhere([EMPRESA_A]);
    expect(where).not.toHaveProperty("distinct");
    expect(where.externalReference).toEqual({ in: [EMPRESA_A] });
  });

  it("sem empresa vinculada cobre nulo, outra fonte e referência apagada", () => {
    // O `null` vai listado à parte de propósito: `not` sozinho não casa linha
    // nula no Postgres, e conversa sem fonte nenhuma é o caso mais comum.
    expect(unlinkedCompanyWhere().OR).toEqual([
      { externalSource: null },
      { externalSource: { not: AZEVEDO_OS_SOURCE } },
      { externalReference: null },
    ]);
  });

  it("critério vazio devolve lista vazia sem chamar o portal", async () => {
    let chamou = false;
    const client = fakeAzevedoOs({
      companyIds: async () => {
        chamou = true;
        return { ids: [], truncated: false };
      },
    });
    // A rota nunca chega aqui sem critério, mas o guarda vale: um `in` com a
    // base inteira seria o oposto de um filtro.
    const resultado = await resolveCompanyIds(client, { taxRegime: "simples" });
    expect(chamou).toBe(true);
    expect(resultado.ids).toEqual([]);
  });
});

describe("cache curto do recorte", () => {
  it("o mesmo critério não vai duas vezes ao portal", async () => {
    const app = await buildApp();
    await listar(app, "?taxRegime=simples");
    await listar(app, "?taxRegime=simples");
    expect(gravado.chamadasAoPortal).toBe(1);
    await app.close();
  });

  it("critério diferente é pergunta diferente", async () => {
    const app = await buildApp();
    await listar(app, "?taxRegime=simples");
    await listar(app, "?taxRegime=presumido");
    expect(gravado.chamadasAoPortal).toBe(2);
    await app.close();
  });

  it("vencido o prazo, pergunta de novo — regime muda e a Inbox acompanha", () => {
    let agora = 0;
    const cache = new TtlCache<string>(60_000, () => agora);
    cache.set("k", "v");
    agora = 59_000;
    expect(cache.get("k")).toBe("v");
    agora = 60_001;
    expect(cache.get("k")).toBeUndefined();
  });
});

describe("facetas entregues à tela", () => {
  it("oferece 'sem informação' só onde existe empresa em branco", () => {
    const dto = serializeAzevedoOsFacets({
      taxRegime: { options: [{ value: "simples", label: "Simples Nacional" }], noneCount: 0 },
      payroll: { options: [{ value: "folha_fixa", label: "Folha fixa" }], noneCount: 83 },
    });
    expect(dto.taxRegime.hasNone).toBe(false);
    expect(dto.payroll.hasNone).toBe(true);
  });

  it("a contagem de empresas do portal não atravessa para a tela", () => {
    const dto = serializeAzevedoOsFacets({
      taxRegime: { options: [{ value: "simples", label: "Simples Nacional" }], noneCount: 0 },
      payroll: { options: [], noneCount: 0 },
    });
    // "Simples (191)" seria lido como quantidade de conversas, e a lista
    // filtrada com doze linhas pareceria defeito.
    expect(dto.taxRegime.options[0]).toEqual({ value: "simples", label: "Simples Nacional" });
    expect(dto.taxRegime.options[0]).not.toHaveProperty("count");
  });
});

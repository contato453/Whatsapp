import { beforeEach, describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import jwt from "@fastify/jwt";
import type { PrismaClient } from "@azvchat/database";
import {
  ASSIGNMENT_ALL_USERS,
  ASSIGNMENT_UNASSIGNED,
  userAssignmentToken,
} from "@azvchat/shared";
import { registerErrorHandler } from "../src/lib/errors.js";
import type { AuthTokenPayload } from "../src/lib/auth.js";
import { clearPermissionCache } from "../src/lib/permissions.js";
import { conversationRoutes } from "../src/modules/conversations/routes.js";
import { reportRoutes } from "../src/modules/reports/routes.js";
import { clearAzevedoOsFilterCache } from "../src/lib/azevedo-os-company-filter.js";
import { AzevedoOsError, type AzevedoOsClient } from "../src/services/azevedo-os-client.js";
import type { AppDeps } from "../src/types.js";

/**
 * O cenário decisivo: **o número da célula tem que ser exatamente a
 * quantidade que o painel lista**.
 *
 * Este teste roda as DUAS rotas de verdade (`/reports/agents`, que conta, e
 * `/conversations`, que lista) sobre a mesma base em memória, e compara
 * célula a célula. É o teste que fica vermelho no dia em que alguém mexer só
 * de um lado — e é justamente esse desencontro que já custou a confiança da
 * equipe nos cards do Dashboard.
 *
 * A base tem, de propósito, conversas que precisam ficar de fora dos dois
 * lados igual: arquivada e conversa de um número que a supervisora não
 * enxerga. Se o painel passasse por cima do escopo de acesso, os números
 * parariam de bater aqui antes de qualquer pessoa notar em produção.
 */

const ORG = "org-1";
const INSTANCIA = "44444444-4444-4444-8444-444444444444";
const INSTANCIA_FORA = "11111111-1111-4111-8111-111111111111";
const DEPTO = "55555555-5555-4555-8555-555555555555";
const DEPTO_2 = "66666666-6666-4666-8666-666666666666";
const ANA = "77777777-7777-4777-8777-777777777777";
const BRUNO = "88888888-8888-4888-8888-888888888888";
const CLARA = "99999999-9999-4999-8999-999999999999";
const DESDE = "2026-08-01T00:00:00.000Z";
const ATE = "2026-08-31T23:59:59.000Z";

interface Conversa {
  id: string;
  organizationId: string;
  whatsappInstanceId: string;
  departmentId: string | null;
  status: string;
  assignedUserId: string | null;
  assignedToAll: boolean;
  archivedAt: Date | null;
  /** Quem concluiu esta conversa, e quando — o histórico de atribuição. */
  resolvedBy: Array<{ userId: string; at: Date }>;
}

let seq = 0;
function conversa(parcial: Partial<Conversa>): Conversa {
  seq += 1;
  return {
    id: `c-${seq}`,
    organizationId: ORG,
    whatsappInstanceId: INSTANCIA,
    departmentId: DEPTO,
    status: "open",
    assignedUserId: null,
    assignedToAll: false,
    archivedAt: null,
    resolvedBy: [],
    ...parcial,
  };
}

const NO_PERIODO = new Date("2026-08-10T12:00:00.000Z");
const FORA_DO_PERIODO = new Date("2026-07-10T12:00:00.000Z");

/**
 * A base do cenário. Os números que ela produz estão escritos no teste, e
 * qualquer mudança de critério de um dos lados quebra a comparação.
 */
function base(): Conversa[] {
  return [
    // Ana: 3 abertas, 2 aguardando cliente, 1 aguardando operacional
    ...Array.from({ length: 3 }, () => conversa({ assignedUserId: ANA, status: "open" })),
    ...Array.from({ length: 2 }, () =>
      conversa({ assignedUserId: ANA, status: "waiting_client" }),
    ),
    conversa({ assignedUserId: ANA, status: "waiting_internal" }),
    // Bruno: 2 abertas
    ...Array.from({ length: 2 }, () => conversa({ assignedUserId: BRUNO, status: "open" })),
    // Órfãs: 4 abertas e 1 aguardando cliente
    ...Array.from({ length: 4 }, () => conversa({ status: "open" })),
    conversa({ status: "waiting_client" }),
    // Clara: 4 abertas, todas no SEGUNDO departamento. Existem para o filtro
    // ter o que separar: sem filtro ela aparece, filtrando o primeiro
    // departamento ela zera, e a Ana faz o inverso.
    ...Array.from({ length: 4 }, () =>
      conversa({ assignedUserId: CLARA, status: "open", departmentId: DEPTO_2 }),
    ),
    // Coletivo (@todos): 2 abertas — sem dono por DECISÃO, não por falta
    ...Array.from({ length: 2 }, () => conversa({ assignedToAll: true, status: "open" })),
    // Fora dos dois lados: arquivada, e número que a supervisora não enxerga
    conversa({ assignedUserId: ANA, status: "open", archivedAt: new Date() }),
    conversa({ status: "open", archivedAt: new Date() }),
    conversa({ assignedUserId: ANA, status: "open", whatsappInstanceId: INSTANCIA_FORA }),
    conversa({ status: "open", whatsappInstanceId: INSTANCIA_FORA }),
    // Concluídas de Ana dentro do período: 2 — uma delas já reaberta e na
    // mão do Bruno, para provar que a coluna mede o EVENTO, não o dono
    conversa({
      status: "resolved",
      assignedUserId: ANA,
      resolvedBy: [{ userId: ANA, at: NO_PERIODO }],
    }),
    conversa({
      status: "open",
      assignedUserId: BRUNO,
      resolvedBy: [{ userId: ANA, at: NO_PERIODO }],
    }),
    // Concluída por Ana fora do período: não entra na célula nem no painel
    conversa({ status: "resolved", resolvedBy: [{ userId: ANA, at: FORA_DO_PERIODO }] }),
    // Concluída dentro do período, mas arquivada depois: fora dos dois lados
    conversa({
      status: "resolved",
      archivedAt: new Date(),
      resolvedBy: [{ userId: ANA, at: NO_PERIODO }],
    }),
  ];
}

// ---------- Avaliador mínimo de `where`, só com as formas que as rotas usam ----------

function bate(conversa: Conversa, where: unknown): boolean {
  if (!where || typeof where !== "object") return true;
  return Object.entries(where as Record<string, unknown>).every(([campo, criterio]) => {
    if (campo === "AND") return (criterio as unknown[]).every((item) => bate(conversa, item));
    if (campo === "OR") return (criterio as unknown[]).some((item) => bate(conversa, item));
    if (campo === "assignmentHistory") {
      const some = (criterio as { some: Record<string, unknown> }).some;
      return conversa.resolvedBy.some((registro) => {
        if (some.performedByUserId && registro.userId !== some.performedByUserId) return false;
        const janela = some.createdAt as { gte: Date; lte: Date } | undefined;
        if (!janela) return true;
        return registro.at >= janela.gte && registro.at <= janela.lte;
      });
    }
    const valor = (conversa as unknown as Record<string, unknown>)[campo];
    if (criterio === null) return valor === null;
    if (typeof criterio === "object") {
      const c = criterio as Record<string, unknown>;
      if ("in" in c) return (c.in as unknown[]).includes(valor);
      if ("not" in c) return c.not === null ? valor !== null : valor !== c.not;
      return true;
    }
    return valor === criterio;
  });
}

let dados: Conversa[];

beforeEach(() => {
  seq = 0;
  dados = base();
  clearAzevedoOsFilterCache();
  clearPermissionCache();
});

function fakePrisma(): PrismaClient {
  const nomes: Record<string, string> = {
    [ANA]: "Ana Souza",
    [BRUNO]: "Bruno Lima",
    [CLARA]: "Clara Dias",
  };
  const usuarios = [ANA, BRUNO, CLARA].map((id) => ({
    id,
    name: nomes[id] as string,
    email: `${id}@example.com`,
    role: "agent",
    status: "active",
    avatarUrl: null,
    signMessages: false,
    notificationSound: "sound_1",
    notificationVolume: "medium",
    lastLoginAt: null,
    createdAt: new Date(DESDE),
  }));
  return {
    userWhatsAppInstance: { findMany: async () => [{ whatsappInstanceId: INSTANCIA }] },
    userDepartment: {
      findMany: async () => [{ departmentId: DEPTO }, { departmentId: DEPTO_2 }],
    },
    rolePermission: { findMany: async () => [] },
    department: {
      findMany: async (args: { where?: { id?: { in: string[] } } }) => {
        const pedidos = args.where?.id?.in;
        const existentes = [{ id: DEPTO }, { id: DEPTO_2 }];
        return pedidos ? existentes.filter((row) => pedidos.includes(row.id)) : existentes;
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
    personProfile: { findMany: async () => [] },
    // O contador de não lidas sai de um SQL cru; ele não é assunto deste
    // teste, e um mapa vazio basta.
    $queryRaw: async () => [],
    groupParticipant: { groupBy: async () => [] },
    user: {
      findMany: async (args: { where?: { id?: { in: string[] } } }) => {
        const pedidos = args.where?.id?.in;
        if (pedidos) return usuarios.filter((usuario) => pedidos.includes(usuario.id));
        return usuarios;
      },
    },
    message: { findMany: async () => [], count: async () => 0 },
    conversationAssignmentHistory: {
      groupBy: async (args: { where: Record<string, unknown> }) => {
        // O `where` do relatório fala do HISTÓRICO com um `conversation`
        // aninhado; aqui a base guarda os dois juntos, então o critério de
        // conversa é aplicado na própria linha.
        const { conversation, ...historico } = args.where as Record<string, unknown> & {
          conversation?: unknown;
        };
        const pares = new Set<string>();
        for (const item of dados) {
          if (conversation && !bate(item, conversation)) continue;
          for (const registro of item.resolvedBy) {
            if (!bate(item, { assignmentHistory: { some: historico } })) continue;
            const janela = (historico.createdAt as { gte: Date; lte: Date } | undefined) ?? null;
            if (janela && (registro.at < janela.gte || registro.at > janela.lte)) continue;
            pares.add(`${registro.userId}|${item.id}`);
          }
        }
        return [...pares].map((chave) => {
          const [performedByUserId, conversationId] = chave.split("|");
          return { performedByUserId, conversationId, _count: { _all: 1 } };
        });
      },
    },
    conversation: {
      findMany: async (args: { where: unknown; take?: number; skip?: number }) => {
        const casadas = dados.filter((item) => bate(item, args.where));
        const inicio = args.skip ?? 0;
        return casadas.slice(inicio, inicio + (args.take ?? casadas.length)).map((item) => ({
          ...item,
          externalChatId: `${item.id}@s.whatsapp.net`,
          type: "individual",
          title: item.id,
          customTitle: null,
          profilePicture: null,
          lastMessageAt: NO_PERIODO,
          lastMessagePreview: null,
          externalReference: null,
          externalSource: null,
          createdAt: NO_PERIODO,
          instance: null,
          assignedUser: null,
          archivedBy: null,
          department: null,
          tags: [],
        }));
      },
      count: async (args: { where: unknown }) => dados.filter((item) => bate(item, args.where)).length,
      groupBy: async (args: { where: unknown }) => {
        const grupos = new Map<string, number>();
        for (const item of dados) {
          if (!bate(item, args.where)) continue;
          const chave = `${item.assignedUserId ?? ""}|${item.assignedToAll}|${item.status}`;
          grupos.set(chave, (grupos.get(chave) ?? 0) + 1);
        }
        return [...grupos].map(([chave, total]) => {
          const [assignedUserId, assignedToAll, status] = chave.split("|");
          return {
            assignedUserId: assignedUserId === "" ? null : assignedUserId,
            assignedToAll: assignedToAll === "true",
            status,
            _count: { _all: total },
          };
        });
      },
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
    azevedoOs: {
      enabled: false,
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
  } as unknown as AppDeps;
  await conversationRoutes(app, deps);
  await reportRoutes(app, deps);
  await app.ready();
  return app;
}

function pedir(app: FastifyInstance, url: string) {
  return app.inject({
    method: "GET",
    url,
    headers: {
      authorization: `Bearer ${app.jwt.sign({
        sub: "user-sup",
        organizationId: ORG,
        role: "supervisor",
        name: "Supervisora",
        email: "sup@example.com",
      })}`,
    },
  });
}

interface Relatorio {
  rows: Array<{
    user: { id: string; name: string };
    conversationsResolved: number;
    queue: { open: number; waitingClient: number; waitingInternal: number };
  }>;
  unassigned: { queue: { open: number; waitingClient: number; waitingInternal: number } };
  allUsers: { queue: { open: number; waitingClient: number; waitingInternal: number } };
  totals: { queue: { open: number; waitingClient: number; waitingInternal: number } };
}

async function relatorio(app: FastifyInstance, filtro = ""): Promise<Relatorio> {
  const resposta = await pedir(app, `/reports/agents?from=${DESDE}&to=${ATE}${filtro}`);
  expect(resposta.statusCode).toBe(200);
  return resposta.json() as Relatorio;
}

async function painel(app: FastifyInstance, query: string): Promise<number> {
  const resposta = await pedir(app, `/conversations?limit=25&offset=0&${query}`);
  expect(resposta.statusCode).toBe(200);
  return (resposta.json() as { total: number }).total;
}

describe("o número da célula é a quantidade que o painel lista", () => {
  it("confere as cinco células do cenário, uma a uma", async () => {
    const app = await buildApp();
    const dados = await relatorio(app);
    const ana = dados.rows.find((linha) => linha.user.id === ANA);
    const bruno = dados.rows.find((linha) => linha.user.id === BRUNO);
    expect(ana).toBeDefined();
    expect(bruno).toBeDefined();

    // 1. Ana, Aberto
    expect(ana?.queue.open).toBe(3);
    expect(
      await painel(app, `status=open&assignment=${encodeURIComponent(userAssignmentToken(ANA))}`),
    ).toBe(3);

    // 2. Ana, AG. Cliente
    expect(ana?.queue.waitingClient).toBe(2);
    expect(
      await painel(
        app,
        `status=waiting_client&assignment=${encodeURIComponent(userAssignmentToken(ANA))}`,
      ),
    ).toBe(2);

    // 3. Sem responsável, Aberto
    expect(dados.unassigned.queue.open).toBe(4);
    expect(await painel(app, `status=open&assignment=${ASSIGNMENT_UNASSIGNED}`)).toBe(4);

    // 4. @todos, Aberto
    expect(dados.allUsers.queue.open).toBe(2);
    expect(await painel(app, `status=open&assignment=${ASSIGNMENT_ALL_USERS}`)).toBe(2);

    // 5. Ana, Concluídas no período (uma delas já reaberta e com o Bruno)
    expect(ana?.conversationsResolved).toBe(2);
    expect(await painel(app, `resolvedBy=${ANA}&resolvedFrom=${DESDE}&resolvedTo=${ATE}`)).toBe(2);

    // 6. Bruno, Aberto — a sexta, de brinde, porque é a linha que prova que
    //    a conversa reaberta ficou com ele e mesmo assim conta para a Ana
    //    na coluna de concluídas.
    expect(bruno?.queue.open).toBe(3);
    expect(
      await painel(app, `status=open&assignment=${encodeURIComponent(userAssignmentToken(BRUNO))}`),
    ).toBe(3);

    await app.close();
  });

  it("o total do cabeçalho fecha com a soma da coluna, linha sem dono incluída", async () => {
    const app = await buildApp();
    const dados = await relatorio(app);
    const somaVisivel = (campo: "open" | "waitingClient" | "waitingInternal"): number =>
      dados.rows.reduce((soma, linha) => soma + linha.queue[campo], 0) +
      dados.unassigned.queue[campo] +
      dados.allUsers.queue[campo];
    expect(dados.totals.queue.open).toBe(somaVisivel("open"));
    expect(dados.totals.queue.waitingClient).toBe(somaVisivel("waitingClient"));
    expect(dados.totals.queue.waitingInternal).toBe(somaVisivel("waitingInternal"));
    // E o total de "Aberto" é tudo que a coluna mostra: Ana 3, Bruno 3,
    // Clara 4, sem responsável 4 e coletivo 2.
    expect(dados.totals.queue.open).toBe(16);
    await app.close();
  });

  it("arquivada e número fora do alcance ficam de fora dos DOIS lados", async () => {
    const app = await buildApp();
    const dados = await relatorio(app);
    const ana = dados.rows.find((linha) => linha.user.id === ANA);
    // A base tem 3 abertas visíveis da Ana + 1 arquivada + 1 em número que a
    // supervisora não enxerga. Nenhuma das duas últimas pode aparecer.
    expect(ana?.queue.open).toBe(3);
    expect(
      await painel(app, `status=open&assignment=${encodeURIComponent(userAssignmentToken(ANA))}`),
    ).toBe(3);
    await app.close();
  });

  it("o painel pagina sem perder o total: página 1 traz 2, e o total continua 4", async () => {
    const app = await buildApp();
    const resposta = await pedir(
      app,
      `/conversations?limit=2&offset=0&status=open&assignment=${ASSIGNMENT_UNASSIGNED}`,
    );
    const pagina = resposta.json() as { conversations: unknown[]; total: number };
    expect(pagina.conversations).toHaveLength(2);
    expect(pagina.total).toBe(4);

    const segunda = await pedir(
      app,
      `/conversations?limit=2&offset=2&status=open&assignment=${ASSIGNMENT_UNASSIGNED}`,
    );
    const resto = segunda.json() as { conversations: unknown[]; total: number };
    expect(resto.conversations).toHaveLength(2);
    expect(resto.total).toBe(4);
    await app.close();
  });

  it("concluída fora do período não entra na célula nem no painel", async () => {
    const app = await buildApp();
    const curto = await pedir(
      app,
      `/reports/agents?from=2026-08-20T00:00:00.000Z&to=2026-08-31T23:59:59.000Z`,
    );
    const dados = curto.json() as Relatorio;
    const ana = dados.rows.find((linha) => linha.user.id === ANA);
    expect(ana?.conversationsResolved ?? 0).toBe(0);
    expect(
      await painel(
        app,
        `resolvedBy=${ANA}&resolvedFrom=2026-08-20T00:00:00.000Z&resolvedTo=2026-08-31T23:59:59.000Z`,
      ),
    ).toBe(0);
    await app.close();
  });
});

describe("com os filtros da barra ligados, a célula continua batendo com o painel", () => {
  it("filtrar um departamento recorta a tabela e o painel do mesmo jeito", async () => {
    const app = await buildApp();

    // Sem filtro: Ana tem 3 abertas (no primeiro departamento) e Clara 4 (no
    // segundo).
    const inteiro = await relatorio(app);
    expect(inteiro.rows.find((linha) => linha.user.id === ANA)?.queue.open).toBe(3);
    expect(inteiro.rows.find((linha) => linha.user.id === CLARA)?.queue.open).toBe(4);

    // Filtrando o primeiro departamento, a Clara zera e some da tabela, e a
    // Ana continua com as 3 dela.
    const so1 = await relatorio(app, `&departmentId=${DEPTO}`);
    expect(so1.rows.find((linha) => linha.user.id === ANA)?.queue.open).toBe(3);
    expect(so1.rows.find((linha) => linha.user.id === CLARA)).toBeUndefined();
    expect(
      await painel(
        app,
        `status=open&assignment=${encodeURIComponent(userAssignmentToken(ANA))}&departmentId=${DEPTO}`,
      ),
    ).toBe(3);

    // Filtrando o segundo, o inverso — e o painel acompanha os dois.
    const so2 = await relatorio(app, `&departmentId=${DEPTO_2}`);
    expect(so2.rows.find((linha) => linha.user.id === ANA)).toBeUndefined();
    expect(so2.rows.find((linha) => linha.user.id === CLARA)?.queue.open).toBe(4);
    expect(
      await painel(
        app,
        `status=open&assignment=${encodeURIComponent(userAssignmentToken(CLARA))}&departmentId=${DEPTO_2}`,
      ),
    ).toBe(4);

    await app.close();
  });

  it("os dois departamentos marcados SOMAM entre si", async () => {
    const app = await buildApp();
    const dados = await relatorio(app, `&departmentId=${DEPTO}&departmentId=${DEPTO_2}`);
    expect(dados.rows.find((linha) => linha.user.id === ANA)?.queue.open).toBe(3);
    expect(dados.rows.find((linha) => linha.user.id === CLARA)?.queue.open).toBe(4);
    await app.close();
  });

  it("departamento e conexão CRUZAM: chip certo com departamento errado zera", async () => {
    const app = await buildApp();
    // A Clara só tem conversa no segundo departamento; pedir o chip dela
    // junto do PRIMEIRO departamento devolve zero, e está certo.
    const dados = await relatorio(app, `&instanceId=${INSTANCIA}&departmentId=${DEPTO}`);
    expect(dados.rows.find((linha) => linha.user.id === CLARA)).toBeUndefined();
    expect(dados.rows.find((linha) => linha.user.id === ANA)?.queue.open).toBe(3);
    expect(
      await painel(
        app,
        `status=open&assignment=${encodeURIComponent(userAssignmentToken(CLARA))}&instanceId=${INSTANCIA}&departmentId=${DEPTO}`,
      ),
    ).toBe(0);
    await app.close();
  });

  it("o total do cabeçalho continua fechando com a coluna, agora filtrada", async () => {
    const app = await buildApp();
    const dados = await relatorio(app, `&departmentId=${DEPTO_2}`);
    const soma =
      dados.rows.reduce((total, linha) => total + linha.queue.open, 0) +
      dados.unassigned.queue.open +
      dados.allUsers.queue.open;
    expect(dados.totals.queue.open).toBe(soma);
    // Só as 4 da Clara vivem no segundo departamento.
    expect(dados.totals.queue.open).toBe(4);
    await app.close();
  });
});

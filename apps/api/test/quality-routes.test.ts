import { beforeEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance, type InjectOptions } from "fastify";
import jwt from "@fastify/jwt";
import pino from "pino";
import { registerErrorHandler } from "../src/lib/errors.js";
import type { AuthTokenPayload } from "../src/lib/auth.js";
import { foldQualityAgents, qualityRoutes } from "../src/modules/quality/routes.js";
import type { AppDeps } from "../src/types.js";
import { MemoryPrisma } from "./helpers/memory-prisma.js";

/**
 * SIGILO DO QUALITY — o que estes casos trancam:
 *   1. para quem não é administrador, TODA rota do módulo responde como se ele
 *      não existisse (404, nunca 403: "sem permissão" confirmaria o recurso);
 *   2. o disparo respeita o teto de conversas configurado;
 *   3. sem IA configurada o módulo fica desligado, e disparar é recusado sem
 *      quebrar nada;
 *   4. descartar uma avaliação não mexe na nota, que é da IA;
 *   5. a auditoria registra quem disparou, sobre quais conversas e quando.
 */

const ORG = "org-1";
const CONVERSATION = "11111111-1111-4111-8111-111111111111";
const ANA = "22222222-2222-4222-8222-222222222222";

const ADMIN: AuthTokenPayload = { sub: "admin-1", organizationId: ORG, role: "admin", name: "Admin", email: "a@x" };
const SUPERVISOR: AuthTokenPayload = { sub: "sup-1", organizationId: ORG, role: "supervisor", name: "Sup", email: "s@x" };
const AGENT: AuthTokenPayload = { sub: "ag-1", organizationId: ORG, role: "agent", name: "Ag", email: "g@x" };

const auditoria: Array<{ action: string; metadata?: Record<string, unknown> }> = [];
/** Salas em que o módulo emitiu, para provar que o socket foi alcançado. */
const emissoes: string[] = [];

async function buildApp(db: MemoryPrisma): Promise<{ app: FastifyInstance; token: (user: AuthTokenPayload) => string }> {
  const app = Fastify();
  await app.register(jwt, { secret: "segredo-de-teste-com-tamanho-suficiente" });
  app.decorate("verifySession", async (payload: AuthTokenPayload) => payload);
  registerErrorHandler(app);
  const deps = {
    prisma: db.client(),
    logger: pino({ level: "silent" }),
    audit: { record: (entry: { action: string; metadata?: Record<string, unknown> }) => auditoria.push(entry) },
    // `io` NÃO entra aqui de propósito: em produção ele só existe depois de
    // buildApp (o Socket.IO precisa do servidor HTTP), e é exatamente essa
    // ordem que fazia o analisador nascer com undefined. O teste reproduz o
    // boot real; montá-lo já pronto esconderia a falha, que foi o que
    // aconteceu na primeira entrega.
    storage: { read: async () => Buffer.from("") },
    aiCipher: { encrypt: (v: string) => v, decrypt: (v: string) => v },
  } as unknown as AppDeps;
  await qualityRoutes(app, deps);
  deps.io = {
    to: (room: string) => {
      emissoes.push(room);
      return { emit: () => undefined };
    },
  } as unknown as AppDeps["io"];
  await app.ready();
  return { app, token: (user) => app.jwt.sign(user) };
}

function seed(db: MemoryPrisma, options: { comIa?: boolean } = {}) {
  db.seed("organization", { id: ORG, name: "Azevedo" });
  db.seed("user", { id: ANA, organizationId: ORG, name: "Ana", role: "agent", status: "active" });
  db.seed("conversation", {
    id: CONVERSATION,
    organizationId: ORG,
    type: "individual",
    status: "open",
    externalChatId: "5511999990000@s.whatsapp.net",
    title: "Cliente teste",
    customTitle: null,
  });
  if (options.comIa !== false) {
    db.seed("aiProviderConfig", {
      organizationId: ORG,
      provider: "openai",
      apiKeyEncrypted: "cifrado",
      defaultModel: "gpt-4.1-mini",
    });
  }
}

describe("rotas do Quality", () => {
  let db: MemoryPrisma;
  let app: FastifyInstance;
  let token: (user: AuthTokenPayload) => string;

  beforeEach(async () => {
    db = new MemoryPrisma();
    auditoria.length = 0;
    emissoes.length = 0;
    seed(db);
    ({ app, token } = await buildApp(db));
  });

  async function chamar(
    user: AuthTokenPayload,
    method: "GET" | "POST" | "PUT",
    url: string,
    payload?: unknown,
  ): Promise<Awaited<ReturnType<FastifyInstance["inject"]>>> {
    const options: InjectOptions = {
      method,
      url,
      headers: { authorization: `Bearer ${token(user)}` },
    };
    if (payload !== undefined) options.payload = payload as InjectOptions["payload"];
    return app.inject(options);
  }

  it("responde como se o módulo não existisse para supervisor e para usuário", async () => {
    const rotas: Array<[("GET" | "POST"), string]> = [
      ["GET", "/quality/availability"],
      ["GET", "/quality/settings"],
      ["GET", "/quality/runs"],
      ["GET", "/quality/evaluations"],
      ["GET", "/quality/agents"],
      ["POST", "/quality/runs"],
    ];
    for (const user of [SUPERVISOR, AGENT]) {
      for (const [method, url] of rotas) {
        const response = await chamar(user, method, url, method === "POST" ? {} : undefined);
        expect(response.statusCode, `${user.role} ${method} ${url}`).toBe(404);
        // 404 de recurso inexistente, e nunca "sem permissão": a mensagem não
        // pode revelar que existe um módulo de avaliação.
        expect(response.json().error).toBe("not_found");
        expect(JSON.stringify(response.json())).not.toContain("permiss");
      }
    }
  });

  it("o administrador enxerga o módulo disponível quando a IA está configurada", async () => {
    const response = await chamar(ADMIN, "GET", "/quality/availability");
    expect(response.statusCode).toBe(200);
    expect(response.json().availability.enabled).toBe(true);
  });

  it("sem IA configurada o módulo fica desligado e o disparo é recusado sem quebrar nada", async () => {
    const semIa = new MemoryPrisma();
    seed(semIa, { comIa: false });
    const isolado = await buildApp(semIa);
    const disponibilidade = await isolado.app.inject({
      method: "GET",
      url: "/quality/availability",
      headers: { authorization: `Bearer ${isolado.token(ADMIN)}` },
    });
    expect(disponibilidade.json().availability.enabled).toBe(false);

    const disparo = await isolado.app.inject({
      method: "POST",
      url: "/quality/runs",
      headers: { authorization: `Bearer ${isolado.token(ADMIN)}` },
      payload: { conversationIds: [CONVERSATION], from: "2026-09-01T00:00:00Z", to: "2026-09-02T00:00:00Z" },
    });
    expect(disparo.statusCode).toBe(409);
    expect(disparo.json().error).toBe("quality_disabled");
  });

  it("recusa o disparo acima do teto de conversas, dizendo o número", async () => {
    await chamar(ADMIN, "PUT", "/quality/settings", {
      maxConversationsPerRun: 2,
      maxAudioSeconds: 600,
      minCoveragePercent: 60,
      model: null,
    });
    const ids = [
      "11111111-1111-4111-8111-111111111111",
      "33333333-3333-4333-8333-333333333333",
      "44444444-4444-4444-8444-444444444444",
    ];
    const response = await chamar(ADMIN, "POST", "/quality/runs", {
      conversationIds: ids,
      from: "2026-09-01T00:00:00Z",
      to: "2026-09-02T00:00:00Z",
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toBe("quality_run_limit");
    expect(response.json().message).toContain("2");
  });

  it("audita quem disparou, sobre quais conversas e quando", async () => {
    // A análise em si roda em segundo plano; aqui interessa o registro.
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const response = await chamar(ADMIN, "POST", "/quality/runs", {
      conversationIds: [CONVERSATION],
      from: "2026-09-01T00:00:00Z",
      to: "2026-09-02T00:00:00Z",
    });
    expect(response.statusCode).toBe(200);
    const registro = auditoria.find((entry) => entry.action === "quality.analysis_requested");
    expect(registro).toBeDefined();
    expect(registro?.metadata?.conversationIds).toEqual([CONVERSATION]);
    expect(registro?.metadata?.periodFrom).toBe("2026-09-01T00:00:00.000Z");
  });

  it("o disparo alcança o socket, que só nasce depois das rotas", async () => {
    // REGRESSÃO (produção, 23/09/2026): o analisador copiava `deps.io` no
    // REGISTRO das rotas, quando ele ainda é undefined, e todo disparo morria
    // no primeiro aviso de tela com "Cannot read properties of undefined
    // (reading 'to')". Na tela isso virava o motivo genérico "Erro inesperado
    // durante a análise", sem nenhuma pista de causa para quem administra.
    //
    // O que prende a regra são as duas asserções juntas: houve emissão para a
    // sala da organização (o socket foi alcançado de verdade) e o disparo não
    // terminou no motivo genérico. Sem a primeira, um disparo que falhasse
    // cedo por outro motivo passaria; sem a segunda, o `unexpected` voltaria
    // sem ninguém notar.
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const response = await chamar(ADMIN, "POST", "/quality/runs", {
      conversationIds: [CONVERSATION],
      from: "2026-09-01T00:00:00Z",
      to: "2026-09-02T00:00:00Z",
    });
    expect(response.statusCode).toBe(200);
    const runId = response.json().run.id as string;

    // A análise roda em segundo plano (a rota já respondeu): espera ela parar.
    await vi.waitFor(async () => {
      const run = await db.client().qualityRun.findUnique({ where: { id: runId } });
      expect(["completed", "failed"]).toContain(run?.status);
    });

    expect(emissoes).toContain(`org:${ORG}`);
    const run = await db.client().qualityRun.findUnique({ where: { id: runId } });
    expect(run?.failureReason).not.toBe("unexpected");
  });

  it("a lista de análises leva o nome da conversa, pela mesma cadeia da Inbox", async () => {
    // O escritório tem quatro grupos "Demandas CS - <cliente>", um por
    // departamento: sem o nome na linha, as análises deles são indistinguíveis.
    // E o nome tem de ser o EFETIVO — quem corrigiu um cliente pelo lápis
    // espera vê-lo corrigido aqui também, não o pushName antigo do WhatsApp.
    const run = db.seed("qualityRun", {
      organizationId: ORG,
      periodFrom: new Date("2026-09-01T00:00:00Z"),
      periodTo: new Date("2026-09-02T00:00:00Z"),
      requestedById: ADMIN.sub,
      requestedByName: "Admin",
      model: "gpt-4.1-mini",
      conversationCount: 1,
      status: "completed",
    });
    db.seed("qualityRunItem", {
      organizationId: ORG,
      runId: run.id as string,
      conversationId: CONVERSATION,
      status: "completed",
    });

    const semPerfil = await chamar(ADMIN, "GET", "/quality/runs");
    expect(semPerfil.statusCode).toBe(200);
    const linha = semPerfil.json().runs.find((item: { id: string }) => item.id === run.id);
    expect(linha.conversationTitles).toEqual(["Cliente teste"]);

    // Com o nome da PESSOA gravado, ele vence o título que veio do WhatsApp.
    db.seed("personProfile", {
      organizationId: ORG,
      externalId: "5511999990000@s.whatsapp.net",
      customName: "Kosa Contabilidade",
      phoneNumber: null,
      clientRole: null,
    });
    const comPerfil = await chamar(ADMIN, "GET", "/quality/runs");
    const corrigida = comPerfil.json().runs.find((item: { id: string }) => item.id === run.id);
    expect(corrigida.conversationTitles).toEqual(["Kosa Contabilidade"]);
  });

  it("descartar uma avaliação não altera a nota, que é da IA", async () => {
    const run = db.seed("qualityRun", {
      organizationId: ORG,
      periodFrom: new Date("2026-09-01T00:00:00Z"),
      periodTo: new Date("2026-09-02T00:00:00Z"),
      requestedById: ADMIN.sub,
      requestedByName: "Admin",
      model: "gpt-4.1-mini",
      conversationCount: 1,
    });
    const item = db.seed("qualityRunItem", {
      organizationId: ORG,
      runId: run.id as string,
      conversationId: CONVERSATION,
      status: "completed",
    });
    const evaluation = db.seed("qualityEvaluation", {
      organizationId: ORG,
      runId: run.id as string,
      itemId: item.id as string,
      conversationId: CONVERSATION,
      userId: ANA,
      userName: "Ana",
      overallScore: 7.5,
      criteria: [{ key: "cordiality", score: 8, justification: "x", messageIds: [] }],
      subject: "fiscal",
      actionPlan: { improvements: [], strengths: [] },
      confidence: "high",
      conversationOutcome: "resolved",
    });

    const descarte = await chamar(ADMIN, "POST", `/quality/evaluations/${evaluation.id}/discard`, {
      comment: "Cliente já era difícil antes desta conversa.",
    });
    expect(descarte.statusCode).toBe(200);
    expect(descarte.json().evaluation.overallScore).toBe(7.5);
    expect(descarte.json().evaluation.adminComment).toContain("difícil");
    expect(descarte.json().evaluation.discardedAt).not.toBeNull();

    // Descartada sai da lista por padrão, e volta com o filtro.
    const semDescartadas = await chamar(ADMIN, "GET", "/quality/evaluations");
    expect(semDescartadas.json().evaluations).toHaveLength(0);
    const comDescartadas = await chamar(ADMIN, "GET", "/quality/evaluations?includeDiscarded=true");
    expect(comDescartadas.json().evaluations).toHaveLength(1);
    expect(comDescartadas.json().evaluations[0].overallScore).toBe(7.5);
  });
});

describe("visão por atendente", () => {
  it("agrupa por pessoa, tira a média e ordena os pontos repetidos", () => {
    const base = {
      runId: "r1",
      itemId: "i1",
      conversationId: CONVERSATION,
      conversationTitle: "Cliente",
      criteria: [
        { key: "cordiality" as const, score: 8, justification: "x", messageIds: [] },
        { key: "clarity" as const, score: 6, justification: "x", messageIds: [] },
      ],
      subject: "fiscal" as const,
      confidence: "high" as const,
      coveragePercent: 100,
      partial: false,
      metrics: {
        firstResponseMinutes: 5,
        avgResponseMinutes: 5,
        responsesMeasured: 1,
        limitBreaches: 0,
        messagesSent: 2,
        outcome: "resolved" as const,
      },
      discardedAt: null,
      adminComment: null,
    };
    const agents = foldQualityAgents([
      {
        ...base,
        id: "e1",
        userId: ANA,
        userName: "Ana",
        overallScore: 8,
        actionPlan: { improvements: [{ point: "Confirmar prazo", action: "diga a data" }], strengths: ["Cordial"] },
        // Período de AGOSTO, analisado só em setembro: é o período que manda.
        periodFrom: "2026-08-01T00:00:00.000Z",
        periodTo: "2026-08-31T23:59:59.000Z",
        createdAt: "2026-09-20T12:00:00.000Z",
      },
      {
        ...base,
        id: "e2",
        userId: ANA,
        userName: "Ana",
        overallScore: 6,
        actionPlan: { improvements: [{ point: "confirmar prazo.", action: "diga a data" }], strengths: [] },
        periodFrom: "2026-09-01T00:00:00.000Z",
        periodTo: "2026-09-30T23:59:59.000Z",
        createdAt: "2026-09-20T12:00:00.000Z",
      },
    ]);

    expect(agents).toHaveLength(1);
    expect(agents[0]?.evaluations).toBe(2);
    expect(agents[0]?.averageScore).toBe(7);
    // "Confirmar prazo" e "confirmar prazo." são o mesmo ponto.
    expect(agents[0]?.recurringImprovements[0]).toEqual({ point: "confirmar prazo", total: 2 });
    // As duas foram analisadas no MESMO dia (20/09), e mesmo assim a linha do
    // tempo tem dois meses: ela segue o período avaliado, não a data da análise.
    expect(agents[0]?.timeline.map((point) => point.month)).toEqual(["2026-08", "2026-09"]);
    expect(agents[0]?.averageByCriterion.find((c) => c.key === "clarity")?.score).toBe(6);
  });
});

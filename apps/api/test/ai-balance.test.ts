import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import jwt from "@fastify/jwt";
import pino from "pino";
import { aiSpendUseOf, computeAiBalance, type AiBalanceDto } from "@azvchat/shared";
import { registerErrorHandler } from "../src/lib/errors.js";
import { createSecretCipher } from "../src/lib/ai-secrets.js";
import type { AuthTokenPayload } from "../src/lib/auth.js";
import { aiRoutes } from "../src/modules/ai/routes.js";
import type { AppDeps } from "../src/types.js";
import { MemoryPrisma } from "./helpers/memory-prisma.js";

/**
 * O saldo estimado da IA:
 *   1. a conta parte do ÚLTIMO saldo informado, e o que veio antes dele já
 *      está dentro do valor lido na OpenAI;
 *   2. o consumo desconta de TODOS os usos (atendimento, fluxo, Quality,
 *      transcrição, imagem), e o `chat` do bloco de fluxo aparece separado;
 *   3. lançar e excluir é só do admin; ver é da chave de consumo.
 */

const ORG = "org-1";
const DAY = 24 * 60 * 60 * 1000;
const ADMIN: AuthTokenPayload = { sub: "admin-1", organizationId: ORG, role: "admin", name: "Admin", email: "a@x" };
const SUPERVISOR: AuthTokenPayload = { sub: "sup-1", organizationId: ORG, role: "supervisor", name: "Sup", email: "s@x" };
const AGENT: AuthTokenPayload = { sub: "agent-1", organizationId: ORG, role: "agent", name: "Ag", email: "g@x" };

describe("computeAiBalance", () => {
  const at = (day: number) => new Date(Date.UTC(2026, 8, day, 12));

  it("sem lançamento não há saldo a estimar", () => {
    expect(computeAiBalance([])).toEqual({ since: null, creditedMicros: 0 });
  });

  it("só recargas: parte da primeira, somando todas", () => {
    const result = computeAiBalance([
      { kind: "top_up", amountCents: 1000, effectiveAt: at(10), createdAt: at(10) },
      { kind: "top_up", amountCents: 500, effectiveAt: at(5), createdAt: at(5) },
    ]);
    expect(result.since).toEqual(at(5));
    expect(result.creditedMicros).toBe(15_000_000);
  });

  it("o saldo informado recomeça a conta: o que veio antes dele não soma de novo", () => {
    const result = computeAiBalance([
      { kind: "top_up", amountCents: 5000, effectiveAt: at(1), createdAt: at(1) },
      { kind: "balance", amountCents: 3720, effectiveAt: at(10), createdAt: at(10) },
      { kind: "top_up", amountCents: 2000, effectiveAt: at(15), createdAt: at(15) },
    ]);
    expect(result.since).toEqual(at(10));
    expect(result.creditedMicros).toBe(57_200_000);
  });

  it("chat de fluxo e de automação de IA são usos diferentes", () => {
    expect(aiSpendUseOf("chat", true)).toBe("flows");
    expect(aiSpendUseOf("chat", false)).toBe("attendance");
    expect(aiSpendUseOf("quality", false)).toBe("quality");
    expect(aiSpendUseOf("models", false)).toBe("other");
  });
});

describe("rotas do saldo da IA", () => {
  let db: MemoryPrisma;
  let app: FastifyInstance;
  let token: (user: AuthTokenPayload) => string;

  beforeEach(async () => {
    db = new MemoryPrisma();
    db.seed("organization", { id: ORG, name: "Azevedo" });
    db.seed("user", { id: ADMIN.sub, organizationId: ORG, name: "Admin", role: "admin" });
    app = Fastify();
    await app.register(jwt, { secret: "segredo-de-teste-com-tamanho-suficiente" });
    app.decorate("verifySession", async (payload: AuthTokenPayload) => payload);
    registerErrorHandler(app);
    const deps = {
      prisma: db.client(),
      logger: pino({ level: "silent" }),
      audit: { record: () => undefined },
      aiCipher: createSecretCipher({ aiSecretsKey: "d".repeat(64), jwtSecret: "x".repeat(32) }),
      io: { to: () => ({ emit: () => undefined }) },
    } as unknown as AppDeps;
    await aiRoutes(app, deps);
    await app.ready();
    token = (user) => app.jwt.sign(user);
  });
  afterEach(async () => {
    await app.close();
  });

  function usage(kind: string, costMicros: number | null, extra: Record<string, unknown> = {}) {
    db.seed("aiUsageLog", {
      organizationId: ORG,
      provider: "openai",
      model: "gpt-4.1-mini",
      kind,
      outcome: "ok",
      inputTokens: 100,
      outputTokens: 50,
      costMicros,
      errorCode: null,
      sessionId: null,
      ...extra,
    });
  }

  it("desconta o consumo de todos os usos desde o saldo informado", async () => {
    const auth = { authorization: `Bearer ${token(ADMIN)}` };
    const informed = new Date(Date.now() - 2 * DAY);
    // Consumo ANTES do saldo informado já está dentro do valor lido na OpenAI.
    usage("chat", 9_000_000, { createdAt: new Date(Date.now() - 5 * DAY) });

    const created = await app.inject({
      method: "POST",
      url: "/ai/credit-entries",
      headers: auth,
      payload: { kind: "balance", amountCents: 5000, effectiveAt: informed.toISOString() },
    });
    expect(created.statusCode).toBe(201);

    const flowSession = db.seed("aiSession", { organizationId: ORG, conversationId: "c-1", agentId: "a-1", status: "ended", automationExecutionId: "exec-1" });
    const plainSession = db.seed("aiSession", { organizationId: ORG, conversationId: "c-2", agentId: "a-1", status: "ended", automationExecutionId: null });
    usage("chat", 1_000_000, { sessionId: plainSession.id });
    usage("chat", 2_000_000, { sessionId: flowSession.id });
    usage("quality", 3_000_000);
    usage("transcription", 500_000);
    usage("vision", null);

    const response = await app.inject({ method: "GET", url: "/ai/balance", headers: auth });
    expect(response.statusCode).toBe(200);
    const { balance } = response.json() as { balance: AiBalanceDto };
    expect(balance.configured).toBe(true);
    expect(balance.creditedMicros).toBe(50_000_000);
    expect(balance.spentMicros).toBe(6_500_000);
    expect(balance.balanceMicros).toBe(43_500_000);
    expect(balance.unpricedRequests).toBe(1);
    const byUse = Object.fromEntries(balance.byUse.map((row) => [row.use, row.costMicros]));
    expect(byUse).toMatchObject({ attendance: 1_000_000, flows: 2_000_000, quality: 3_000_000, transcription: 500_000 });
  });

  it("recusa por falta de crédito e aviso de saldo baixo aparecem no saldo", async () => {
    const auth = { authorization: `Bearer ${token(ADMIN)}` };
    await app.inject({ method: "POST", url: "/ai/credit-entries", headers: auth, payload: { kind: "top_up", amountCents: 1000 } });
    usage("chat", 8_000_000);
    usage("chat", null, { outcome: "error", errorCode: "insufficient_quota" });
    const alert = await app.inject({ method: "PUT", url: "/ai/balance/alert", headers: auth, payload: { lowBalanceAlertCents: 500 } });
    expect(alert.statusCode).toBe(200);
    const { balance } = alert.json() as { balance: AiBalanceDto };
    expect(balance.balanceMicros).toBe(2_000_000);
    expect(balance.low).toBe(true);
    expect(balance.lastQuotaErrorAt).not.toBeNull();
  });

  it("recusa data no futuro e recarga zerada", async () => {
    const auth = { authorization: `Bearer ${token(ADMIN)}` };
    const future = await app.inject({
      method: "POST",
      url: "/ai/credit-entries",
      headers: auth,
      payload: { kind: "balance", amountCents: 100, effectiveAt: new Date(Date.now() + DAY).toISOString() },
    });
    expect(future.statusCode).toBe(400);
    const empty = await app.inject({ method: "POST", url: "/ai/credit-entries", headers: auth, payload: { kind: "top_up", amountCents: 0 } });
    expect(empty.statusCode).toBe(400);
  });

  it("lançar e excluir é só do admin; ver segue a chave de consumo", async () => {
    const sup = { authorization: `Bearer ${token(SUPERVISOR)}` };
    const post = await app.inject({ method: "POST", url: "/ai/credit-entries", headers: sup, payload: { kind: "top_up", amountCents: 1000 } });
    expect(post.statusCode).toBe(403);
    const alert = await app.inject({ method: "PUT", url: "/ai/balance/alert", headers: sup, payload: { lowBalanceAlertCents: 100 } });
    expect(alert.statusCode).toBe(403);
    const agentView = await app.inject({ method: "GET", url: "/ai/balance", headers: { authorization: `Bearer ${token(AGENT)}` } });
    expect(agentView.statusCode).toBe(403);

    const admin = { authorization: `Bearer ${token(ADMIN)}` };
    const created = await app.inject({ method: "POST", url: "/ai/credit-entries", headers: admin, payload: { kind: "top_up", amountCents: 1000, note: "Recarga setembro" } });
    const entryId = (created.json() as { balance: AiBalanceDto }).balance.entries[0]?.id;
    expect(entryId).toBeTruthy();
    const deleted = await app.inject({ method: "DELETE", url: `/ai/credit-entries/${entryId}`, headers: admin });
    expect(deleted.statusCode).toBe(200);
    expect((deleted.json() as { balance: AiBalanceDto }).balance.configured).toBe(false);
  });
});

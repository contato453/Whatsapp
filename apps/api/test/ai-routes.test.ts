import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import jwt from "@fastify/jwt";
import pino from "pino";
import { defaultAiAgentConfig } from "@azvchat/shared";
import { registerErrorHandler } from "../src/lib/errors.js";
import { createSecretCipher } from "../src/lib/ai-secrets.js";
import type { AuthTokenPayload } from "../src/lib/auth.js";
import { aiRoutes } from "../src/modules/ai/routes.js";
import type { AppDeps } from "../src/types.js";
import { MemoryPrisma } from "./helpers/memory-prisma.js";

/**
 * O que estes casos fixam nas rotas de IA:
 *   1. a chave do provedor entra, é gravada CIFRADA e volta só como hint —
 *      nunca em claro, em nenhuma resposta;
 *   2. provedor, orçamento e configurações gerais são só do admin;
 *   3. supervisor cria agente (chave `ai.agent.manage`) e atendente não;
 *   4. ativar agente sem objetivo é recusado.
 */

const ORG = "org-1";
const DEP = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CIPHER = createSecretCipher({ aiSecretsKey: "d".repeat(64), jwtSecret: "x".repeat(32) });

const ADMIN: AuthTokenPayload = { sub: "admin-1", organizationId: ORG, role: "admin", name: "Admin", email: "a@x" };
const SUPERVISOR: AuthTokenPayload = { sub: "sup-1", organizationId: ORG, role: "supervisor", name: "Sup", email: "s@x" };
const AGENT: AuthTokenPayload = { sub: "agent-1", organizationId: ORG, role: "agent", name: "Ag", email: "g@x" };

async function buildApp(db: MemoryPrisma): Promise<{ app: FastifyInstance; token: (user: AuthTokenPayload) => string }> {
  const app = Fastify();
  await app.register(jwt, { secret: "segredo-de-teste-com-tamanho-suficiente" });
  app.decorate("verifySession", async (payload: AuthTokenPayload) => payload);
  registerErrorHandler(app);
  const deps = {
    prisma: db.client(),
    logger: pino({ level: "silent" }),
    audit: { record: () => undefined },
    aiCipher: CIPHER,
    aiRuntime: { runTest: async () => ({ reply: "ok", state: {}, ended: null, debug: null }), resumeSession: async () => ({ ok: true }) },
    io: { to: () => ({ emit: () => undefined }) },
  } as unknown as AppDeps;
  await aiRoutes(app, deps);
  await app.ready();
  return { app, token: (user) => app.jwt.sign(user) };
}

function seedBase(db: MemoryPrisma) {
  db.seed("organization", { id: ORG, name: "Azevedo" });
  db.seed("department", { id: DEP, organizationId: ORG, name: "Comercial", color: null, isInternal: false, defaultAssigneeId: null });
  db.seed("userDepartment", { userId: SUPERVISOR.sub, departmentId: DEP });
  db.seed("userDepartment", { userId: AGENT.sub, departmentId: DEP });
}

describe("rotas de IA", () => {
  let db: MemoryPrisma;
  let app: FastifyInstance;
  let token: (user: AuthTokenPayload) => string;

  beforeEach(async () => {
    db = new MemoryPrisma();
    seedBase(db);
    ({ app, token } = await buildApp(db));
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.endsWith("/models")) return new Response(JSON.stringify({ data: [{ id: "gpt-4.1-mini" }, { id: "whisper-1" }] }), { status: 200 });
        return new Response("{}", { status: 500 });
      }),
    );
  });
  afterEach(async () => {
    await app.close();
    vi.unstubAllGlobals();
  });

  it("a chave entra, é testada, gravada cifrada e só o hint volta", async () => {
    const put = await app.inject({
      method: "PUT",
      url: "/ai/providers/openai",
      headers: { authorization: `Bearer ${token(ADMIN)}` },
      payload: { apiKey: "sk-proj-SEGREDOSEGREDOSEGREDO8F2A", defaultModel: "gpt-4.1-mini" },
    });
    expect(put.statusCode).toBe(200);
    const body = put.json() as { provider: { status: string; apiKeyHint: string }; test: { ok: boolean } };
    expect(body.test.ok).toBe(true);
    expect(body.provider.status).toBe("connected");
    expect(body.provider.apiKeyHint).toBe("sk-••••••••••••8F2A");
    expect(put.body).not.toContain("SEGREDO");

    const stored = db.rows("aiProviderConfig")[0];
    expect(String(stored?.apiKeyEncrypted)).not.toContain("SEGREDO");
    expect(CIPHER.decrypt(String(stored?.apiKeyEncrypted))).toBe("sk-proj-SEGREDOSEGREDOSEGREDO8F2A");

    const get = await app.inject({ method: "GET", url: "/ai/providers", headers: { authorization: `Bearer ${token(ADMIN)}` } });
    expect(get.body).not.toContain("SEGREDO");
    expect(get.body).not.toContain("apiKeyEncrypted");

    const models = await app.inject({ method: "GET", url: "/ai/providers/openai/models", headers: { authorization: `Bearer ${token(ADMIN)}` } });
    const list = (models.json() as { models: Array<{ id: string }>; source: string }).models.map((model) => model.id);
    expect(list).toContain("gpt-4.1-mini");
    expect(list).not.toContain("whisper-1");
  });

  it("chave inválida grava com status de erro e mensagem clara, sem detalhe do provedor", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: { message: "Bearer sk-... invalid" } }), { status: 401 })));
    const put = await app.inject({
      method: "PUT",
      url: "/ai/providers/openai",
      headers: { authorization: `Bearer ${token(ADMIN)}` },
      payload: { apiKey: "sk-errada-1234567890" },
    });
    const body = put.json() as { provider: { status: string }; test: { ok: boolean; message: string } };
    expect(body.test.ok).toBe(false);
    expect(body.provider.status).toBe("error");
    expect(body.test.message).toContain("Chave de API inválida");
    expect(put.body).not.toContain("Bearer sk-");
  });

  it("desconectar apaga a chave", async () => {
    await app.inject({ method: "PUT", url: "/ai/providers/openai", headers: { authorization: `Bearer ${token(ADMIN)}` }, payload: { apiKey: "sk-proj-1234567890abcd" } });
    const res = await app.inject({ method: "POST", url: "/ai/providers/openai/disconnect", headers: { authorization: `Bearer ${token(ADMIN)}` } });
    expect((res.json() as { provider: { status: string; apiKeyHint: string | null } }).provider).toMatchObject({ status: "not_connected", apiKeyHint: null });
    expect(db.rows("aiProviderConfig")[0]?.apiKeyEncrypted).toBeNull();
  });

  it("provedor e orçamento são só do admin — supervisor recebe 403", async () => {
    for (const [method, url] of [
      ["GET", "/ai/providers"],
      ["PUT", "/ai/providers/openai"],
      ["PUT", "/ai/settings"],
    ] as const) {
      const res = await app.inject({ method, url, headers: { authorization: `Bearer ${token(SUPERVISOR)}` }, payload: {} });
      expect(res.statusCode, `${method} ${url}`).toBe(403);
    }
  });

  it("supervisor cria agente no próprio departamento; atendente é recusado pela chave", async () => {
    const payload = {
      name: "IA Comercial",
      description: "Leads",
      isGeneral: false,
      departmentIds: [DEP],
      model: null,
      knowledgeSourceIds: [],
      config: { ...defaultAiAgentConfig(), objective: "Qualificar leads" },
    };
    const created = await app.inject({ method: "POST", url: "/ai/agents", headers: { authorization: `Bearer ${token(SUPERVISOR)}` }, payload });
    expect(created.statusCode, created.body).toBe(201);
    const agent = (created.json() as { agent: { id: string; status: string; version: number; config: { objective: string } } }).agent;
    expect(agent.status).toBe("draft");
    expect(agent.version).toBe(1);
    expect(agent.config.objective).toBe("Qualificar leads");
    expect(db.rows("aiAgentVersion")).toHaveLength(1);

    const denied = await app.inject({ method: "POST", url: "/ai/agents", headers: { authorization: `Bearer ${token(AGENT)}` }, payload: { ...payload, name: "Outra" } });
    expect(denied.statusCode).toBe(403);
    expect((denied.json() as { error: string }).error).toBe("permission_denied");

    // Mudar a configuração cria a versão 2; renomear não.
    const renamed = await app.inject({ method: "PATCH", url: `/ai/agents/${agent.id}`, headers: { authorization: `Bearer ${token(SUPERVISOR)}` }, payload: { ...payload, name: "IA Comercial 2" } });
    expect((renamed.json() as { agent: { version: number } }).agent.version).toBe(1);
    const changed = await app.inject({
      method: "PATCH",
      url: `/ai/agents/${agent.id}`,
      headers: { authorization: `Bearer ${token(SUPERVISOR)}` },
      payload: { ...payload, config: { ...payload.config, objective: "Outro objetivo" } },
    });
    expect((changed.json() as { agent: { version: number } }).agent.version).toBe(2);
    expect(db.rows("aiAgentVersion")).toHaveLength(2);
  });

  it("ativar exige provedor conectado e objetivo preenchido", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/ai/agents",
      headers: { authorization: `Bearer ${token(ADMIN)}` },
      payload: { name: "IA X", isGeneral: true, departmentIds: [], model: null, knowledgeSourceIds: [], config: defaultAiAgentConfig() },
    });
    expect(created.statusCode, created.body).toBe(201);
    const id = (created.json() as { agent: { id: string } }).agent.id;
    const noProvider = await app.inject({ method: "POST", url: `/ai/agents/${id}/status`, headers: { authorization: `Bearer ${token(ADMIN)}` }, payload: { status: "active" } });
    expect(noProvider.statusCode).toBe(409);
    await app.inject({ method: "PUT", url: "/ai/providers/openai", headers: { authorization: `Bearer ${token(ADMIN)}` }, payload: { apiKey: "sk-proj-1234567890abcd" } });
    const noObjective = await app.inject({ method: "POST", url: `/ai/agents/${id}/status`, headers: { authorization: `Bearer ${token(ADMIN)}` }, payload: { status: "active" } });
    expect(noObjective.statusCode).toBe(400);
  });
});

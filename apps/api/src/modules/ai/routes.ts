import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { Prisma } from "@azvchat/database";
import {
  AI_AGENT_STATUSES,
  AI_AUTOMATION_CONVERSATION_TYPES,
  AI_BUDGET_POLICIES,
  AI_KNOWLEDGE_KINDS,
  AI_KNOWLEDGE_MAX_CHARS,
  AI_MODEL_CATALOG,
  AI_PROVIDERS,
  AI_USAGE_KINDS,
  AI_USAGE_OUTCOMES,
  AI_USAGE_PERIODS,
  type AiModelDto,
  type AiSettingsDto,
  type AiStatsDto,
  type AiUsageBucketDto,
  type AiUsageDto,
  type AiUsagePeriod,
  type AiUsageTotalsDto,
} from "@azvchat/shared";
import { accessibleDepartmentIds, departmentResourceScope } from "../../lib/access.js";
import { maskApiKey } from "../../lib/ai-secrets.js";
import { loadAttendanceSettings } from "../../lib/attendance-settings.js";
import { authenticate, requireRole } from "../../lib/auth.js";
import { findAccessibleConversation } from "../../lib/conversation-access.js";
import { assertCanManageResource, auditDepartmentSnapshot, resolveDepartmentTarget } from "../../lib/department-resource.js";
import { AppError, NotFoundError } from "../../lib/errors.js";
import { requireAnyPermission, requirePermission } from "../../lib/permissions.js";
import { serializeUserDirectory } from "../../lib/serialize.js";
import { loadAiSettings, loadBudgetState, monthStart } from "../../services/ai/budget.js";
import { aiAgentConfigSchema, parseStoredAgentConfig } from "../../services/ai/config-schema.js";
import { createAiProvider, resolveCredentials } from "../../services/ai/credentials.js";
import { AiProviderError } from "../../services/ai/provider.js";
import { endAiSession, loadLatestSession, serializeAiSession } from "../../services/ai/session.js";
import { periodRange } from "../dashboard/metrics.js";
import type { AppDeps } from "../../types.js";
import {
  serializeAiAgent,
  serializeAiAgentSummary,
  serializeAiAgentVersion,
  serializeAiAutomation,
  serializeAiKnowledgeSource,
  serializeAiProvider,
  serializeAiUsageLog,
  serializeModels,
} from "./serialize.js";

/**
 * Rotas do módulo de IA.
 *
 * Três níveis, de propósito:
 *   - `requireRole("admin")` para o que é credencial e dinheiro — a chave
 *     do provedor, o orçamento e as configurações gerais. Fixo no código,
 *     como criar usuário e excluir número;
 *   - chave `ai.agent.manage` para agentes, base de conhecimento, automações
 *     e testador; `ai.view_usage` para consumo, indicadores e logs;
 *   - `ai.session.stop` / `ai.session.resume` dentro da conversa.
 * Nada aqui encosta em `access.ts`: quem enxerga a conversa enxerga a faixa
 * de IA dela, e agente/base seguem o recorte de departamento das etiquetas.
 */

const providerParams = z.object({ provider: z.enum(AI_PROVIDERS) });
const idParams = z.object({ id: z.string().uuid() });
const PROVIDER_TEST_TIMEOUT_MS = 15_000;
const MODELS_CACHE_MS = 6 * 60 * 60 * 1000;

const agentLabels = {
  general: "Só o administrador cria agente que vale para todos os departamentos",
  foreign: "Você só pode gravar agentes nos seus departamentos",
  orphan: "Este agente ficou sem departamento; fale com um administrador",
};

export async function aiRoutes(app: FastifyInstance, deps: AppDeps): Promise<void> {
  const { prisma } = deps;

  function providerMessage(err: unknown): string {
    if (err instanceof AiProviderError) return err.message;
    return "Falha na conexão. Verifique sua chave API.";
  }

  // =========================================================================
  // Provedores — admin
  // =========================================================================

  app.get("/ai/providers", { preHandler: requireRole("admin") }, async (request) => {
    const rows = await prisma.aiProviderConfig.findMany({ where: { organizationId: request.user.organizationId } });
    return {
      providers: AI_PROVIDERS.map((kind) =>
        serializeAiProvider(kind, rows.find((row) => row.provider === kind) ?? null),
      ),
      // Avisa o admin quando a cifra está na derivação de reserva.
      dedicatedSecretsKey: deps.aiCipher.dedicatedKey,
    };
  });

  const putProviderSchema = z.object({
    apiKey: z.string().min(10).max(500).optional(),
    defaultModel: z.string().min(1).max(100).optional(),
  });

  /**
   * Conectar/atualizar. Com `apiKey` no corpo, grava cifrada e TESTA na
   * hora: o status só vira "conectado" quando o provedor aceitou. A chave em
   * claro existe só dentro desta requisição.
   */
  app.put("/ai/providers/:provider", { preHandler: requireRole("admin") }, async (request) => {
    const { provider } = providerParams.parse(request.params);
    const body = putProviderSchema.parse(request.body);
    const organizationId = request.user.organizationId;
    if (body.apiKey === undefined && body.defaultModel === undefined) {
      throw new AppError("Nada para atualizar", 400, "empty_update");
    }
    const existing = await prisma.aiProviderConfig.findUnique({
      where: { organizationId_provider: { organizationId, provider } },
    });

    let testResult: { ok: boolean; message: string } | null = null;
    const data: Prisma.AiProviderConfigUncheckedUpdateInput = {};
    if (body.apiKey !== undefined) {
      const apiKey = body.apiKey.trim();
      try {
        await createAiProvider(provider, deps.logger).testConnection(apiKey, PROVIDER_TEST_TIMEOUT_MS);
        testResult = { ok: true, message: "OpenAI conectada com sucesso." };
        data.status = "connected";
        data.lastTestError = null;
      } catch (err) {
        testResult = { ok: false, message: providerMessage(err) };
        data.status = "error";
        data.lastTestError = testResult.message;
      }
      data.apiKeyEncrypted = deps.aiCipher.encrypt(apiKey);
      data.apiKeyHint = maskApiKey(apiKey);
      data.lastTestedAt = new Date();
      // Chave nova pode alcançar modelos diferentes: o cache cai.
      data.modelsCache = Prisma.JsonNull;
      data.modelsFetchedAt = null;
    }
    if (body.defaultModel !== undefined) data.defaultModel = body.defaultModel;

    const saved = existing
      ? await prisma.aiProviderConfig.update({ where: { id: existing.id }, data })
      : await prisma.aiProviderConfig.create({
          data: { ...(data as Omit<Prisma.AiProviderConfigUncheckedCreateInput, "organizationId" | "provider">), organizationId, provider },
        });

    deps.audit.record({
      organizationId,
      userId: request.user.sub,
      action: body.apiKey !== undefined ? "ai.provider_connected" : "ai.provider_updated",
      entityType: "AiProviderConfig",
      entityId: saved.id,
      // Só o hint e o resultado — nunca a chave.
      metadata: { provider, apiKeyHint: saved.apiKeyHint, defaultModel: saved.defaultModel, testOk: testResult?.ok ?? null },
    });
    return { provider: serializeAiProvider(provider, saved), test: testResult };
  });

  app.post("/ai/providers/:provider/test", { preHandler: requireRole("admin") }, async (request) => {
    const { provider } = providerParams.parse(request.params);
    const organizationId = request.user.organizationId;
    const credentials = await resolveCredentials(prisma, deps.aiCipher, deps.logger, organizationId, provider);
    if (!credentials) throw new AppError("Nenhuma chave gravada para este provedor.", 409, "provider_not_connected");
    let ok = true;
    let message = "OpenAI conectada com sucesso.";
    try {
      await credentials.provider.testConnection(credentials.apiKey, PROVIDER_TEST_TIMEOUT_MS);
    } catch (err) {
      ok = false;
      message = providerMessage(err);
    }
    const saved = await prisma.aiProviderConfig.update({
      where: { organizationId_provider: { organizationId, provider } },
      data: { status: ok ? "connected" : "error", lastTestedAt: new Date(), lastTestError: ok ? null : message },
    });
    await prisma.aiUsageLog.create({
      data: { organizationId, provider, model: "-", kind: "connection_test", outcome: ok ? "ok" : "error", errorCode: ok ? null : "connection_failed" },
    });
    deps.audit.record({
      organizationId,
      userId: request.user.sub,
      action: "ai.provider_tested",
      entityType: "AiProviderConfig",
      entityId: saved.id,
      metadata: { provider, ok },
    });
    return { provider: serializeAiProvider(provider, saved), test: { ok, message } };
  });

  app.post("/ai/providers/:provider/disconnect", { preHandler: requireRole("admin") }, async (request) => {
    const { provider } = providerParams.parse(request.params);
    const organizationId = request.user.organizationId;
    const existing = await prisma.aiProviderConfig.findUnique({
      where: { organizationId_provider: { organizationId, provider } },
    });
    if (!existing) throw new NotFoundError("Provedor");
    const saved = await prisma.aiProviderConfig.update({
      where: { id: existing.id },
      data: {
        apiKeyEncrypted: null,
        apiKeyHint: null,
        status: "not_connected",
        lastTestError: null,
        modelsCache: Prisma.JsonNull,
        modelsFetchedAt: null,
      },
    });
    deps.audit.record({
      organizationId,
      userId: request.user.sub,
      action: "ai.provider_disconnected",
      entityType: "AiProviderConfig",
      entityId: saved.id,
      metadata: { provider },
    });
    return { provider: serializeAiProvider(provider, saved) };
  });

  /**
   * Modelos: a lista vem do provedor e fica em cache por algumas horas;
   * `?refresh=1` força. Sem chave (ou provedor mudo), sai o catálogo local,
   * marcado como tal — a tela sempre tem o que oferecer.
   */
  app.get("/ai/providers/:provider/models", { preHandler: requireRole("admin") }, async (request) => {
    const { provider } = providerParams.parse(request.params);
    const { refresh } = z.object({ refresh: z.coerce.boolean().optional() }).parse(request.query);
    const organizationId = request.user.organizationId;
    const config = await prisma.aiProviderConfig.findUnique({
      where: { organizationId_provider: { organizationId, provider } },
    });
    const cached = Array.isArray(config?.modelsCache) ? (config.modelsCache as string[]) : null;
    const fresh = config?.modelsFetchedAt && Date.now() - config.modelsFetchedAt.getTime() < MODELS_CACHE_MS;
    if (cached && fresh && !refresh) {
      return { models: serializeModels(cached), source: "provider", fetchedAt: config.modelsFetchedAt?.toISOString() ?? null };
    }
    const credentials = await resolveCredentials(prisma, deps.aiCipher, deps.logger, organizationId, provider);
    if (credentials) {
      try {
        const models = await credentials.provider.listModels(credentials.apiKey, PROVIDER_TEST_TIMEOUT_MS);
        const ids = models.map((model) => model.id);
        await prisma.aiProviderConfig.update({
          where: { id: config?.id ?? "" },
          data: { modelsCache: ids, modelsFetchedAt: new Date() },
        }).catch(() => undefined);
        return { models: serializeModels(ids), source: "provider", fetchedAt: new Date().toISOString() };
      } catch (err) {
        deps.logger.warn({ event: "ai_models_fetch_failed", organizationId, error: String(err) });
        if (cached) {
          return { models: serializeModels(cached), source: "provider", fetchedAt: config?.modelsFetchedAt?.toISOString() ?? null };
        }
      }
    }
    const catalog: AiModelDto[] = AI_MODEL_CATALOG.map((info) => ({ ...info, recommended: info.recommended ?? false, fromProvider: false }));
    return { models: catalog, source: "catalog", fetchedAt: null };
  });

  app.get("/ai/providers/:provider/billing", { preHandler: requireRole("admin") }, async (request) => {
    const { provider } = providerParams.parse(request.params);
    const credentials = await resolveCredentials(prisma, deps.aiCipher, deps.logger, request.user.organizationId, provider);
    if (!credentials) {
      return { available: false, reason: "Provedor não conectado.", monthCostMicros: null, checkedAt: new Date().toISOString() };
    }
    const billing = await credentials.provider.fetchBilling(credentials.apiKey, monthStart(), PROVIDER_TEST_TIMEOUT_MS);
    return { ...billing, checkedAt: new Date().toISOString() };
  });

  // =========================================================================
  // Configurações gerais — leitura por chave, escrita admin
  // =========================================================================

  async function settingsDto(organizationId: string): Promise<AiSettingsDto> {
    const row = await prisma.aiSettings.findUnique({ where: { organizationId } });
    const view = await loadAiSettings(prisma, organizationId);
    return {
      monthlyBudgetCents: view.monthlyBudgetCents,
      alertThresholds: view.alertThresholds,
      budgetPolicy: view.budgetPolicy,
      timeoutMs: view.timeoutMs,
      contextMessageLimit: view.contextMessageLimit,
      pricingOverrides: view.pricingOverrides,
      updatedAt: row?.updatedAt.toISOString() ?? null,
    };
  }

  app.get(
    "/ai/settings",
    { preHandler: requireAnyPermission(deps, ["ai.view_usage", "ai.agent.manage"]) },
    async (request) => ({ settings: await settingsDto(request.user.organizationId) }),
  );

  const settingsSchema = z.object({
    monthlyBudgetCents: z.number().int().min(0).max(100_000_000).nullable(),
    alertThresholds: z.array(z.number().int().min(1).max(100)).max(10),
    budgetPolicy: z.enum(AI_BUDGET_POLICIES),
    timeoutMs: z.number().int().min(5_000).max(120_000),
    contextMessageLimit: z.number().int().min(4).max(60),
    pricingOverrides: z.record(
      z.string().min(1).max(100),
      z.object({ inputPerMillion: z.number().min(0).max(10_000), outputPerMillion: z.number().min(0).max(10_000) }),
    ),
  });

  app.put("/ai/settings", { preHandler: requireRole("admin") }, async (request) => {
    const body = settingsSchema.parse(request.body);
    const organizationId = request.user.organizationId;
    const thresholds = [...new Set(body.alertThresholds)].sort((a, b) => a - b);
    const saved = await prisma.aiSettings.upsert({
      where: { organizationId },
      update: {
        monthlyBudgetCents: body.monthlyBudgetCents,
        alertThresholds: thresholds,
        budgetPolicy: body.budgetPolicy,
        timeoutMs: body.timeoutMs,
        contextMessageLimit: body.contextMessageLimit,
        pricingOverrides: body.pricingOverrides as Prisma.InputJsonValue,
        updatedById: request.user.sub,
      },
      create: {
        organizationId,
        monthlyBudgetCents: body.monthlyBudgetCents,
        alertThresholds: thresholds,
        budgetPolicy: body.budgetPolicy,
        timeoutMs: body.timeoutMs,
        contextMessageLimit: body.contextMessageLimit,
        pricingOverrides: body.pricingOverrides as Prisma.InputJsonValue,
        updatedById: request.user.sub,
      },
    });
    deps.audit.record({
      organizationId,
      userId: request.user.sub,
      action: "ai.settings_updated",
      entityType: "AiSettings",
      entityId: saved.id,
      metadata: { monthlyBudgetCents: body.monthlyBudgetCents, budgetPolicy: body.budgetPolicy, timeoutMs: body.timeoutMs },
    });
    return { settings: await settingsDto(organizationId) };
  });

  // =========================================================================
  // Consumo, indicadores e logs — ai.view_usage
  // =========================================================================

  async function periodStartFor(organizationId: string, period: AiUsagePeriod, now: Date): Promise<Date> {
    if (period === "month") return monthStart(now);
    const settings = await loadAttendanceSettings(prisma, organizationId);
    return periodRange(period, now, settings.timezone).start;
  }

  async function totalsSince(organizationId: string, since: Date): Promise<AiUsageTotalsDto> {
    const [agg, unpriced] = await Promise.all([
      prisma.aiUsageLog.aggregate({
        where: { organizationId, createdAt: { gte: since } },
        _count: { _all: true },
        _sum: { inputTokens: true, outputTokens: true, costMicros: true },
      }),
      prisma.aiUsageLog.count({ where: { organizationId, createdAt: { gte: since }, costMicros: null, kind: { in: ["chat", "test"] } } }),
    ]);
    const input = agg._sum.inputTokens ?? 0;
    const output = agg._sum.outputTokens ?? 0;
    return {
      requests: agg._count._all,
      inputTokens: input,
      outputTokens: output,
      totalTokens: input + output,
      costMicros: agg._sum.costMicros ?? 0,
      unpricedRequests: unpriced,
    };
  }

  app.get("/ai/usage", { preHandler: requirePermission(deps, "ai.view_usage") }, async (request) => {
    const { period } = z.object({ period: z.enum(AI_USAGE_PERIODS).default("month") }).parse(request.query);
    const organizationId = request.user.organizationId;
    const now = new Date();
    const [todayStart, periodStart, settings] = await Promise.all([
      periodStartFor(organizationId, "today", now),
      periodStartFor(organizationId, period, now),
      loadAiSettings(prisma, organizationId),
    ]);
    const [today, month, periodTotals, byAgentRaw, byDepartmentRaw, byModelRaw, budget] = await Promise.all([
      totalsSince(organizationId, todayStart),
      totalsSince(organizationId, monthStart(now)),
      totalsSince(organizationId, periodStart),
      prisma.aiUsageLog.groupBy({
        by: ["agentId", "agentName"],
        where: { organizationId, createdAt: { gte: periodStart } },
        _count: { _all: true },
        _sum: { inputTokens: true, outputTokens: true, costMicros: true },
      }),
      prisma.aiUsageLog.groupBy({
        by: ["departmentId"],
        where: { organizationId, createdAt: { gte: periodStart } },
        _count: { _all: true },
        _sum: { inputTokens: true, outputTokens: true, costMicros: true },
      }),
      prisma.aiUsageLog.groupBy({
        by: ["model"],
        where: { organizationId, createdAt: { gte: periodStart } },
        _count: { _all: true },
        _sum: { inputTokens: true, outputTokens: true, costMicros: true },
      }),
      loadBudgetState(prisma, organizationId, settings),
    ]);
    const departmentIds = byDepartmentRaw.map((row) => row.departmentId).filter((id): id is string => id != null);
    const departments = await prisma.department.findMany({ where: { id: { in: departmentIds } }, select: { id: true, name: true } });
    const departmentName = new Map(departments.map((department) => [department.id, department.name]));

    const bucket = (
      key: string,
      label: string,
      row: { _count: { _all: number }; _sum: { inputTokens: number | null; outputTokens: number | null; costMicros: number | null } },
    ): AiUsageBucketDto => {
      const input = row._sum.inputTokens ?? 0;
      const output = row._sum.outputTokens ?? 0;
      return {
        key,
        label,
        requests: row._count._all,
        inputTokens: input,
        outputTokens: output,
        totalTokens: input + output,
        costMicros: row._sum.costMicros ?? 0,
        unpricedRequests: 0,
      };
    };
    const byCost = (a: AiUsageBucketDto, b: AiUsageBucketDto) => b.costMicros - a.costMicros || b.totalTokens - a.totalTokens;
    const response: AiUsageDto = {
      period,
      today,
      month,
      period_totals: periodTotals,
      byAgent: byAgentRaw.map((row) => bucket(row.agentId ?? "none", row.agentName ?? "Sem agente (teste de conexão / modelos)", row)).sort(byCost),
      byDepartment: byDepartmentRaw
        .map((row) => bucket(row.departmentId ?? "none", row.departmentId ? (departmentName.get(row.departmentId) ?? "Departamento excluído") : "Sem departamento", row))
        .sort(byCost),
      byModel: byModelRaw.map((row) => bucket(row.model, row.model, row)).sort(byCost),
      budget: {
        monthlyBudgetCents: budget.monthlyBudgetCents,
        spentMicros: budget.spentMicros,
        percent: budget.percent,
        policy: budget.policy,
        blocked: budget.blocked,
      },
    };
    return { usage: response };
  });

  app.get("/ai/stats", { preHandler: requirePermission(deps, "ai.view_usage") }, async (request) => {
    const { period } = z.object({ period: z.enum(AI_USAGE_PERIODS).default("30d") }).parse(request.query);
    const organizationId = request.user.organizationId;
    const now = new Date();
    const start = await periodStartFor(organizationId, period, now);
    const [sessions, monthCost] = await Promise.all([
      prisma.aiSession.findMany({
        where: { organizationId, startedAt: { gte: start } },
        select: { agentId: true, status: true, aiMessageCount: true, costMicros: true, agent: { select: { name: true } } },
      }),
      prisma.aiUsageLog.aggregate({ where: { organizationId, createdAt: { gte: monthStart(now) } }, _sum: { costMicros: true } }),
    ]);
    const finished = sessions.filter((session) => session.status !== "active");
    const resolved = sessions.filter((session) => session.status === "resolved").length;
    const transferred = sessions.filter((session) => session.status === "transferred").length;
    const active = sessions.filter((session) => session.status === "active").length;
    const cost = sessions.reduce((sum, session) => sum + session.costMicros, 0);
    const messages = sessions.reduce((sum, session) => sum + session.aiMessageCount, 0);
    const rate = (num: number, den: number) => (den > 0 ? Math.round((num / den) * 100) : null);

    const byAgentMap = new Map<string, AiStatsDto["byAgent"][number]>();
    for (const session of sessions) {
      const row = byAgentMap.get(session.agentId) ?? {
        agentId: session.agentId,
        agentName: session.agent.name,
        sessions: 0,
        resolved: 0,
        transferred: 0,
        resolutionRate: null,
        avgMessages: null,
        costMicros: 0,
        avgCostMicros: null,
      };
      row.sessions += 1;
      if (session.status === "resolved") row.resolved += 1;
      if (session.status === "transferred") row.transferred += 1;
      row.costMicros += session.costMicros;
      row.avgMessages = (row.avgMessages ?? 0) + session.aiMessageCount;
      byAgentMap.set(session.agentId, row);
    }
    const byAgent = [...byAgentMap.values()].map((row) => {
      const finishedCount = row.resolved + row.transferred;
      return {
        ...row,
        resolutionRate: rate(row.resolved, finishedCount),
        avgMessages: row.sessions > 0 ? Math.round(((row.avgMessages ?? 0) / row.sessions) * 10) / 10 : null,
        avgCostMicros: row.sessions > 0 ? Math.round(row.costMicros / row.sessions) : null,
      };
    });
    byAgent.sort((a, b) => b.sessions - a.sessions);

    const stats: AiStatsDto = {
      period,
      sessions: sessions.length,
      active,
      resolved,
      transferred,
      other: finished.length - resolved - transferred,
      resolutionRate: rate(resolved, resolved + transferred),
      avgMessages: sessions.length > 0 ? Math.round((messages / sessions.length) * 10) / 10 : null,
      monthCostMicros: monthCost._sum.costMicros ?? 0,
      costMicros: cost,
      avgCostMicros: sessions.length > 0 ? Math.round(cost / sessions.length) : null,
      byAgent,
    };
    return { stats };
  });

  app.get("/ai/logs", { preHandler: requirePermission(deps, "ai.view_usage") }, async (request) => {
    const query = z
      .object({
        limit: z.coerce.number().int().min(1).max(200).default(50),
        before: z.string().datetime().optional(),
        agentId: z.string().uuid().optional(),
        kind: z.enum(AI_USAGE_KINDS).optional(),
        outcome: z.enum(AI_USAGE_OUTCOMES).optional(),
      })
      .parse(request.query);
    const rows = await prisma.aiUsageLog.findMany({
      where: {
        organizationId: request.user.organizationId,
        ...(query.before ? { createdAt: { lt: new Date(query.before) } } : {}),
        ...(query.agentId ? { agentId: query.agentId } : {}),
        ...(query.kind ? { kind: query.kind } : {}),
        ...(query.outcome ? { outcome: query.outcome } : {}),
      },
      orderBy: { createdAt: "desc" },
      take: query.limit + 1,
      include: { conversation: { select: { title: true, customTitle: true } } },
    });
    const hasMore = rows.length > query.limit;
    return { logs: rows.slice(0, query.limit).map(serializeAiUsageLog), hasMore };
  });

  // =========================================================================
  // Agentes — ai.agent.manage
  // =========================================================================

  const agentInclude = {
    departments: { include: { department: true } },
    knowledgeSources: { select: { sourceId: true } },
    _count: { select: { sessions: true } },
  } satisfies Prisma.AiAgentInclude;

  async function agentCosts(agentIds: string[]): Promise<Map<string, number>> {
    if (agentIds.length === 0) return new Map();
    const rows = await prisma.aiUsageLog.groupBy({
      by: ["agentId"],
      where: { agentId: { in: agentIds } },
      _sum: { costMicros: true },
    });
    return new Map(rows.map((row) => [row.agentId ?? "", row._sum.costMicros ?? 0]));
  }

  async function defaultModelOf(organizationId: string): Promise<string | null> {
    const config = await prisma.aiProviderConfig.findUnique({
      where: { organizationId_provider: { organizationId, provider: "openai" } },
      select: { defaultModel: true },
    });
    return config?.defaultModel ?? null;
  }

  async function findAgentOr404(id: string, user: FastifyRequest["user"]) {
    const accessible = await accessibleDepartmentIds(prisma, user);
    const agent = await prisma.aiAgent.findFirst({
      where: { id, organizationId: user.organizationId, ...departmentResourceScope(accessible) },
      include: agentInclude,
    });
    if (!agent) throw new NotFoundError("Agente de IA");
    return { agent, accessible };
  }

  app.get("/ai/agents", { preHandler: requireAnyPermission(deps, ["ai.agent.manage", "ai.view_usage"]) }, async (request) => {
    const accessible = await accessibleDepartmentIds(prisma, request.user);
    const agents = await prisma.aiAgent.findMany({
      where: { organizationId: request.user.organizationId, ...departmentResourceScope(accessible) },
      include: agentInclude,
      orderBy: { name: "asc" },
    });
    const [costs, defaultModel] = await Promise.all([agentCosts(agents.map((agent) => agent.id)), defaultModelOf(request.user.organizationId)]);
    return {
      agents: agents.map((agent) => serializeAiAgentSummary(agent, { costMicros: costs.get(agent.id) ?? 0, defaultModel })),
    };
  });

  app.get("/ai/agents/:id", { preHandler: requirePermission(deps, "ai.agent.manage") }, async (request) => {
    const { id } = idParams.parse(request.params);
    const { agent } = await findAgentOr404(id, request.user);
    const [costs, defaultModel] = await Promise.all([agentCosts([agent.id]), defaultModelOf(request.user.organizationId)]);
    return { agent: serializeAiAgent(agent, { costMicros: costs.get(agent.id) ?? 0, defaultModel }) };
  });

  const agentBodySchema = z.object({
    name: z.string().min(2).max(80),
    description: z.string().max(500).default(""),
    status: z.enum(AI_AGENT_STATUSES).optional(),
    isGeneral: z.boolean(),
    departmentIds: z.array(z.string().uuid()),
    model: z.string().min(1).max(100).nullable().default(null),
    knowledgeSourceIds: z.array(z.string().uuid()).max(50).default([]),
    config: aiAgentConfigSchema,
  });

  /** Confere que o destino de transferência é da organização. */
  async function validateHandoff(organizationId: string, config: z.infer<typeof aiAgentConfigSchema>) {
    if (config.handoff.departmentId) {
      const department = await prisma.department.findFirst({ where: { id: config.handoff.departmentId, organizationId }, select: { id: true } });
      if (!department) throw new AppError("Departamento de transferência inválido", 400, "invalid_department");
    }
    if (config.handoff.assigneeMode === "specific") {
      if (!config.handoff.assigneeUserId) throw new AppError("Escolha a pessoa que recebe a transferência", 400, "invalid_assignee");
      const user = await prisma.user.findFirst({ where: { id: config.handoff.assigneeUserId, organizationId, status: "active" }, select: { id: true } });
      if (!user) throw new AppError("Responsável de transferência inválido", 400, "invalid_assignee");
    }
  }

  async function validateKnowledge(organizationId: string, ids: string[]): Promise<string[]> {
    const unique = [...new Set(ids)];
    if (unique.length === 0) return [];
    const found = await prisma.aiKnowledgeSource.findMany({ where: { id: { in: unique }, organizationId }, select: { id: true } });
    if (found.length !== unique.length) throw new AppError("Fonte de conhecimento inválida", 400, "invalid_knowledge_source");
    return unique;
  }

  app.post("/ai/agents", { preHandler: requirePermission(deps, "ai.agent.manage") }, async (request, reply) => {
    const body = agentBodySchema.parse(request.body);
    const organizationId = request.user.organizationId;
    const accessible = await accessibleDepartmentIds(prisma, request.user);
    const target = await resolveDepartmentTarget(prisma, request.user, accessible, body, agentLabels);
    await validateHandoff(organizationId, body.config);
    const knowledgeIds = await validateKnowledge(organizationId, body.knowledgeSourceIds);
    const existing = await prisma.aiAgent.findUnique({ where: { organizationId_name: { organizationId, name: body.name } } });
    if (existing) throw new AppError("Já existe um agente com este nome", 409, "duplicate_name");

    const created = await prisma.aiAgent.create({
      data: {
        organizationId,
        name: body.name,
        description: body.description,
        status: body.status ?? "draft",
        isGeneral: target.isGeneral,
        model: body.model,
        config: body.config as unknown as Prisma.InputJsonValue,
        currentVersion: 1,
        handoffDepartmentId: body.config.handoff.departmentId,
        handoffAssigneeId: body.config.handoff.assigneeMode === "specific" ? body.config.handoff.assigneeUserId : null,
        createdById: request.user.sub,
        updatedById: request.user.sub,
        departments: { create: target.departmentIds.map((departmentId) => ({ departmentId })) },
        knowledgeSources: { create: knowledgeIds.map((sourceId) => ({ sourceId })) },
        versions: { create: { version: 1, model: body.model, config: body.config as unknown as Prisma.InputJsonValue, createdById: request.user.sub } },
      },
      include: agentInclude,
    });
    deps.audit.record({
      organizationId,
      userId: request.user.sub,
      action: "ai.agent_created",
      entityType: "AiAgent",
      entityId: created.id,
      metadata: { name: created.name, status: created.status, ...auditDepartmentSnapshot(created.isGeneral, created.departments) },
    });
    return reply.status(201).send({ agent: serializeAiAgent(created, { costMicros: 0, defaultModel: await defaultModelOf(organizationId) }) });
  });

  app.patch("/ai/agents/:id", { preHandler: requirePermission(deps, "ai.agent.manage") }, async (request) => {
    const { id } = idParams.parse(request.params);
    const body = agentBodySchema.parse(request.body);
    const organizationId = request.user.organizationId;
    const { agent, accessible } = await findAgentOr404(id, request.user);
    assertCanManageResource(accessible, { isGeneral: agent.isGeneral, departmentIds: agent.departments.map((link) => link.departmentId) }, agentLabels);
    const target = await resolveDepartmentTarget(prisma, request.user, accessible, body, agentLabels);
    await validateHandoff(organizationId, body.config);
    const knowledgeIds = await validateKnowledge(organizationId, body.knowledgeSourceIds);
    if (body.name !== agent.name) {
      const clash = await prisma.aiAgent.findUnique({ where: { organizationId_name: { organizationId, name: body.name } } });
      if (clash) throw new AppError("Já existe um agente com este nome", 409, "duplicate_name");
    }

    // Versão nova só quando o que a IA LÊ mudou (configuração ou modelo).
    // Renomear ou trocar departamento não é versão.
    const previous = parseStoredAgentConfig(agent.config);
    const configChanged = JSON.stringify(previous) !== JSON.stringify(body.config) || agent.model !== body.model;
    const nextVersion = configChanged ? agent.currentVersion + 1 : agent.currentVersion;

    const updated = await prisma.$transaction(async (tx) => {
      await tx.aiAgentDepartment.deleteMany({ where: { agentId: id } });
      await tx.aiAgentKnowledgeSource.deleteMany({ where: { agentId: id } });
      const row = await tx.aiAgent.update({
        where: { id },
        data: {
          name: body.name,
          description: body.description,
          ...(body.status ? { status: body.status } : {}),
          isGeneral: target.isGeneral,
          model: body.model,
          config: body.config as unknown as Prisma.InputJsonValue,
          currentVersion: nextVersion,
          handoffDepartmentId: body.config.handoff.departmentId,
          handoffAssigneeId: body.config.handoff.assigneeMode === "specific" ? body.config.handoff.assigneeUserId : null,
          updatedById: request.user.sub,
          departments: { create: target.departmentIds.map((departmentId) => ({ departmentId })) },
          knowledgeSources: { create: knowledgeIds.map((sourceId) => ({ sourceId })) },
          ...(configChanged
            ? { versions: { create: { version: nextVersion, model: body.model, config: body.config as unknown as Prisma.InputJsonValue, createdById: request.user.sub } } }
            : {}),
        },
        include: agentInclude,
      });
      return row;
    });
    deps.audit.record({
      organizationId,
      userId: request.user.sub,
      action: "ai.agent_updated",
      entityType: "AiAgent",
      entityId: id,
      metadata: { name: updated.name, status: updated.status, version: updated.currentVersion, configChanged },
    });
    const [costs, defaultModel] = await Promise.all([agentCosts([id]), defaultModelOf(organizationId)]);
    return { agent: serializeAiAgent(updated, { costMicros: costs.get(id) ?? 0, defaultModel }) };
  });

  app.post("/ai/agents/:id/status", { preHandler: requirePermission(deps, "ai.agent.manage") }, async (request) => {
    const { id } = idParams.parse(request.params);
    const { status } = z.object({ status: z.enum(AI_AGENT_STATUSES) }).parse(request.body);
    const { agent, accessible } = await findAgentOr404(id, request.user);
    assertCanManageResource(accessible, { isGeneral: agent.isGeneral, departmentIds: agent.departments.map((link) => link.departmentId) }, agentLabels);
    if (status === "active") {
      const credentials = await resolveCredentials(prisma, deps.aiCipher, deps.logger, request.user.organizationId);
      if (!credentials) throw new AppError("Conecte o provedor de IA antes de ativar um agente.", 409, "provider_not_connected");
      const config = parseStoredAgentConfig(agent.config);
      if (!config.objective.trim()) throw new AppError("Defina o objetivo do agente antes de ativá-lo.", 400, "missing_objective");
    }
    const updated = await prisma.aiAgent.update({ where: { id }, data: { status, updatedById: request.user.sub }, include: agentInclude });
    // Desativar com atendimento em andamento: as sessões ativas são
    // encerradas com transferência na próxima varredura/turno (o motor
    // confere `agent.status`). Aqui só registramos.
    deps.audit.record({
      organizationId: request.user.organizationId,
      userId: request.user.sub,
      action: "ai.agent_status_changed",
      entityType: "AiAgent",
      entityId: id,
      metadata: { from: agent.status, to: status },
    });
    const [costs, defaultModel] = await Promise.all([agentCosts([id]), defaultModelOf(request.user.organizationId)]);
    return { agent: serializeAiAgent(updated, { costMicros: costs.get(id) ?? 0, defaultModel }) };
  });

  app.post("/ai/agents/:id/duplicate", { preHandler: requirePermission(deps, "ai.agent.manage") }, async (request, reply) => {
    const { id } = idParams.parse(request.params);
    const { agent } = await findAgentOr404(id, request.user);
    const organizationId = request.user.organizationId;
    let name = `${agent.name} (cópia)`;
    for (let attempt = 2; await prisma.aiAgent.findUnique({ where: { organizationId_name: { organizationId, name } } }); attempt += 1) {
      name = `${agent.name} (cópia ${attempt})`;
    }
    const created = await prisma.aiAgent.create({
      data: {
        organizationId,
        name,
        description: agent.description,
        status: "draft",
        isGeneral: agent.isGeneral,
        model: agent.model,
        config: agent.config as Prisma.InputJsonValue,
        currentVersion: 1,
        handoffDepartmentId: agent.handoffDepartmentId,
        handoffAssigneeId: agent.handoffAssigneeId,
        createdById: request.user.sub,
        updatedById: request.user.sub,
        departments: { create: agent.departments.map((link) => ({ departmentId: link.departmentId })) },
        knowledgeSources: { create: agent.knowledgeSources.map((link) => ({ sourceId: link.sourceId })) },
        versions: { create: { version: 1, model: agent.model, config: agent.config as Prisma.InputJsonValue, createdById: request.user.sub } },
      },
      include: agentInclude,
    });
    deps.audit.record({ organizationId, userId: request.user.sub, action: "ai.agent_duplicated", entityType: "AiAgent", entityId: created.id, metadata: { from: id } });
    return reply.status(201).send({ agent: serializeAiAgent(created, { costMicros: 0, defaultModel: await defaultModelOf(organizationId) }) });
  });

  app.delete("/ai/agents/:id", { preHandler: requirePermission(deps, "ai.agent.manage") }, async (request) => {
    const { id } = idParams.parse(request.params);
    const { agent, accessible } = await findAgentOr404(id, request.user);
    assertCanManageResource(accessible, { isGeneral: agent.isGeneral, departmentIds: agent.departments.map((link) => link.departmentId) }, agentLabels);
    const active = await prisma.aiSession.count({ where: { agentId: id, status: "active" } });
    if (active > 0) throw new AppError(`Este agente tem ${active} atendimento(s) em andamento. Desative-o e aguarde antes de excluir.`, 409, "agent_in_use");
    await prisma.aiAgent.delete({ where: { id } });
    deps.audit.record({ organizationId: request.user.organizationId, userId: request.user.sub, action: "ai.agent_deleted", entityType: "AiAgent", entityId: id, metadata: { name: agent.name } });
    return { ok: true };
  });

  app.get("/ai/agents/:id/versions", { preHandler: requirePermission(deps, "ai.agent.manage") }, async (request) => {
    const { id } = idParams.parse(request.params);
    await findAgentOr404(id, request.user);
    const versions = await prisma.aiAgentVersion.findMany({
      where: { agentId: id },
      orderBy: { version: "desc" },
      take: 50,
      include: { createdBy: { select: { id: true, name: true } } },
    });
    return { versions: versions.map(serializeAiAgentVersion) };
  });

  const testSchema = z.object({
    transcript: z
      .array(z.object({ role: z.enum(["customer", "assistant"]), content: z.string().min(1).max(4000) }))
      .min(1)
      .max(60),
    state: z.record(z.unknown()).nullable().default(null),
    debug: z.boolean().default(false),
  });

  /** Testador: nada sai pelo WhatsApp, nada é gravado na conversa. */
  app.post("/ai/agents/:id/test", { preHandler: requirePermission(deps, "ai.agent.manage") }, async (request) => {
    const { id } = idParams.parse(request.params);
    const body = testSchema.parse(request.body);
    const { agent } = await findAgentOr404(id, request.user);
    try {
      const result = await deps.aiRuntime.runTest({
        organizationId: request.user.organizationId,
        agent,
        transcript: body.transcript,
        state: body.state,
        debug: body.debug,
      });
      deps.audit.record({ organizationId: request.user.organizationId, userId: request.user.sub, action: "ai.agent_tested", entityType: "AiAgent", entityId: id });
      return { result };
    } catch (err) {
      if (err instanceof AiProviderError) throw new AppError(err.message, 502, `ai_${err.code}`);
      throw err;
    }
  });

  // =========================================================================
  // Base de conhecimento — ai.agent.manage
  // =========================================================================

  app.get("/ai/knowledge", { preHandler: requirePermission(deps, "ai.agent.manage") }, async (request) => {
    const sources = await prisma.aiKnowledgeSource.findMany({
      where: { organizationId: request.user.organizationId },
      orderBy: { title: "asc" },
      include: { _count: { select: { agents: true } } },
    });
    return { sources: sources.map(serializeAiKnowledgeSource) };
  });

  const knowledgeSchema = z.object({
    title: z.string().min(2).max(120),
    kind: z.enum(AI_KNOWLEDGE_KINDS),
    content: z.string().min(1).max(AI_KNOWLEDGE_MAX_CHARS),
    active: z.boolean().default(true),
  });

  app.post("/ai/knowledge", { preHandler: requirePermission(deps, "ai.agent.manage") }, async (request, reply) => {
    const body = knowledgeSchema.parse(request.body);
    const created = await prisma.aiKnowledgeSource.create({
      data: { organizationId: request.user.organizationId, ...body, createdById: request.user.sub },
      include: { _count: { select: { agents: true } } },
    });
    deps.audit.record({ organizationId: request.user.organizationId, userId: request.user.sub, action: "ai.knowledge_created", entityType: "AiKnowledgeSource", entityId: created.id, metadata: { title: created.title, kind: created.kind } });
    return reply.status(201).send({ source: serializeAiKnowledgeSource(created) });
  });

  app.patch("/ai/knowledge/:id", { preHandler: requirePermission(deps, "ai.agent.manage") }, async (request) => {
    const { id } = idParams.parse(request.params);
    const body = knowledgeSchema.partial().parse(request.body);
    const existing = await prisma.aiKnowledgeSource.findFirst({ where: { id, organizationId: request.user.organizationId } });
    if (!existing) throw new NotFoundError("Fonte de conhecimento");
    const updated = await prisma.aiKnowledgeSource.update({ where: { id }, data: body, include: { _count: { select: { agents: true } } } });
    deps.audit.record({ organizationId: request.user.organizationId, userId: request.user.sub, action: "ai.knowledge_updated", entityType: "AiKnowledgeSource", entityId: id, metadata: { title: updated.title } });
    return { source: serializeAiKnowledgeSource(updated) };
  });

  app.delete("/ai/knowledge/:id", { preHandler: requirePermission(deps, "ai.agent.manage") }, async (request) => {
    const { id } = idParams.parse(request.params);
    const existing = await prisma.aiKnowledgeSource.findFirst({ where: { id, organizationId: request.user.organizationId } });
    if (!existing) throw new NotFoundError("Fonte de conhecimento");
    await prisma.aiKnowledgeSource.delete({ where: { id } });
    deps.audit.record({ organizationId: request.user.organizationId, userId: request.user.sub, action: "ai.knowledge_deleted", entityType: "AiKnowledgeSource", entityId: id, metadata: { title: existing.title } });
    return { ok: true };
  });

  // =========================================================================
  // Automações — ai.agent.manage
  // =========================================================================

  const automationInclude = { agent: { select: { name: true, status: true } }, _count: { select: { sessions: true } } } satisfies Prisma.AiAutomationInclude;

  app.get("/ai/automations", { preHandler: requirePermission(deps, "ai.agent.manage") }, async (request) => {
    const automations = await prisma.aiAutomation.findMany({
      where: { organizationId: request.user.organizationId },
      orderBy: [{ priority: "asc" }, { createdAt: "asc" }],
      include: automationInclude,
    });
    return { automations: automations.map(serializeAiAutomation) };
  });

  const automationSchema = z.object({
    name: z.string().min(2).max(80),
    active: z.boolean().default(true),
    agentId: z.string().uuid(),
    whatsappInstanceId: z.string().uuid().nullable().default(null),
    departmentId: z.string().uuid().nullable().default(null),
    onlyWithoutDepartment: z.boolean().default(false),
    conversationType: z.enum(AI_AUTOMATION_CONVERSATION_TYPES).default("any"),
    onlyUnassigned: z.boolean().default(true),
    onlyNewConversations: z.boolean().default(false),
    resolvedTagId: z.string().uuid().nullable().default(null),
    priority: z.number().int().min(1).max(1000).default(100),
  });

  async function validateAutomation(organizationId: string, body: z.infer<typeof automationSchema>) {
    const agent = await prisma.aiAgent.findFirst({ where: { id: body.agentId, organizationId }, select: { id: true } });
    if (!agent) throw new AppError("Agente inválido", 400, "invalid_agent");
    if (body.whatsappInstanceId) {
      const instance = await prisma.whatsAppInstance.findFirst({ where: { id: body.whatsappInstanceId, organizationId }, select: { id: true } });
      if (!instance) throw new AppError("Número inválido", 400, "invalid_instance");
    }
    if (body.departmentId) {
      const department = await prisma.department.findFirst({ where: { id: body.departmentId, organizationId }, select: { id: true } });
      if (!department) throw new AppError("Departamento inválido", 400, "invalid_department");
    }
    if (body.resolvedTagId) {
      const tag = await prisma.tag.findFirst({ where: { id: body.resolvedTagId, organizationId }, select: { id: true } });
      if (!tag) throw new AppError("Etiqueta inválida", 400, "invalid_tag");
    }
  }

  app.post("/ai/automations", { preHandler: requirePermission(deps, "ai.agent.manage") }, async (request, reply) => {
    const body = automationSchema.parse(request.body);
    await validateAutomation(request.user.organizationId, body);
    const created = await prisma.aiAutomation.create({
      data: {
        organizationId: request.user.organizationId,
        ...body,
        departmentId: body.onlyWithoutDepartment ? null : body.departmentId,
      },
      include: automationInclude,
    });
    deps.audit.record({ organizationId: request.user.organizationId, userId: request.user.sub, action: "ai.automation_created", entityType: "AiAutomation", entityId: created.id, metadata: { name: created.name, agentId: created.agentId } });
    return reply.status(201).send({ automation: serializeAiAutomation(created) });
  });

  app.patch("/ai/automations/:id", { preHandler: requirePermission(deps, "ai.agent.manage") }, async (request) => {
    const { id } = idParams.parse(request.params);
    const body = automationSchema.parse(request.body);
    const existing = await prisma.aiAutomation.findFirst({ where: { id, organizationId: request.user.organizationId } });
    if (!existing) throw new NotFoundError("Automação");
    await validateAutomation(request.user.organizationId, body);
    const updated = await prisma.aiAutomation.update({
      where: { id },
      data: { ...body, departmentId: body.onlyWithoutDepartment ? null : body.departmentId },
      include: automationInclude,
    });
    deps.audit.record({ organizationId: request.user.organizationId, userId: request.user.sub, action: "ai.automation_updated", entityType: "AiAutomation", entityId: id, metadata: { name: updated.name, active: updated.active } });
    return { automation: serializeAiAutomation(updated) };
  });

  app.delete("/ai/automations/:id", { preHandler: requirePermission(deps, "ai.agent.manage") }, async (request) => {
    const { id } = idParams.parse(request.params);
    const existing = await prisma.aiAutomation.findFirst({ where: { id, organizationId: request.user.organizationId } });
    if (!existing) throw new NotFoundError("Automação");
    await prisma.aiAutomation.delete({ where: { id } });
    deps.audit.record({ organizationId: request.user.organizationId, userId: request.user.sub, action: "ai.automation_deleted", entityType: "AiAutomation", entityId: id, metadata: { name: existing.name } });
    return { ok: true };
  });

  /** Opções para os seletores da tela (responsável de transferência). */
  app.get("/ai/options", { preHandler: requirePermission(deps, "ai.agent.manage") }, async (request) => {
    const users = await prisma.user.findMany({
      where: { organizationId: request.user.organizationId, status: "active" },
      orderBy: { name: "asc" },
    });
    return { users: users.map(serializeUserDirectory) };
  });

  // =========================================================================
  // Dentro da conversa
  // =========================================================================

  app.get("/conversations/:id/ai", { preHandler: authenticate }, async (request) => {
    const { id } = idParams.parse(request.params);
    await findAccessibleConversation(prisma, request.user, id);
    const session = await loadLatestSession(prisma, id);
    return { session: session ? serializeAiSession(session) : null };
  });

  app.post("/conversations/:id/ai/stop", { preHandler: requirePermission(deps, "ai.session.stop") }, async (request) => {
    const { id } = idParams.parse(request.params);
    const conversation = await findAccessibleConversation(prisma, request.user, id);
    const session = await prisma.aiSession.findFirst({ where: { conversationId: id, status: "active" }, include: { agent: { select: { name: true } } } });
    if (!session) throw new AppError("Não há atendimento por IA em andamento nesta conversa.", 409, "no_active_session");
    await endAiSession(deps, {
      sessionId: session.id,
      organizationId: conversation.organizationId,
      conversationId: id,
      reason: "stopped_by_user",
      endedByUserId: request.user.sub,
      historyNote: `Atendimento por IA (${session.agent.name}) encerrado por ${request.user.name}.`,
    });
    deps.audit.record({ organizationId: conversation.organizationId, userId: request.user.sub, action: "ai.session_stopped", entityType: "Conversation", entityId: id, metadata: { sessionId: session.id } });
    const latest = await loadLatestSession(prisma, id);
    return { session: latest ? serializeAiSession(latest) : null };
  });

  app.post("/conversations/:id/ai/resume", { preHandler: requirePermission(deps, "ai.session.resume") }, async (request) => {
    const { id } = idParams.parse(request.params);
    const conversation = await findAccessibleConversation(prisma, request.user, id);
    const result = await deps.aiRuntime.resumeSession({
      organizationId: conversation.organizationId,
      conversationId: id,
      userId: request.user.sub,
      userName: request.user.name,
    });
    if (!result.ok) throw new AppError(result.reason, 409, "cannot_resume");
    const latest = await loadLatestSession(prisma, id);
    return { session: latest ? serializeAiSession(latest) : null };
  });
}

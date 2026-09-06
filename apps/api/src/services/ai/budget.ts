import type { AiSettings, PrismaClient } from "@azvchat/database";
import {
  AI_BUDGET_ALERT_THRESHOLDS,
  AI_USD_MICROS,
  RealtimeEvents,
  type AiBudgetAlertPayload,
  type AiBudgetPolicy,
  type AiPricingOverrides,
} from "@azvchat/shared";
import type { Server } from "socket.io";
import type { Logger } from "pino";
import { orgRoom } from "../../realtime/socket.js";

/**
 * Orçamento mensal de IA: quanto já foi gasto, se cruzou algum degrau, e o
 * que fazer ao chegar em 100%. O gasto é o REGISTRADO PELO AZVCHAT
 * (`AiUsageLog.costMicros`), a única fonte que existe para toda chave —
 * o custo faturado pelo provedor, quando disponível, é informação à parte
 * na tela e nunca entra nesta conta.
 */

export interface AiSettingsView {
  monthlyBudgetCents: number | null;
  alertThresholds: number[];
  budgetPolicy: AiBudgetPolicy;
  timeoutMs: number;
  contextMessageLimit: number;
  pricingOverrides: AiPricingOverrides;
}

export const DEFAULT_AI_SETTINGS: AiSettingsView = {
  monthlyBudgetCents: null,
  alertThresholds: [...AI_BUDGET_ALERT_THRESHOLDS],
  budgetPolicy: "alert_only",
  timeoutMs: 30_000,
  contextMessageLimit: 20,
  pricingOverrides: {},
};

export function settingsView(row: AiSettings | null): AiSettingsView {
  if (!row) return DEFAULT_AI_SETTINGS;
  return {
    monthlyBudgetCents: row.monthlyBudgetCents,
    alertThresholds: row.alertThresholds.length ? row.alertThresholds : [...AI_BUDGET_ALERT_THRESHOLDS],
    budgetPolicy: row.budgetPolicy,
    timeoutMs: row.timeoutMs,
    contextMessageLimit: row.contextMessageLimit,
    pricingOverrides: readPricingOverrides(row.pricingOverrides),
  };
}

export function readPricingOverrides(raw: unknown): AiPricingOverrides {
  if (!raw || typeof raw !== "object") return {};
  const result: AiPricingOverrides = {};
  for (const [model, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!value || typeof value !== "object") continue;
    const { inputPerMillion, outputPerMillion } = value as Record<string, unknown>;
    if (typeof inputPerMillion === "number" && typeof outputPerMillion === "number") {
      result[model] = { inputPerMillion, outputPerMillion };
    }
  }
  return result;
}

export async function loadAiSettings(prisma: PrismaClient, organizationId: string): Promise<AiSettingsView> {
  const row = await prisma.aiSettings.findUnique({ where: { organizationId } });
  return settingsView(row);
}

/** Início do mês corrente em UTC — a fatura do provedor também é em UTC. */
export function monthStart(now = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

export function monthKey(now = new Date()): string {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
}

export async function monthSpendMicros(prisma: PrismaClient, organizationId: string, now = new Date()): Promise<number> {
  const aggregate = await prisma.aiUsageLog.aggregate({
    where: { organizationId, createdAt: { gte: monthStart(now) } },
    _sum: { costMicros: true },
  });
  return aggregate._sum.costMicros ?? 0;
}

export interface BudgetState {
  monthlyBudgetCents: number | null;
  spentMicros: number;
  percent: number | null;
  policy: AiBudgetPolicy;
  /** Estourou E a política não é "só alertar". */
  blocked: boolean;
}

export async function loadBudgetState(
  prisma: PrismaClient,
  organizationId: string,
  settings?: AiSettingsView,
): Promise<BudgetState> {
  const view = settings ?? (await loadAiSettings(prisma, organizationId));
  const spentMicros = await monthSpendMicros(prisma, organizationId);
  const budgetMicros = view.monthlyBudgetCents == null ? null : (view.monthlyBudgetCents / 100) * AI_USD_MICROS;
  const percent = budgetMicros == null || budgetMicros <= 0 ? null : Math.round((spentMicros / budgetMicros) * 100);
  return {
    monthlyBudgetCents: view.monthlyBudgetCents,
    spentMicros,
    percent,
    policy: view.budgetPolicy,
    blocked: percent != null && percent >= 100 && view.budgetPolicy !== "alert_only",
  };
}

/**
 * Depois de registrar um consumo: cruzou um degrau ainda não avisado neste
 * mês? Avisa os administradores (sala da organização) e marca o degrau, para
 * o aviso sair UMA vez por mês por degrau. A marcação vive na própria linha
 * de configurações — não vale uma tabela para quatro números.
 */
export async function checkBudgetAlerts(
  deps: { prisma: PrismaClient; io: Server; logger: Logger },
  organizationId: string,
): Promise<void> {
  const row = await deps.prisma.aiSettings.findUnique({ where: { organizationId } });
  if (!row?.monthlyBudgetCents) return;
  const state = await loadBudgetState(deps.prisma, organizationId, settingsView(row));
  if (state.percent == null) return;

  const key = monthKey();
  const already = row.alertedMonth === key ? row.alertedThresholds : [];
  const thresholds = (row.alertThresholds.length ? row.alertThresholds : [...AI_BUDGET_ALERT_THRESHOLDS])
    .filter((threshold) => state.percent != null && state.percent >= threshold && !already.includes(threshold))
    .sort((a, b) => a - b);
  if (thresholds.length === 0) return;

  await deps.prisma.aiSettings.update({
    where: { organizationId },
    data: { alertedMonth: key, alertedThresholds: [...already, ...thresholds] },
  });
  // Só o maior degrau cruzado nesta rodada vira aviso: pular de 40% para
  // 95% numa chamada cara não deve disparar três alertas.
  const threshold = thresholds[thresholds.length - 1] as number;
  const payload: AiBudgetAlertPayload = {
    threshold,
    percent: state.percent,
    spentMicros: state.spentMicros,
    monthlyBudgetCents: row.monthlyBudgetCents,
    policy: row.budgetPolicy,
  };
  deps.io.to(orgRoom(organizationId)).emit(RealtimeEvents.AiBudgetAlert, payload);
  deps.logger.warn({ event: "ai_budget_threshold", organizationId, threshold, percent: state.percent });
}

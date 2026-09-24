import type { AiCreditEntry, PrismaClient } from "@azvchat/database";
import {
  AI_SPEND_USES,
  AI_USD_MICROS,
  AI_SPEND_USE_LABELS,
  aiSpendUseOf,
  computeAiBalance,
  type AiBalanceDto,
  type AiCreditEntryDto,
  type AiSpendUse,
  type AiUsageKind,
} from "@azvchat/shared";

/**
 * Saldo ESTIMADO do crédito da IA.
 *
 * A OpenAI não tem consulta de saldo pré-pago para chave de API, então a
 * conta é feita aqui: último saldo informado + recargas − consumo registrado
 * (`AiUsageLog.costMicros`) desde então. É a MESMA fonte do orçamento mensal
 * (`budget.ts`) e da aba Consumo, de propósito: três números de gasto
 * saídos de três somas diferentes discordariam, e a tela perderia a
 * confiança de quem a lê. Só fecha porque a chave é usada apenas pelo
 * AZVCHAT; o texto do card diz isso.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const AVERAGE_WINDOW_DAYS = 30;
/** Com menos de um dia de histórico, a média diária seria um chute. */
const MIN_AVERAGE_DAYS = 1;

/** Chamadas que custam e deveriam ter preço; sem ele, o gasto real é maior. */
const PRICEABLE_KINDS: AiUsageKind[] = ["chat", "test", "transcription", "vision", "quality"];

type EntryWithAuthor = AiCreditEntry & { createdBy: { id: string; name: string } | null };

export function serializeAiCreditEntry(entry: EntryWithAuthor): AiCreditEntryDto {
  return {
    id: entry.id,
    kind: entry.kind,
    amountCents: entry.amountCents,
    effectiveAt: entry.effectiveAt.toISOString(),
    note: entry.note,
    createdBy: entry.createdBy ? { id: entry.createdBy.id, name: entry.createdBy.name } : null,
    createdAt: entry.createdAt.toISOString(),
  };
}

export async function loadAiBalance(prisma: PrismaClient, organizationId: string, now = new Date()): Promise<AiBalanceDto> {
  const [entries, settings, lastQuotaError] = await Promise.all([
    prisma.aiCreditEntry.findMany({
      where: { organizationId },
      orderBy: [{ effectiveAt: "desc" }, { createdAt: "desc" }],
      include: { createdBy: { select: { id: true, name: true } } },
    }) as Promise<EntryWithAuthor[]>,
    prisma.aiSettings.findUnique({ where: { organizationId } }),
    prisma.aiUsageLog.findFirst({
      where: { organizationId, errorCode: "insufficient_quota" },
      orderBy: { createdAt: "desc" },
      select: { createdAt: true },
    }),
  ]);
  const lowBalanceAlertCents = settings?.lowBalanceAlertCents ?? null;
  const { since, creditedMicros } = computeAiBalance(entries);

  const base = {
    lowBalanceAlertCents,
    lastQuotaErrorAt: lastQuotaError?.createdAt.toISOString() ?? null,
    entries: entries.map(serializeAiCreditEntry),
  };
  if (!since) {
    return {
      ...base,
      configured: false,
      since: null,
      creditedMicros: 0,
      spentMicros: 0,
      balanceMicros: null,
      unpricedRequests: 0,
      byUse: [],
      dailyAverageMicros: null,
      estimatedDaysLeft: null,
      low: false,
    };
  }

  const window = { organizationId, createdAt: { gte: since } };
  const averageStart = new Date(Math.max(since.getTime(), now.getTime() - AVERAGE_WINDOW_DAYS * DAY_MS));
  const [byKind, flowChat, unpricedRequests, averageAgg] = await Promise.all([
    prisma.aiUsageLog.groupBy({
      by: ["kind"],
      where: window,
      _count: { _all: true },
      _sum: { costMicros: true },
    }),
    // O `chat` do bloco de fluxo só se distingue pela sessão: ela guarda a
    // execução do fluxo que a abriu (`automationExecutionId`).
    prisma.aiUsageLog.aggregate({
      where: { ...window, kind: "chat", session: { is: { automationExecutionId: { not: null } } } },
      _count: { _all: true },
      _sum: { costMicros: true },
    }),
    prisma.aiUsageLog.count({ where: { ...window, costMicros: null, outcome: "ok", kind: { in: PRICEABLE_KINDS } } }),
    prisma.aiUsageLog.aggregate({ where: { organizationId, createdAt: { gte: averageStart } }, _sum: { costMicros: true } }),
  ]);

  const uses = new Map<AiSpendUse, { requests: number; costMicros: number }>();
  const add = (use: AiSpendUse, requests: number, costMicros: number) => {
    const current = uses.get(use) ?? { requests: 0, costMicros: 0 };
    uses.set(use, { requests: current.requests + requests, costMicros: current.costMicros + costMicros });
  };
  for (const row of byKind) {
    add(aiSpendUseOf(row.kind, false), row._count._all, row._sum.costMicros ?? 0);
  }
  // Tira dos atendimentos o que foi de fluxo e põe no lugar certo.
  const flowRequests = flowChat._count._all;
  const flowCost = flowChat._sum.costMicros ?? 0;
  if (flowRequests > 0) {
    add("attendance", -flowRequests, -flowCost);
    add("flows", flowRequests, flowCost);
  }
  const byUse = AI_SPEND_USES.map((use) => ({ use, label: AI_SPEND_USE_LABELS[use], ...(uses.get(use) ?? { requests: 0, costMicros: 0 }) }))
    .filter((row) => row.requests > 0)
    .sort((a, b) => b.costMicros - a.costMicros || b.requests - a.requests);

  const spentMicros = byUse.reduce((total, row) => total + row.costMicros, 0);
  const balanceMicros = creditedMicros - spentMicros;

  const averageDays = (now.getTime() - averageStart.getTime()) / DAY_MS;
  const averageSpent = averageAgg._sum.costMicros ?? 0;
  const dailyAverageMicros = averageDays >= MIN_AVERAGE_DAYS ? Math.round(averageSpent / averageDays) : null;
  const estimatedDaysLeft =
    dailyAverageMicros && dailyAverageMicros > 0 && balanceMicros > 0 ? Math.floor(balanceMicros / dailyAverageMicros) : null;

  return {
    ...base,
    configured: true,
    since: since.toISOString(),
    creditedMicros,
    spentMicros,
    balanceMicros,
    unpricedRequests,
    byUse,
    dailyAverageMicros,
    estimatedDaysLeft,
    low: lowBalanceAlertCents != null && balanceMicros < lowBalanceAlertCents * (AI_USD_MICROS / 100),
  };
}

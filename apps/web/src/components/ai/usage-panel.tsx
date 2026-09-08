"use client";

import { useCallback, useEffect, useState } from "react";
import { Save } from "lucide-react";
import {
  AI_BUDGET_ALERT_THRESHOLDS,
  AI_BUDGET_POLICIES,
  AI_BUDGET_POLICY_DESCRIPTIONS,
  AI_BUDGET_POLICY_LABELS,
  AI_USAGE_PERIODS,
  AI_USAGE_PERIOD_LABELS,
  type AiSettingsDto,
  type AiUsageBucketDto,
  type AiUsageDto,
  type AiUsagePeriod,
} from "@azvchat/shared";
import { ApiError, aiApi } from "@/lib/api";
import { useAuth } from "@/lib/auth-context";
import { Button, Field, Input, Spinner } from "@/components/ui";
import { formatCost, formatPercent, formatTokens, Notice, Section, Select, StatTile, Toggle } from "./ai-ui";

/**
 * Consumo e limites. O consumo é o REGISTRADO PELO AZVCHAT (cada chamada ao
 * provedor entra com tokens e custo estimado pela tabela de preço); o
 * orçamento é interno e a política decide o que acontece ao estourar.
 */
export function UsagePanel() {
  const { user } = useAuth();
  const isAdmin = user?.role === "admin";
  const [period, setPeriod] = useState<AiUsagePeriod>("month");
  const [usage, setUsage] = useState<AiUsageDto | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setUsage(await aiApi.usage(period));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Não foi possível carregar o consumo");
    }
  }, [period]);
  useEffect(() => void load(), [load]);

  if (error) return <Notice tone="error">{error}</Notice>;
  if (!usage) {
    return (
      <div className="flex justify-center py-8">
        <Spinner />
      </div>
    );
  }

  const budget = usage.budget;
  const budgetTone = budget.percent != null && budget.percent >= 80 ? "warn" : "default";

  return (
    <div className="space-y-6">
      <div className="grid gap-3 md:grid-cols-4">
        <StatTile label="Consumo hoje" value={formatCost(usage.today.costMicros)} hint={`${usage.today.requests} requisição(ões) · ${formatTokens(usage.today.totalTokens)} tokens`} />
        <StatTile label="Consumo no mês" value={formatCost(usage.month.costMicros)} hint={`${usage.month.requests} requisição(ões) · ${formatTokens(usage.month.totalTokens)} tokens`} />
        <StatTile
          label="Orçamento mensal"
          tone={budgetTone}
          value={budget.monthlyBudgetCents == null ? "Sem teto" : formatPercent(budget.percent)}
          hint={
            budget.monthlyBudgetCents == null
              ? "Defina abaixo para receber alertas"
              : `${formatCost(budget.spentMicros)} de US$ ${(budget.monthlyBudgetCents / 100).toFixed(2)}${budget.blocked ? " — BLOQUEADO" : ""}`
          }
        />
        <StatTile label="Tokens no mês" value={formatTokens(usage.month.totalTokens)} hint={`${formatTokens(usage.month.inputTokens)} entrada · ${formatTokens(usage.month.outputTokens)} saída`} />
      </div>
      {usage.month.unpricedRequests > 0 && (
        <Notice tone="warn">
          {usage.month.unpricedRequests} chamada(s) no mês usaram modelo sem tabela de preço: os tokens estão contados, mas o
          custo delas NÃO entra no total. Defina o preço em Configurações gerais.
        </Notice>
      )}

      <Section
        title="Detalhamento"
        description="Custo estimado pela tabela de preço por modelo. Não é a fatura do provedor."
        aside={
          <Select className="w-auto" value={period} onChange={(event) => setPeriod(event.target.value as AiUsagePeriod)}>
            {AI_USAGE_PERIODS.map((option) => (
              <option key={option} value={option}>
                {AI_USAGE_PERIOD_LABELS[option]}
              </option>
            ))}
          </Select>
        }
      >
        <div className="grid gap-4 lg:grid-cols-3">
          <BucketTable title="Por agente" rows={usage.byAgent} />
          <BucketTable title="Por departamento" rows={usage.byDepartment} />
          <BucketTable title="Por modelo" rows={usage.byModel} />
        </div>
      </Section>

      {isAdmin && <BudgetSettings onSaved={load} />}
    </div>
  );
}

function BucketTable({ title, rows }: { title: string; rows: AiUsageBucketDto[] }) {
  return (
    <div>
      <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">{title}</p>
      {rows.length === 0 ? (
        <p className="text-xs text-slate-400">Sem consumo no período.</p>
      ) : (
        <table className="w-full text-xs">
          <thead className="text-left text-[10px] uppercase text-slate-400">
            <tr>
              <th className="py-1">Nome</th>
              <th className="py-1 text-right">Req.</th>
              <th className="py-1 text-right">Tokens</th>
              <th className="py-1 text-right">Custo</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {rows.map((row) => (
              <tr key={row.key}>
                <td className="max-w-[10rem] truncate py-1 text-slate-700" title={row.label}>
                  {row.label}
                </td>
                <td className="py-1 text-right tabular-nums">{row.requests}</td>
                <td className="py-1 text-right tabular-nums">{formatTokens(row.totalTokens)}</td>
                <td className="py-1 text-right tabular-nums">{formatCost(row.costMicros)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

/** Orçamento interno e política ao atingir 100% — só admin. */
function BudgetSettings({ onSaved }: { onSaved: () => Promise<void> }) {
  const [settings, setSettings] = useState<AiSettingsDto | null>(null);
  const [budgetUsd, setBudgetUsd] = useState("");
  const [thresholds, setThresholds] = useState<number[]>([...AI_BUDGET_ALERT_THRESHOLDS]);
  const [policy, setPolicy] = useState<AiSettingsDto["budgetPolicy"]>("alert_only");
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<{ ok: boolean; message: string } | null>(null);

  useEffect(() => {
    void aiApi.settings().then((data) => {
      setSettings(data);
      setBudgetUsd(data.monthlyBudgetCents == null ? "" : (data.monthlyBudgetCents / 100).toFixed(2));
      setThresholds(data.alertThresholds);
      setPolicy(data.budgetPolicy);
    });
  }, []);

  async function save() {
    if (!settings) return;
    setBusy(true);
    setFeedback(null);
    try {
      const cents = budgetUsd.trim() ? Math.round(Number(budgetUsd.replace(",", ".")) * 100) : null;
      if (cents != null && (!Number.isFinite(cents) || cents < 0)) throw new Error("Orçamento inválido");
      const saved = await aiApi.saveSettings({
        monthlyBudgetCents: cents,
        alertThresholds: thresholds,
        budgetPolicy: policy,
        timeoutMs: settings.timeoutMs,
        contextMessageLimit: settings.contextMessageLimit,
        pricingOverrides: settings.pricingOverrides,
      });
      setSettings(saved);
      setFeedback({ ok: true, message: "Orçamento salvo." });
      await onSaved();
    } catch (err) {
      setFeedback({ ok: false, message: err instanceof ApiError || err instanceof Error ? err.message : "Não foi possível salvar" });
    } finally {
      setBusy(false);
    }
  }

  if (!settings) return null;
  return (
    <Section title="Orçamento mensal de IA" description="Teto interno em dólares (a moeda do provedor). Os administradores recebem aviso ao cruzar cada percentual marcado.">
      <div className="grid gap-4 md:grid-cols-2">
        <Field label="Orçamento mensal (US$)">
          <Input inputMode="decimal" placeholder="Ex.: 100,00 (vazio = sem teto)" value={budgetUsd} onChange={(event) => setBudgetUsd(event.target.value)} />
        </Field>
        <Field label="Alertar ao atingir">
          <div className="flex flex-wrap gap-2">
            {AI_BUDGET_ALERT_THRESHOLDS.map((threshold) => (
              <label key={threshold} className="flex items-center gap-1.5 rounded-lg border border-slate-200 px-2.5 py-1.5 text-sm">
                <input
                  type="checkbox"
                  className="h-4 w-4 rounded border-slate-300 text-brand-600"
                  checked={thresholds.includes(threshold)}
                  onChange={(event) =>
                    setThresholds(event.target.checked ? [...thresholds, threshold].sort((a, b) => a - b) : thresholds.filter((value) => value !== threshold))
                  }
                />
                {threshold}%
              </label>
            ))}
          </div>
        </Field>
      </div>
      <div className="space-y-1.5">
        <p className="text-xs font-medium uppercase tracking-wide text-slate-500">Ao atingir 100% do orçamento</p>
        {AI_BUDGET_POLICIES.map((option) => (
          <Toggle
            key={option}
            checked={policy === option}
            onChange={() => setPolicy(option)}
            label={AI_BUDGET_POLICY_LABELS[option]}
            hint={AI_BUDGET_POLICY_DESCRIPTIONS[option]}
          />
        ))}
        <p className="text-[11px] text-slate-400">
          Nenhuma política interrompe uma conversa em silêncio: o cliente sempre recebe a mensagem de fallback do agente
          e a conversa vai para a fila humana.
        </p>
      </div>
      {feedback && <Notice tone={feedback.ok ? "ok" : "error"}>{feedback.message}</Notice>}
      <Button disabled={busy} onClick={() => void save()}>
        <Save className="h-4 w-4" /> Salvar orçamento
      </Button>
    </Section>
  );
}

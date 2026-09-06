"use client";

import { useCallback, useEffect, useState } from "react";
import { AI_USAGE_PERIODS, AI_USAGE_PERIOD_LABELS, type AiStatsDto, type AiUsagePeriod } from "@azvchat/shared";
import { ApiError, aiApi } from "@/lib/api";
import { Card, Spinner } from "@/components/ui";
import { formatCost, formatPercent, Notice, Section, Select, StatTile } from "./ai-ui";

/** Indicadores do atendimento por IA: gerais e por agente. */
export function OverviewPanel() {
  const [period, setPeriod] = useState<AiUsagePeriod>("30d");
  const [stats, setStats] = useState<AiStatsDto | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setStats(await aiApi.stats(period));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Não foi possível carregar os indicadores");
    }
  }, [period]);
  useEffect(() => void load(), [load]);

  if (error) return <Notice tone="error">{error}</Notice>;
  if (!stats) {
    return (
      <div className="flex justify-center py-8">
        <Spinner />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <p className="text-sm text-slate-500">Atendimentos iniciados no período; resolvidos e transferidos são estados finais.</p>
        <Select className="w-auto" value={period} onChange={(event) => setPeriod(event.target.value as AiUsagePeriod)}>
          {AI_USAGE_PERIODS.map((option) => (
            <option key={option} value={option}>
              {AI_USAGE_PERIOD_LABELS[option]}
            </option>
          ))}
        </Select>
      </div>
      <div className="grid gap-3 md:grid-cols-4">
        <StatTile label="Atendimentos por IA" value={stats.sessions} hint={`${stats.active} em andamento agora`} />
        <StatTile label="Resolvidos pela IA" value={stats.resolved} />
        <StatTile label="Transferidos para humano" value={stats.transferred} hint={stats.other > 0 ? `${stats.other} por limite, erro ou interrupção` : undefined} />
        <StatTile label="Taxa de resolução" value={formatPercent(stats.resolutionRate)} hint="resolvidos ÷ (resolvidos + transferidos)" />
        <StatTile label="Média de mensagens da IA" value={stats.avgMessages ?? "—"} hint="por atendimento" />
        <StatTile label="Consumo do mês" value={formatCost(stats.monthCostMicros)} hint="todas as chamadas do mês corrente" />
        <StatTile label="Custo estimado no período" value={formatCost(stats.costMicros)} />
        <StatTile label="Custo médio por atendimento" value={formatCost(stats.avgCostMicros)} />
      </div>

      <Section title="Indicadores por agente">
        {stats.byAgent.length === 0 ? (
          <p className="text-sm text-slate-400">Nenhum atendimento por IA no período.</p>
        ) : (
          <Card className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-left text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="px-4 py-2">Agente</th>
                  <th className="px-4 py-2 text-right">Atendimentos</th>
                  <th className="px-4 py-2 text-right">Resolvidos</th>
                  <th className="px-4 py-2 text-right">Transferidos</th>
                  <th className="px-4 py-2 text-right">Resolução</th>
                  <th className="px-4 py-2 text-right">Média msgs</th>
                  <th className="px-4 py-2 text-right">Consumo</th>
                  <th className="px-4 py-2 text-right">Custo médio</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {stats.byAgent.map((row) => (
                  <tr key={row.agentId}>
                    <td className="px-4 py-2 font-medium text-slate-900">{row.agentName}</td>
                    <td className="px-4 py-2 text-right tabular-nums">{row.sessions}</td>
                    <td className="px-4 py-2 text-right tabular-nums">{row.resolved}</td>
                    <td className="px-4 py-2 text-right tabular-nums">{row.transferred}</td>
                    <td className="px-4 py-2 text-right tabular-nums">{formatPercent(row.resolutionRate)}</td>
                    <td className="px-4 py-2 text-right tabular-nums">{row.avgMessages ?? "—"}</td>
                    <td className="px-4 py-2 text-right tabular-nums">{formatCost(row.costMicros)}</td>
                    <td className="px-4 py-2 text-right tabular-nums">{formatCost(row.avgCostMicros)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        )}
      </Section>
    </div>
  );
}

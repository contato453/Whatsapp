"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Download, RefreshCw } from "lucide-react";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth-context";
import type { AgentReportDto } from "@/lib/types";
import { Button, Card, EmptyState, Spinner } from "@/components/ui";
import { UserAvatar } from "@/components/user-avatar";

/** Períodos prontos — o dia a dia da gestão cabe nestes quatro. */
const PRESETS = [
  { key: "today", label: "Hoje" },
  { key: "7d", label: "7 dias" },
  { key: "30d", label: "30 dias" },
  { key: "month", label: "Este mês" },
] as const;

type PresetKey = (typeof PRESETS)[number]["key"];

function rangeFor(preset: PresetKey): { from: Date; to: Date } {
  const to = new Date();
  const from = new Date();
  if (preset === "today") {
    from.setHours(0, 0, 0, 0);
  } else if (preset === "7d") {
    from.setDate(from.getDate() - 7);
  } else if (preset === "30d") {
    from.setDate(from.getDate() - 30);
  } else {
    from.setDate(1);
    from.setHours(0, 0, 0, 0);
  }
  return { from, to };
}

/** "2h 15min", "3min", "45s" — mesma regra usada na API. */
function formatDuration(seconds: number | null): string {
  if (seconds == null) return "—";
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest > 0 ? `${hours}h ${rest}min` : `${hours}h`;
}

function toDateInput(date: Date): string {
  const offset = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 10);
}

export default function ReportsPage() {
  const { user: me } = useAuth();
  const [preset, setPreset] = useState<PresetKey | "custom">("7d");
  const [customFrom, setCustomFrom] = useState(toDateInput(rangeFor("7d").from));
  const [customTo, setCustomTo] = useState(toDateInput(new Date()));
  const [report, setReport] = useState<AgentReportDto | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const range = useMemo(() => {
    if (preset !== "custom") return rangeFor(preset);
    const from = new Date(`${customFrom}T00:00:00`);
    const to = new Date(`${customTo}T23:59:59`);
    return { from, to };
  }, [preset, customFrom, customTo]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({
        from: range.from.toISOString(),
        to: range.to.toISOString(),
      });
      setReport(await api.get<AgentReportDto>(`/reports/agents?${params}`));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Erro ao carregar o relatório");
    } finally {
      setLoading(false);
    }
  }, [range]);

  useEffect(() => {
    void load();
  }, [load]);

  /** CSV gerado no navegador: os dados já estão todos aqui. */
  function downloadCsv() {
    if (!report) return;
    const header = [
      "Atendente",
      "E-mail",
      "Mensagens enviadas",
      "Conversas atendidas",
      "Tempo médio de resposta (s)",
      "Respostas medidas",
      "Conversas concluídas",
      "Fila: Aberto",
      "Fila: AG. Cliente",
      "Fila: AG. Operacional",
    ];
    const lines = report.rows.map((row) =>
      [
        row.user.name,
        row.user.email,
        row.messagesSent,
        row.conversationsHandled,
        row.avgResponseSeconds ?? "",
        row.responsesMeasured,
        row.conversationsResolved,
        row.queue.open,
        row.queue.waitingClient,
        row.queue.waitingInternal,
      ]
        .map((value) => `"${String(value).replace(/"/g, '""')}"`)
        .join(";"),
    );
    const csv = [header.join(";"), ...lines].join("\n");
    // BOM para o Excel abrir os acentos corretamente.
    const blob = new Blob(["\ufeff", csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `atendimentos-${toDateInput(range.from)}-a-${toDateInput(range.to)}.csv`;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  }

  if (me && me.role !== "admin" && me.role !== "supervisor") {
    return (
      <div className="p-8">
        <EmptyState
          title="Relatório restrito"
          description="Apenas supervisores e administradores acessam os números da equipe."
        />
      </div>
    );
  }

  return (
    <div className="thin-scroll h-full overflow-y-auto p-8">
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-bold text-slate-900">Atendimentos por atendente</h1>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={() => void load()} disabled={loading}>
            <RefreshCw className="h-4 w-4" /> Atualizar
          </Button>
          <Button size="sm" onClick={downloadCsv} disabled={!report || report.rows.length === 0}>
            <Download className="h-4 w-4" /> Baixar CSV
          </Button>
        </div>
      </div>

      <div className="mb-4 flex flex-wrap items-center gap-2">
        {PRESETS.map((option) => (
          <button
            key={option.key}
            onClick={() => setPreset(option.key)}
            className={
              preset === option.key
                ? "rounded-full bg-brand-600 px-3 py-1 text-xs font-medium text-white"
                : "rounded-full bg-slate-100 px-3 py-1 text-xs font-medium text-slate-600 hover:bg-slate-200"
            }
          >
            {option.label}
          </button>
        ))}
        <button
          onClick={() => setPreset("custom")}
          className={
            preset === "custom"
              ? "rounded-full bg-brand-600 px-3 py-1 text-xs font-medium text-white"
              : "rounded-full bg-slate-100 px-3 py-1 text-xs font-medium text-slate-600 hover:bg-slate-200"
          }
        >
          Personalizado
        </button>
        {preset === "custom" && (
          <span className="flex items-center gap-2 text-xs text-slate-500">
            <input
              type="date"
              value={customFrom}
              max={customTo}
              onChange={(event) => setCustomFrom(event.target.value)}
              className="rounded-lg border border-slate-300 px-2 py-1"
            />
            até
            <input
              type="date"
              value={customTo}
              min={customFrom}
              onChange={(event) => setCustomTo(event.target.value)}
              className="rounded-lg border border-slate-300 px-2 py-1"
            />
          </span>
        )}
      </div>

      {loading ? (
        <div className="flex justify-center py-16">
          <Spinner className="h-8 w-8" />
        </div>
      ) : error ? (
        <p className="text-sm text-red-600">{error}</p>
      ) : !report || report.rows.length === 0 ? (
        <EmptyState
          title="Sem movimento no período"
          description="Nenhum atendente enviou mensagens nas datas selecionadas."
        />
      ) : (
        <>
          <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
            <SummaryCard label="Recebidas" value={report.totals.messagesReceived} />
            <SummaryCard label="Enviadas" value={report.totals.messagesSent} />
            <SummaryCard label="Concluídas" value={report.totals.conversationsResolved} />
            <SummaryCard label="Na fila agora" value={report.totals.openNow} />
          </div>

          {report.truncated && (
            <p className="mb-3 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-700">
              O período selecionado tem mensagens demais e os números estão parciais. Escolha um
              intervalo menor para o relatório ficar exato.
            </p>
          )}

          <Card className="overflow-x-auto">
            <table className="w-full min-w-[900px] text-sm">
              <thead>
                <tr className="border-b border-slate-100 text-left text-xs uppercase tracking-wide text-slate-400">
                  <th className="px-4 py-3 font-medium">Atendente</th>
                  <th className="px-4 py-3 text-right font-medium">Mensagens</th>
                  <th className="px-4 py-3 text-right font-medium">Conversas</th>
                  <th className="px-4 py-3 text-right font-medium">Tempo médio</th>
                  <th className="px-4 py-3 text-right font-medium">Concluídas</th>
                  {/* Fila atual, separada por status do atendimento */}
                  <th className="border-l border-slate-100 px-4 py-3 text-right font-medium">
                    Aberto
                  </th>
                  <th className="px-4 py-3 text-right font-medium">AG. Cliente</th>
                  <th className="px-4 py-3 text-right font-medium">AG. Operacional</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {report.rows.map((row) => (
                  <tr key={row.user.id}>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        <UserAvatar
                          userId={row.user.id}
                          name={row.user.name}
                          hasAvatar={row.user.hasAvatar}
                          className="h-7 w-7 text-[10px]"
                        />
                        <div className="min-w-0">
                          <p className="truncate font-medium text-slate-900">{row.user.name}</p>
                          <p className="truncate text-xs text-slate-400">{row.user.email}</p>
                        </div>
                      </div>
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums">{row.messagesSent}</td>
                    <td className="px-4 py-3 text-right tabular-nums">{row.conversationsHandled}</td>
                    <td className="px-4 py-3 text-right tabular-nums">
                      {formatDuration(row.avgResponseSeconds)}
                      {row.responsesMeasured > 0 && (
                        <span className="ml-1 text-[10px] text-slate-400">
                          ({row.responsesMeasured})
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums">{row.conversationsResolved}</td>
                    <td className="border-l border-slate-100 px-4 py-3 text-right tabular-nums">
                      {row.queue.open}
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums">{row.queue.waitingClient}</td>
                    <td className="px-4 py-3 text-right tabular-nums">
                      {row.queue.waitingInternal}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>

          <div className="mt-3 space-y-1 text-xs text-slate-400">
            <p>
              <strong>Conversas</strong>: em quantas conversas distintas a pessoa respondeu no
              período. <strong>Tempo médio</strong>: da mensagem do cliente até a resposta dela; o
              número entre parênteses é quantas respostas entraram na média.
            </p>
            <p>
              <strong>Aberto</strong>, <strong>AG. Cliente</strong> e{" "}
              <strong>AG. Operacional</strong> são o retrato de agora — a fila atual da pessoa em
              cada etapa —, e não dependem do período escolhido. <strong>Concluídas</strong>, sim:
              conta quantas ela concluiu dentro das datas selecionadas.
            </p>
          </div>
        </>
      )}
    </div>
  );
}

function SummaryCard({ label, value }: { label: string; value: number }) {
  return (
    <Card className="p-4">
      <p className="text-xs uppercase tracking-wide text-slate-400">{label}</p>
      <p className="mt-1 text-2xl font-bold text-slate-900 tabular-nums">{value}</p>
    </Card>
  );
}

"use client";

import { useCallback, useEffect, useState } from "react";
import { Download } from "lucide-react";
import { qualityApi } from "@/lib/api";
import type { QualityAgentSummaryDto } from "@/lib/types";
import { Button, Card, EmptyState, Input, Spinner } from "@/components/ui";
import {
  QUALITY_SUBJECT_LABELS,
  criterionLabel,
  dateInputValue,
  formatMonth,
  formatScore,
  scoreClasses,
} from "./quality-ui";

/**
 * VISÃO POR ATENDENTE: média das notas ao longo do tempo, assuntos mais
 * frequentes e os pontos a melhorar que mais se repetem nos planos de ação.
 *
 * As médias vêm agregadas do servidor, e não são recalculadas aqui: dois
 * arredondamentos em lugares diferentes divergiriam, e "a média da linha não bate
 * com a do detalhe" é como um painel perde a confiança de quem o lê.
 *
 * A exportação segue o padrão que o relatório por atendente já usa: CSV montado
 * no navegador, ponto e vírgula como separador e BOM na frente, que é o que faz
 * o Excel abrir os acentos.
 */
export function AgentView() {
  const [de, setDe] = useState(() => dateInputValue(new Date(Date.now() - 89 * 86_400_000)));
  const [ate, setAte] = useState(() => dateInputValue(new Date()));
  const [agents, setAgents] = useState<QualityAgentSummaryDto[] | null>(null);

  const carregar = useCallback(() => {
    setAgents(null);
    qualityApi
      .agents({ from: new Date(`${de}T00:00:00`).toISOString(), to: new Date(`${ate}T23:59:59`).toISOString() })
      .then(setAgents)
      .catch(() => setAgents([]));
  }, [de, ate]);

  useEffect(carregar, [carregar]);

  function exportar(): void {
    if (!agents || agents.length === 0) return;
    const header = ["Atendente", "Avaliações", "Nota média", "Assunto mais frequente", "Ponto a melhorar mais frequente"];
    const linhas = agents.map((agent) =>
      [
        agent.userName,
        agent.evaluations,
        formatScore(agent.averageScore),
        agent.subjects[0] ? `${QUALITY_SUBJECT_LABELS[agent.subjects[0].subject]} (${agent.subjects[0].total})` : "",
        agent.recurringImprovements[0]
          ? `${agent.recurringImprovements[0].point} (${agent.recurringImprovements[0].total})`
          : "",
      ]
        .map((value) => `"${String(value).replace(/"/g, '""')}"`)
        .join(";"),
    );
    const csv = [header.join(";"), ...linhas].join("\n");
    // BOM para o Excel abrir os acentos corretamente.
    const blob = new Blob(["﻿", csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `qualidade-por-atendente-${de}-a-${ate}.csv`;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  }

  return (
    <div className="space-y-4">
      <Card>
        <div className="flex flex-wrap items-end gap-3">
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-slate-600">De</span>
            <Input type="date" value={de} max={ate} onChange={(event) => setDe(event.target.value)} />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-slate-600">Até</span>
            <Input type="date" value={ate} min={de} onChange={(event) => setAte(event.target.value)} />
          </label>
          <Button variant="outline" onClick={exportar} disabled={!agents || agents.length === 0}>
            <Download className="h-4 w-4" /> Exportar CSV
          </Button>
        </div>
        <p className="mt-2 text-xs text-slate-500">
          Avaliações descartadas ficam fora destes números.
        </p>
      </Card>

      {!agents ? <Spinner className="mx-auto mt-10 h-6 w-6" /> : null}
      {agents && agents.length === 0 ? (
        <EmptyState
          title="Nenhuma avaliação no período"
          description="Dispare uma análise para começar a acompanhar a evolução de cada atendente."
        />
      ) : null}

      {agents?.map((agent) => (
        <Card key={agent.userId ?? agent.userName}>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h3 className="text-sm font-semibold text-slate-900">{agent.userName}</h3>
              <p className="text-xs text-slate-500">
                {agent.evaluations} {agent.evaluations === 1 ? "avaliação" : "avaliações"} no período
              </p>
            </div>
            <span
              className={`inline-flex h-12 w-12 items-center justify-center rounded-xl text-lg font-semibold ring-1 ${scoreClasses(agent.averageScore)}`}
            >
              {formatScore(agent.averageScore)}
            </span>
          </div>

          <div className="mt-3 grid gap-3 md:grid-cols-2">
            <div>
              <h4 className="text-xs font-semibold text-slate-700">Média por critério</h4>
              <ul className="mt-2 space-y-1">
                {agent.averageByCriterion.map((criterion) => (
                  <li key={criterion.key} className="flex items-center justify-between gap-2 text-xs text-slate-600">
                    <span>{criterionLabel(criterion.key)}</span>
                    <span className={`rounded px-1.5 py-0.5 font-semibold ring-1 ${scoreClasses(criterion.score)}`}>
                      {formatScore(criterion.score)}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
            <div>
              <h4 className="text-xs font-semibold text-slate-700">Evolução da nota</h4>
              <ul className="mt-2 space-y-1">
                {agent.timeline.map((point) => (
                  <li key={point.month} className="flex items-center gap-2 text-xs text-slate-600">
                    <span className="w-20 shrink-0">{formatMonth(point.month)}</span>
                    {/* Barra em CSS puro: nota é uma escala de 0 a 10, e uma
                        biblioteca de gráfico para isso seria dependência nova. */}
                    <span className="h-2 flex-1 overflow-hidden rounded-full bg-slate-100">
                      <span
                        className="block h-full rounded-full bg-indigo-500"
                        style={{ width: `${(point.score / 10) * 100}%` }}
                      />
                    </span>
                    <span className="w-8 shrink-0 text-right font-semibold">{formatScore(point.score)}</span>
                  </li>
                ))}
              </ul>
            </div>
          </div>

          <div className="mt-3 grid gap-3 md:grid-cols-2">
            <div>
              <h4 className="text-xs font-semibold text-slate-700">Assuntos mais frequentes</h4>
              <ul className="mt-2 flex flex-wrap gap-2">
                {agent.subjects.map((subject) => (
                  <li
                    key={subject.subject}
                    className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] text-slate-700"
                  >
                    {QUALITY_SUBJECT_LABELS[subject.subject]} · {subject.total}
                  </li>
                ))}
              </ul>
            </div>
            <div>
              <h4 className="text-xs font-semibold text-slate-700">Pontos a melhorar que mais se repetem</h4>
              {agent.recurringImprovements.length === 0 ? (
                <p className="mt-2 text-xs text-slate-500">Nenhum ponto repetido.</p>
              ) : (
                <ul className="mt-2 space-y-1">
                  {agent.recurringImprovements.map((improvement) => (
                    <li key={improvement.point} className="text-xs text-slate-600">
                      {improvement.point} <span className="text-slate-400">({improvement.total}x)</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        </Card>
      ))}
    </div>
  );
}

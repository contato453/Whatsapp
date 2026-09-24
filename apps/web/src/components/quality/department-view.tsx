"use client";

import { useCallback, useEffect, useState } from "react";
import { Building2, Download } from "lucide-react";
import { qualityApi } from "@/lib/api";
import type { QualityAggregateDto, QualityDepartmentSummaryDto } from "@/lib/types";
import { Button, Card, EmptyState, Input, Spinner } from "@/components/ui";
import {
  QUALITY_OUTCOME_LABELS,
  QUALITY_SUBJECT_LABELS,
  criterionLabel,
  dateInputValue,
  formatMinutes,
  formatMonth,
  formatScore,
  scoreClasses,
} from "./quality-ui";

/**
 * VISÃO POR DEPARTAMENTO: como cada setor foi no período, com a linha do
 * escritório inteiro em cima.
 *
 * Ela responde o que a visão por atendente não responde. Aquela lista pessoa a
 * pessoa, e o dono do escritório pergunta "como o CS foi em agosto" — juntar as
 * pessoas na cabeça não dá a resposta, porque quem atende em dois setores
 * contaria duas vezes.
 *
 * NOTA E MÉTRICA ANDAM JUNTAS, de propósito. A nota é opinião da IA; o tempo
 * até a primeira resposta e os estouros do limite são medidos sem IA nenhuma,
 * em minutos de EXPEDIENTE, pela mesma régua do card "Atrasados agora". É o que
 * separa "a IA achou ruim" de "demoraram 48 minutos em média" numa conversa com
 * a equipe.
 *
 * Os números vêm agregados do servidor e NÃO são recalculados aqui: dois
 * arredondamentos em lugares diferentes divergiriam, e "o total não bate com a
 * soma das linhas" é como um painel perde quem o lê.
 */
export function DepartmentView() {
  const [de, setDe] = useState(() => dateInputValue(new Date(Date.now() - 89 * 86_400_000)));
  const [ate, setAte] = useState(() => dateInputValue(new Date()));
  const [dados, setDados] = useState<{
    departments: QualityDepartmentSummaryDto[];
    overall: QualityAggregateDto;
  } | null>(null);

  const carregar = useCallback(() => {
    setDados(null);
    qualityApi
      .departments({
        from: new Date(`${de}T00:00:00`).toISOString(),
        to: new Date(`${ate}T23:59:59`).toISOString(),
      })
      .then(setDados)
      .catch(() => setDados({ departments: [], overall: null as unknown as QualityAggregateDto }));
  }, [de, ate]);

  useEffect(carregar, [carregar]);

  function exportar(): void {
    if (!dados || dados.departments.length === 0) return;
    const header = [
      "Departamento",
      "Avaliações",
      "Conversas",
      "Atendentes",
      "Nota média",
      "1ª resposta (min úteis)",
      "Tempo médio (min úteis)",
      "Estouros do limite",
      "Mensagens enviadas",
      "Mensagens recebidas",
    ];
    const linha = (nome: string, bloco: QualityAggregateDto): string =>
      [
        nome,
        bloco.evaluations,
        bloco.conversations,
        bloco.agents,
        formatScore(bloco.averageScore),
        bloco.metrics.firstResponseMinutes ?? "",
        bloco.metrics.avgResponseMinutes ?? "",
        bloco.metrics.limitBreaches,
        bloco.metrics.messagesSent,
        bloco.metrics.messagesReceived,
      ]
        .map((value) => `"${String(value).replace(/"/g, '""')}"`)
        .join(";");

    const csv = [
      header.join(";"),
      ...dados.departments.map((department) => linha(department.departmentName, department)),
      linha("TODOS OS DEPARTAMENTOS", dados.overall),
    ].join("\n");
    // BOM para o Excel abrir os acentos corretamente.
    const blob = new Blob(["﻿", csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `qualidade-por-departamento-${de}-a-${ate}.csv`;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  }

  const vazio = dados !== null && dados.departments.length === 0;

  return (
    <div className="space-y-4">
      <Card className="p-5">
        <div className="flex flex-wrap items-end gap-3">
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-slate-600">Período avaliado de</span>
            <Input type="date" value={de} max={ate} onChange={(event) => setDe(event.target.value)} />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-slate-600">Até</span>
            <Input type="date" value={ate} min={de} onChange={(event) => setAte(event.target.value)} />
          </label>
          <Button variant="outline" onClick={exportar} disabled={vazio || !dados}>
            <Download className="h-4 w-4" /> Exportar CSV
          </Button>
        </div>
        <p className="mt-2 text-xs text-slate-500">
          O setor é o que a conversa tinha quando foi avaliada: transferir a conversa depois não muda o
          relatório do mês passado. O recorte é pelo período avaliado, e avaliações descartadas ficam fora.
        </p>
      </Card>

      {!dados ? <Spinner className="mx-auto mt-10 h-6 w-6" /> : null}
      {vazio ? (
        <EmptyState
          icon={<Building2 className="h-8 w-8" />}
          title="Nenhuma avaliação no período"
          description="Dispare uma análise para começar a acompanhar o atendimento por setor. Avaliações feitas antes desta tela existir não têm setor gravado e não aparecem aqui."
        />
      ) : null}

      {dados && !vazio ? (
        <>
          <Bloco titulo="Todos os departamentos" destaque bloco={dados.overall} />
          {dados.departments.map((department) => (
            <Bloco
              key={department.departmentId ?? "none"}
              titulo={department.departmentName}
              bloco={department}
            />
          ))}
        </>
      ) : null}
    </div>
  );
}

function Bloco({
  titulo,
  bloco,
  destaque,
}: {
  titulo: string;
  bloco: QualityAggregateDto;
  destaque?: boolean;
}) {
  return (
    <Card className={`p-5 ${destaque ? "ring-2 ring-brand-100" : ""}`}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold text-slate-900">{titulo}</h3>
          <p className="text-xs text-slate-500">
            {bloco.conversations} {bloco.conversations === 1 ? "conversa" : "conversas"} ·{" "}
            {bloco.evaluations} {bloco.evaluations === 1 ? "avaliação" : "avaliações"} · {bloco.agents}{" "}
            {bloco.agents === 1 ? "atendente" : "atendentes"}
            {bloco.partialEvaluations > 0 ? (
              <span className="text-amber-700"> · {bloco.partialEvaluations} parcial(is)</span>
            ) : null}
          </p>
        </div>
        <span
          className={`inline-flex h-12 w-12 items-center justify-center rounded-xl text-lg font-semibold ring-1 ${scoreClasses(bloco.averageScore)}`}
        >
          {formatScore(bloco.averageScore)}
        </span>
      </div>

      {/* As objetivas primeiro: é o número duro que sustenta a conversa com a
          equipe, e a nota da IA vem logo abaixo para explicá-lo. */}
      <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Celula
          rotulo="1ª resposta"
          valor={formatMinutes(bloco.metrics.firstResponseMinutes)}
          dica={`Média em minutos de expediente, sobre ${bloco.metrics.firstResponseMeasured} avaliação(ões) com resposta medida.`}
        />
        <Celula
          rotulo="Tempo médio"
          valor={formatMinutes(bloco.metrics.avgResponseMinutes)}
          dica={`Ponderado por ${bloco.metrics.responsesMeasured} resposta(s) medida(s), em minutos de expediente.`}
        />
        <Celula
          rotulo="Estouros do limite"
          valor={String(bloco.metrics.limitBreaches)}
          dica={`Em ${bloco.metrics.breachedEvaluations} avaliação(ões) houve ao menos um estouro do limite de resposta.`}
        />
        <Celula
          rotulo="Mensagens"
          valor={`${bloco.metrics.messagesSent} / ${bloco.metrics.messagesReceived}`}
          dica="Enviadas pela equipe / recebidas do cliente. As recebidas são da conversa, contadas uma vez só."
        />
      </div>

      <div className="mt-3 grid gap-3 md:grid-cols-2">
        <div>
          <h4 className="text-xs font-semibold text-slate-700">Média por critério</h4>
          <ul className="mt-2 space-y-1">
            {bloco.averageByCriterion.map((criterion) => (
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
            {bloco.timeline.map((point) => (
              <li key={point.month} className="flex items-center gap-2 text-xs text-slate-600">
                <span className="w-20 shrink-0">{formatMonth(point.month)}</span>
                {/* Barra em CSS puro, como na visão por atendente: nota é uma
                    escala de 0 a 10, e biblioteca de gráfico para isso seria
                    dependência nova. */}
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
          <h4 className="text-xs font-semibold text-slate-700">Desfecho das conversas</h4>
          <ul className="mt-2 flex flex-wrap gap-2">
            {bloco.metrics.outcomes.map((item) => (
              <li key={item.outcome} className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] text-slate-700">
                {QUALITY_OUTCOME_LABELS[item.outcome]} · {item.total}
              </li>
            ))}
          </ul>
          <h4 className="mt-3 text-xs font-semibold text-slate-700">Assuntos mais frequentes</h4>
          <ul className="mt-2 flex flex-wrap gap-2">
            {bloco.subjects.map((subject) => (
              <li key={subject.subject} className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] text-slate-700">
                {QUALITY_SUBJECT_LABELS[subject.subject]} · {subject.total}
              </li>
            ))}
          </ul>
        </div>
        <div>
          <h4 className="text-xs font-semibold text-slate-700">Pontos a melhorar que mais se repetem</h4>
          {bloco.recurringImprovements.length === 0 ? (
            <p className="mt-2 text-xs text-slate-500">Nenhum ponto repetido.</p>
          ) : (
            <ul className="mt-2 space-y-1">
              {bloco.recurringImprovements.map((improvement) => (
                <li key={improvement.point} className="text-xs text-slate-600">
                  {improvement.point} <span className="text-slate-400">({improvement.total}x)</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </Card>
  );
}

function Celula({ rotulo, valor, dica }: { rotulo: string; valor: string; dica: string }) {
  return (
    <div className="rounded-lg bg-slate-50 px-3 py-2" title={dica}>
      <p className="text-[11px] text-slate-500">{rotulo}</p>
      <p className="text-sm font-semibold text-slate-800">{valor}</p>
    </div>
  );
}

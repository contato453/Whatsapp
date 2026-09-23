"use client";

import { useEffect, useState } from "react";
import { AlertTriangle, MessageSquare, Trash2, Undo2 } from "lucide-react";
import Link from "next/link";
import { qualityApi } from "@/lib/api";
import type { QualityEvaluationDto, QualityTranscriptDto } from "@/lib/types";
import { Badge, Button, Card, Spinner, Textarea, Tooltip } from "@/components/ui";
import { cn } from "@/lib/utils";
import {
  QUALITY_CONFIDENCE_LABELS,
  QUALITY_OUTCOME_LABELS,
  QUALITY_SUBJECT_LABELS,
  criterionDescription,
  criterionLabel,
  formatDate,
  formatDateTime,
  formatMinutes,
  formatScore,
  scoreClasses,
} from "./quality-ui";

/**
 * O DETALHE DE UMA AVALIAÇÃO: métricas medidas, nota geral, nota por critério
 * com justificativa e link para as mensagens citadas, assunto, plano de ação,
 * cobertura e o selo de PARCIAL.
 *
 * O comentário do administrador fica AO LADO da nota, nunca por cima dela: a
 * nota é da IA, e um campo que a corrigisse transformaria o painel em opinião
 * assinada por um número que a IA deu.
 */
export function EvaluationDetail({
  evaluation,
  runId,
  itemId,
  onChanged,
}: {
  evaluation: QualityEvaluationDto;
  runId: string;
  /** Quando vem, a faixa oferece as transcrições dos áudios do período. */
  itemId?: string;
  onChanged: (evaluation: QualityEvaluationDto) => void;
}) {
  const [comentario, setComentario] = useState(evaluation.adminComment ?? "");
  const [salvando, setSalvando] = useState(false);
  const [trabalhando, setTrabalhando] = useState(false);

  async function salvarComentario(): Promise<void> {
    setSalvando(true);
    try {
      onChanged(await qualityApi.comment(evaluation.id, comentario));
    } finally {
      setSalvando(false);
    }
  }

  async function alternarDescarte(): Promise<void> {
    setTrabalhando(true);
    try {
      onChanged(
        evaluation.discardedAt
          ? await qualityApi.restore(evaluation.id)
          : await qualityApi.discard(evaluation.id, comentario || undefined),
      );
    } finally {
      setTrabalhando(false);
    }
  }

  return (
    <Card className={cn("p-5", evaluation.discardedAt && "opacity-70")}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-sm font-semibold text-slate-900">{evaluation.userName}</h3>
            <Badge className="bg-slate-100 text-slate-700">
              {QUALITY_SUBJECT_LABELS[evaluation.subject]}
            </Badge>
            {evaluation.partial ? (
              <Tooltip
                label={`Parte da conversa não chegou legível à avaliação: a cobertura foi de ${evaluation.coveragePercent}%.`}
              >
                <Badge className="bg-amber-50 text-amber-700">
                  <AlertTriangle className="h-3 w-3" /> Parcial
                </Badge>
              </Tooltip>
            ) : null}
            {evaluation.discardedAt ? (
              <Badge className="bg-slate-200 text-slate-600">Descartada</Badge>
            ) : null}
          </div>
          <p className="mt-1 text-xs text-slate-500">
            {evaluation.conversationTitle ?? "Conversa sem título"} · período avaliado de{" "}
            {formatDate(evaluation.periodFrom)} a {formatDate(evaluation.periodTo)} · analisada em{" "}
            {formatDateTime(evaluation.createdAt)} · cobertura {evaluation.coveragePercent}% · confiança da
            análise: {QUALITY_CONFIDENCE_LABELS[evaluation.confidence]}
          </p>
        </div>
        <div className="flex items-center gap-3">
          <span
            className={`inline-flex h-12 w-12 items-center justify-center rounded-xl text-lg font-semibold ring-1 ${scoreClasses(evaluation.overallScore)}`}
          >
            {formatScore(evaluation.overallScore)}
          </span>
          <Button variant="ghost" className="print:hidden" onClick={alternarDescarte} disabled={trabalhando}>
            {evaluation.discardedAt ? <Undo2 className="h-4 w-4" /> : <Trash2 className="h-4 w-4" />}
            {evaluation.discardedAt ? "Restaurar" : "Descartar"}
          </Button>
        </div>
      </div>

      <Metricas evaluation={evaluation} />

      <div className="mt-4 space-y-3">
        {evaluation.criteria.map((criterion) => (
          <div key={criterion.key} className="rounded-lg border border-slate-200 p-3">
            <div className="flex items-start justify-between gap-3">
              <Tooltip label={criterionDescription(criterion.key)}>
                <span className="text-xs font-semibold text-slate-700">{criterionLabel(criterion.key)}</span>
              </Tooltip>
              <span
                className={`shrink-0 rounded-md px-2 py-0.5 text-xs font-semibold ring-1 ${scoreClasses(criterion.score)}`}
              >
                {formatScore(criterion.score)}
              </span>
            </div>
            <p className="mt-2 text-xs text-slate-600">{criterion.justification}</p>
            {criterion.messageIds.length > 0 ? (
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <span className="text-[11px] text-slate-400">Mensagens citadas:</span>
                {criterion.messageIds.map((messageId, index) => (
                  <Link
                    key={messageId}
                    // O link abre a conversa na mensagem citada, pelo caminho que
                    // a Inbox já entende — nada de rota nova só para conferir.
                    href={`/inbox/${evaluation.conversationId}?messageId=${messageId}`}
                    className="rounded bg-slate-100 px-1.5 py-0.5 text-[11px] text-brand-600 hover:bg-slate-200"
                  >
                    trecho {index + 1}
                  </Link>
                ))}
              </div>
            ) : null}
          </div>
        ))}
      </div>

      <div className="mt-4 grid gap-3 md:grid-cols-2">
        <div className="rounded-lg bg-amber-50 p-3 ring-1 ring-amber-200">
          <h4 className="text-xs font-semibold text-amber-800">Plano de ação</h4>
          {evaluation.actionPlan.improvements.length === 0 ? (
            <p className="mt-1 text-xs text-amber-700">Nenhum ponto a melhorar apontado.</p>
          ) : (
            <ul className="mt-2 space-y-2">
              {evaluation.actionPlan.improvements.map((improvement, index) => (
                <li key={`${improvement.point}-${index}`} className="text-xs text-amber-900">
                  <span className="font-medium">{improvement.point}</span>
                  <span className="mt-0.5 block text-amber-700">{improvement.action}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="rounded-lg bg-emerald-50 p-3 ring-1 ring-emerald-200">
          <h4 className="text-xs font-semibold text-emerald-800">Pontos fortes</h4>
          {evaluation.actionPlan.strengths.length === 0 ? (
            <p className="mt-1 text-xs text-emerald-700">Nenhum ponto forte registrado.</p>
          ) : (
            <ul className="mt-2 list-disc space-y-1 pl-4">
              {evaluation.actionPlan.strengths.map((strength, index) => (
                <li key={`${strength}-${index}`} className="text-xs text-emerald-900">
                  {strength}
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      {itemId ? <Transcricoes runId={runId} itemId={itemId} /> : null}

      {/* NO PAPEL o comentário vira TEXTO, e o editor não vai junto. Campo de
          digitação impresso sai como caixa vazia, e o que o administrador
          escreveu precisa aparecer no relatório: é a única linha dele num
          documento que o resto é da IA. Sem comentário gravado, nada é
          impresso. */}
      {evaluation.adminComment ? (
        <div className="mt-4 hidden print:block">
          <h4 className="text-xs font-semibold text-slate-700">Comentário do administrador</h4>
          <p className="mt-1 whitespace-pre-wrap text-xs text-slate-700">{evaluation.adminComment}</p>
        </div>
      ) : null}

      <div className="mt-4 print:hidden">
        <h4 className="flex items-center gap-1 text-xs font-semibold text-slate-700">
          <MessageSquare className="h-3.5 w-3.5" /> Comentário do administrador
        </h4>
        <p className="mt-1 text-[11px] text-slate-500">
          Fica registrado ao lado da avaliação e não altera a nota: a nota é da IA.
        </p>
        <Textarea
          className="mt-2"
          rows={2}
          value={comentario}
          onChange={(event) => setComentario(event.target.value)}
          placeholder="Anotação sua sobre esta avaliação"
        />
        <Button className="mt-2" variant="secondary" onClick={salvarComentario} disabled={salvando}>
          {salvando ? <Spinner className="h-4 w-4" /> : null}
          Salvar comentário
        </Button>
      </div>
    </Card>
  );
}

function Metricas({ evaluation }: { evaluation: QualityEvaluationDto }) {
  const { metrics } = evaluation;
  const celulas: Array<{ label: string; value: string; hint?: string }> = [
    {
      label: "Primeira resposta",
      value: formatMinutes(metrics.firstResponseMinutes),
      hint: "Contado só dentro do expediente configurado em Parâmetros.",
    },
    { label: "Tempo médio", value: formatMinutes(metrics.avgResponseMinutes), hint: `${metrics.responsesMeasured} respostas medidas` },
    { label: "Limite estourado", value: `${metrics.limitBreaches}x` },
    { label: "Mensagens enviadas", value: String(metrics.messagesSent) },
    { label: "Desfecho", value: QUALITY_OUTCOME_LABELS[metrics.outcome] },
  ];
  return (
    <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-5">
      {celulas.map((celula) => (
        <div key={celula.label} className="rounded-lg bg-slate-50 p-2">
          <p className="text-[11px] text-slate-500">{celula.label}</p>
          <p className="text-sm font-semibold text-slate-800" title={celula.hint}>
            {celula.value}
          </p>
        </div>
      ))}
    </div>
  );
}

/**
 * As transcrições dos áudios do período, para o administrador LER o que foi dito
 * sem precisar ouvir. Íntegras, sem máscara: é conteúdo da conversa que ele já
 * pode abrir no chat — a máscara existe para o que sai para a IA.
 */
function Transcricoes({ runId, itemId }: { runId: string; itemId: string }) {
  const [aberto, setAberto] = useState(false);
  const [carregando, setCarregando] = useState(false);
  const [transcricoes, setTranscricoes] = useState<QualityTranscriptDto[] | null>(null);

  useEffect(() => {
    if (!aberto || transcricoes) return;
    setCarregando(true);
    qualityApi
      .transcripts(runId, itemId)
      .then(setTranscricoes)
      .catch(() => setTranscricoes([]))
      .finally(() => setCarregando(false));
  }, [aberto, transcricoes, runId, itemId]);

  return (
    // `print:hidden`: a transcrição é o conteúdo BRUTO da conversa, não o
    // julgamento. Num relatório de dez conversas viraria dezenas de páginas do
    // que o administrador já lê no chat — a mesma decisão de quando o PDF era
    // uma página à parte.
    <div className="mt-4 rounded-lg border border-slate-200 print:hidden">
      <button
        type="button"
        onClick={() => setAberto((atual) => !atual)}
        className="flex w-full items-center justify-between px-3 py-2 text-xs font-semibold text-slate-700"
      >
        Transcrições dos áudios do período
        <span className="text-slate-400">{aberto ? "ocultar" : "mostrar"}</span>
      </button>
      {aberto ? (
        <div className="space-y-2 px-3 pb-3">
          {carregando ? <Spinner className="h-4 w-4" /> : null}
          {transcricoes && transcricoes.length === 0 ? (
            <p className="text-xs text-slate-500">Nenhum áudio neste período.</p>
          ) : null}
          {transcricoes?.map((transcript) => (
            <div key={transcript.messageId} className="rounded bg-slate-50 p-2">
              <p className="text-[11px] text-slate-500">
                {transcript.direction === "inbound" ? "Cliente" : "Atendimento"} ·{" "}
                {formatDateTime(transcript.at)}
                {transcript.durationSeconds ? ` · ${Math.round(transcript.durationSeconds)}s` : ""}
              </p>
              <p className="mt-1 text-xs text-slate-700">
                {transcript.text ?? "Este áudio não pôde ser transcrito."}
              </p>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

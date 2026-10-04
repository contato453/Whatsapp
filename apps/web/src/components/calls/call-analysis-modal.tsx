"use client";

import { useEffect, useState } from "react";
import { AlertTriangle, Sparkles } from "lucide-react";
import {
  CALL_ANALYSIS_LIMITS,
  CALL_SUMMARY_SECTION_LABELS,
  type CallAnalysisDto,
  type CallSummary,
} from "@azvchat/shared";
import { ApiError, callsApi } from "@/lib/api";
import type { CallLogDto } from "@/lib/types";
import { Button, Modal, Spinner } from "@/components/ui";

/**
 * Transcrição e resumo da gravação de uma ligação, pela IA.
 *
 * Três coisas que a tela precisa dizer, e diz sem esconder em "saiba mais":
 *   - a análise é COBRADA na conta OpenAI do escritório, então só começa com
 *     o clique de quem pode pedir (nunca ao abrir a janela);
 *   - a transcrição NÃO separa quem falou — a gravação mistura as duas vozes;
 *   - número e nome ditados são o que a transcrição mais erra, e por isso os
 *     "Dados citados" vêm com o pedido de conferir na gravação.
 */
export function CallAnalysisModal({
  call,
  canAnalyze,
  onClose,
  onAnalyzed,
  onRecordingMissing,
}: {
  call: CallLogDto;
  canAnalyze: boolean;
  onClose: () => void;
  onAnalyzed: (status: CallLogDto["analysis"]) => void;
  /** A API respondeu que a gravação não existe no AstraCalls. */
  onRecordingMissing?: () => void;
}) {
  const [analysis, setAnalysis] = useState<CallAnalysisDto | null>(null);
  const [loading, setLoading] = useState(call.analysis !== "none");
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (call.analysis === "none") return;
    let cancelled = false;
    callsApi
      .analysis(call.id)
      .then((data) => {
        if (!cancelled) setAnalysis(data.analysis);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : "Falha ao carregar a análise.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [call.id, call.analysis]);

  async function run() {
    setRunning(true);
    setError(null);
    try {
      const data = await callsApi.analyze(call.id);
      setAnalysis(data.analysis);
      onAnalyzed(data.analysis.summary ? "ready" : data.analysis.transcript != null ? "transcribed" : "none");
    } catch (err) {
      if (err instanceof ApiError && err.code === "recording_missing") onRecordingMissing?.();
      setError(err instanceof Error ? err.message : "Falha ao analisar a gravação.");
    } finally {
      setRunning(false);
    }
  }

  const title = `Resumo da ligação${call.contactName ? ` · ${call.contactName}` : ""}`;
  const hasSummary = Boolean(analysis?.summary);
  const noSpeech = analysis?.transcript === "";
  // Transcrita sem resumo (o resumo falhou da outra vez): o clique agora paga
  // só o resumo, e o texto do botão diz isso.
  const canRun = canAnalyze && call.hasRecording && !hasSummary && !noSpeech;
  const minutes = Math.max(1, Math.round((call.durationSeconds ?? 0) / 60));

  return (
    <Modal open onClose={onClose} title={title} wide>
      {loading ? (
        <div className="flex justify-center py-10">
          <Spinner className="h-6 w-6" />
        </div>
      ) : running ? (
        <div className="flex flex-col items-center gap-3 py-10 text-center text-sm text-slate-600">
          <Spinner className="h-6 w-6" />
          <p className="font-medium text-slate-900">
            {analysis?.transcript ? "Resumindo a ligação…" : "Transcrevendo a gravação…"}
          </p>
          <p className="max-w-sm text-xs text-slate-500">
            Ligações longas podem levar alguns minutos. Se fechar a janela, a análise continua e fica
            guardada nesta ligação.
          </p>
        </div>
      ) : (
        <div className="space-y-5 text-sm text-slate-700">
          {error && (
            <p className="rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700 ring-1 ring-rose-200">{error}</p>
          )}

          {analysis?.summary && <SummaryView summary={analysis.summary} />}

          {noSpeech && (
            <p className="rounded-lg bg-slate-50 px-3 py-2 text-slate-600 ring-1 ring-slate-200">
              Nenhuma fala foi reconhecida na gravação. Ela pode estar muda ou só com ruído.
            </p>
          )}

          {!hasSummary && !noSpeech && (
            <div className="space-y-3">
              {analysis?.transcript ? (
                <p>A transcrição já está pronta, mas o resumo não foi gerado. Peça de novo para tentar só o resumo.</p>
              ) : (
                <p>
                  A IA transcreve a gravação e resume o que foi conversado: o assunto, o que o cliente pediu, o que
                  ficou combinado e os próximos passos.
                </p>
              )}
              <ul className="list-disc space-y-1 pl-5 text-xs text-slate-500">
                <li>É cobrado na conta da OpenAI do escritório, por minuto de gravação ({minutes} min aqui).</li>
                <li>A transcrição não separa quem falou: a gravação mistura as duas vozes.</li>
                <li>Números e nomes ditados podem sair errados. Confira na gravação antes de usar.</li>
                <li>Gravações com mais de {CALL_ANALYSIS_LIMITS.maxSeconds / 60} minutos não são analisadas.</li>
              </ul>
              {!canAnalyze && (
                <p className="text-xs text-slate-500">Seu perfil não pode pedir a análise desta gravação.</p>
              )}
              {canAnalyze && !call.hasRecording && (
                <p className="text-xs text-slate-500">A gravação desta ligação não está mais disponível.</p>
              )}
            </div>
          )}

          {analysis?.transcript ? (
            <details className="rounded-lg ring-1 ring-slate-200">
              <summary className="cursor-pointer select-none px-3 py-2 text-xs font-medium text-slate-600 hover:bg-slate-50">
                Ver transcrição completa
              </summary>
              <div className="thin-scroll max-h-72 overflow-y-auto border-t border-slate-100 px-3 py-2">
                <p className="whitespace-pre-wrap text-xs leading-relaxed text-slate-700">{analysis.transcript}</p>
                {analysis.transcriptTruncated && (
                  <p className="mt-2 text-xs text-amber-700">A transcrição foi cortada no fim por ser muito longa.</p>
                )}
              </div>
            </details>
          ) : null}

          {analysis && (analysis.summarizedAt || analysis.transcribedAt) && (
            <p className="text-[11px] text-slate-400">
              Gerado pela IA em {formatWhen(analysis.summarizedAt ?? analysis.transcribedAt ?? "")}
              {analysis.requestedByName ? ` · pedido por ${analysis.requestedByName}` : ""}
              {analysis.model ? ` · ${analysis.model}` : ""}
            </p>
          )}

          <div className="flex justify-end gap-2">
            <Button variant="outline" size="sm" onClick={onClose}>
              Fechar
            </Button>
            {canRun && (
              <Button size="sm" onClick={() => void run()}>
                <Sparkles className="h-4 w-4" />
                {analysis?.transcript ? "Gerar o resumo" : "Transcrever e resumir"}
              </Button>
            )}
          </div>
        </div>
      )}
    </Modal>
  );
}

function SummaryView({ summary }: { summary: CallSummary }) {
  const sections = (["clientRequests", "agreements", "nextSteps"] as const).filter(
    (key) => summary[key].length > 0,
  );
  return (
    <div className="space-y-4">
      <div>
        <p className="text-base font-semibold text-slate-900">{summary.subject}</p>
        {summary.summary && <p className="mt-1 leading-relaxed">{summary.summary}</p>}
      </div>
      {sections.map((key) => (
        <div key={key}>
          <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-500">
            {CALL_SUMMARY_SECTION_LABELS[key]}
          </p>
          <ul className="list-disc space-y-0.5 pl-5">
            {summary[key].map((item, index) => (
              <li key={index}>{item}</li>
            ))}
          </ul>
        </div>
      ))}
      {summary.mentionedData.length > 0 && (
        <div className="rounded-lg bg-amber-50 px-3 py-2 ring-1 ring-amber-200">
          <p className="mb-1 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-amber-800">
            <AlertTriangle className="h-3.5 w-3.5" />
            {CALL_SUMMARY_SECTION_LABELS.mentionedData}
          </p>
          <ul className="list-disc space-y-0.5 pl-5 text-amber-900">
            {summary.mentionedData.map((item, index) => (
              <li key={index}>{item}</li>
            ))}
          </ul>
          <p className="mt-1 text-[11px] text-amber-800">
            Número e nome ditados são o que a transcrição mais erra. Confira na gravação antes de usar.
          </p>
        </div>
      )}
      {summary.caveat && <p className="text-xs italic text-slate-500">Observação da IA: {summary.caveat}</p>}
    </div>
  );
}

function formatWhen(iso: string): string {
  if (!iso) return "";
  return new Date(iso).toLocaleString("pt-BR", {
    day: "2-digit",
    month: "2-digit",
    year: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

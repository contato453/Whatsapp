"use client";

import { useCallback, useEffect, useState } from "react";
import { ChevronRight, Download, RefreshCw } from "lucide-react";
import { RealtimeEvents } from "@azvchat/shared";
import { qualityApi } from "@/lib/api";
import { downloadQualityRunPdf } from "@/lib/quality-pdf";
import { useSocket } from "@/lib/socket-context";
import type { QualityEvaluationDto, QualityRunDetailDto, QualityRunDto } from "@/lib/types";
import { Badge, Button, Card, EmptyState, Spinner } from "@/components/ui";
import { EvaluationDetail } from "./evaluation-detail";
import {
  ITEM_STATUS_TONE,
  RUN_STATUS_TONE,
  formatCostMicros,
  formatDateTime,
  itemReasonText,
  itemStatusLabel,
  runReasonText,
  runStatusLabel,
} from "./quality-ui";

const TONE_CLASSES: Record<string, string> = {
  slate: "bg-slate-100 text-slate-700",
  blue: "bg-sky-50 text-sky-700",
  green: "bg-emerald-50 text-emerald-700",
  amber: "bg-amber-50 text-amber-700",
  red: "bg-red-50 text-red-700",
};

/**
 * A LISTA DE ANÁLISES e o detalhe de cada uma.
 *
 * O estado de um disparo muda enquanto a tela está aberta (na fila →
 * transcrevendo → analisando → concluída), e é o evento `quality:run` que
 * atualiza a linha: ele vai só para a sala da organização, que é a sala de
 * administrador. Quando o socket não está disponível, o botão "Atualizar" faz o
 * mesmo trabalho na mão — a tela nunca depende do tempo real para funcionar.
 */
export function RunList({ refreshToken }: { refreshToken: number }) {
  const socket = useSocket();
  const [runs, setRuns] = useState<QualityRunDto[] | null>(null);
  const [aberta, setAberta] = useState<string | null>(null);
  /**
   * A análise cujo PDF está sendo montado. O botão trava enquanto isso: o
   * detalhe vem da API antes de o documento existir, e dois cliques baixariam
   * dois arquivos iguais.
   */
  const [baixando, setBaixando] = useState<string | null>(null);
  const [erroPdf, setErroPdf] = useState<string | null>(null);

  /**
   * O PDF NÃO DEPENDE DE O CARTÃO ESTAR ABERTO. Ele busca o detalhe da análise
   * e monta o documento — abrir a linha na tela é outra coisa, e amarrar as
   * duas faria o download esperar uma renderização que ninguém pediu.
   */
  async function baixarPdf(runId: string): Promise<void> {
    setErroPdf(null);
    setBaixando(runId);
    try {
      await downloadQualityRunPdf(await qualityApi.run(runId));
    } catch {
      setErroPdf("Não foi possível gerar o PDF desta análise. Tente de novo.");
    } finally {
      setBaixando(null);
    }
  }

  const carregar = useCallback(() => {
    qualityApi
      .runs()
      .then(setRuns)
      .catch(() => setRuns([]));
  }, []);

  useEffect(carregar, [carregar, refreshToken]);

  useEffect(() => {
    if (!socket) return;
    const aplicar = (payload: { run: QualityRunDto }): void => {
      setRuns((atual) => {
        if (!atual) return atual;
        const existe = atual.some((run) => run.id === payload.run.id);
        return existe
          ? atual.map((run) => (run.id === payload.run.id ? payload.run : run))
          : [payload.run, ...atual];
      });
    };
    socket.on(RealtimeEvents.QualityRun, aplicar);
    return () => {
      socket.off(RealtimeEvents.QualityRun, aplicar);
    };
  }, [socket]);

  if (!runs) return <Spinner className="mx-auto mt-10 h-6 w-6" />;
  if (runs.length === 0) {
    return (
      <EmptyState
        title="Nenhuma análise disparada ainda"
        description="Escolha conversas e um período na aba Nova análise para começar."
      />
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-end gap-3">
        {erroPdf ? <span className="text-xs text-red-600">{erroPdf}</span> : null}
        <Button variant="ghost" size="sm" onClick={carregar}>
          <RefreshCw className="h-3.5 w-3.5" /> Atualizar
        </Button>
      </div>
      {runs.map((run) => (
        <Card key={run.id} className="p-4">
          <div className="flex items-start gap-3">
          <button
            type="button"
            className="flex min-w-0 flex-1 items-center justify-between gap-3 text-left"
            onClick={() => setAberta((atual) => (atual === run.id ? null : run.id))}
          >
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <Badge className={TONE_CLASSES[RUN_STATUS_TONE[run.status]]}>{runStatusLabel(run.status)}</Badge>
                {/* O NOME DA CONVERSA vem antes do contador: o escritório tem
                    quatro grupos "Demandas CS" de clientes diferentes, e sem o
                    nome as linhas ficavam indistinguíveis. O `title` leva a
                    lista inteira, porque o cartão só mostra o primeiro. */}
                {run.conversationTitles.length > 0 ? (
                  <span
                    className="max-w-[18rem] truncate text-sm font-medium text-slate-800"
                    title={run.conversationTitles.join(", ")}
                  >
                    {run.conversationTitles[0]}
                  </span>
                ) : null}
                {run.conversationTitles.length > 1 ? (
                  <Badge className="bg-slate-100 text-slate-600" title={run.conversationTitles.join(", ")}>
                    +{run.conversationTitles.length - 1}
                  </Badge>
                ) : null}
                <span
                  className={
                    run.conversationTitles.length > 0
                      ? "text-xs text-slate-500"
                      : "text-sm font-medium text-slate-800"
                  }
                >
                  {run.conversationCount} {run.conversationCount === 1 ? "conversa" : "conversas"}
                </span>
                <span className="text-xs text-slate-500">
                  período de {formatDateTime(run.periodFrom)} a {formatDateTime(run.periodTo)}
                </span>
              </div>
              <p className="mt-1 text-xs text-slate-500">
                disparada por {run.requestedByName} em {formatDateTime(run.createdAt)} · modelo {run.model}
              </p>
              {runReasonText(run.failureReason) ? (
                <p className="mt-1 text-xs text-red-600">{runReasonText(run.failureReason)}</p>
              ) : null}
            </div>
            <ChevronRight
              className={`h-4 w-4 shrink-0 text-slate-400 transition-transform ${aberta === run.id ? "rotate-90" : ""}`}
            />
          </button>
          {/* O PDF só faz sentido quando há resultado: análise ainda rodando
              geraria um papel pela metade. */}
          {run.status === "completed" ? (
            <Button
              variant="outline"
              size="sm"
              className="shrink-0"
              onClick={() => void baixarPdf(run.id)}
              disabled={baixando === run.id}
              title="Baixa o relatório em PDF, A4 retrato"
            >
              {baixando === run.id ? (
                <Spinner className="h-3.5 w-3.5" />
              ) : (
                <Download className="h-3.5 w-3.5" />
              )}
              Baixar PDF
            </Button>
          ) : null}
          </div>
          {aberta === run.id ? <RunDetail runId={run.id} status={run.status} /> : null}
        </Card>
      ))}
    </div>
  );
}

function RunDetail({ runId, status }: { runId: string; status: QualityRunDto["status"] }) {
  const [detail, setDetail] = useState<QualityRunDetailDto | null>(null);

  const carregar = useCallback(() => {
    qualityApi
      .run(runId)
      .then(setDetail)
      .catch(() => setDetail(null));
  }, [runId]);

  useEffect(carregar, [carregar]);
  // Enquanto o disparo está andando, o detalhe volta a ser lido: os itens mudam
  // de estado um por um, e só o disparo inteiro viaja no evento de tempo real.
  useEffect(() => {
    if (status === "completed" || status === "failed") return;
    const timer = setInterval(carregar, 5_000);
    return () => clearInterval(timer);
  }, [status, carregar]);

  function trocar(evaluation: QualityEvaluationDto): void {
    setDetail((atual) =>
      atual
        ? {
            ...atual,
            items: atual.items.map((item) => ({
              ...item,
              evaluations: item.evaluations.map((current) =>
                current.id === evaluation.id ? evaluation : current,
              ),
            })),
          }
        : atual,
    );
  }

  if (!detail) return <Spinner className="mx-auto mt-4 h-5 w-5" />;

  return (
    <div className="mt-4 space-y-4 border-t border-slate-200 pt-4">
      {detail.items.map((item) => (
        <div key={item.id} className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <Badge className={TONE_CLASSES[ITEM_STATUS_TONE[item.status]]}>{itemStatusLabel(item.status)}</Badge>
            <span className="text-sm font-medium text-slate-800">
              {item.conversationTitle ?? "Conversa sem título"}
            </span>
            {item.coveragePercent != null ? (
              <span className="text-xs text-slate-500">cobertura {item.coveragePercent}%</span>
            ) : null}
            {item.audioCount > 0 ? (
              <span className="text-xs text-slate-500">
                {item.audioTranscribedCount} de {item.audioCount} áudios transcritos
              </span>
            ) : null}
            {item.truncated ? (
              <Badge className="bg-amber-50 text-amber-700">Conversa recortada</Badge>
            ) : null}
            {item.costMicros != null ? (
              <span className="text-xs text-slate-400">custo {formatCostMicros(item.costMicros)}</span>
            ) : null}
          </div>
          {itemReasonText(item) ? (
            <p className="rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-600">{itemReasonText(item)}</p>
          ) : null}
          {item.evaluations.map((evaluation) => (
            <EvaluationDetail
              key={evaluation.id}
              evaluation={evaluation}
              runId={runId}
              itemId={item.id}
              onChanged={trocar}
            />
          ))}
        </div>
      ))}
    </div>
  );
}

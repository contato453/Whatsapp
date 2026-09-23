"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronRight, FileText, RefreshCw } from "lucide-react";
import { RealtimeEvents } from "@azvchat/shared";
import { qualityApi } from "@/lib/api";
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
   * A análise que está indo para o papel. O botão PDF a ABRE e a marca; quem
   * chama `window.print()` é o detalhe, quando termina de carregar — imprimir
   * antes mandaria uma folha com o spinner no meio.
   */
  const [imprimindo, setImprimindo] = useState<string | null>(null);

  function imprimir(runId: string): void {
    setAberta(runId);
    setImprimindo(runId);
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
      <div className="flex justify-end">
        <Button variant="ghost" size="sm" onClick={carregar}>
          <RefreshCw className="h-3.5 w-3.5" /> Atualizar
        </Button>
      </div>
      {runs.map((run) => (
        <Card key={run.id} className="p-4" {...(imprimindo === run.id ? { "data-imprimir": "true" } : {})}>
          <div className="flex items-start gap-3">
          <button
            type="button"
            className="flex min-w-0 flex-1 items-center justify-between gap-3 text-left"
            onClick={() => setAberta((atual) => (atual === run.id ? null : run.id))}
          >
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <Badge className={TONE_CLASSES[RUN_STATUS_TONE[run.status]]}>{runStatusLabel(run.status)}</Badge>
                <span className="text-sm font-medium text-slate-800">
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
              className={`h-4 w-4 shrink-0 text-slate-400 transition-transform print:hidden ${aberta === run.id ? "rotate-90" : ""}`}
            />
          </button>
          {/* O PDF só faz sentido quando há resultado: análise ainda rodando
              geraria um papel pela metade. */}
          {run.status === "completed" ? (
            <Button
              variant="outline"
              size="sm"
              className="shrink-0 print:hidden"
              onClick={() => imprimir(run.id)}
            >
              <FileText className="h-3.5 w-3.5" /> PDF
            </Button>
          ) : null}
          </div>
          {aberta === run.id ? (
            <RunDetail
              runId={run.id}
              status={run.status}
              aoFicarPronta={imprimindo === run.id ? () => setImprimindo(null) : undefined}
            />
          ) : null}
        </Card>
      ))}
    </div>
  );
}

function RunDetail({
  runId,
  status,
  aoFicarPronta,
}: {
  runId: string;
  status: QualityRunDto["status"];
  /** Vem preenchido só quando esta análise foi aberta para virar PDF. */
  aoFicarPronta?: () => void;
}) {
  const [detail, setDetail] = useState<QualityRunDetailDto | null>(null);
  const jaImprimiu = useRef(false);

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

  // A IMPRESSÃO ESPERA O DETALHE, e acontece UMA vez. `window.print()` trava o
  // navegador até a caixa fechar, então dispará-lo antes do conteúdo chegar
  // mandaria ao papel um cartão com o spinner no meio; e sem a trava do ref ele
  // voltaria a cada re-render enquanto a marca não fosse limpa, abrindo a caixa
  // de impressão em série. O quadro extra antes de imprimir existe porque a
  // marca `data-imprimir` e o conteúdo entram na MESMA passada do React: sem
  // ele, o navegador ainda não aplicou o CSS que esconde o resto da página.
  useEffect(() => {
    // Marca limpa = pedido terminado; destravar aqui é o que permite imprimir a
    // MESMA análise de novo sem fechar e reabrir o cartão.
    if (!aoFicarPronta) {
      jaImprimiu.current = false;
      return;
    }
    if (!detail || jaImprimiu.current) return;
    jaImprimiu.current = true;
    const quadro = requestAnimationFrame(() => {
      window.print();
      aoFicarPronta();
    });
    return () => cancelAnimationFrame(quadro);
  }, [detail, aoFicarPronta]);

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

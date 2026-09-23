"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { ArrowLeft, Printer } from "lucide-react";
import { qualityApi } from "@/lib/api";
import { useAuth } from "@/lib/auth-context";
import type { QualityRunDetailDto } from "@/lib/types";
import { Button, EmptyState, Spinner } from "@/components/ui";
import {
  QUALITY_CONFIDENCE_LABELS,
  QUALITY_OUTCOME_LABELS,
  QUALITY_SUBJECT_LABELS,
  criterionLabel,
  formatDateTime,
  formatMinutes,
  formatScore,
  itemReasonText,
  itemStatusLabel,
} from "@/components/quality/quality-ui";

/**
 * O RELATÓRIO DA ANÁLISE EM PAPEL — e é assim que sai o PDF.
 *
 * Quem gera o arquivo é o PRÓPRIO NAVEGADOR ("Salvar como PDF" na caixa de
 * impressão), e não uma biblioteca no projeto. Foi decisão, não falta: gerar
 * PDF no servidor traria uma dependência pesada (um navegador headless ou um
 * montador de PDF) para produzir o que o Chrome já produz, e cada mudança de
 * layout passaria a ter de ser feita duas vezes, uma na tela e outra no
 * gerador. Aqui a tela É o layout, então ela nunca diverge do papel.
 *
 * O que entra: o cabeçalho da análise, e de cada conversa as métricas
 * objetivas, as notas com justificativa, o assunto e o plano de ação. O que
 * NÃO entra são as transcrições dos áudios: elas são o conteúdo bruto da
 * conversa, e não o julgamento — num relatório de dez conversas virariam
 * dezenas de páginas do que o administrador já lê no chat.
 */
export default function QualityRunPrintPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const { user } = useAuth();
  const [run, setRun] = useState<QualityRunDetailDto | null>(null);
  const [erro, setErro] = useState(false);

  useEffect(() => {
    if (!params?.id) return;
    qualityApi
      .run(params.id)
      .then(setRun)
      .catch(() => setErro(true));
  }, [params?.id]);

  if (user && user.role !== "admin") {
    return (
      <div className="p-6">
        <EmptyState title="Área restrita" description="Esta tela é de administração do sistema." />
      </div>
    );
  }

  if (erro) {
    return (
      <div className="p-6">
        <EmptyState title="Análise não encontrada" description="Ela pode ter sido removida." />
      </div>
    );
  }

  if (!run) {
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner className="h-8 w-8" />
      </div>
    );
  }

  const avaliadas = run.items.filter((item) => item.evaluations.length > 0);
  const semAvaliacao = run.items.filter((item) => item.evaluations.length === 0);

  return (
    <div className="h-full overflow-y-auto bg-white print:overflow-visible">
      <div className="mx-auto max-w-4xl p-8 print:p-0">
        <div className="mb-6 flex items-center gap-2 print:hidden">
          <Button variant="ghost" onClick={() => router.push("/quality")}>
            <ArrowLeft className="h-4 w-4" /> Voltar
          </Button>
          <Button onClick={() => window.print()}>
            <Printer className="h-4 w-4" /> Imprimir ou salvar em PDF
          </Button>
        </div>

        <header className="border-b border-slate-300 pb-4">
          <h1 className="text-xl font-semibold text-slate-900">Avaliação de qualidade do atendimento</h1>
          <p className="mt-1 text-sm text-slate-600">
            Período avaliado: {formatDateTime(run.periodFrom)} a {formatDateTime(run.periodTo)}
          </p>
          <p className="text-sm text-slate-600">
            Análise disparada por {run.requestedByName} em {formatDateTime(run.createdAt)} · modelo{" "}
            {run.model} · {run.conversationCount}{" "}
            {run.conversationCount === 1 ? "conversa" : "conversas"}
          </p>
          <p className="mt-2 text-xs text-slate-500">
            As notas e o plano de ação foram produzidos por inteligência artificial a partir do texto das
            conversas. As métricas de tempo foram medidas pelo sistema, em minutos de expediente.
            Documento de uso interno.
          </p>
        </header>

        {avaliadas.map((item) => (
          <section key={item.id} className="mt-6 break-inside-avoid border-b border-slate-200 pb-6">
            <h2 className="text-base font-semibold text-slate-900">
              {item.conversationTitle ?? "Conversa sem título"}
            </h2>
            <p className="text-xs text-slate-500">
              Cobertura da análise: {item.coveragePercent ?? 0}%
              {item.partial ? " (parcial)" : ""}
              {item.audioCount > 0
                ? ` · ${item.audioTranscribedCount} de ${item.audioCount} áudios transcritos`
                : ""}
              {item.truncated ? " · conversa recortada por tamanho" : ""}
            </p>

            {item.evaluations.map((evaluation) => (
              <article key={evaluation.id} className="mt-4 break-inside-avoid">
                <div className="flex items-baseline justify-between gap-3 border-b border-slate-100 pb-1">
                  <h3 className="text-sm font-semibold text-slate-800">
                    {evaluation.userName}
                    {evaluation.discardedAt ? " (avaliação descartada)" : ""}
                  </h3>
                  <span className="text-sm font-semibold text-slate-900">
                    Nota geral {formatScore(evaluation.overallScore)} de 10
                  </span>
                </div>

                <p className="mt-2 text-xs text-slate-600">
                  Assunto: {QUALITY_SUBJECT_LABELS[evaluation.subject]} · Confiança da análise:{" "}
                  {QUALITY_CONFIDENCE_LABELS[evaluation.confidence]}
                </p>

                <table className="mt-2 w-full text-xs">
                  <tbody>
                    <tr>
                      <td className="py-0.5 pr-3 text-slate-500">Primeira resposta</td>
                      <td className="py-0.5 text-slate-800">
                        {formatMinutes(evaluation.metrics.firstResponseMinutes)}
                      </td>
                      <td className="py-0.5 pr-3 text-slate-500">Tempo médio</td>
                      <td className="py-0.5 text-slate-800">
                        {formatMinutes(evaluation.metrics.avgResponseMinutes)}
                      </td>
                    </tr>
                    <tr>
                      <td className="py-0.5 pr-3 text-slate-500">Limite estourado</td>
                      <td className="py-0.5 text-slate-800">{evaluation.metrics.limitBreaches}x</td>
                      <td className="py-0.5 pr-3 text-slate-500">Mensagens enviadas</td>
                      <td className="py-0.5 text-slate-800">{evaluation.metrics.messagesSent}</td>
                    </tr>
                    <tr>
                      <td className="py-0.5 pr-3 text-slate-500">Desfecho</td>
                      <td className="py-0.5 text-slate-800" colSpan={3}>
                        {QUALITY_OUTCOME_LABELS[evaluation.metrics.outcome]}
                      </td>
                    </tr>
                  </tbody>
                </table>

                <ul className="mt-3 space-y-1">
                  {evaluation.criteria.map((criterion) => (
                    <li key={criterion.key} className="text-xs text-slate-700">
                      <span className="font-medium">
                        {criterionLabel(criterion.key)}: {formatScore(criterion.score)}
                      </span>
                      <span className="block text-slate-600">{criterion.justification}</span>
                    </li>
                  ))}
                </ul>

                {evaluation.actionPlan.improvements.length > 0 ? (
                  <div className="mt-3">
                    <h4 className="text-xs font-semibold text-slate-800">Plano de ação</h4>
                    <ul className="mt-1 list-disc space-y-1 pl-4">
                      {evaluation.actionPlan.improvements.map((improvement, index) => (
                        <li key={`${improvement.point}-${index}`} className="text-xs text-slate-700">
                          <span className="font-medium">{improvement.point}</span>
                          <span className="block text-slate-600">{improvement.action}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}

                {evaluation.actionPlan.strengths.length > 0 ? (
                  <div className="mt-2">
                    <h4 className="text-xs font-semibold text-slate-800">Pontos fortes</h4>
                    <ul className="mt-1 list-disc space-y-0.5 pl-4">
                      {evaluation.actionPlan.strengths.map((strength, index) => (
                        <li key={`${strength}-${index}`} className="text-xs text-slate-700">
                          {strength}
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}

                {evaluation.adminComment ? (
                  <p className="mt-2 border-l-2 border-slate-300 pl-2 text-xs text-slate-600">
                    Comentário do administrador: {evaluation.adminComment}
                  </p>
                ) : null}
              </article>
            ))}
          </section>
        ))}

        {semAvaliacao.length > 0 ? (
          <section className="mt-6 break-inside-avoid">
            <h2 className="text-sm font-semibold text-slate-900">Conversas sem avaliação</h2>
            <ul className="mt-2 space-y-1">
              {semAvaliacao.map((item) => (
                <li key={item.id} className="text-xs text-slate-600">
                  <span className="font-medium">{item.conversationTitle ?? "Conversa sem título"}</span>
                  {" — "}
                  {itemReasonText(item) ?? itemStatusLabel(item.status)}
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        {avaliadas.length === 0 && semAvaliacao.length === 0 ? (
          <p className="mt-6 text-sm text-slate-500">Esta análise ainda não produziu resultado.</p>
        ) : null}
      </div>
    </div>
  );
}

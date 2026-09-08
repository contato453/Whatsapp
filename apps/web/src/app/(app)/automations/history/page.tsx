"use client";

import { useEffect, useState } from "react";
import {
  AUTOMATION_EXECUTION_STATUS_COLORS,
  AUTOMATION_EXECUTION_STATUS_LABELS,
  AUTOMATION_TRIGGER_LABELS,
} from "@azvchat/shared";
import { automationApi } from "@/lib/api";
import type { AutomationExecutionDetailDto, AutomationExecutionSummaryDto } from "@/lib/types";
import { Badge, Card, EmptyState, Modal, Spinner } from "@/components/ui";
import { AutomationTabs, AutomationsHeader } from "@/components/automations/automation-tabs";
import { History } from "lucide-react";

export default function AutomationHistoryPage() {
  const [executions, setExecutions] = useState<AutomationExecutionSummaryDto[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [detail, setDetail] = useState<AutomationExecutionDetailDto | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  useEffect(() => {
    automationApi
      .listExecutions()
      .then(setExecutions)
      .catch((err) => setError(err instanceof Error ? err.message : "Falha ao carregar o histórico"));
  }, []);

  async function openDetail(id: string) {
    setDetailLoading(true);
    try {
      setDetail(await automationApi.getExecution(id));
    } finally {
      setDetailLoading(false);
    }
  }

  return (
    <div className="thin-scroll h-full overflow-y-auto p-8">
      <AutomationsHeader
        title="Automações"
        description="Cada execução de fluxo, com o caminho percorrido, o resultado e os erros."
      />
      <AutomationTabs />

      {error && <p className="mb-4 text-sm text-red-600">{error}</p>}

      {!executions ? (
        <div className="flex justify-center py-12">
          <Spinner className="h-6 w-6" />
        </div>
      ) : executions.length === 0 ? (
        <EmptyState icon={<History className="h-8 w-8" />} title="Nenhuma execução ainda" />
      ) : (
        <Card className="overflow-hidden">
          <table className="w-full text-sm">
            <thead className="border-b border-slate-100 bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
              <tr>
                <th className="px-4 py-3 font-medium">Fluxo</th>
                <th className="px-4 py-3 font-medium">Conversa</th>
                <th className="px-4 py-3 font-medium">Gatilho</th>
                <th className="px-4 py-3 font-medium">Status</th>
                <th className="px-4 py-3 font-medium">Resultado</th>
                <th className="px-4 py-3 font-medium">Início</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {executions.map((execution) => (
                <tr
                  key={execution.id}
                  className="cursor-pointer hover:bg-slate-50"
                  onClick={() => void openDetail(execution.id)}
                >
                  <td className="px-4 py-3 font-medium text-slate-900">{execution.flowName}</td>
                  <td className="px-4 py-3 text-slate-600">{execution.conversationTitle}</td>
                  <td className="px-4 py-3 text-slate-600">{AUTOMATION_TRIGGER_LABELS[execution.triggerType]}</td>
                  <td className="px-4 py-3">
                    <Badge color={AUTOMATION_EXECUTION_STATUS_COLORS[execution.status]}>
                      {AUTOMATION_EXECUTION_STATUS_LABELS[execution.status]}
                    </Badge>
                  </td>
                  <td className="px-4 py-3 text-slate-500">
                    {execution.error ?? execution.resultSummary ?? "—"}
                  </td>
                  <td className="px-4 py-3 text-slate-500">
                    {new Date(execution.startedAt).toLocaleString("pt-BR")}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}

      <Modal open={detail != null || detailLoading} onClose={() => setDetail(null)} title="Execução" wide>
        {detailLoading || !detail ? (
          <div className="flex justify-center py-8">
            <Spinner className="h-6 w-6" />
          </div>
        ) : (
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-3 text-sm">
              <div>
                <p className="text-xs uppercase text-slate-400">Fluxo</p>
                <p className="font-medium text-slate-900">{detail.flowName}</p>
              </div>
              <div>
                <p className="text-xs uppercase text-slate-400">Status</p>
                <Badge color={AUTOMATION_EXECUTION_STATUS_COLORS[detail.status]}>
                  {AUTOMATION_EXECUTION_STATUS_LABELS[detail.status]}
                </Badge>
              </div>
              <div>
                <p className="text-xs uppercase text-slate-400">Conversa</p>
                <p className="text-slate-700">{detail.conversationTitle}</p>
              </div>
              <div>
                <p className="text-xs uppercase text-slate-400">Resultado</p>
                <p className="text-slate-700">{detail.error ?? detail.resultSummary ?? "—"}</p>
              </div>
            </div>

            {Object.keys(detail.context.answers ?? {}).length > 0 && (
              <div>
                <p className="mb-1 text-xs uppercase text-slate-400">Respostas coletadas</p>
                <div className="rounded-lg bg-slate-50 p-3 text-xs">
                  {Object.entries(detail.context.answers as Record<string, string>).map(([key, value]) => (
                    <div key={key} className="flex justify-between gap-3 py-0.5">
                      <span className="text-slate-500">{key}</span>
                      <span className="font-medium text-slate-800">{value}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            <div>
              <p className="mb-1 text-xs uppercase text-slate-400">Caminho executado</p>
              <ol className="space-y-1.5 border-l border-slate-200 pl-3">
                {detail.logs.map((log) => (
                  <li key={log.id} className="text-xs">
                    <span className="font-mono text-slate-400">
                      {new Date(log.at).toLocaleTimeString("pt-BR")}
                    </span>{" "}
                    <span className={log.level === "error" ? "text-red-600" : "text-slate-700"}>
                      {log.event}
                      {log.nodeType ? ` (${log.nodeType})` : ""}
                    </span>
                    {log.message && <span className="text-slate-500"> — {log.message}</span>}
                  </li>
                ))}
              </ol>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}

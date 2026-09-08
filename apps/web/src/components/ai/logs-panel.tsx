"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import {
  AI_TOOL_LABELS,
  AI_USAGE_KINDS,
  AI_USAGE_KIND_LABELS,
  AI_USAGE_OUTCOMES,
  AI_USAGE_OUTCOME_LABELS,
  type AiAgentSummaryDto,
  type AiToolName,
  type AiUsageKind,
  type AiUsageLogDto,
  type AiUsageOutcome,
} from "@azvchat/shared";
import { ApiError, aiApi } from "@/lib/api";
import { formatDateTime } from "@/lib/utils";
import { Badge, Button, Card, EmptyState, Spinner } from "@/components/ui";
import { formatCost, formatTokens, Notice, Select } from "./ai-ui";

/**
 * Log técnico de cada chamada ao provedor: tokens, custo, duração,
 * ferramentas pedidas/executadas/bloqueadas, erro. Nunca o conteúdo da
 * conversa nem a chave — para o histórico operacional, a conversa tem as
 * notas internas e o painel de contexto.
 */
export function LogsPanel({ initialAgentId }: { initialAgentId?: string }) {
  const [logs, setLogs] = useState<AiUsageLogDto[] | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [agents, setAgents] = useState<AiAgentSummaryDto[]>([]);
  const [agentId, setAgentId] = useState(initialAgentId ?? "");
  const [kind, setKind] = useState<AiUsageKind | "">("");
  const [outcome, setOutcome] = useState<AiUsageOutcome | "">("");
  const [error, setError] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);

  const load = useCallback(async () => {
    try {
      const data = await aiApi.logs({ agentId: agentId || undefined, kind: kind || undefined, outcome: outcome || undefined });
      setLogs(data.logs);
      setHasMore(data.hasMore);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Não foi possível carregar os logs");
    }
  }, [agentId, kind, outcome]);
  useEffect(() => void load(), [load]);
  useEffect(() => {
    void aiApi.agents().then(setAgents).catch(() => setAgents([]));
  }, []);

  async function more() {
    const last = logs?.at(-1);
    if (!last) return;
    setLoadingMore(true);
    try {
      const data = await aiApi.logs({ before: last.createdAt, agentId: agentId || undefined, kind: kind || undefined, outcome: outcome || undefined });
      setLogs((current) => [...(current ?? []), ...data.logs]);
      setHasMore(data.hasMore);
    } finally {
      setLoadingMore(false);
    }
  }

  const toolLabel = (name: string) => AI_TOOL_LABELS[name as AiToolName] ?? name;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-2">
        <Select className="w-auto" value={agentId} onChange={(event) => setAgentId(event.target.value)}>
          <option value="">Todos os agentes</option>
          {agents.map((agent) => (
            <option key={agent.id} value={agent.id}>
              {agent.name}
            </option>
          ))}
        </Select>
        <Select className="w-auto" value={kind} onChange={(event) => setKind(event.target.value as AiUsageKind | "")}>
          <option value="">Todos os tipos</option>
          {AI_USAGE_KINDS.map((option) => (
            <option key={option} value={option}>
              {AI_USAGE_KIND_LABELS[option]}
            </option>
          ))}
        </Select>
        <Select className="w-auto" value={outcome} onChange={(event) => setOutcome(event.target.value as AiUsageOutcome | "")}>
          <option value="">Todos os resultados</option>
          {AI_USAGE_OUTCOMES.map((option) => (
            <option key={option} value={option}>
              {AI_USAGE_OUTCOME_LABELS[option]}
            </option>
          ))}
        </Select>
      </div>
      {error && <Notice tone="error">{error}</Notice>}
      {!logs ? (
        <div className="flex justify-center py-8">
          <Spinner />
        </div>
      ) : logs.length === 0 ? (
        <Card>
          <EmptyState title="Nenhuma chamada registrada" description="Cada chamada ao provedor (atendimento, testador, teste de conexão) aparece aqui." />
        </Card>
      ) : (
        <Card className="overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="bg-slate-50 text-left text-[10px] font-semibold uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="px-3 py-2">Data/hora</th>
                  <th className="px-3 py-2">Tipo</th>
                  <th className="px-3 py-2">Agente / atendimento</th>
                  <th className="px-3 py-2">Modelo</th>
                  <th className="px-3 py-2">Resultado</th>
                  <th className="px-3 py-2 text-right">Entrada</th>
                  <th className="px-3 py-2 text-right">Saída</th>
                  <th className="px-3 py-2 text-right">Custo</th>
                  <th className="px-3 py-2 text-right">Duração</th>
                  <th className="px-3 py-2">Ações</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {logs.map((log) => (
                  <tr key={log.id} className="align-top hover:bg-slate-50/60">
                    <td className="whitespace-nowrap px-3 py-2 text-slate-500">{formatDateTime(log.createdAt)}</td>
                    <td className="px-3 py-2">{AI_USAGE_KIND_LABELS[log.kind]}</td>
                    <td className="px-3 py-2">
                      <p className="font-medium text-slate-800">{log.agentName ?? "—"}</p>
                      {log.conversationId && (
                        <Link href={`/inbox/${log.conversationId}`} className="text-brand-600 hover:underline">
                          {log.conversationTitle ?? "Conversa"}
                        </Link>
                      )}
                    </td>
                    <td className="px-3 py-2 font-mono">{log.model}</td>
                    <td className="px-3 py-2">
                      <Badge color={log.outcome === "ok" ? "#16a34a" : log.outcome === "blocked" ? "#b45309" : "#dc2626"}>{AI_USAGE_OUTCOME_LABELS[log.outcome]}</Badge>
                      {log.errorCode && <p className="mt-0.5 font-mono text-[10px] text-slate-400">{log.errorCode}</p>}
                      {log.handoffReason && <p className="mt-0.5 text-[10px] text-slate-500">Transferido: {log.handoffReason}</p>}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">{formatTokens(log.inputTokens)}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{formatTokens(log.outputTokens)}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{log.costMicros == null ? <span title="Modelo sem tabela de preço">—</span> : formatCost(log.costMicros)}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{(log.durationMs / 1000).toFixed(1)}s</td>
                    <td className="px-3 py-2">
                      {log.toolsExecuted.length > 0 && <p className="text-emerald-700">✓ {log.toolsExecuted.map(toolLabel).join(", ")}</p>}
                      {log.toolsBlocked.length > 0 && <p className="text-amber-700">✕ {log.toolsBlocked.map(toolLabel).join(", ")}</p>}
                      {log.toolsRequested.length === 0 && <span className="text-slate-300">—</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {hasMore && (
            <div className="border-t border-slate-100 p-3 text-center">
              <Button size="sm" variant="outline" disabled={loadingMore} onClick={() => void more()}>
                {loadingMore ? "Carregando…" : "Carregar mais"}
              </Button>
            </div>
          )}
        </Card>
      )}
    </div>
  );
}

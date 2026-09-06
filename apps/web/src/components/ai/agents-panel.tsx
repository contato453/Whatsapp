"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Bot, Copy, Pencil, Plus, Power, ScrollText, Trash2 } from "lucide-react";
import {
  AI_AGENT_STATUS_COLORS,
  AI_AGENT_STATUS_LABELS,
  AI_PROVIDER_LABELS,
  formatUsdFromMicros,
  type AiAgentSummaryDto,
} from "@azvchat/shared";
import { ApiError, aiApi } from "@/lib/api";
import { useAuth } from "@/lib/auth-context";
import { formatDateTime } from "@/lib/utils";
import { Badge, Button, Card, EmptyState, Spinner } from "@/components/ui";
import { Notice } from "./ai-ui";

/**
 * Lista de agentes. Criar, editar e testar acontecem na tela do agente
 * (`/settings/ai/agents/:id`); aqui ficam as ações de linha.
 */
export function AgentsPanel() {
  const { can } = useAuth();
  const router = useRouter();
  const [agents, setAgents] = useState<AiAgentSummaryDto[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const canManage = can("ai.agent.manage");

  const load = useCallback(async () => {
    try {
      setAgents(await aiApi.agents());
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Não foi possível carregar os agentes");
    }
  }, []);
  useEffect(() => void load(), [load]);

  async function run(id: string, action: () => Promise<unknown>) {
    setBusyId(id);
    setError(null);
    try {
      await action();
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Falha na operação");
    } finally {
      setBusyId(null);
    }
  }

  if (!agents) {
    return (
      <div className="flex justify-center py-8">
        <Spinner />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-slate-500">
          Um agente é uma configuração reutilizável: objetivo, limites, conhecimento e permissões. Configure uma vez e
          use em quantas automações precisar.
        </p>
        {canManage && (
          <Link href="/settings/ai/agents/new">
            <Button>
              <Plus className="h-4 w-4" /> Novo agente de IA
            </Button>
          </Link>
        )}
      </div>
      {error && <Notice tone="error">{error}</Notice>}
      {agents.length === 0 ? (
        <Card>
          <EmptyState
            icon={<Bot className="h-8 w-8" />}
            title="Nenhum agente de IA ainda"
            description="Crie o primeiro (ex.: IA Comercial), teste no simulador e ative para usá-lo numa automação."
            action={
              canManage ? (
                <Link href="/settings/ai/agents/new">
                  <Button size="sm">
                    <Plus className="h-4 w-4" /> Criar agente
                  </Button>
                </Link>
              ) : undefined
            }
          />
        </Card>
      ) : (
        <Card className="overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-left text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="px-4 py-2">Agente</th>
                  <th className="px-4 py-2">Status</th>
                  <th className="px-4 py-2">Departamentos</th>
                  <th className="px-4 py-2">Provedor / modelo</th>
                  <th className="px-4 py-2 text-right">Atendimentos</th>
                  <th className="px-4 py-2 text-right">Consumo</th>
                  <th className="px-4 py-2">Alterado</th>
                  <th className="px-4 py-2" />
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {agents.map((agent) => (
                  <tr key={agent.id} className="hover:bg-slate-50/60">
                    <td className="px-4 py-2.5">
                      <p className="font-medium text-slate-900">{agent.name}</p>
                      {agent.description && <p className="text-xs text-slate-400">{agent.description}</p>}
                    </td>
                    <td className="px-4 py-2.5">
                      <Badge color={AI_AGENT_STATUS_COLORS[agent.status]}>{AI_AGENT_STATUS_LABELS[agent.status]}</Badge>
                      <span className="ml-1 text-[11px] text-slate-400">v{agent.version}</span>
                    </td>
                    <td className="px-4 py-2.5">
                      {agent.isGeneral ? (
                        <Badge>Todos</Badge>
                      ) : agent.departments.length === 0 ? (
                        <span className="text-xs text-amber-700">Sem departamento</span>
                      ) : (
                        <span className="flex flex-wrap gap-1">
                          {agent.departments.map((department) => (
                            <Badge key={department.id} color={department.color ?? undefined}>
                              {department.name}
                            </Badge>
                          ))}
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-2.5 text-xs text-slate-600">
                      {AI_PROVIDER_LABELS[agent.provider]} · <span className="font-mono">{agent.model}</span>
                    </td>
                    <td className="px-4 py-2.5 text-right tabular-nums">{agent.sessionsCount}</td>
                    <td className="px-4 py-2.5 text-right tabular-nums">{formatUsdFromMicros(agent.costMicros)}</td>
                    <td className="px-4 py-2.5 text-xs text-slate-400">{formatDateTime(agent.updatedAt)}</td>
                    <td className="px-4 py-2.5">
                      {canManage && (
                        <div className="flex justify-end gap-1">
                          <Button size="sm" variant="ghost" title="Editar e testar" onClick={() => router.push(`/settings/ai/agents/${agent.id}`)}>
                            <Pencil className="h-3.5 w-3.5" />
                          </Button>
                          <Button size="sm" variant="ghost" title="Ver logs" onClick={() => router.push(`/settings/ai?tab=logs&agentId=${agent.id}`)}>
                            <ScrollText className="h-3.5 w-3.5" />
                          </Button>
                          <Button size="sm" variant="ghost" title="Duplicar" disabled={busyId === agent.id} onClick={() => void run(agent.id, () => aiApi.duplicateAgent(agent.id))}>
                            <Copy className="h-3.5 w-3.5" />
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            title={agent.status === "active" ? "Desativar" : "Ativar"}
                            disabled={busyId === agent.id}
                            onClick={() =>
                              void run(agent.id, () => aiApi.setAgentStatus(agent.id, agent.status === "active" ? "inactive" : "active"))
                            }
                          >
                            <Power className={agent.status === "active" ? "h-3.5 w-3.5 text-emerald-600" : "h-3.5 w-3.5 text-slate-400"} />
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            title="Excluir"
                            disabled={busyId === agent.id}
                            onClick={() => {
                              if (!window.confirm(`Excluir o agente "${agent.name}"? As automações dele também serão excluídas.`)) return;
                              void run(agent.id, () => aiApi.deleteAgent(agent.id));
                            }}
                          >
                            <Trash2 className="h-3.5 w-3.5 text-red-500" />
                          </Button>
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </div>
  );
}

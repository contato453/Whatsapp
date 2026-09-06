"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  Copy,
  Pause,
  Play,
  Plus,
  Trash2,
  Workflow as WorkflowIcon,
} from "lucide-react";
import {
  AUTOMATION_FLOW_STATUS_COLORS,
  AUTOMATION_FLOW_STATUS_LABELS,
  AUTOMATION_TRIGGER_LABELS,
} from "@azvchat/shared";
import { automationApi } from "@/lib/api";
import type { AutomationFlowSummaryDto } from "@/lib/types";
import { Badge, Button, Card, EmptyState, Field, Input, Modal, Spinner } from "@/components/ui";
import { AutomationTabs, AutomationsHeader } from "@/components/automations/automation-tabs";

export default function AutomationFlowsPage() {
  const router = useRouter();
  const [flows, setFlows] = useState<AutomationFlowSummaryDto[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);

  function reload() {
    automationApi
      .listFlows()
      .then(setFlows)
      .catch((err) => setError(err instanceof Error ? err.message : "Falha ao carregar fluxos"));
  }

  useEffect(reload, []);

  async function handleCreate() {
    if (!newName.trim()) return;
    const flow = await automationApi.createFlow({ name: newName.trim() });
    setCreating(false);
    setNewName("");
    router.push(`/automations/${flow.id}`);
  }

  async function handleDuplicate(id: string) {
    setBusyId(id);
    try {
      await automationApi.duplicateFlow(id);
      reload();
    } finally {
      setBusyId(null);
    }
  }

  async function handleToggle(flow: AutomationFlowSummaryDto) {
    setBusyId(flow.id);
    try {
      if (flow.status === "active") {
        await automationApi.deactivateFlow(flow.id);
      } else if (flow.hasPublishedVersion) {
        await automationApi.activateFlow(flow.id);
      } else {
        router.push(`/automations/${flow.id}`);
        return;
      }
      reload();
    } finally {
      setBusyId(null);
    }
  }

  async function handleDelete(id: string, name: string) {
    if (!window.confirm(`Excluir o fluxo "${name}"? Isso apaga também o histórico de execuções dele.`)) return;
    setBusyId(id);
    try {
      await automationApi.deleteFlow(id);
      reload();
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="thin-scroll h-full overflow-y-auto p-8">
      <AutomationsHeader
        title="Automações"
        description="Fluxos automáticos de atendimento — mensagens, menus, perguntas, condições e encaminhamentos."
      />
      <AutomationTabs />

      <div className="mb-4 flex items-center justify-between">
        <p className="text-sm text-slate-500">
          {flows ? `${flows.length} fluxo${flows.length === 1 ? "" : "s"}` : "Carregando..."}
        </p>
        <Button onClick={() => setCreating(true)}>
          <Plus className="h-4 w-4" />
          Novo fluxo
        </Button>
      </div>

      {error && <p className="mb-4 text-sm text-red-600">{error}</p>}

      {!flows ? (
        <div className="flex justify-center py-12">
          <Spinner className="h-6 w-6" />
        </div>
      ) : flows.length === 0 ? (
        <EmptyState
          icon={<WorkflowIcon className="h-8 w-8" />}
          title="Nenhum fluxo ainda"
          description="Crie um fluxo do zero ou comece por um template pronto."
        />
      ) : (
        <Card className="overflow-hidden">
          <table className="w-full text-sm">
            <thead className="border-b border-slate-100 bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
              <tr>
                <th className="px-4 py-3 font-medium">Nome</th>
                <th className="px-4 py-3 font-medium">Gatilho</th>
                <th className="px-4 py-3 font-medium">Número</th>
                <th className="px-4 py-3 font-medium">Status</th>
                <th className="px-4 py-3 font-medium">Execuções</th>
                <th className="px-4 py-3 font-medium">Atualizado</th>
                <th className="px-4 py-3" />
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {flows.map((flow) => (
                <tr key={flow.id} className="hover:bg-slate-50">
                  <td className="px-4 py-3">
                    <Link href={`/automations/${flow.id}`} className="font-medium text-slate-900 hover:text-brand-600">
                      {flow.name}
                    </Link>
                    {flow.description && <p className="text-xs text-slate-500">{flow.description}</p>}
                  </td>
                  <td className="px-4 py-3 text-slate-600">{AUTOMATION_TRIGGER_LABELS[flow.triggerType]}</td>
                  <td className="px-4 py-3 text-slate-600">{flow.instanceName ?? "Todos os números"}</td>
                  <td className="px-4 py-3">
                    <Badge color={AUTOMATION_FLOW_STATUS_COLORS[flow.status]}>
                      {AUTOMATION_FLOW_STATUS_LABELS[flow.status]}
                    </Badge>
                  </td>
                  <td className="px-4 py-3 text-slate-600">{flow.executionsCount}</td>
                  <td className="px-4 py-3 text-slate-500">
                    {new Date(flow.updatedAt).toLocaleDateString("pt-BR")}
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center justify-end gap-1">
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={busyId === flow.id}
                        onClick={() => void handleToggle(flow)}
                        title={
                          flow.status === "active"
                            ? "Desativar"
                            : flow.hasPublishedVersion
                              ? "Ativar"
                              : "Publicar no construtor"
                        }
                      >
                        {flow.status === "active" ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={busyId === flow.id}
                        onClick={() => void handleDuplicate(flow.id)}
                        title="Duplicar"
                      >
                        <Copy className="h-4 w-4" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={busyId === flow.id}
                        onClick={() => void handleDelete(flow.id, flow.name)}
                        title="Excluir"
                      >
                        <Trash2 className="h-4 w-4 text-red-500" />
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}

      <Modal open={creating} onClose={() => setCreating(false)} title="Novo fluxo">
        <div className="space-y-4">
          <Field label="Nome do fluxo">
            <Input
              autoFocus
              value={newName}
              onChange={(event) => setNewName(event.target.value)}
              placeholder="Ex.: Atendimento Comercial"
              onKeyDown={(event) => {
                if (event.key === "Enter") void handleCreate();
              }}
            />
          </Field>
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setCreating(false)}>
              Cancelar
            </Button>
            <Button onClick={() => void handleCreate()} disabled={!newName.trim()}>
              Criar e abrir o construtor
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}

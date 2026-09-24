"use client";

import { useEffect, useMemo, useState } from "react";
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
  AUTOMATION_ALL_INSTANCES_LABEL,
  AUTOMATION_FLOW_STATUS_COLORS,
  AUTOMATION_FLOW_STATUS_LABELS,
  AUTOMATION_GENERAL_DEPARTMENT_LABEL,
  AUTOMATION_SCOPE_EXECUTION_NOTE,
  AUTOMATION_TRIGGER_LABELS,
} from "@azvchat/shared";
import { automationApi } from "@/lib/api";
import type { AutomationFlowSummaryDto } from "@/lib/types";
import { Badge, Button, Card, EmptyState, Field, Input, Modal, Spinner } from "@/components/ui";
import { AutomationTabs, AutomationsHeader } from "@/components/automations/automation-tabs";
import { stoppedExecutionsMessage } from "@/components/automations/automation-ui";
import {
  EMPTY_SCOPE,
  FlowDepartmentBadge,
  FlowScopeFields,
  SCOPE_SELECT_CLASS,
  scopeDraftComplete,
  scopeFromDraft,
  useFlowScopeOptions,
  type FlowScopeDraft,
} from "@/components/automations/flow-scope";

/** Valor do filtro de departamento que traz só os gerais (não classificados). */
const FILTER_GENERAL = "none";

export default function AutomationFlowsPage() {
  const router = useRouter();
  const [flows, setFlows] = useState<AutomationFlowSummaryDto[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [newScope, setNewScope] = useState<FlowScopeDraft>(EMPTY_SCOPE);
  const [createError, setCreateError] = useState<string | null>(null);
  const [departmentFilter, setDepartmentFilter] = useState("");
  const scopeOptions = useFlowScopeOptions();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  function reload() {
    automationApi
      .listFlows()
      .then(setFlows)
      .catch((err) => setError(err instanceof Error ? err.message : "Falha ao carregar fluxos"));
  }

  useEffect(reload, []);

  // O filtro é recorte VISUAL sobre o que a API já devolveu — a lista já
  // vem só com os fluxos que a pessoa enxerga, e são poucas dezenas.
  const visibleFlows = useMemo(() => {
    if (!flows || !departmentFilter) return flows;
    return flows.filter((flow) =>
      departmentFilter === FILTER_GENERAL ? flow.departmentId === null : flow.departmentId === departmentFilter,
    );
  }, [flows, departmentFilter]);

  // O aviso de não classificados só aparece para quem consegue classificar:
  // fluxo geral só é gravado com a chave de alcance geral, e a API diz por
  // `canEdit` quais esta pessoa pode abrir para editar.
  const unclassified = useMemo(
    () => (flows ?? []).filter((flow) => flow.departmentId === null && flow.canEdit),
    [flows],
  );

  // Departamentos do filtro: só os que a pessoa enxerga (os dela, ou os que
  // aparecem nos fluxos que a API já recortou para ela).
  const filterDepartments = useMemo(() => {
    const seen = new Map<string, string>();
    for (const department of scopeOptions.departments) seen.set(department.id, department.name);
    for (const flow of flows ?? []) {
      if (flow.departmentId && flow.departmentName) seen.set(flow.departmentId, flow.departmentName);
    }
    return [...seen.entries()].sort((a, b) => a[1].localeCompare(b[1], "pt-BR"));
  }, [scopeOptions.departments, flows]);

  function openCreate() {
    setNewName("");
    setNewScope(EMPTY_SCOPE);
    setCreateError(null);
    setCreating(true);
  }

  async function handleCreate() {
    if (!newName.trim() || !scopeDraftComplete(newScope)) return;
    setCreateError(null);
    try {
      const flow = await automationApi.createFlow({ name: newName.trim(), ...scopeFromDraft(newScope) });
      setCreating(false);
      router.push(`/automations/${flow.id}`);
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : "Falha ao criar o fluxo");
    }
  }

  async function handleDuplicate(id: string) {
    setBusyId(id);
    setNotice(null);
    try {
      await automationApi.duplicateFlow(id);
      reload();
    } catch (err) {
      setNotice(err instanceof Error ? err.message : "Falha ao duplicar");
    } finally {
      setBusyId(null);
    }
  }

  async function handleToggle(flow: AutomationFlowSummaryDto) {
    setBusyId(flow.id);
    setNotice(null);
    try {
      if (flow.status === "active") {
        const result = await automationApi.deactivateFlow(flow.id);
        setNotice(stoppedExecutionsMessage(result.stoppedExecutions));
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
    setNotice(null);
    try {
      const result = await automationApi.deleteFlow(id);
      setNotice(stoppedExecutionsMessage(result.stoppedExecutions));
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

      {unclassified.length > 0 && (
        <div className="mb-4 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-800">
          {unclassified.length === 1
            ? "1 fluxo está sem departamento e aparece para todos que têm o número."
            : `${unclassified.length} fluxos estão sem departamento e aparecem para todos que têm o número.`}{" "}
          Abra cada um e escolha o departamento, ou mantenha como geral se ele vale para todos.{" "}
          <button
            type="button"
            className="font-medium underline"
            onClick={() => setDepartmentFilter(FILTER_GENERAL)}
          >
            Ver os não classificados
          </button>
        </div>
      )}

      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <p className="text-sm text-slate-500">
            {visibleFlows
              ? `${visibleFlows.length} fluxo${visibleFlows.length === 1 ? "" : "s"}`
              : "Carregando..."}
          </p>
          <select
            className={`${SCOPE_SELECT_CLASS} w-56`}
            value={departmentFilter}
            onChange={(event) => setDepartmentFilter(event.target.value)}
            aria-label="Filtrar por departamento"
          >
            <option value="">Todos os departamentos</option>
            <option value={FILTER_GENERAL}>{AUTOMATION_GENERAL_DEPARTMENT_LABEL} (sem departamento)</option>
            {filterDepartments.map(([id, departmentName]) => (
              <option key={id} value={id}>
                {departmentName}
              </option>
            ))}
          </select>
        </div>
        <Button onClick={openCreate}>
          <Plus className="h-4 w-4" />
          Novo fluxo
        </Button>
      </div>

      {error && <p className="mb-4 text-sm text-red-600">{error}</p>}
      {notice && (
        <p className="mb-4 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-800">{notice}</p>
      )}

      {!visibleFlows ? (
        <div className="flex justify-center py-12">
          <Spinner className="h-6 w-6" />
        </div>
      ) : visibleFlows.length === 0 ? (
        <EmptyState
          icon={<WorkflowIcon className="h-8 w-8" />}
          title={departmentFilter ? "Nenhum fluxo neste recorte" : "Nenhum fluxo ainda"}
          description={
            departmentFilter
              ? "Troque o filtro de departamento para ver os demais."
              : "Crie um fluxo do zero ou comece por um template pronto."
          }
        />
      ) : (
        <Card className="overflow-hidden">
          <table className="w-full text-sm">
            <thead className="border-b border-slate-100 bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
              <tr>
                <th className="px-4 py-3 font-medium">Nome</th>
                <th className="px-4 py-3 font-medium">Gatilho</th>
                <th className="px-4 py-3 font-medium">Departamento</th>
                <th className="px-4 py-3 font-medium">Número</th>
                <th className="px-4 py-3 font-medium">Status</th>
                <th className="px-4 py-3 font-medium">Execuções</th>
                <th className="px-4 py-3 font-medium">Atualizado</th>
                <th className="px-4 py-3" />
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {visibleFlows.map((flow) => (
                <tr key={flow.id} className="hover:bg-slate-50">
                  <td className="px-4 py-3">
                    <Link href={`/automations/${flow.id}`} className="font-medium text-slate-900 hover:text-brand-600">
                      {flow.name}
                    </Link>
                    {flow.description && <p className="text-xs text-slate-500">{flow.description}</p>}
                  </td>
                  <td className="px-4 py-3 text-slate-600">{AUTOMATION_TRIGGER_LABELS[flow.triggerType]}</td>
                  <td className="px-4 py-3">
                    <FlowDepartmentBadge flow={flow} />
                  </td>
                  <td className="px-4 py-3 text-slate-600">{flow.instanceName ?? AUTOMATION_ALL_INSTANCES_LABEL}</td>
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
                    {/* Quem só lê (fluxo geral sem a chave de alcance geral) não
                        ganha botão que a API recusaria. */}
                    <div className={`flex items-center justify-end gap-1 ${flow.canEdit ? "" : "hidden"}`}>
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
          <FlowScopeFields
            value={newScope}
            onChange={setNewScope}
            departments={scopeOptions.departments}
            instances={scopeOptions.instances}
            canManageGeneral={scopeOptions.canManageGeneral}
          />
          <p className="text-xs text-slate-400">{AUTOMATION_SCOPE_EXECUTION_NOTE}</p>
          {createError && <p className="text-sm text-red-600">{createError}</p>}
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setCreating(false)}>
              Cancelar
            </Button>
            <Button onClick={() => void handleCreate()} disabled={!newName.trim() || !scopeDraftComplete(newScope)}>
              Criar e abrir o construtor
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}

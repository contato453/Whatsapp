"use client";

import { useCallback, useEffect, useState } from "react";
import { Pencil, Plus, Trash2, Workflow } from "lucide-react";
import {
  AI_AGENT_STATUS_LABELS,
  AI_AUTOMATION_CONVERSATION_TYPES,
  AI_AUTOMATION_CONVERSATION_TYPE_LABELS,
  AI_AUTOMATION_NO_DEPARTMENT,
  type AiAgentSummaryDto,
  type AiAutomationDto,
} from "@azvchat/shared";
import { ApiError, aiApi, api, type AiAutomationInput } from "@/lib/api";
import type { DepartmentDto, InstanceDto, TagDto } from "@/lib/types";
import { Badge, Button, Card, EmptyState, Field, Input, Modal, Spinner } from "@/components/ui";
import { Notice, Section, Select, Toggle } from "./ai-ui";

/**
 * Automações — o "bloco Atendimento por IA". Este repositório não tem
 * construtor visual de fluxos; a automação é o gatilho que põe um agente
 * para atender: em qual número, em qual departamento, em que tipo de
 * conversa, e o que acontece quando a IA resolve (etiqueta). As saídas
 * "transferido" e "erro" ficam configuradas no próprio agente (destino da
 * transferência e mensagem de fallback).
 */

const EMPTY: AiAutomationInput = {
  name: "",
  active: true,
  agentId: "",
  whatsappInstanceId: null,
  departmentId: null,
  onlyWithoutDepartment: false,
  conversationType: "any",
  onlyUnassigned: true,
  onlyNewConversations: false,
  resolvedTagId: null,
  priority: 100,
};

export function AutomationsPanel() {
  const [automations, setAutomations] = useState<AiAutomationDto[] | null>(null);
  const [agents, setAgents] = useState<AiAgentSummaryDto[]>([]);
  const [instances, setInstances] = useState<InstanceDto[]>([]);
  const [departments, setDepartments] = useState<DepartmentDto[]>([]);
  const [tags, setTags] = useState<TagDto[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<AiAutomationDto | "new" | null>(null);
  const [form, setForm] = useState<AiAutomationInput>(EMPTY);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const [list, agentList, instanceData, departmentData, tagData] = await Promise.all([
        aiApi.automations(),
        aiApi.agents(),
        api.get<{ instances: InstanceDto[] }>("/whatsapp-instances"),
        api.get<{ departments: DepartmentDto[] }>("/departments"),
        api.get<{ tags: TagDto[] }>("/tags"),
      ]);
      setAutomations(list);
      setAgents(agentList);
      setInstances(instanceData.instances);
      setDepartments(departmentData.departments);
      setTags(tagData.tags);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Não foi possível carregar as automações");
    }
  }, []);
  useEffect(() => void load(), [load]);

  function open(target: AiAutomationDto | "new") {
    setEditing(target);
    setForm(
      target === "new"
        ? { ...EMPTY, agentId: agents.find((agent) => agent.status === "active")?.id ?? agents[0]?.id ?? "" }
        : {
            name: target.name,
            active: target.active,
            agentId: target.agentId,
            whatsappInstanceId: target.whatsappInstanceId,
            departmentId: target.departmentId,
            onlyWithoutDepartment: target.onlyWithoutDepartment,
            conversationType: target.conversationType,
            onlyUnassigned: target.onlyUnassigned,
            onlyNewConversations: target.onlyNewConversations,
            resolvedTagId: target.resolvedTagId,
            priority: target.priority,
          },
    );
  }

  async function save() {
    if (!editing) return;
    setBusy(true);
    setError(null);
    try {
      if (editing === "new") await aiApi.createAutomation(form);
      else await aiApi.updateAutomation(editing.id, form);
      setEditing(null);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Não foi possível salvar");
    } finally {
      setBusy(false);
    }
  }

  async function remove(automation: AiAutomationDto) {
    if (!window.confirm(`Excluir a automação "${automation.name}"?`)) return;
    try {
      await aiApi.deleteAutomation(automation.id);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Não foi possível excluir");
    }
  }

  if (!automations) {
    return (
      <div className="flex justify-center py-8">
        <Spinner />
      </div>
    );
  }

  const departmentValue = form.onlyWithoutDepartment ? AI_AUTOMATION_NO_DEPARTMENT : (form.departmentId ?? "");
  const nameOf = {
    instance: (id: string | null) => instances.find((instance) => instance.id === id)?.name ?? "Qualquer número",
    department: (automation: AiAutomationDto) =>
      automation.onlyWithoutDepartment
        ? "Só sem departamento"
        : (departments.find((department) => department.id === automation.departmentId)?.name ?? "Qualquer departamento"),
    tag: (id: string | null) => tags.find((tag) => tag.id === id)?.name ?? null,
  };

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-4">
        <p className="text-sm text-slate-500">
          A automação é o bloco &ldquo;Atendimento por IA&rdquo;: quando uma mensagem chega numa conversa que casa com
          as condições, o agente escolhido assume. Saídas: <strong>resolvido</strong> (conclui e aplica a etiqueta),{" "}
          <strong>transferido</strong> e <strong>erro/limite</strong> (destino e mensagem de fallback configurados no agente).
        </p>
        <Button onClick={() => open("new")} disabled={agents.length === 0}>
          <Plus className="h-4 w-4" /> Nova automação
        </Button>
      </div>
      {agents.length === 0 && <Notice tone="info">Crie e ative um agente antes de criar uma automação.</Notice>}
      {error && <Notice tone="error">{error}</Notice>}

      {automations.length === 0 ? (
        <Card>
          <EmptyState
            icon={<Workflow className="h-8 w-8" />}
            title="Nenhuma automação"
            description="Sem automação, nenhum agente entra em conversa alguma. Crie uma para ligar o agente a um número ou departamento."
          />
        </Card>
      ) : (
        <div className="space-y-2">
          {automations.map((automation) => (
            <Card key={automation.id} className="flex flex-wrap items-center gap-3 p-4">
              <div className="min-w-0 flex-1">
                <p className="flex items-center gap-2 text-sm font-medium text-slate-900">
                  {automation.name}
                  <Badge color={automation.active ? "#16a34a" : "#64748b"}>{automation.active ? "Ativa" : "Pausada"}</Badge>
                  <span className="text-[11px] font-normal text-slate-400">prioridade {automation.priority}</span>
                </p>
                <p className="mt-0.5 text-xs text-slate-500">
                  <strong>{automation.agentName}</strong>{" "}
                  <span className={automation.agentStatus !== "active" ? "text-amber-700" : ""}>
                    ({AI_AGENT_STATUS_LABELS[automation.agentStatus]})
                  </span>{" "}
                  · {nameOf.instance(automation.whatsappInstanceId)} · {nameOf.department(automation)} ·{" "}
                  {AI_AUTOMATION_CONVERSATION_TYPE_LABELS[automation.conversationType]}
                  {automation.onlyUnassigned ? " · só sem responsável" : ""}
                  {automation.onlyNewConversations ? " · só conversa nova" : ""}
                  {nameOf.tag(automation.resolvedTagId) ? ` · resolvido → etiqueta "${nameOf.tag(automation.resolvedTagId)}"` : ""}
                </p>
                <p className="text-[11px] text-slate-400">{automation.sessionsCount} atendimento(s) iniciados por esta automação</p>
              </div>
              <div className="flex gap-1">
                <Button size="sm" variant="ghost" onClick={() => open(automation)}>
                  <Pencil className="h-3.5 w-3.5" />
                </Button>
                <Button size="sm" variant="ghost" onClick={() => void remove(automation)}>
                  <Trash2 className="h-3.5 w-3.5 text-red-500" />
                </Button>
              </div>
            </Card>
          ))}
        </div>
      )}

      <Modal open={editing !== null} onClose={() => setEditing(null)} title={editing === "new" ? "Nova automação" : "Editar automação"} wide>
        <div className="space-y-4">
          <Field label="Nome">
            <Input value={form.name} maxLength={80} placeholder="Ex.: Comercial no número principal" onChange={(event) => setForm({ ...form, name: event.target.value })} />
          </Field>
          <Field label="Agente de IA">
            <Select value={form.agentId} onChange={(event) => setForm({ ...form, agentId: event.target.value })}>
              {agents.map((agent) => (
                <option key={agent.id} value={agent.id}>
                  {agent.name} ({AI_AGENT_STATUS_LABELS[agent.status]})
                </option>
              ))}
            </Select>
          </Field>
          <Section title="Quando iniciar" description="Imediatamente, na mensagem recebida que casar com todas as condições abaixo.">
            <div className="grid gap-3 md:grid-cols-2">
              <Field label="Número de WhatsApp">
                <Select value={form.whatsappInstanceId ?? ""} onChange={(event) => setForm({ ...form, whatsappInstanceId: event.target.value || null })}>
                  <option value="">Qualquer número</option>
                  {instances.map((instance) => (
                    <option key={instance.id} value={instance.id}>
                      {instance.name}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Departamento da conversa">
                <Select
                  value={departmentValue}
                  onChange={(event) => {
                    const value = event.target.value;
                    setForm({
                      ...form,
                      onlyWithoutDepartment: value === AI_AUTOMATION_NO_DEPARTMENT,
                      departmentId: value && value !== AI_AUTOMATION_NO_DEPARTMENT ? value : null,
                    });
                  }}
                >
                  <option value="">Qualquer departamento</option>
                  <option value={AI_AUTOMATION_NO_DEPARTMENT}>Só conversa sem departamento</option>
                  {departments.map((department) => (
                    <option key={department.id} value={department.id}>
                      {department.name}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Tipo de conversa">
                <Select value={form.conversationType} onChange={(event) => setForm({ ...form, conversationType: event.target.value as AiAutomationInput["conversationType"] })}>
                  {AI_AUTOMATION_CONVERSATION_TYPES.map((type) => (
                    <option key={type} value={type}>
                      {AI_AUTOMATION_CONVERSATION_TYPE_LABELS[type]}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Prioridade (menor vence)">
                <Input type="number" min={1} max={1000} value={form.priority} onChange={(event) => setForm({ ...form, priority: Number(event.target.value) || 100 })} />
              </Field>
            </div>
            <Toggle
              checked={form.onlyUnassigned}
              onChange={(checked) => setForm({ ...form, onlyUnassigned: checked })}
              label="Só em conversa sem responsável"
              hint="A IA não toma conversa que já está com um atendente. Desligue só se souber o que está fazendo."
            />
            <Toggle
              checked={form.onlyNewConversations}
              onChange={(checked) => setForm({ ...form, onlyNewConversations: checked })}
              label="Só na primeira mensagem de uma conversa nova"
              hint="Cliente que já conversou com o escritório antes não entra na IA."
            />
          </Section>
          <Section title="Quando a IA resolver" description="Saída RESOLVIDO: a conversa é concluída e, se escolhida, recebe a etiqueta.">
            <Field label="Etiqueta ao resolver">
              <Select value={form.resolvedTagId ?? ""} onChange={(event) => setForm({ ...form, resolvedTagId: event.target.value || null })}>
                <option value="">Nenhuma</option>
                {tags.map((tag) => (
                  <option key={tag.id} value={tag.id}>
                    {tag.name}
                  </option>
                ))}
              </Select>
            </Field>
          </Section>
          <Toggle checked={form.active} onChange={(checked) => setForm({ ...form, active: checked })} label="Automação ativa" />
          {error && <Notice tone="error">{error}</Notice>}
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setEditing(null)}>
              Cancelar
            </Button>
            <Button disabled={busy || !form.name.trim() || !form.agentId} onClick={() => void save()}>
              {busy ? "Salvando…" : "Salvar"}
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}

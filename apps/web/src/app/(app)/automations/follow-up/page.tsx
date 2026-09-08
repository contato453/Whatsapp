"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ArrowDown,
  ArrowUp,
  Copy,
  History,
  Pencil,
  Plus,
  Power,
  PowerOff,
  Trash2,
  Workflow,
} from "lucide-react";
import {
  FOLLOW_UP_EXECUTION_STATUS_LABELS,
  FOLLOW_UP_STEP_ACTION_LABELS,
  FOLLOW_UP_TIME_UNIT_LABELS,
  FOLLOW_UP_TRIGGER_LABELS,
  followUpFinishReasonLabel,
  followUpWaitLabel,
  CONVERSATION_STATUS_LABELS,
} from "@azvchat/shared";
import { api, followUpRulesApi, type FollowUpRuleInput, type FollowUpStepInput } from "@/lib/api";
import { useAuth } from "@/lib/auth-context";
import { formatDateTime } from "@/lib/utils";
import type {
  FollowUpExecutionDto,
  FollowUpRuleDto,
  FollowUpStepAction,
  FollowUpTimeUnit,
  InstanceDto,
  TagDto,
} from "@/lib/types";
import { Badge, Button, Card, EmptyState, Field, Input, Modal, Spinner, Textarea } from "@/components/ui";
import { DepartmentBadges, DepartmentCheckboxes, canManageScopedItem, useMyDepartments } from "@/components/department-picker";

/** Uma etapa em edição na tela — sempre os quatro campos, mesmo os que a ação atual não usa. */
interface StepFormState {
  waitAmount: number;
  waitUnit: FollowUpTimeUnit;
  action: FollowUpStepAction;
  messageContent: string;
  tagId: string;
  newStatus: string;
}

const EMPTY_STEP: StepFormState = {
  waitAmount: 2,
  waitUnit: "hours",
  action: "send_message",
  messageContent: "",
  tagId: "",
  newStatus: "",
};

const EMPTY_FORM = {
  name: "",
  description: "",
  isGeneral: true,
  departmentIds: [] as string[],
  respectBusinessHours: true,
  whatsappInstanceId: "",
  finalizeOnComplete: true,
  finalizeReason: "Sem retorno do cliente",
  finalizeTagId: "",
  steps: [EMPTY_STEP] as StepFormState[],
};

type FormState = typeof EMPTY_FORM;

/** Template pronto — seção 41 do pedido, para quem abre a tela pela primeira vez. */
const TEMPLATE_GERAL: FormState = {
  name: "Follow-up Geral",
  description: "Modelo pronto: três lembretes espaçados e encerramento automático sem retorno.",
  isGeneral: true,
  departmentIds: [],
  respectBusinessHours: true,
  whatsappInstanceId: "",
  finalizeOnComplete: true,
  finalizeReason: "Sem retorno do cliente",
  finalizeTagId: "",
  steps: [
    {
      waitAmount: 2,
      waitUnit: "hours",
      action: "send_message",
      messageContent: "Olá, {{primeiro_nome}}! Você ainda precisa de ajuda?",
      tagId: "",
      newStatus: "",
    },
    {
      waitAmount: 24,
      waitUnit: "hours",
      action: "send_message",
      messageContent: "Estamos aguardando seu retorno para continuar o atendimento.",
      tagId: "",
      newStatus: "",
    },
    {
      waitAmount: 24,
      waitUnit: "hours",
      action: "send_message",
      messageContent:
        "Como não tivemos retorno, este atendimento será encerrado. Quando precisar, é só chamar novamente.",
      tagId: "",
      newStatus: "",
    },
  ],
};

function ruleToForm(rule: FollowUpRuleDto): FormState {
  return {
    name: rule.name,
    description: rule.description ?? "",
    isGeneral: rule.isGeneral,
    departmentIds: rule.departments.map((department) => department.id),
    respectBusinessHours: rule.respectBusinessHours,
    whatsappInstanceId: rule.whatsappInstance?.id ?? "",
    finalizeOnComplete: rule.finalizeOnComplete,
    finalizeReason: rule.finalizeReason,
    finalizeTagId: rule.finalizeTag?.id ?? "",
    steps: rule.steps
      .slice()
      .sort((a, b) => a.order - b.order)
      .map((step) => ({
        waitAmount: step.waitAmount,
        waitUnit: step.waitUnit,
        action: step.action,
        messageContent: step.messageContent ?? "",
        tagId: step.tagId ?? "",
        newStatus: step.newStatus ?? "",
      })),
  };
}

function formToInput(form: FormState, status: "active" | "inactive"): FollowUpRuleInput {
  return {
    name: form.name.trim(),
    description: form.description.trim() || undefined,
    status,
    isGeneral: form.isGeneral,
    departmentIds: form.isGeneral ? [] : form.departmentIds,
    respectBusinessHours: form.respectBusinessHours,
    whatsappInstanceId: form.whatsappInstanceId || null,
    finalizeOnComplete: form.finalizeOnComplete,
    finalizeReason: form.finalizeReason.trim() || "Sem retorno do cliente",
    finalizeTagId: form.finalizeTagId || null,
    steps: form.steps.map((step): FollowUpStepInput => ({
      waitAmount: step.waitAmount,
      waitUnit: step.waitUnit,
      action: step.action,
      messageContent: step.action === "send_message" ? step.messageContent.trim() : undefined,
      tagId: step.action === "add_tag" || step.action === "remove_tag" ? step.tagId || undefined : undefined,
      newStatus:
        step.action === "change_status"
          ? ((step.newStatus || undefined) as FollowUpRuleInput["steps"][number]["newStatus"])
          : undefined,
    })),
  };
}

/** Primeira etapa em texto — "Após 2 horas" — para a coluna da listagem. */
function firstStepLabel(rule: FollowUpRuleDto): string {
  const first = rule.steps.slice().sort((a, b) => a.order - b.order)[0];
  if (!first) return "—";
  return `Após ${followUpWaitLabel(first.waitAmount, first.waitUnit)}`;
}

export default function FollowUpPage() {
  const { user } = useAuth();
  const departments = useMyDepartments();
  const isAdmin = user?.role === "admin";
  const [rules, setRules] = useState<FollowUpRuleDto[] | null>(null);
  const [tags, setTags] = useState<TagDto[]>([]);
  const [instances, setInstances] = useState<InstanceDto[]>([]);
  const [editing, setEditing] = useState<FollowUpRuleDto | "new" | null>(null);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [historyFor, setHistoryFor] = useState<FollowUpRuleDto | null>(null);

  const load = useCallback(() => {
    followUpRulesApi.list().then(setRules);
  }, []);
  useEffect(load, [load]);
  useEffect(() => {
    api.get<{ tags: TagDto[] }>("/tags").then((data) => setTags(data.tags)).catch(() => setTags([]));
    api
      .get<{ instances: InstanceDto[] }>("/whatsapp-instances")
      .then((data) => setInstances(data.instances))
      .catch(() => setInstances([]));
  }, []);

  // Regra geral ("todos os departamentos") é como a etiqueta geral: só o
  // administrador cria — `resolveDepartmentTarget` na API recusa o resto
  // sem uma chave própria para isso, então a tela já nasce coerente com o
  // que o servidor vai aceitar.
  const canCreateShared = isAdmin;

  function openNew() {
    setForm({
      ...TEMPLATE_GERAL,
      departmentIds: canCreateShared ? [] : departments[0] ? [departments[0].id] : [],
      isGeneral: canCreateShared,
    });
    setError(null);
    setEditing("new");
  }

  function openEdit(rule: FollowUpRuleDto) {
    setForm(ruleToForm(rule));
    setError(null);
    setEditing(rule);
  }

  function updateStep(index: number, patch: Partial<StepFormState>) {
    setForm((current) => ({
      ...current,
      steps: current.steps.map((step, i) => (i === index ? { ...step, ...patch } : step)),
    }));
  }

  function addStep() {
    setForm((current) => ({ ...current, steps: [...current.steps, { ...EMPTY_STEP }] }));
  }

  function removeStep(index: number) {
    setForm((current) => ({ ...current, steps: current.steps.filter((_, i) => i !== index) }));
  }

  function moveStep(index: number, direction: -1 | 1) {
    setForm((current) => {
      const target = index + direction;
      if (target < 0 || target >= current.steps.length) return current;
      const steps = current.steps.slice();
      const [moved] = steps.splice(index, 1);
      steps.splice(target, 0, moved);
      return { ...current, steps };
    });
  }

  async function save(status: "active" | "inactive") {
    setError(null);
    if (!form.name.trim()) {
      setError("Dê um nome para a regra");
      return;
    }
    if (!form.isGeneral && form.departmentIds.length === 0) {
      setError("Selecione pelo menos um departamento, ou marque \"Todos os departamentos\"");
      return;
    }
    if (form.steps.length === 0) {
      setError("Adicione pelo menos uma etapa");
      return;
    }
    for (const step of form.steps) {
      if (step.action === "send_message" && !step.messageContent.trim()) {
        setError("Toda etapa de enviar mensagem precisa de um texto");
        return;
      }
      if ((step.action === "add_tag" || step.action === "remove_tag") && !step.tagId) {
        setError("Toda etapa de etiqueta precisa de uma etiqueta selecionada");
        return;
      }
      if (step.action === "change_status" && !step.newStatus) {
        setError("Toda etapa de alterar status precisa de um status alvo");
        return;
      }
    }
    setBusy(true);
    try {
      const input = formToInput(form, status);
      if (editing === "new") {
        await followUpRulesApi.create(input);
      } else if (editing) {
        await followUpRulesApi.update(editing.id, input);
      }
      setEditing(null);
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Não foi possível salvar a regra");
    } finally {
      setBusy(false);
    }
  }

  async function duplicate(rule: FollowUpRuleDto) {
    await followUpRulesApi.duplicate(rule.id);
    load();
  }

  async function toggleStatus(rule: FollowUpRuleDto) {
    if (rule.status === "active") await followUpRulesApi.deactivate(rule.id);
    else await followUpRulesApi.activate(rule.id);
    load();
  }

  async function remove(rule: FollowUpRuleDto) {
    if (!confirm(`Excluir a regra "${rule.name}"? Follow-ups em andamento com ela serão cancelados.`)) return;
    await followUpRulesApi.remove(rule.id);
    load();
  }

  const stepActionOptions = useMemo(
    () => Object.entries(FOLLOW_UP_STEP_ACTION_LABELS) as Array<[FollowUpStepAction, string]>,
    [],
  );

  return (
    <div className="mx-auto max-w-6xl p-6">
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="flex items-center gap-2 text-xl font-semibold text-slate-900">
            <Workflow className="h-5 w-5 text-brand-600" />
            Follow-up Automático
          </h1>
          <p className="text-sm text-slate-500">
            Automações por tempo sem resposta do cliente — uma regra pode valer para um, vários ou
            todos os departamentos, sem precisar ser duplicada.
          </p>
        </div>
        <Button onClick={openNew}>
          <Plus className="h-4 w-4" /> Nova regra
        </Button>
      </div>

      {rules === null ? (
        <div className="flex justify-center py-16">
          <Spinner />
        </div>
      ) : rules.length === 0 ? (
        <EmptyState
          icon={<Workflow className="h-10 w-10" />}
          title="Nenhuma regra de follow-up ainda"
          description="Crie a primeira regra para começar a lembrar clientes que pararam de responder."
          action={
            <Button onClick={openNew}>
              <Plus className="h-4 w-4" /> Nova regra
            </Button>
          }
        />
      ) : (
        <Card className="overflow-hidden p-0">
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="border-b border-slate-100 bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="px-4 py-3">Regra</th>
                  <th className="px-4 py-3">Departamentos</th>
                  <th className="px-4 py-3">Número</th>
                  <th className="px-4 py-3">Gatilho</th>
                  <th className="px-4 py-3">1º follow-up</th>
                  <th className="px-4 py-3">Etapas</th>
                  <th className="px-4 py-3">Ativos</th>
                  <th className="px-4 py-3">Enviadas</th>
                  <th className="px-4 py-3">Alterado em</th>
                  <th className="px-4 py-3 text-right">Ações</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {rules.map((rule) => {
                  const editable = canManageScopedItem(rule, isAdmin, departments);
                  return (
                    <tr key={rule.id} className="align-top">
                      <td className="px-4 py-3">
                        <div className="font-medium text-slate-900">{rule.name}</div>
                        {rule.description && (
                          <div className="max-w-xs text-xs text-slate-500">{rule.description}</div>
                        )}
                        <div className="mt-1">
                          <Badge color={rule.status === "active" ? "#16a34a" : "#94a3b8"}>
                            {rule.status === "active" ? "Ativo" : "Inativo"}
                          </Badge>
                        </div>
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex flex-wrap gap-1">
                          <DepartmentBadges item={rule} />
                        </div>
                      </td>
                      <td className="px-4 py-3 text-slate-600">{rule.whatsappInstance?.name ?? "Todos"}</td>
                      <td className="px-4 py-3 text-slate-600">{FOLLOW_UP_TRIGGER_LABELS[rule.trigger]}</td>
                      <td className="px-4 py-3 text-slate-600">{firstStepLabel(rule)}</td>
                      <td className="px-4 py-3 text-slate-600">{rule.steps.length}</td>
                      <td className="px-4 py-3 text-slate-600">{rule.activeExecutions ?? 0}</td>
                      <td className="px-4 py-3 text-slate-600">{rule.messagesSent ?? 0}</td>
                      <td className="px-4 py-3 text-slate-500">{formatDateTime(rule.updatedAt)}</td>
                      <td className="px-4 py-3">
                        <div className="flex justify-end gap-1">
                          <Button variant="ghost" size="sm" title="Histórico" onClick={() => setHistoryFor(rule)}>
                            <History className="h-4 w-4" />
                          </Button>
                          {editable && (
                            <>
                              <Button variant="ghost" size="sm" title="Duplicar" onClick={() => duplicate(rule)}>
                                <Copy className="h-4 w-4" />
                              </Button>
                              <Button
                                variant="ghost"
                                size="sm"
                                title={rule.status === "active" ? "Desativar" : "Ativar"}
                                onClick={() => toggleStatus(rule)}
                              >
                                {rule.status === "active" ? (
                                  <PowerOff className="h-4 w-4" />
                                ) : (
                                  <Power className="h-4 w-4" />
                                )}
                              </Button>
                              <Button variant="ghost" size="sm" title="Editar" onClick={() => openEdit(rule)}>
                                <Pencil className="h-4 w-4" />
                              </Button>
                              <Button variant="ghost" size="sm" title="Excluir" onClick={() => remove(rule)}>
                                <Trash2 className="h-4 w-4 text-red-500" />
                              </Button>
                            </>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      <Modal open={editing !== null} onClose={() => setEditing(null)} title={editing === "new" ? "Nova regra de follow-up" : `Editar "${(editing as FollowUpRuleDto)?.name}"`} wide>
        <div className="space-y-5">
          {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}

          <Field label="Nome da regra">
            <Input value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} placeholder="Ex.: Cliente sem retorno" />
          </Field>
          <Field label="Descrição (opcional)">
            <Textarea
              rows={2}
              value={form.description}
              onChange={(event) => setForm({ ...form, description: event.target.value })}
            />
          </Field>

          <div>
            <span className="text-xs font-medium uppercase tracking-wide text-slate-500">
              Aplicar esta regra em
            </span>
            <div className="mt-2 space-y-2">
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="radio"
                  checked={form.isGeneral}
                  disabled={!canCreateShared}
                  onChange={() => setForm({ ...form, isGeneral: true })}
                />
                Todos os departamentos
              </label>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="radio"
                  checked={!form.isGeneral}
                  onChange={() => setForm({ ...form, isGeneral: false })}
                />
                Departamentos selecionados
              </label>
              {!form.isGeneral && (
                <DepartmentCheckboxes
                  selected={form.departmentIds}
                  departments={departments}
                  onChange={(ids) => setForm({ ...form, departmentIds: ids })}
                />
              )}
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <Field label="Quando iniciar?">
              <select className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm" value="waiting_client" disabled>
                <option value="waiting_client">{FOLLOW_UP_TRIGGER_LABELS.waiting_client}</option>
              </select>
            </Field>
            <Field label="Número de WhatsApp (opcional)">
              <select
                className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                value={form.whatsappInstanceId}
                onChange={(event) => setForm({ ...form, whatsappInstanceId: event.target.value })}
              >
                <option value="">Todos os números</option>
                {instances.map((instance) => (
                  <option key={instance.id} value={instance.id}>
                    {instance.name}
                  </option>
                ))}
              </select>
            </Field>
          </div>

          <label className="flex items-center gap-2 text-sm text-slate-700">
            <input
              type="checkbox"
              checked={form.respectBusinessHours}
              onChange={(event) => setForm({ ...form, respectBusinessHours: event.target.checked })}
            />
            Respeitar horário de expediente (fora dele, envia no início do próximo expediente)
          </label>

          <div className="space-y-3 rounded-lg border border-slate-200 p-4">
            <p className="text-xs font-medium uppercase tracking-wide text-slate-500">Etapas</p>
            {form.steps.map((step, index) => (
              <div key={index} className="rounded-lg border border-slate-200 bg-slate-50 p-3">
                <div className="mb-2 flex items-center justify-between">
                  <span className="text-xs font-semibold text-slate-500">Etapa {index + 1}</span>
                  <div className="flex gap-1">
                    <Button variant="ghost" size="sm" onClick={() => moveStep(index, -1)} disabled={index === 0}>
                      <ArrowUp className="h-3.5 w-3.5" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => moveStep(index, 1)}
                      disabled={index === form.steps.length - 1}
                    >
                      <ArrowDown className="h-3.5 w-3.5" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => removeStep(index)}
                      disabled={form.steps.length === 1}
                    >
                      <Trash2 className="h-3.5 w-3.5 text-red-500" />
                    </Button>
                  </div>
                </div>
                <div className="grid grid-cols-3 gap-2">
                  <Field label="Após">
                    <Input
                      type="number"
                      min={1}
                      value={step.waitAmount}
                      onChange={(event) => updateStep(index, { waitAmount: Number(event.target.value) || 1 })}
                    />
                  </Field>
                  <Field label="Unidade">
                    <select
                      className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                      value={step.waitUnit}
                      onChange={(event) => updateStep(index, { waitUnit: event.target.value as FollowUpTimeUnit })}
                    >
                      {Object.entries(FOLLOW_UP_TIME_UNIT_LABELS).map(([value, label]) => (
                        <option key={value} value={value}>
                          {label}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <Field label="Ação">
                    <select
                      className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                      value={step.action}
                      onChange={(event) => updateStep(index, { action: event.target.value as FollowUpStepAction })}
                    >
                      {stepActionOptions.map(([value, label]) => (
                        <option key={value} value={value}>
                          {label}
                        </option>
                      ))}
                    </select>
                  </Field>
                </div>
                {step.action === "send_message" && (
                  <div className="mt-2">
                    <Field label="Mensagem">
                      <Textarea
                        rows={2}
                        value={step.messageContent}
                        onChange={(event) => updateStep(index, { messageContent: event.target.value })}
                        placeholder="Olá, {{primeiro_nome}}! Você ainda precisa de ajuda?"
                      />
                    </Field>
                  </div>
                )}
                {(step.action === "add_tag" || step.action === "remove_tag") && (
                  <div className="mt-2">
                    <Field label="Etiqueta">
                      <select
                        className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                        value={step.tagId}
                        onChange={(event) => updateStep(index, { tagId: event.target.value })}
                      >
                        <option value="">Selecione</option>
                        {tags.map((tag) => (
                          <option key={tag.id} value={tag.id}>
                            {tag.name}
                          </option>
                        ))}
                      </select>
                    </Field>
                  </div>
                )}
                {step.action === "change_status" && (
                  <div className="mt-2">
                    <Field label="Novo status">
                      <select
                        className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                        value={step.newStatus}
                        onChange={(event) => updateStep(index, { newStatus: event.target.value })}
                      >
                        <option value="">Selecione</option>
                        {Object.entries(CONVERSATION_STATUS_LABELS).map(([value, label]) => (
                          <option key={value} value={value}>
                            {label}
                          </option>
                        ))}
                      </select>
                    </Field>
                  </div>
                )}
              </div>
            ))}
            <Button variant="outline" size="sm" onClick={addStep}>
              <Plus className="h-3.5 w-3.5" /> Adicionar etapa
            </Button>
          </div>

          <div className="space-y-2 rounded-lg border border-slate-200 p-4">
            <label className="flex items-center gap-2 text-sm text-slate-700">
              <input
                type="checkbox"
                checked={form.finalizeOnComplete}
                onChange={(event) => setForm({ ...form, finalizeOnComplete: event.target.checked })}
              />
              Finalizar atendimento depois da última etapa
            </label>
            {form.finalizeOnComplete && (
              <div className="grid grid-cols-2 gap-3">
                <Field label="Motivo do encerramento">
                  <Input
                    value={form.finalizeReason}
                    onChange={(event) => setForm({ ...form, finalizeReason: event.target.value })}
                  />
                </Field>
                <Field label="Etiqueta ao encerrar (opcional)">
                  <select
                    className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                    value={form.finalizeTagId}
                    onChange={(event) => setForm({ ...form, finalizeTagId: event.target.value })}
                  >
                    <option value="">Nenhuma</option>
                    {tags.map((tag) => (
                      <option key={tag.id} value={tag.id}>
                        {tag.name}
                      </option>
                    ))}
                  </select>
                </Field>
              </div>
            )}
          </div>

          <div className="flex justify-end gap-2 border-t border-slate-100 pt-4">
            <Button variant="outline" disabled={busy} onClick={() => setEditing(null)}>
              Cancelar
            </Button>
            <Button variant="secondary" disabled={busy} onClick={() => save(editing !== "new" ? (editing as FollowUpRuleDto).status : "inactive")}>
              {busy ? <Spinner className="h-4 w-4" /> : "Salvar"}
            </Button>
            <Button disabled={busy} onClick={() => save("active")}>
              {busy ? <Spinner className="h-4 w-4" /> : "Salvar e ativar"}
            </Button>
          </div>
        </div>
      </Modal>

      {historyFor && <HistoryModal rule={historyFor} onClose={() => setHistoryFor(null)} />}
    </div>
  );
}

function HistoryModal({ rule, onClose }: { rule: FollowUpRuleDto; onClose: () => void }) {
  const [data, setData] = useState<Awaited<ReturnType<typeof followUpRulesApi.history>> | null>(null);

  useEffect(() => {
    followUpRulesApi.history(rule.id).then(setData);
  }, [rule.id]);

  return (
    <Modal open onClose={onClose} title={`Histórico — ${rule.name}`} wide>
      {!data ? (
        <div className="flex justify-center py-10">
          <Spinner />
        </div>
      ) : (
        <div className="space-y-5">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
            <StatBox label="Execuções" value={data.stats.totalExecutions} />
            <StatBox label="Departamentos" value={data.stats.departmentsUsed} />
            <StatBox label="Clientes responderam" value={data.stats.clientsReplied} />
            <StatBox label="Encerradas por inatividade" value={data.stats.resolvedByRule} />
            <StatBox label="Canceladas" value={data.stats.canceledCount} />
          </div>

          {data.executions.length === 0 ? (
            <EmptyState title="Ainda não rodou nenhuma vez" />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead className="border-b border-slate-100 text-xs uppercase tracking-wide text-slate-500">
                  <tr>
                    <th className="px-3 py-2">Conversa</th>
                    <th className="px-3 py-2">Departamento</th>
                    <th className="px-3 py-2">Etapa</th>
                    <th className="px-3 py-2">Status</th>
                    <th className="px-3 py-2">Motivo</th>
                    <th className="px-3 py-2">Iniciado</th>
                    <th className="px-3 py-2">Mensagens</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {data.executions.map((execution) => (
                    <ExecutionRow key={execution.id} execution={execution} />
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}

function StatBox({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-lg border border-slate-200 p-3 text-center">
      <div className="text-lg font-semibold text-slate-900">{value}</div>
      <div className="text-[11px] text-slate-500">{label}</div>
    </div>
  );
}

function ExecutionRow({ execution }: { execution: FollowUpExecutionDto }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <tr className="cursor-pointer hover:bg-slate-50" onClick={() => setOpen((value) => !value)}>
        <td className="px-3 py-2 text-slate-800">{execution.conversation?.title ?? execution.conversationId}</td>
        <td className="px-3 py-2 text-slate-600">{execution.conversation?.departmentName ?? "—"}</td>
        <td className="px-3 py-2 text-slate-600">
          {execution.currentStepOrder}
          {execution.totalSteps ? ` de ${execution.totalSteps}` : ""}
        </td>
        <td className="px-3 py-2">
          <Badge>{FOLLOW_UP_EXECUTION_STATUS_LABELS[execution.status]}</Badge>
        </td>
        <td className="px-3 py-2 text-slate-600">{followUpFinishReasonLabel(execution.finishReason) ?? "—"}</td>
        <td className="px-3 py-2 text-slate-500">{formatDateTime(execution.startedAt)}</td>
        <td className="px-3 py-2 text-slate-600">{execution.messagesSentCount}</td>
      </tr>
      {open && execution.logs && execution.logs.length > 0 && (
        <tr>
          <td colSpan={7} className="bg-slate-50 px-3 py-2">
            <ul className="space-y-1 text-xs text-slate-600">
              {execution.logs.map((log) => (
                <li key={log.id}>
                  {formatDateTime(log.createdAt)} — {log.eventType}
                  {log.stepOrder ? ` (etapa ${log.stepOrder})` : ""}
                  {log.detail ? `: ${log.detail}` : ""}
                </li>
              ))}
            </ul>
          </td>
        </tr>
      )}
    </>
  );
}

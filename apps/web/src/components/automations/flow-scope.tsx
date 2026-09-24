"use client";

import { useEffect, useState } from "react";
import {
  AUTOMATION_ALL_INSTANCES_LABEL,
  AUTOMATION_GENERAL_DEPARTMENT_HINT,
  AUTOMATION_GENERAL_DEPARTMENT_LABEL,
} from "@azvchat/shared";
import { api, type AutomationFlowScopeInput } from "@/lib/api";
import { useAuth } from "@/lib/auth-context";
import type { DepartmentDto } from "@/lib/types";
import { Badge, Field } from "@/components/ui";
import { useMyDepartments } from "@/components/department-picker";

export const SCOPE_SELECT_CLASS =
  "w-full rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 text-sm text-slate-900 focus:border-brand-600 focus:outline-none focus:ring-2 focus:ring-brand-500/20";

/** Valor do seletor: vazio = ainda não escolhido; "general"/"all" = alcance geral. */
export interface FlowScopeDraft {
  department: string;
  instance: string;
}

export const GENERAL = "general";
export const ALL_INSTANCES = "all";

export const EMPTY_SCOPE: FlowScopeDraft = { department: "", instance: "" };

/**
 * O que o formulário pode oferecer: os departamentos e os números DA PESSOA
 * (as duas rotas já devolvem só o que ela alcança) e as opções gerais só
 * para quem tem a chave `automation.manage_general`. A tela oferece o que a
 * API vai aceitar — a recusa de verdade continua sendo do servidor.
 */
export function useFlowScopeOptions() {
  const { can } = useAuth();
  const departments = useMyDepartments();
  const [instances, setInstances] = useState<{ id: string; name: string }[]>([]);
  useEffect(() => {
    api
      .get<{ instances: { id: string; name: string }[] }>("/whatsapp-instances")
      .then((data) => setInstances(data.instances))
      .catch(() => setInstances([]));
  }, []);
  return { departments, instances, canManageGeneral: can("automation.manage_general") };
}

export function scopeDraftComplete(draft: FlowScopeDraft): boolean {
  return draft.department !== "" && draft.instance !== "";
}

export function scopeFromDraft(draft: FlowScopeDraft): AutomationFlowScopeInput {
  return {
    departmentId: draft.department === GENERAL ? null : draft.department,
    whatsappInstanceId: draft.instance === ALL_INSTANCES ? null : draft.instance,
  };
}

export function draftFromScope(scope: AutomationFlowScopeInput): FlowScopeDraft {
  return {
    department: scope.departmentId ?? GENERAL,
    instance: scope.whatsappInstanceId ?? ALL_INSTANCES,
  };
}

/**
 * Departamento e número do fluxo, obrigatórios de escolher. "Geral" é
 * decisão explícita, nunca o que sobra de um campo esquecido.
 */
export function FlowScopeFields({
  value,
  onChange,
  departments,
  instances,
  canManageGeneral,
}: {
  value: FlowScopeDraft;
  onChange: (next: FlowScopeDraft) => void;
  departments: DepartmentDto[];
  instances: { id: string; name: string }[];
  canManageGeneral: boolean;
}) {
  return (
    <div className="space-y-3">
      <Field label="Departamento">
        <select
          className={SCOPE_SELECT_CLASS}
          value={value.department}
          onChange={(event) => onChange({ ...value, department: event.target.value })}
        >
          <option value="" disabled>
            Escolha o departamento
          </option>
          {canManageGeneral && <option value={GENERAL}>{AUTOMATION_GENERAL_DEPARTMENT_LABEL} (todos os departamentos)</option>}
          {departments.map((department) => (
            <option key={department.id} value={department.id}>
              {department.name}
            </option>
          ))}
        </select>
      </Field>
      <p className="text-xs text-slate-500">{AUTOMATION_GENERAL_DEPARTMENT_HINT}</p>
      <Field label="Número">
        <select
          className={SCOPE_SELECT_CLASS}
          value={value.instance}
          onChange={(event) => onChange({ ...value, instance: event.target.value })}
        >
          <option value="" disabled>
            Escolha o número
          </option>
          {canManageGeneral && <option value={ALL_INSTANCES}>{AUTOMATION_ALL_INSTANCES_LABEL}</option>}
          {instances.map((instance) => (
            <option key={instance.id} value={instance.id}>
              {instance.name}
            </option>
          ))}
        </select>
      </Field>
      {!canManageGeneral && (
        <p className="text-xs text-slate-500">
          Fluxo geral (sem departamento ou para todos os números) exige a permissão de automações gerais.
        </p>
      )}
    </div>
  );
}

/** O departamento do fluxo na lista: o badge com a cor cadastrada, ou "Geral". */
export function FlowDepartmentBadge({
  flow,
}: {
  flow: { departmentId: string | null; departmentName: string | null; departmentColor: string | null };
}) {
  if (!flow.departmentId) {
    return (
      <Badge color="#64748b" title="Sem classificação de departamento">
        {AUTOMATION_GENERAL_DEPARTMENT_LABEL}
      </Badge>
    );
  }
  return <Badge color={flow.departmentColor ?? "#64748b"}>{flow.departmentName ?? "Departamento"}</Badge>;
}

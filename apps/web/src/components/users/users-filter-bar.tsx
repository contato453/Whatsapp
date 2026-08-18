"use client";

import { ListFilter, X } from "lucide-react";
import { USER_ROLES, USER_ROLE_LABELS } from "@azvchat/shared";
import { cn } from "@/lib/utils";
import { hasActiveUsersFilters, type UsersFilters } from "@/lib/users-filters";
import type { DepartmentDto, InstanceDto } from "@/lib/types";
import { Badge, Button, Field } from "@/components/ui";

/**
 * Barra de filtros da tela de Usuários, em componente próprio para a
 * `page.tsx` continuar sendo a lista — o estado mora lá, porque é ele que a
 * persistência grava; aqui é só a apresentação.
 *
 * As opções de chip e de departamento vêm das listas reais de conexões e
 * departamentos, não dos vínculos existentes: departamento sem ninguém
 * precisa aparecer para a resposta ser "ninguém está neste departamento",
 * que é exatamente a pergunta de quem acabou de mexer na equipe.
 */

/**
 * Mesmo estilo dos seletores da Inbox: com valor escolhido o campo fica
 * marcado, para a pessoa perceber de relance que a lista está recortada —
 * sem isso, um filtro esquecido parece cadastro vazio.
 */
function filterSelectClass(ativo: boolean): string {
  return cn(
    "w-full rounded-lg border bg-white px-2.5 py-2 text-sm focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/20",
    ativo ? "border-brand-500 font-medium text-brand-700" : "border-slate-300 text-slate-600",
  );
}

export function UsersFilterBar({
  filters,
  onChange,
  onClear,
  instances,
  departments,
  total,
  shown,
}: {
  filters: UsersFilters;
  onChange: (patch: Partial<UsersFilters>) => void;
  onClear: () => void;
  instances: InstanceDto[];
  departments: DepartmentDto[];
  /** Contagem antes e depois do filtro: "8 de 23 usuários". */
  total: number;
  shown: number;
}) {
  const active = hasActiveUsersFilters(filters);

  return (
    <div className="mb-4 space-y-3 rounded-xl border border-slate-200 bg-white p-4">
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Chip">
          <select
            className={filterSelectClass(filters.instanceId !== "")}
            value={filters.instanceId}
            onChange={(event) => onChange({ instanceId: event.target.value })}
          >
            <option value="">Todos os chips</option>
            {instances.map((instance) => (
              <option key={instance.id} value={instance.id}>
                {instance.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Tipo de usuário">
          <select
            className={filterSelectClass(filters.role !== "")}
            value={filters.role}
            onChange={(event) =>
              onChange({ role: event.target.value as UsersFilters["role"] })
            }
          >
            <option value="">Todos os tipos</option>
            {/* Rótulos do `@azvchat/shared` — `agent` continua sendo
                "Usuário" na interface, e nada disso é escrito à mão aqui. */}
            {USER_ROLES.map((role) => (
              <option key={role} value={role}>
                {USER_ROLE_LABELS[role]}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Departamento">
          <select
            className={filterSelectClass(filters.departmentId !== "")}
            value={filters.departmentId}
            onChange={(event) => onChange({ departmentId: event.target.value })}
          >
            <option value="">Todos os departamentos</option>
            {departments.map((department) => (
              <option key={department.id} value={department.id}>
                {department.name}
              </option>
            ))}
          </select>
        </Field>
      </div>
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="text-xs text-slate-500">
            {active
              ? `${shown} de ${total} ${total === 1 ? "usuário" : "usuários"}`
              : `${total} ${total === 1 ? "usuário" : "usuários"}`}
          </span>
          {active && (
            <Badge className="bg-brand-500/10 text-brand-700">
              <ListFilter className="h-3 w-3" />
              lista filtrada
            </Badge>
          )}
        </div>
        {/* O botão só existe com filtro ativo: sem nada aplicado ele seria
            um botão que não faz nada. */}
        {active && (
          <Button variant="ghost" size="sm" onClick={onClear} className="text-slate-500">
            <X className="h-3.5 w-3.5" /> Limpar filtros
          </Button>
        )}
      </div>
    </div>
  );
}

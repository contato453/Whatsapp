"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { Badge } from "@/components/ui";
import type { DepartmentDto, ResourceDepartmentDto } from "@/lib/types";

/**
 * Departamentos em que a pessoa pode criar etiquetas e respostas rápidas.
 * A tela oferece só o que a API vai aceitar — admin recebe todos.
 */
export function useMyDepartments(): DepartmentDto[] {
  const [departments, setDepartments] = useState<DepartmentDto[]>([]);
  useEffect(() => {
    api
      .get<{ departments: DepartmentDto[] }>("/departments/mine")
      .then((data) => setDepartments(data.departments))
      .catch(() => setDepartments([]));
  }, []);
  return departments;
}

/** Recurso que vale para todos os departamentos ou para uma lista deles. */
export interface DepartmentScopedItem {
  isGeneral: boolean;
  departments: ResourceDepartmentDto[];
}

/**
 * Pode editar e excluir? Precisa de acesso a TODOS os departamentos do item,
 * espelhando a regra da API — sem isso a tela ofereceria um botão que sempre
 * responde 403.
 *
 * Item que ficou sem departamento (o departamento foi excluído) é assunto de
 * admin: ele é o único que ainda o enxerga.
 */
export function canManageScopedItem(
  item: DepartmentScopedItem,
  isAdmin: boolean,
  myDepartments: DepartmentDto[],
): boolean {
  if (isAdmin) return true;
  if (item.isGeneral) return false;
  if (item.departments.length === 0) return false;
  return item.departments.every((department) =>
    myDepartments.some((mine) => mine.id === department.id),
  );
}

/**
 * A etiqueta ou resposta rápida vale para esta conversa?
 *
 * Espelha a regra da API: geral vale sempre; restrita, só se o departamento
 * da conversa estiver entre os dela. Conversa sem departamento aceita
 * qualquer item visível — é o comportamento que já existia, e ela aparece
 * quando o número não tem departamento padrão.
 */
export function appliesToConversation(
  item: DepartmentScopedItem,
  conversationDepartmentId: string | null,
): boolean {
  if (item.isGeneral) return true;
  if (conversationDepartmentId === null) return true;
  return item.departments.some((department) => department.id === conversationDepartmentId);
}

/**
 * Os selos de departamento da listagem: "Geral" quando vale para todos, um
 * Badge por departamento quando é restrito, e um aviso quando ficou sem
 * nenhum — que é o estado que só o admin enxerga e precisa arrumar.
 */
export function DepartmentBadges({ item }: { item: DepartmentScopedItem }) {
  if (item.isGeneral) {
    return <Badge color="#64748b">Geral</Badge>;
  }
  if (item.departments.length === 0) {
    return <Badge color="#dc2626">Sem departamento</Badge>;
  }
  return (
    <>
      {item.departments.map((department) => (
        <Badge key={department.id} color={department.color ?? "#64748b"}>
          {department.name}
        </Badge>
      ))}
    </>
  );
}

/**
 * Seleção múltipla de departamentos. O kit não tem componente de
 * multiseleção, então são checkboxes montados com o que já existe — sem
 * biblioteca nova.
 */
export function DepartmentCheckboxes({
  selected,
  departments,
  disabled = false,
  onChange,
}: {
  selected: string[];
  /** Os departamentos em que esta pessoa pode gravar. */
  departments: DepartmentDto[];
  disabled?: boolean;
  onChange: (ids: string[]) => void;
}) {
  function toggle(id: string, checked: boolean) {
    onChange(checked ? [...selected, id] : selected.filter((item) => item !== id));
  }

  if (departments.length === 0) {
    return (
      <p className="text-sm text-slate-500">
        Você ainda não atua em nenhum departamento. Peça acesso ao administrador.
      </p>
    );
  }

  return (
    <div className="max-h-48 space-y-1 overflow-y-auto rounded-lg border border-slate-200 p-2">
      {departments.map((department) => (
        <label
          key={department.id}
          className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-slate-50"
        >
          <input
            type="checkbox"
            className="h-4 w-4 rounded border-slate-300 text-brand-600"
            checked={selected.includes(department.id)}
            disabled={disabled}
            onChange={(event) => toggle(department.id, event.target.checked)}
          />
          <span className={disabled ? "text-slate-400" : "text-slate-700"}>{department.name}</span>
        </label>
      ))}
    </div>
  );
}

"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import type { DepartmentDto } from "@/lib/types";

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

/** Rótulo do grupo: o nome do departamento, ou "Geral" quando não há. */
export function departmentLabel(
  departmentId: string | null,
  departments: DepartmentDto[],
): string {
  if (!departmentId) return "Geral (todos os departamentos)";
  return departments.find((department) => department.id === departmentId)?.name ?? "Departamento";
}

/**
 * Agrupa por departamento, mantendo a ordem em que vieram da API.
 * O geral fica por último: é o menos específico.
 */
export function groupByDepartment<T extends { departmentId: string | null }>(
  items: T[],
): Array<{ departmentId: string | null; items: T[] }> {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const key = item.departmentId ?? "";
    const list = groups.get(key) ?? [];
    list.push(item);
    groups.set(key, list);
  }
  return [...groups.entries()]
    .map(([key, list]) => ({ departmentId: key === "" ? null : key, items: list }))
    .sort((a, b) => {
      if (a.departmentId === null) return 1;
      if (b.departmentId === null) return -1;
      return 0;
    });
}

export function DepartmentSelect({
  value,
  departments,
  canUseGeneral,
  onChange,
}: {
  value: string;
  departments: DepartmentDto[];
  /** Só o admin cria recurso geral, que vale para a organização inteira. */
  canUseGeneral: boolean;
  onChange: (value: string) => void;
}) {
  return (
    <select
      className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
      value={value}
      onChange={(event) => onChange(event.target.value)}
    >
      {canUseGeneral && <option value="">Geral (todos os departamentos)</option>}
      {departments.map((department) => (
        <option key={department.id} value={department.id}>
          {department.name}
        </option>
      ))}
    </select>
  );
}

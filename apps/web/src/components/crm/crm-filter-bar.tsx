"use client";

import { AlarmClock, Search, X } from "lucide-react";
import { CRM_ORIGINS, CRM_ORIGIN_LABELS } from "@azvchat/shared";
import type {
  CrmPipelineDto,
  CrmProductDto,
  DepartmentDto,
  TagDto,
  UserDirectoryDto,
} from "@/lib/types";
import type { CrmFilterState } from "@/lib/crm-filters";
import { hasActiveCrmFilters, clearCrmFilters } from "@/lib/crm-filters";
import { cn } from "@/lib/utils";
import { Button, Input, MultiSelect } from "@/components/ui";

/**
 * A barra de filtros do CRM.
 *
 * Todos os seletores são o `MultiSelect` da casa — o mesmo da Inbox e do
 * Dashboard. Quatro implementações separadas divergiriam no teclado e no
 * clique fora, e a equipe sentiria a diferença sem saber nomear.
 *
 * **OU dentro do filtro, E entre filtros**: marcar duas pessoas mostra as
 * duas; marcar uma pessoa e uma etiqueta mostra o que tem as duas coisas.
 */
export function CrmFilterBar({
  filters,
  onChange,
  pipelines,
  users,
  departments,
  tags,
  products,
  showPipeline = true,
  total,
}: {
  filters: CrmFilterState;
  onChange: (filters: CrmFilterState) => void;
  pipelines: CrmPipelineDto[];
  users: UserDirectoryDto[];
  departments: DepartmentDto[];
  tags: TagDto[];
  products: CrmProductDto[];
  showPipeline?: boolean;
  /** Quantas oportunidades o recorte devolveu — sempre visível, como na Inbox. */
  total?: number;
}) {
  const ativo = hasActiveCrmFilters(filters);

  return (
    <div className="flex flex-wrap items-center gap-2 px-4 py-2">
      {showPipeline && (
        <select
          value={filters.pipelineId}
          onChange={(event) => onChange({ ...filters, pipelineId: event.target.value })}
          className="rounded-lg border border-slate-300 bg-white px-2 py-1 text-xs font-medium text-slate-700"
          aria-label="Funil"
        >
          {pipelines.map((pipeline) => (
            <option key={pipeline.id} value={pipeline.id}>
              {pipeline.name}
            </option>
          ))}
        </select>
      )}

      <div className="relative">
        <Search className="pointer-events-none absolute left-2 top-1/2 h-3 w-3 -translate-y-1/2 text-slate-400" />
        <Input
          value={filters.search}
          onChange={(event) => onChange({ ...filters, search: event.target.value })}
          placeholder="Buscar cliente, telefone, serviço..."
          className="h-7 w-56 py-1 pl-7 text-xs"
        />
      </div>

      <MultiSelect
        className="w-40"
        label="Responsável"
        selected={filters.assignedUserIds}
        onChange={(assignedUserIds) => onChange({ ...filters, assignedUserIds })}
        searchPlaceholder="Buscar pessoa"
        groups={[
          {
            label: null,
            options: [
              { value: "none", label: "Sem responsável" },
              ...users
                .filter((user) => user.status === "active")
                .map((user) => ({ value: user.id, label: user.name })),
            ],
          },
        ]}
      />

      <MultiSelect
        className="w-40"
        label="Departamento"
        selected={filters.departmentIds}
        onChange={(departmentIds) => onChange({ ...filters, departmentIds })}
        groups={[
          {
            label: null,
            options: [
              { value: "none", label: "Sem departamento" },
              ...departments.map((department) => ({
                value: department.id,
                label: department.name,
              })),
            ],
          },
        ]}
      />

      <MultiSelect
        className="w-36"
        label="Etiqueta"
        selected={filters.tagIds}
        onChange={(tagIds) => onChange({ ...filters, tagIds })}
        searchPlaceholder="Buscar etiqueta"
        groups={[{ label: null, options: tags.map((tag) => ({ value: tag.id, label: tag.name })) }]}
      />

      <MultiSelect
        className="w-32"
        label="Origem"
        selected={filters.origins}
        onChange={(origins) => onChange({ ...filters, origins })}
        groups={[
          {
            label: null,
            options: CRM_ORIGINS.map((origin) => ({
              value: origin,
              label: CRM_ORIGIN_LABELS[origin],
            })),
          },
        ]}
      />

      {products.length > 0 && (
        <MultiSelect
          className="w-36"
          label="Serviço"
          selected={filters.productIds}
          onChange={(productIds) => onChange({ ...filters, productIds })}
          searchPlaceholder="Buscar serviço"
          groups={[
            {
              label: null,
              options: products.map((product) => ({ value: product.id, label: product.name })),
            },
          ]}
        />
      )}

      <button
        type="button"
        onClick={() => onChange({ ...filters, overdueActivity: !filters.overdueActivity })}
        className={cn(
          "flex items-center gap-1 rounded-lg border px-2 py-1 text-[11px]",
          filters.overdueActivity
            ? "border-amber-400 bg-amber-50 font-medium text-amber-700"
            : "border-slate-200 text-slate-600 hover:bg-slate-50",
        )}
      >
        <AlarmClock className="h-3 w-3" /> Atrasadas
      </button>

      {ativo && (
        <Button size="sm" variant="ghost" onClick={() => onChange(clearCrmFilters(filters))}>
          <X className="h-3 w-3" /> Limpar
        </Button>
      )}

      {total != null && (
        <span className="ml-auto text-[11px] text-slate-500">
          {total} oportunidade{total === 1 ? "" : "s"}
        </span>
      )}
    </div>
  );
}

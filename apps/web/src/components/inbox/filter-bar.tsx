"use client";

import { ListFilter, Search, X } from "lucide-react";
import { ALL_USERS_ASSIGNEE_LABEL } from "@azvchat/shared";
import { cn } from "@/lib/utils";
import {
  countActiveInboxFilters,
  hasActiveInboxFilters,
  type InboxFilters,
  type QuickFilter,
} from "@/lib/inbox-filters";
import type { DepartmentDto, InstanceDto, TagDto } from "@/lib/types";
import { Badge, Button, Input } from "@/components/ui";

/**
 * Barra de filtros da lista de conversas. Extraída do `inbox-shell.tsx` para
 * ele não passar das ~1300 linhas — o estado continua lá (a consulta e o
 * tempo real dependem dele); aqui é só a apresentação.
 */

/**
 * Os filtros rápidos em grupos, para caber num seletor só — mesmo formato
 * dos filtros de número, departamento e etiqueta. Como só um vale por vez,
 * a fileira de chips não representava melhor o comportamento e ainda
 * empurrava metade das opções para fora da tela.
 */
const QUICK_FILTER_GROUPS: Array<{ label: string; options: Array<{ key: QuickFilter; label: string }> }> = [
  {
    label: "Atendimento",
    options: [
      { key: "mine", label: "Minhas" },
      { key: "unassigned", label: "Sem responsável" },
      // Separado de "Sem responsável" de propósito: as duas têm a conversa
      // sem dono, mas só uma está esperando alguém pegar.
      { key: "all_users", label: ALL_USERS_ASSIGNEE_LABEL },
      { key: "unread", label: "Não lidas" },
      // Visão à parte, nunca misturada: o padrão da lista é sem arquivadas.
      { key: "archived", label: "Arquivadas" },
    ],
  },
  {
    label: "Tipo",
    options: [
      { key: "groups", label: "Grupos" },
      { key: "individual", label: "Individuais" },
    ],
  },
  {
    label: "Status",
    options: [
      { key: "open", label: "Aberto" },
      { key: "waiting_client", label: "AG. Cliente" },
      { key: "waiting_internal", label: "AG. Operacional" },
      { key: "resolved", label: "Concluído" },
    ],
  },
];

/**
 * Estilo dos seletores de filtro. Com valor escolhido o campo fica marcado,
 * para a pessoa perceber de relance que a lista está filtrada — sem isso, um
 * filtro esquecido parece inbox vazia.
 */
function filterSelectClass(ativo: boolean): string {
  return cn(
    "rounded-lg border px-1.5 py-1 text-[11px]",
    ativo ? "border-brand-500 font-medium text-brand-700" : "border-slate-200 text-slate-600",
  );
}

export function FilterBar({
  filters,
  onChange,
  onClear,
  canFilterScope,
  instances,
  departments,
  tags,
}: {
  filters: InboxFilters;
  onChange: (patch: Partial<InboxFilters>) => void;
  onClear: () => void;
  /** Número e departamento só aparecem para supervisor e admin. */
  canFilterScope: boolean;
  instances: InstanceDto[];
  departments: DepartmentDto[];
  tags: TagDto[];
}) {
  const active = hasActiveInboxFilters(filters);
  const activeCount = countActiveInboxFilters(filters);

  return (
    <div className="space-y-2">
      <div className="relative">
        <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-slate-400" />
        <Input
          className="pl-8"
          placeholder="Buscar conversa, grupo, cliente..."
          value={filters.search}
          onChange={(event) => onChange({ search: event.target.value })}
        />
      </div>
      {/* Os quatro filtros no mesmo formato. Número e departamento só
          aparecem para quem enxerga mais de um recorte: para o usuário
          comum a lista já vem restrita, e os dois seletores ocupariam
          espaço sem mudar nada. */}
      <div className="grid grid-cols-2 gap-1.5">
        <select
          className={filterSelectClass(filters.quick !== "all")}
          value={filters.quick}
          onChange={(event) => onChange({ quick: event.target.value as QuickFilter })}
        >
          <option value="all">Todas</option>
          {QUICK_FILTER_GROUPS.map((group) => (
            <optgroup key={group.label} label={group.label}>
              {group.options.map((option) => (
                <option key={option.key} value={option.key}>
                  {option.label}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
        {canFilterScope && (
          <>
            <select
              className={filterSelectClass(filters.instanceId !== "")}
              value={filters.instanceId}
              onChange={(event) => onChange({ instanceId: event.target.value })}
            >
              <option value="">WhatsApp</option>
              {instances.map((instance) => (
                <option key={instance.id} value={instance.id}>
                  {instance.name}
                </option>
              ))}
            </select>
            <select
              className={filterSelectClass(filters.departmentId !== "")}
              value={filters.departmentId}
              onChange={(event) => onChange({ departmentId: event.target.value })}
            >
              <option value="">Depto</option>
              {departments.map((department) => (
                <option key={department.id} value={department.id}>
                  {department.name}
                </option>
              ))}
            </select>
          </>
        )}
        <select
          className={filterSelectClass(filters.tagId !== "")}
          value={filters.tagId}
          onChange={(event) => onChange({ tagId: event.target.value })}
        >
          <option value="">Etiqueta</option>
          {tags.map((tag) => (
            <option key={tag.id} value={tag.id}>
              {tag.name}
            </option>
          ))}
        </select>
      </div>
      {/* Aviso de lista filtrada + limpeza. Só existe com filtro ativo: sem
          ele, uma Inbox curta por causa de filtro esquecido parece vazia. */}
      {active && (
        <div className="flex items-center justify-between gap-2">
          <Badge className="bg-brand-500/10 text-brand-700">
            <ListFilter className="h-3 w-3" />
            {activeCount === 1 ? "1 filtro ativo" : `${activeCount} filtros ativos`}
          </Badge>
          <Button variant="ghost" size="sm" onClick={onClear} className="text-slate-500">
            <X className="h-3.5 w-3.5" /> Limpar filtros
          </Button>
        </div>
      )}
    </div>
  );
}

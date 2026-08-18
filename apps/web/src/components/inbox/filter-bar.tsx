"use client";

import { ListFilter, Search, TriangleAlert, X, Building2 } from "lucide-react";
import {
  ALL_USERS_ASSIGNEE_LABEL,
  ASSIGNMENT_ALL_USERS,
  ASSIGNMENT_FILTER_LABEL,
  ASSIGNMENT_GROUP_LABELS,
  ASSIGNMENT_NO_DEPARTMENT,
  ASSIGNMENT_NO_DEPARTMENT_LABEL,
  ASSIGNMENT_UNASSIGNED,
  AZEVEDO_OS_FACET_NONE,
  AZEVEDO_OS_FACET_NONE_LABEL,
  AZEVEDO_OS_FILTER_UNAVAILABLE_MESSAGE,
  AZEVEDO_OS_PAYROLL_LABEL,
  AZEVEDO_OS_TAX_REGIME_LABEL,
  CONVERSATION_STATUSES,
  CONVERSATION_STATUS_LABELS,
  USER_ROLE_LABELS,
  departmentAssignmentToken,
  userAssignmentToken,
  type AzevedoOsFacetsDto,
  type AzevedoOsFieldFacets,
  type ConversationStatus,
} from "@azvchat/shared";
import { cn } from "@/lib/utils";
import {
  clearFilterField,
  countActiveInboxFilters,
  filterFieldIsActive,
  hasActiveInboxFilters,
  type InboxFilterField,
  type InboxFilters,
  type InboxView,
} from "@/lib/inbox-filters";
import type {
  CompanyFilterStateDto,
  DepartmentDto,
  InstanceDto,
  TagDto,
  UserDirectoryDto,
} from "@/lib/types";
import { Badge, Button, Input, MultiSelect, type MultiSelectGroup } from "@/components/ui";

/**
 * Barra de filtros da lista de conversas. Extraída do `inbox-shell.tsx` para
 * ele não passar das ~1300 linhas: o estado continua lá (a consulta e o tempo
 * real dependem dele), aqui é só a apresentação.
 *
 * ## A regra que esta barra desenha
 *
 * **OU dentro de um filtro, E entre filtros diferentes.** Cada seletor aceita
 * vários valores, e o que está marcado ali soma; seletores diferentes cruzam.
 * A caixa de seleção é o sinal visual dessa soma, e é por isso que ela existe
 * em vez de um seletor de valor único.
 *
 * **Departamento e responsável são UM filtro só.** O caso normal do escritório
 * é "quero ver o Contábil inteiro mais a fulana", e fulana costuma ser de
 * outro departamento. Em dois filtros separados isso cruzaria por E e voltaria
 * vazio. Juntos, somam, que é o comportamento do programa antigo que a equipe
 * usava. Ver `@azvchat/shared/inbox-filters`.
 */

/**
 * Estilo dos seletores. Com valor escolhido o campo fica marcado, para a
 * pessoa perceber de relance que a lista está filtrada: sem isso, um filtro
 * esquecido parece inbox vazia.
 */
function filterSelectClass(ativo: boolean): string {
  return cn(
    "rounded-lg border px-1.5 py-1 text-[11px]",
    ativo ? "border-brand-500 font-medium text-brand-700" : "border-slate-200 text-slate-600",
  );
}

const VIEW_LABELS: Record<InboxView, string> = {
  all: "Todas",
  unread: "Não lidas",
  archived: "Arquivadas",
};

/** Rótulo curto de cada filtro no resumo do recorte ativo. */
const FIELD_LABELS: Record<InboxFilterField, string> = {
  view: "Visão",
  search: "Busca",
  assignment: ASSIGNMENT_FILTER_LABEL,
  instanceIds: "WhatsApp",
  tagIds: "Etiqueta",
  statuses: "Status",
  types: "Tipo",
  taxRegime: AZEVEDO_OS_TAX_REGIME_LABEL,
  payroll: AZEVEDO_OS_PAYROLL_LABEL,
  unlinked: "Sem empresa",
};

/** Ordem do resumo: a mesma da barra, para o olho não precisar procurar. */
const SUMMARY_FIELDS: InboxFilterField[] = [
  "view",
  "search",
  "statuses",
  "assignment",
  "instanceIds",
  "tagIds",
  "types",
  "payroll",
  "taxRegime",
  "unlinked",
];

function facetGroup(field: AzevedoOsFieldFacets | null): MultiSelectGroup[] {
  if (!field) return [];
  const options = [
    // "Sem informação" só entra quando existe empresa com o campo em branco:
    // opção que nunca devolve nada é beco sem saída no meio do seletor.
    ...(field.hasNone ? [{ value: AZEVEDO_OS_FACET_NONE, label: AZEVEDO_OS_FACET_NONE_LABEL }] : []),
    ...field.options.map((option) => ({ value: option.value, label: option.label })),
  ];
  return [{ label: null, options }];
}

export function FilterBar({
  filters,
  onChange,
  onClear,
  canFilterScope,
  instances,
  departments,
  tags,
  users,
  facets,
  facetsUnavailable,
  companyFilter,
  total,
}: {
  filters: InboxFilters;
  onChange: (patch: Partial<InboxFilters>) => void;
  onClear: () => void;
  /** Número, departamentos e pessoas só aparecem para supervisor e admin. */
  canFilterScope: boolean;
  instances: InstanceDto[];
  departments: DepartmentDto[];
  tags: TagDto[];
  users: UserDirectoryDto[];
  /** Opções vindas do Azevedo-OS; nulo = integração desligada. */
  facets: AzevedoOsFacetsDto | null;
  /** Portal mudo: os seletores aparecem, desligados e com o aviso. */
  facetsUnavailable: boolean;
  companyFilter: CompanyFilterStateDto | null;
  /** Quantas conversas o recorte devolveu; nulo enquanto carrega. */
  total: number | null;
}) {
  const active = hasActiveInboxFilters(filters);
  const activeCount = countActiveInboxFilters(filters);

  /**
   * Os três blocos do filtro unificado, na ordem do programa antigo. O bloco
   * de atendimento vem primeiro porque "sem responsável" é a fila que a
   * equipe olha todo dia.
   *
   * Para quem não filtra por recorte (o "Usuário"), só o primeiro bloco
   * aparece: a lista dele já é restrita às próprias conversas e às sem
   * responsável, então marcar um colega devolveria vazio sempre, e um filtro
   * que nunca acha nada é pior do que filtro nenhum.
   */
  const assignmentGroups: MultiSelectGroup[] = [
    {
      label: ASSIGNMENT_GROUP_LABELS.situation,
      options: [
        { value: ASSIGNMENT_UNASSIGNED, label: "Sem responsável" },
        { value: ASSIGNMENT_ALL_USERS, label: ALL_USERS_ASSIGNEE_LABEL },
        { value: ASSIGNMENT_NO_DEPARTMENT, label: ASSIGNMENT_NO_DEPARTMENT_LABEL },
      ],
    },
    ...(canFilterScope
      ? [
          {
            label: ASSIGNMENT_GROUP_LABELS.departments,
            options: departments.map((department) => ({
              value: departmentAssignmentToken(department.id),
              label: department.name,
            })),
          },
          {
            label: ASSIGNMENT_GROUP_LABELS.users,
            options: users
              // Usuário inativo não aparece: ele não recebe conversa nova, e
              // a lista existe para recortar atendimento, não para consultar
              // o cadastro de quem já saiu.
              .filter((user) => user.status === "active")
              .map((user) => ({
                value: userAssignmentToken(user.id),
                label: user.name,
                hint: USER_ROLE_LABELS[user.role],
              })),
          },
        ]
      : []),
  ].filter((group) => group.options.length > 0);

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

      {/* Status como botões, e não como seletor: são quatro, são o recorte
          mais usado do dia, e ver os quatro de uma vez custa menos que abrir
          uma lista. Marcar dois soma os dois, igual aos demais filtros. */}
      <div className="flex flex-wrap gap-1">
        {CONVERSATION_STATUSES.map((status) => {
          const marcado = filters.statuses.includes(status);
          return (
            <button
              key={status}
              type="button"
              aria-pressed={marcado}
              onClick={() =>
                onChange({
                  statuses: marcado
                    ? filters.statuses.filter((item) => item !== status)
                    : [...filters.statuses, status as ConversationStatus],
                })
              }
              className={cn(
                "rounded-full border px-2 py-0.5 text-[11px] transition-colors",
                marcado
                  ? "border-brand-550 bg-brand-550 font-medium text-white"
                  : "border-slate-200 text-slate-600 hover:bg-slate-50",
              )}
            >
              {CONVERSATION_STATUS_LABELS[status]}
            </button>
          );
        })}
      </div>

      <div className="grid grid-cols-2 gap-1.5">
        <select
          className={filterSelectClass(filters.view !== "all")}
          value={filters.view}
          onChange={(event) => onChange({ view: event.target.value as InboxView })}
        >
          {(Object.keys(VIEW_LABELS) as InboxView[]).map((view) => (
            <option key={view} value={view}>
              {VIEW_LABELS[view]}
            </option>
          ))}
        </select>

        <MultiSelect
          label="Tipo"
          groups={[
            {
              label: null,
              options: [
                { value: "group", label: "Grupos" },
                { value: "individual", label: "Individuais" },
              ],
            },
          ]}
          selected={filters.types}
          onChange={(types) => onChange({ types: types as InboxFilters["types"] })}
        />

        {/* Departamento e responsável no MESMO filtro, somando. */}
        <MultiSelect
          className="col-span-2"
          label={ASSIGNMENT_FILTER_LABEL}
          groups={assignmentGroups}
          selected={filters.assignment}
          onChange={(assignment) => onChange({ assignment })}
          searchPlaceholder="Buscar departamento ou pessoa..."
          emptyLabel="Nenhum departamento ou pessoa com esse nome."
        />

        {canFilterScope && (
          <MultiSelect
            label="WhatsApp"
            groups={[
              {
                label: null,
                options: instances.map((instance) => ({ value: instance.id, label: instance.name })),
              },
            ]}
            selected={filters.instanceIds}
            onChange={(instanceIds) => onChange({ instanceIds })}
          />
        )}

        <MultiSelect
          label="Etiqueta"
          groups={[{ label: null, options: tags.map((tag) => ({ value: tag.id, label: tag.name })) }]}
          selected={filters.tagIds}
          onChange={(tagIds) => onChange({ tagIds })}
        />

        {/* Característica do cliente, vinda do Azevedo-OS. */}
        {(facets !== null || facetsUnavailable) && (
          <>
            <MultiSelect
              label={AZEVEDO_OS_PAYROLL_LABEL}
              groups={facetGroup(facets?.payroll ?? null)}
              selected={filters.payroll}
              onChange={(payroll) => onChange({ payroll })}
              disabled={facetsUnavailable}
            />
            <MultiSelect
              label={AZEVEDO_OS_TAX_REGIME_LABEL}
              groups={facetGroup(facets?.taxRegime ?? null)}
              selected={filters.taxRegime}
              onChange={(taxRegime) => onChange({ taxRegime })}
              disabled={facetsUnavailable}
            />
          </>
        )}
      </div>

      {/* Recorte por empresa ligado e o portal caiu no meio: a lista voltou
          COMPLETA, sem o recorte. O aviso precisa dizer isso com todas as
          letras, senão a pessoa lê uma lista inteira achando que é a filtrada. */}
      {(facetsUnavailable || companyFilter?.unavailable) && (
        <p className="flex items-start gap-1.5 rounded-lg bg-amber-50 px-2 py-1.5 text-[11px] text-amber-800">
          <TriangleAlert className="mt-0.5 h-3 w-3 shrink-0" />
          {AZEVEDO_OS_FILTER_UNAVAILABLE_MESSAGE}
        </p>
      )}

      {/* Quantas ficaram de fora por não terem empresa vinculada. */}
      {!companyFilter?.unavailable && (companyFilter?.unlinkedExcluded ?? 0) > 0 && (
        <p className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 px-0.5 text-[11px] text-slate-500">
          <Building2 className="h-3 w-3 shrink-0" />
          {companyFilter?.unlinkedExcluded === 1
            ? "1 conversa ficou de fora por não ter empresa vinculada."
            : `${companyFilter?.unlinkedExcluded} conversas ficaram de fora por não terem empresa vinculada.`}
          <button
            type="button"
            className="font-medium text-brand-700 underline underline-offset-2"
            onClick={() => onChange({ unlinked: true })}
          >
            Ver as sem vínculo
          </button>
        </p>
      )}

      {companyFilter?.truncated && (
        <p className="px-0.5 text-[11px] text-amber-700">
          O cadastro devolveu empresas demais e a lista foi cortada. Combine com outro filtro para
          estreitar o recorte.
        </p>
      )}

      {filters.unlinked && (
        <p className="flex flex-wrap items-center gap-x-1.5 px-0.5 text-[11px] text-slate-500">
          <Building2 className="h-3 w-3 shrink-0" />
          Mostrando só conversas sem empresa vinculada.
          <button
            type="button"
            className="font-medium text-brand-700 underline underline-offset-2"
            onClick={() => onChange({ unlinked: false })}
          >
            Voltar
          </button>
        </p>
      )}

      {/* Contador SEMPRE visível, e o resumo do recorte logo abaixo.
          Multisseleção esconde o que está sendo visto: com quatro seletores
          fechados, "37 conversas" é a única coisa que diz de onde veio a
          lista curta. Cada item do resumo zera só o seu filtro, sem obrigar
          a abrir a lista dele. */}
      <div className="flex items-center justify-between gap-2">
        <span className="text-[11px] text-slate-500">
          {total === null ? "Carregando..." : total === 1 ? "1 conversa" : `${total} conversas`}
        </span>
        {active && (
          <Button variant="ghost" size="sm" onClick={onClear} className="text-slate-500">
            <X className="h-3.5 w-3.5" /> Limpar filtros
          </Button>
        )}
      </div>

      {active && (
        <div className="flex flex-wrap items-center gap-1">
          <Badge className="bg-brand-500/10 text-brand-700">
            <ListFilter className="h-3 w-3" />
            {activeCount === 1 ? "1 filtro" : `${activeCount} filtros`}
          </Badge>
          {SUMMARY_FIELDS.filter((field) => filterFieldIsActive(filters, field)).map((field) => (
            <button
              key={field}
              type="button"
              onClick={() => onChange(clearFilterField(filters, field))}
              title={`Remover o filtro de ${FIELD_LABELS[field]}`}
              className="inline-flex max-w-full items-center gap-1 rounded-full bg-slate-100 px-2 py-0.5 text-[11px] text-slate-600 hover:bg-slate-200"
            >
              <span className="truncate">{FIELD_LABELS[field]}</span>
              <X className="h-3 w-3 shrink-0" />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

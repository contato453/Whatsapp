"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { MessageSquare, Table2 } from "lucide-react";
import {
  CRM_LIST_PAGE_SIZE,
  crmOriginLabel,
  crmTimeInStageLabel,
  formatCurrencyBRL,
} from "@azvchat/shared";
import { api, crmApi } from "@/lib/api";
import { useAuth } from "@/lib/auth-context";
import {
  DEFAULT_CRM_FILTERS,
  readCrmFilters,
  saveCrmFilters,
  type CrmFilterState,
} from "@/lib/crm-filters";
import type {
  CrmLossReasonDto,
  CrmOpportunityDto,
  CrmPipelineDto,
  CrmProductDto,
  DepartmentDto,
  TagDto,
  UserDirectoryDto,
} from "@/lib/types";
import { Badge, Button, EmptyState, Spinner } from "@/components/ui";
import { CrmNav } from "@/components/crm/crm-nav";
import { CrmFilterBar } from "@/components/crm/crm-filter-bar";
import { OpportunityPanel } from "@/components/crm/opportunity-panel";
import { formatDateTime } from "@/lib/utils";

/**
 * A mesma coisa do Kanban, em tabela.
 *
 * Existe porque quadro é bom para trabalhar o funil e ruim para varrer: quem
 * precisa achar "todas as propostas acima de X paradas há duas semanas" lê
 * linha, não card. Os filtros são os MESMOS (mesmo estado guardado), então
 * trocar de visão não faz a pessoa remontar o recorte.
 *
 * Aqui, e não no quadro, aparecem também as GANHAS e PERDIDAS: o Kanban é do
 * que está em jogo agora.
 */
export default function CrmOpportunitiesPage() {
  const { user } = useAuth();
  const [filters, setFilters] = useState<CrmFilterState>(DEFAULT_CRM_FILTERS);
  const [status, setStatus] = useState<string[]>(["open"]);
  const [pipelines, setPipelines] = useState<CrmPipelineDto[]>([]);
  const [users, setUsers] = useState<UserDirectoryDto[]>([]);
  const [departments, setDepartments] = useState<DepartmentDto[]>([]);
  const [tags, setTags] = useState<TagDto[]>([]);
  const [products, setProducts] = useState<CrmProductDto[]>([]);
  const [lossReasons, setLossReasons] = useState<CrmLossReasonDto[]>([]);
  const [items, setItems] = useState<CrmOpportunityDto[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [carregando, setCarregando] = useState(true);
  const [aberta, setAberta] = useState<string | null>(null);

  useEffect(() => {
    if (user) setFilters(readCrmFilters(user.id));
  }, [user]);

  useEffect(() => {
    void crmApi.pipelines().then(setPipelines).catch(() => undefined);
    void crmApi
      .settings()
      .then((data) => {
        setProducts(data.products);
        setLossReasons(data.lossReasons);
      })
      .catch(() => undefined);
    void api.get<{ users: UserDirectoryDto[] }>("/users").then((d) => setUsers(d.users)).catch(() => undefined);
    void api
      .get<{ departments: DepartmentDto[] }>("/departments/mine")
      .then((d) => setDepartments(d.departments))
      .catch(() => undefined);
    void api.get<{ tags: TagDto[] }>("/tags").then((d) => setTags(d.tags)).catch(() => undefined);
  }, []);

  const carregar = useCallback(async () => {
    setCarregando(true);
    try {
      const data = await crmApi.list({
        pipelineId: filters.pipelineId || undefined,
        search: filters.search || undefined,
        assignedUserId: filters.assignedUserIds,
        departmentId: filters.departmentIds,
        tagId: filters.tagIds,
        origin: filters.origins,
        productId: filters.productIds,
        overdueActivity: filters.overdueActivity,
        status,
        offset,
      });
      setItems(data.opportunities);
      setTotal(data.total);
    } finally {
      setCarregando(false);
    }
  }, [filters, status, offset]);

  useEffect(() => {
    void carregar();
  }, [carregar]);

  useEffect(() => {
    if (user) saveCrmFilters(user.id, filters);
  }, [user, filters]);

  return (
    <div className="flex h-full flex-col">
      <div className="px-4 pt-4">
        <h1 className="text-lg font-semibold text-slate-900">CRM</h1>
        <p className="text-xs text-slate-500">Todas as oportunidades em formato de lista</p>
      </div>
      <CrmNav />
      <CrmFilterBar
        filters={filters}
        onChange={(next) => {
          setOffset(0);
          setFilters(next);
        }}
        pipelines={[{ id: "", name: "Todos os funis" } as CrmPipelineDto, ...pipelines]}
        users={users}
        departments={departments}
        tags={tags}
        products={products}
        total={total}
      />

      <div className="flex gap-1 px-4 pb-2">
        {(
          [
            ["open", "Em aberto"],
            ["won", "Ganhas"],
            ["lost", "Perdidas"],
          ] as const
        ).map(([valor, rotulo]) => {
          const marcado = status.includes(valor);
          return (
            <button
              key={valor}
              onClick={() => {
                setOffset(0);
                setStatus((atual) =>
                  marcado ? atual.filter((item) => item !== valor) : [...atual, valor],
                );
              }}
              className={
                marcado
                  ? "rounded-lg border border-brand-500 bg-brand-50 px-2 py-1 text-[11px] font-medium text-brand-700"
                  : "rounded-lg border border-slate-200 px-2 py-1 text-[11px] text-slate-600 hover:bg-slate-50"
              }
            >
              {rotulo}
            </button>
          );
        })}
      </div>

      <div className="flex min-h-0 flex-1">
        <div className="thin-scroll min-w-0 flex-1 overflow-auto px-4 pb-4">
          {carregando && (
            <div className="flex justify-center py-10">
              <Spinner />
            </div>
          )}
          {!carregando && items.length === 0 && (
            <EmptyState
              icon={<Table2 className="h-10 w-10" />}
              title="Nenhuma oportunidade no recorte"
              description="Ajuste os filtros ou abra uma oportunidade a partir de uma conversa."
            />
          )}
          {!carregando && items.length > 0 && (
            <table className="w-full min-w-[60rem] text-sm">
              <thead>
                <tr className="border-b border-slate-200 text-left text-[11px] uppercase tracking-wide text-slate-400">
                  <th className="py-2 pr-2">Oportunidade</th>
                  <th className="py-2 pr-2">Cliente</th>
                  <th className="py-2 pr-2">Etapa</th>
                  <th className="py-2 pr-2">Responsável</th>
                  <th className="py-2 pr-2 text-right">Valor</th>
                  <th className="py-2 pr-2">Origem</th>
                  <th className="py-2 pr-2">Próxima ação</th>
                  <th className="py-2">Parada há</th>
                </tr>
              </thead>
              <tbody>
                {items.map((item) => (
                  <tr
                    key={item.id}
                    onClick={() => setAberta(item.id)}
                    className="cursor-pointer border-b border-slate-100 hover:bg-slate-50"
                  >
                    <td className="py-2 pr-2">
                      <span className="font-medium text-slate-800">{item.title}</span>
                      {item.product && (
                        <span className="block text-[11px] text-slate-400">{item.product.name}</span>
                      )}
                    </td>
                    <td className="py-2 pr-2 text-slate-600">
                      {item.conversationId ? (
                        <Link
                          href={`/inbox/${item.conversationId}`}
                          onClick={(event) => event.stopPropagation()}
                          className="inline-flex items-center gap-1 text-brand-700 hover:underline"
                        >
                          <MessageSquare className="h-3 w-3" />
                          {item.contactName ?? "Conversa"}
                        </Link>
                      ) : (
                        (item.contactName ?? "—")
                      )}
                    </td>
                    <td className="py-2 pr-2">
                      <Badge color={item.stageColor}>{item.stageName}</Badge>
                    </td>
                    <td className="py-2 pr-2 text-slate-600">
                      {item.assignedUser?.name ?? "—"}
                    </td>
                    <td className="py-2 pr-2 text-right text-slate-700">
                      {formatCurrencyBRL(item.finalValue)}
                    </td>
                    <td className="py-2 pr-2 text-slate-500">{crmOriginLabel(item.origin)}</td>
                    <td className="py-2 pr-2 text-slate-500">
                      {item.nextActivity ? (
                        <span className={item.nextActivity.overdue ? "text-amber-700" : ""}>
                          {item.nextActivity.title} · {formatDateTime(item.nextActivity.dueAt)}
                        </span>
                      ) : (
                        "—"
                      )}
                    </td>
                    <td className="py-2 text-slate-500">
                      {crmTimeInStageLabel(item.stageEnteredAt)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          {total > CRM_LIST_PAGE_SIZE && (
            <div className="flex items-center justify-between gap-2 py-3 text-xs text-slate-500">
              <span>
                {offset + 1}–{Math.min(offset + CRM_LIST_PAGE_SIZE, total)} de {total}
              </span>
              <span className="flex gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  disabled={offset === 0}
                  onClick={() => setOffset(Math.max(0, offset - CRM_LIST_PAGE_SIZE))}
                >
                  Anterior
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={offset + CRM_LIST_PAGE_SIZE >= total}
                  onClick={() => setOffset(offset + CRM_LIST_PAGE_SIZE)}
                >
                  Próxima
                </Button>
              </span>
            </div>
          )}
        </div>

        {aberta && (
          <div className="absolute inset-0 z-20 bg-white lg:static lg:z-auto lg:w-[26rem] lg:shrink-0">
            <OpportunityPanel
              opportunityId={aberta}
              pipelines={pipelines}
              lossReasons={lossReasons}
              onClose={() => setAberta(null)}
              onChanged={() => void carregar()}
              onEdit={() => undefined}
            />
          </div>
        )}
      </div>
    </div>
  );
}

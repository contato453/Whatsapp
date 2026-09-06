"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { KanbanSquare, Plus } from "lucide-react";
import { formatCurrencyBRL, RealtimeEvents } from "@azvchat/shared";
import { api, crmApi } from "@/lib/api";
import { useAuth } from "@/lib/auth-context";
import { useSocket } from "@/lib/socket-context";
import {
  pruneCrmFilters,
  readCrmFilters,
  saveCrmFilters,
  type CrmFilterState,
  DEFAULT_CRM_FILTERS,
} from "@/lib/crm-filters";
import type {
  CrmBoardDto,
  CrmLossReasonDto,
  CrmOpportunityDto,
  CrmPipelineDto,
  CrmProductDto,
  DepartmentDto,
  TagDto,
  UserDirectoryDto,
} from "@/lib/types";
import { Button, EmptyState, Spinner } from "@/components/ui";
import { CrmNav } from "@/components/crm/crm-nav";
import { CrmFilterBar } from "@/components/crm/crm-filter-bar";
import { KanbanBoard } from "@/components/crm/kanban-board";
import { OpportunityForm } from "@/components/crm/opportunity-form";
import { OpportunityPanel } from "@/components/crm/opportunity-panel";

/**
 * O Kanban — a tela onde o CRM acontece.
 *
 * TEMPO REAL: o quadro escuta `crm:opportunity`, que carrega o card INTEIRO.
 * Quando o card chega, ele é trocado onde estiver (mudando de coluna se
 * preciso) — e sai do quadro se deixou de pertencer a este funil ou foi
 * fechado. Sem isso, duas pessoas trabalhando o mesmo funil veriam quadros
 * diferentes e uma desfaria o trabalho da outra.
 *
 * MOVIMENTAÇÃO OTIMISTA COM CONFERÊNCIA: o card muda de coluna na hora e a
 * chamada leva a etapa que ESTA tela acreditava. Recusa (409, alguém moveu
 * antes) recarrega o quadro em vez de insistir.
 */
export default function CrmKanbanPage() {
  const { user } = useAuth();
  const socket = useSocket();

  const [filters, setFilters] = useState<CrmFilterState>(DEFAULT_CRM_FILTERS);
  const [carregouFiltros, setCarregouFiltros] = useState(false);
  const [pipelines, setPipelines] = useState<CrmPipelineDto[]>([]);
  const [board, setBoard] = useState<CrmBoardDto | null>(null);
  const [users, setUsers] = useState<UserDirectoryDto[]>([]);
  const [departments, setDepartments] = useState<DepartmentDto[]>([]);
  const [tags, setTags] = useState<TagDto[]>([]);
  const [products, setProducts] = useState<CrmProductDto[]>([]);
  const [lossReasons, setLossReasons] = useState<CrmLossReasonDto[]>([]);
  const [carregando, setCarregando] = useState(true);
  const [erro, setErro] = useState<string | null>(null);
  const [movendo, setMovendo] = useState<string | null>(null);
  const [aberta, setAberta] = useState<string | null>(null);
  const [formAberto, setFormAberto] = useState(false);
  const [editando, setEditando] = useState<CrmOpportunityDto | null>(null);

  // A busca não pode disparar uma consulta por tecla.
  const buscaRef = useRef(filters.search);
  const [buscaAplicada, setBuscaAplicada] = useState("");

  useEffect(() => {
    if (!user) return;
    setFilters(readCrmFilters(user.id));
    setCarregouFiltros(true);
  }, [user]);

  useEffect(() => {
    buscaRef.current = filters.search;
    const timer = setTimeout(() => setBuscaAplicada(buscaRef.current), 350);
    return () => clearTimeout(timer);
  }, [filters.search]);

  /** Listas de apoio: uma vez só, e nenhuma delas bloqueia o quadro. */
  useEffect(() => {
    void crmApi.pipelines().then(setPipelines).catch(() => setPipelines([]));
    void crmApi
      .settings()
      .then((data) => {
        setProducts(data.products);
        setLossReasons(data.lossReasons);
      })
      .catch(() => undefined);
    void api
      .get<{ users: UserDirectoryDto[] }>("/users")
      .then((data) => setUsers(data.users))
      .catch(() =>
        // `GET /users` é de admin; quem não é continua com o filtro de
        // responsável vazio em vez de ver um erro que não sabe resolver.
        setUsers([]),
      );
    void api
      .get<{ departments: DepartmentDto[] }>("/departments/mine")
      .then((data) => setDepartments(data.departments))
      .catch(() => setDepartments([]));
    void api
      .get<{ tags: TagDto[] }>("/tags")
      .then((data) => setTags(data.tags))
      .catch(() => setTags([]));
  }, []);

  // Poda ANTES de virar consulta: id que sumiu do cadastro faria a API
  // recusar com 400, e esse erro não pode aparecer para quem só voltou à tela.
  useEffect(() => {
    if (!user || pipelines.length === 0) return;
    setFilters((atual) => {
      const podado = pruneCrmFilters(atual, {
        userIds: users.map((item) => item.id),
        departmentIds: departments.map((item) => item.id),
        tagIds: tags.map((item) => item.id),
        productIds: products.map((item) => item.id),
        pipelineIds: pipelines.map((item) => item.id),
      });
      const escolhido =
        podado.pipelineId ||
        pipelines.find((item) => item.isDefault)?.id ||
        pipelines[0]?.id ||
        "";
      return podado.pipelineId === escolhido ? podado : { ...podado, pipelineId: escolhido };
    });
  }, [user, pipelines, users, departments, tags, products]);

  useEffect(() => {
    if (!user || !carregouFiltros) return;
    saveCrmFilters(user.id, filters);
  }, [user, filters, carregouFiltros]);

  const carregarQuadro = useCallback(async () => {
    if (!filters.pipelineId) return;
    setErro(null);
    try {
      const data = await crmApi.board({
        pipelineId: filters.pipelineId,
        search: buscaAplicada || undefined,
        assignedUserId: filters.assignedUserIds,
        departmentId: filters.departmentIds,
        tagId: filters.tagIds,
        origin: filters.origins,
        productId: filters.productIds,
        overdueActivity: filters.overdueActivity,
      });
      setBoard(data);
    } catch (err) {
      setErro(err instanceof Error ? err.message : "Não foi possível carregar o quadro");
    } finally {
      setCarregando(false);
    }
  }, [
    filters.pipelineId,
    filters.assignedUserIds,
    filters.departmentIds,
    filters.tagIds,
    filters.origins,
    filters.productIds,
    filters.overdueActivity,
    buscaAplicada,
  ]);

  useEffect(() => {
    void carregarQuadro();
  }, [carregarQuadro]);

  /** Tempo real: o card chega inteiro e substitui o que estiver no quadro. */
  useEffect(() => {
    if (!socket) return;
    const aoMudar = (opportunity: CrmOpportunityDto) => {
      setBoard((atual) => {
        if (!atual) return atual;
        const pertence =
          opportunity.pipelineId === atual.pipeline.id && opportunity.status === "open";
        const colunas = atual.columns.map((coluna) => {
          const semEle = coluna.opportunities.filter((item) => item.id !== opportunity.id);
          const tinha = semEle.length !== coluna.opportunities.length;
          if (pertence && coluna.stage.id === opportunity.stageId) {
            const lista = [...semEle, opportunity].sort((a, b) => a.position - b.position);
            return {
              ...coluna,
              opportunities: lista,
              // O total da coluna vem do servidor; ajustar aqui só mantém o
              // número coerente até a próxima carga, sem inventar valor.
              totals: tinha
                ? coluna.totals
                : { ...coluna.totals, count: coluna.totals.count + 1 },
            };
          }
          return tinha
            ? {
                ...coluna,
                opportunities: semEle,
                totals: { ...coluna.totals, count: Math.max(0, coluna.totals.count - 1) },
              }
            : coluna;
        });
        return { ...atual, columns: colunas };
      });
    };
    socket.on(RealtimeEvents.CrmOpportunity, aoMudar);
    return () => {
      socket.off(RealtimeEvents.CrmOpportunity, aoMudar);
    };
  }, [socket]);

  async function mover(input: {
    opportunity: CrmOpportunityDto;
    toStageId: string;
    beforeId: string | null;
    afterId: string | null;
  }) {
    setMovendo(input.opportunity.id);
    try {
      await crmApi.move(input.opportunity.id, {
        stageId: input.toStageId,
        // A etapa que ESTA tela acredita ser a atual: é ela que faz o servidor
        // recusar quando o colega moveu o card um segundo antes.
        fromStageId: input.opportunity.stageId,
        beforeId: input.beforeId,
        afterId: input.afterId,
      });
      // A resposta já emite o evento de socket para todo mundo, esta aba
      // incluída — não é preciso mexer no estado aqui.
    } catch (err) {
      setErro(
        err instanceof Error
          ? err.message
          : "Não foi possível mover. O quadro foi recarregado.",
      );
      await carregarQuadro();
    } finally {
      setMovendo(null);
    }
  }

  const funilAtual = pipelines.find((item) => item.id === filters.pipelineId) ?? null;

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between gap-2 px-4 pt-4">
        <div>
          <h1 className="text-lg font-semibold text-slate-900">CRM</h1>
          <p className="text-xs text-slate-500">
            {board
              ? `${board.totals.count} oportunidade(s) em aberto · ${formatCurrencyBRL(
                  board.totals.value,
                )} no funil · ${formatCurrencyBRL(board.totals.weightedValue)} ponderado`
              : "Funil de oportunidades do atendimento"}
          </p>
        </div>
        <Button onClick={() => { setEditando(null); setFormAberto(true); }}>
          <Plus className="h-4 w-4" /> Nova oportunidade
        </Button>
      </div>

      <CrmNav />

      <CrmFilterBar
        filters={filters}
        onChange={setFilters}
        pipelines={pipelines}
        users={users}
        departments={departments}
        tags={tags}
        products={products}
        total={board?.totals.count}
      />

      {erro && (
        <p className="mx-4 mb-2 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700">{erro}</p>
      )}

      <div className="flex min-h-0 flex-1">
        <div className="min-w-0 flex-1">
          {carregando && (
            <div className="flex h-full items-center justify-center">
              <Spinner className="h-8 w-8" />
            </div>
          )}
          {!carregando && pipelines.length === 0 && (
            <EmptyState
              icon={<KanbanSquare className="h-10 w-10" />}
              title="Nenhum funil disponível"
              description="Peça a um supervisor para criar um funil e liberá-lo para o seu departamento."
            />
          )}
          {!carregando && board && board.columns.length === 0 && (
            <EmptyState
              icon={<KanbanSquare className="h-10 w-10" />}
              title="Este funil ainda não tem etapas"
              description="Configure as colunas em CRM → Funis."
            />
          )}
          {!carregando && board && board.columns.length > 0 && (
            <KanbanBoard
              columns={board.columns}
              moving={movendo}
              onOpen={(oportunidade) => setAberta(oportunidade.id)}
              onMove={(input) => void mover(input)}
            />
          )}
        </div>

        {aberta && (
          // Em tela estreita o painel cobre o quadro; no desktop ele divide a
          // largura, para não perder o funil de vista.
          <div className="absolute inset-0 z-20 bg-white lg:static lg:z-auto lg:w-[26rem] lg:shrink-0">
            <OpportunityPanel
              opportunityId={aberta}
              pipelines={pipelines}
              lossReasons={lossReasons}
              onClose={() => setAberta(null)}
              onChanged={() => void carregarQuadro()}
              onEdit={(oportunidade) => {
                setEditando(oportunidade);
                setFormAberto(true);
              }}
            />
          </div>
        )}
      </div>

      <OpportunityForm
        open={formAberto}
        onClose={() => setFormAberto(false)}
        pipelines={funilAtual ? [funilAtual, ...pipelines.filter((p) => p.id !== funilAtual.id)] : pipelines}
        products={products}
        users={users}
        tags={tags}
        editing={editando}
        onSaved={() => void carregarQuadro()}
      />
    </div>
  );
}

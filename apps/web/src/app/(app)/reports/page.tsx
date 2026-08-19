"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Download, RefreshCw } from "lucide-react";
import {
  ALL_USERS_ASSIGNEE_HINT,
  CONVERSATION_STATUS_LABELS,
  DASHBOARD_NO_DEPARTMENT_LABEL,
  FILTER_NONE,
  type ConversationStatus,
} from "@azvchat/shared";
import { api, reportsApi, type ReportFilters } from "@/lib/api";
import { useAuth } from "@/lib/auth-context";
import {
  queueCellStyle,
  queueSlice,
  resolvedCellStyle,
  resolvedSlice,
  rowLabel,
  type ReportRowRef,
  type ReportSlice,
} from "@/lib/report-cells";
import type {
  AgentReportDto,
  AgentReportRowDto,
  DepartmentDto,
  InstanceDto,
  QueueByStatusDto,
} from "@/lib/types";
import {
  Button,
  Card,
  EmptyState,
  MultiSelect,
  Spinner,
  type MultiSelectGroup,
} from "@/components/ui";
import { UserAvatar } from "@/components/user-avatar";
import { ReportSlicePanel } from "@/components/reports/slice-panel";

/** Períodos prontos — o dia a dia da gestão cabe nestes quatro. */
const PRESETS = [
  { key: "today", label: "Hoje" },
  { key: "7d", label: "7 dias" },
  { key: "30d", label: "30 dias" },
  { key: "month", label: "Este mês" },
] as const;

type PresetKey = (typeof PRESETS)[number]["key"];

/** As três colunas de fila, na ordem em que a tabela as mostra. */
const QUEUE_COLUMNS = [
  { status: "open" as const, field: "open" as const },
  { status: "waiting_client" as const, field: "waitingClient" as const },
  { status: "waiting_internal" as const, field: "waitingInternal" as const },
];

function rangeFor(preset: PresetKey): { from: Date; to: Date } {
  const to = new Date();
  const from = new Date();
  if (preset === "today") {
    from.setHours(0, 0, 0, 0);
  } else if (preset === "7d") {
    from.setDate(from.getDate() - 7);
  } else if (preset === "30d") {
    from.setDate(from.getDate() - 30);
  } else {
    from.setDate(1);
    from.setHours(0, 0, 0, 0);
  }
  return { from, to };
}

/** "2h 15min", "3min", "45s" — mesma regra usada na API. */
function formatDuration(seconds: number | null): string {
  if (seconds == null) return "—";
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest > 0 ? `${hours}h ${rest}min` : `${hours}h`;
}

function toDateInput(date: Date): string {
  const offset = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 10);
}

export default function ReportsPage() {
  const { user: me } = useAuth();
  const [preset, setPreset] = useState<PresetKey | "custom">("7d");
  const [customFrom, setCustomFrom] = useState(toDateInput(rangeFor("7d").from));
  const [customTo, setCustomTo] = useState(toDateInput(new Date()));
  const [report, setReport] = useState<AgentReportDto | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [slice, setSlice] = useState<ReportSlice | null>(null);
  const [departmentIds, setDepartmentIds] = useState<string[]>([]);
  const [instanceIds, setInstanceIds] = useState<string[]>([]);
  const [departments, setDepartments] = useState<DepartmentDto[]>([]);
  const [instances, setInstances] = useState<InstanceDto[]>([]);
  // Sobe a cada carga da tabela: o painel aberto recarrega junto, em vez de
  // continuar mostrando a lista de antes do "Atualizar".
  const [reloadToken, setReloadToken] = useState(0);

  /**
   * As duas listas já vêm recortadas pelo acesso de quem pediu, então o
   * seletor nunca oferece um chip ou departamento que a pessoa não enxerga.
   */
  useEffect(() => {
    api
      .get<{ instances: InstanceDto[] }>("/whatsapp-instances")
      .then((data) => setInstances(data.instances))
      .catch(() => undefined);
    api
      .get<{ departments: DepartmentDto[] }>("/departments/mine")
      .then((data) => setDepartments(data.departments))
      .catch(() => undefined);
  }, []);

  const range = useMemo(() => {
    if (preset !== "custom") return rangeFor(preset);
    const from = new Date(`${customFrom}T00:00:00`);
    const to = new Date(`${customTo}T23:59:59`);
    return { from, to };
  }, [preset, customFrom, customTo]);

  const filters = useMemo<ReportFilters>(
    () => ({ departmentId: departmentIds, instanceId: instanceIds }),
    [departmentIds, instanceIds],
  );

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setReport(
        await reportsApi.agents(range.from.toISOString(), range.to.toISOString(), filters),
      );
      setReloadToken((token) => token + 1);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Erro ao carregar o relatório");
    } finally {
      setLoading(false);
    }
  }, [range, filters]);

  useEffect(() => {
    void load();
  }, [load]);

  /**
   * Trocar o período OU um filtro fecha o painel. Os números da tabela mudam
   * por baixo dele, e um painel exibindo o recorte anterior é exatamente o
   * tipo de dado velho que faz a equipe deixar de confiar no relatório.
   */
  useEffect(() => {
    setSlice(null);
  }, [range, filters]);

  /**
   * Item marcado que deixou de existir — chip apagado, departamento excluído
   * — sai do recorte em SILÊNCIO, assim que as listas chegam. Quem poda é a
   * tela, porque só ela sabe o que ainda existe, e ela poda ANTES de virar
   * consulta: a API recusa id desconhecido com 400, e esse erro não pode
   * aparecer para quem só voltou à tela depois de um cadastro ter mudado.
   */
  useEffect(() => {
    if (departments.length === 0) return;
    setDepartmentIds((atual) => {
      const vivos = atual.filter(
        (id) => id === FILTER_NONE || departments.some((row) => row.id === id),
      );
      return vivos.length === atual.length ? atual : vivos;
    });
  }, [departments]);

  useEffect(() => {
    if (instances.length === 0) return;
    setInstanceIds((atual) => {
      const vivos = atual.filter((id) => instances.some((row) => row.id === id));
      return vivos.length === atual.length ? atual : vivos;
    });
  }, [instances]);

  /** CSV gerado no navegador: os dados já estão todos aqui. */
  function downloadCsv() {
    if (!report) return;
    const header = [
      "Atendente",
      "E-mail",
      "Mensagens enviadas",
      "Conversas atendidas",
      "Tempo médio de resposta (s)",
      "Respostas medidas",
      "Conversas concluídas",
      "Fila: Aberto",
      "Fila: AG. Cliente",
      "Fila: AG. Operacional",
    ];
    const lines = report.rows.map((row) =>
      [
        row.user.name,
        row.user.email,
        row.messagesSent,
        row.conversationsHandled,
        row.avgResponseSeconds ?? "",
        row.responsesMeasured,
        row.conversationsResolved,
        row.queue.open,
        row.queue.waitingClient,
        row.queue.waitingInternal,
      ]
        .map((value) => `"${String(value).replace(/"/g, '""')}"`)
        .join(";"),
    );
    // As duas linhas sem dono também vão para o CSV: elas estão na tabela, e
    // um arquivo com totais menores que a tela levantaria a mesma dúvida.
    const semDono = ([
      ["Sem responsável", report.unassigned.queue],
      ["@todos", report.allUsers.queue],
    ] as const).map(([nome, queue]) =>
      [nome, "", "", "", "", "", "", queue.open, queue.waitingClient, queue.waitingInternal]
        .map((value) => `"${String(value).replace(/"/g, '""')}"`)
        .join(";"),
    );
    const csv = [header.join(";"), ...semDono, ...lines].join("\n");
    // BOM para o Excel abrir os acentos corretamente.
    const blob = new Blob(["﻿", csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `atendimentos-${toDateInput(range.from)}-a-${toDateInput(range.to)}.csv`;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  }

  /**
   * O maior valor de cada coluna, que dá a escala do preenchimento. As duas
   * linhas sem dono entram: a fila órfã costuma ser a maior da coluna, e
   * deixá-la fora faria o tom das demais estourar no topo da escala.
   */
  const columnMax = useMemo((): QueueByStatusDto => {
    if (!report) return { open: 0, waitingClient: 0, waitingInternal: 0 };
    const queues = [
      ...report.rows.map((row) => row.queue),
      report.unassigned.queue,
      report.allUsers.queue,
    ];
    return {
      open: Math.max(0, ...queues.map((queue) => queue.open)),
      waitingClient: Math.max(0, ...queues.map((queue) => queue.waitingClient)),
      waitingInternal: Math.max(0, ...queues.map((queue) => queue.waitingInternal)),
    };
  }, [report]);

  if (me && me.role !== "admin" && me.role !== "supervisor") {
    return (
      <div className="p-8">
        <EmptyState
          title="Relatório restrito"
          description="Apenas supervisores e administradores acessam os números da equipe."
        />
      </div>
    );
  }

  const departmentGroups: MultiSelectGroup[] = [
    {
      label: null,
      options: [
        // Conversa sem departamento existe quando o número não tem
        // departamento padrão — precisa ser possível olhar só para ela.
        { value: FILTER_NONE, label: DASHBOARD_NO_DEPARTMENT_LABEL },
        ...departments.map((department) => ({ value: department.id, label: department.name })),
      ],
    },
  ];

  const instanceGroups: MultiSelectGroup[] = [
    {
      label: null,
      options: instances.map((instance) => ({ value: instance.id, label: instance.name })),
    },
  ].filter((group) => group.options.length > 0);

  // Aviso de recorte vazio: com filtro marcado a causa provável é o
  // cruzamento, e não a falta de movimento. Dizer a coisa errada aqui faz a
  // pessoa procurar defeito no relatório.
  const filtrando = departmentIds.length > 0 || instanceIds.length > 0;

  function openSlice(next: ReportSlice) {
    // Clicar de novo na mesma célula fecha o painel — é o gesto que a pessoa
    // tenta antes de procurar o botão de fechar.
    setSlice((atual) => (atual?.key === next.key ? null : next));
  }

  return (
    <div className="flex h-full">
      <div className="thin-scroll min-w-0 flex-1 overflow-y-auto p-8">
        <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-2xl font-bold text-slate-900">Atendimentos por atendente</h1>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={() => void load()} disabled={loading}>
              <RefreshCw className="h-4 w-4" /> Atualizar
            </Button>
            <Button size="sm" onClick={downloadCsv} disabled={!report || report.rows.length === 0}>
              <Download className="h-4 w-4" /> Baixar CSV
            </Button>
          </div>
        </div>

        <div className="mb-4 flex flex-wrap items-center gap-2">
          {PRESETS.map((option) => (
            <button
              key={option.key}
              onClick={() => setPreset(option.key)}
              className={
                preset === option.key
                  ? "rounded-full bg-brand-600 px-3 py-1 text-xs font-medium text-white"
                  : "rounded-full bg-slate-100 px-3 py-1 text-xs font-medium text-slate-600 hover:bg-slate-200"
              }
            >
              {option.label}
            </button>
          ))}
          <button
            onClick={() => setPreset("custom")}
            className={
              preset === "custom"
                ? "rounded-full bg-brand-600 px-3 py-1 text-xs font-medium text-white"
                : "rounded-full bg-slate-100 px-3 py-1 text-xs font-medium text-slate-600 hover:bg-slate-200"
            }
          >
            Personalizado
          </button>
          {/*
           * Os dois filtros ficam na MESMA barra do período, e não numa
           * linha própria: são três controles do mesmo recorte, e separá-los
           * faria a pessoa procurar onde está o resto.
           *
           * OU dentro do filtro, E entre filtros: marcar Contábil e Fiscal
           * mostra os dois; marcar Contábil junto de um chip mostra só o que
           * está nos dois ao mesmo tempo. Aqui eles CRUZAM com o responsável
           * da linha, como no Dashboard e ao contrário da lista de conversas
           * — a célula é um número, e somar recortes diferentes dentro do
           * mesmo total não responde pergunta nenhuma.
           */}
          <MultiSelect
            label="Departamento"
            className="w-40"
            groups={departmentGroups}
            selected={departmentIds}
            onChange={setDepartmentIds}
            searchPlaceholder="Buscar departamento"
            emptyLabel="Nenhum departamento"
          />
          <MultiSelect
            label="Conexão"
            className="w-40"
            groups={instanceGroups}
            selected={instanceIds}
            onChange={setInstanceIds}
            searchPlaceholder="Buscar conexão"
            emptyLabel="Nenhuma conexão"
          />
          {(departmentIds.length > 0 || instanceIds.length > 0) && (
            <button
              onClick={() => {
                setDepartmentIds([]);
                setInstanceIds([]);
              }}
              className="text-xs font-medium text-slate-500 underline-offset-2 hover:text-slate-700 hover:underline"
            >
              Limpar filtros
            </button>
          )}
          {preset === "custom" && (
            <span className="flex items-center gap-2 text-xs text-slate-500">
              <input
                type="date"
                value={customFrom}
                max={customTo}
                onChange={(event) => setCustomFrom(event.target.value)}
                className="rounded-lg border border-slate-300 px-2 py-1"
              />
              até
              <input
                type="date"
                value={customTo}
                min={customFrom}
                onChange={(event) => setCustomTo(event.target.value)}
                className="rounded-lg border border-slate-300 px-2 py-1"
              />
            </span>
          )}
        </div>

        {loading ? (
          <div className="flex justify-center py-16">
            <Spinner className="h-8 w-8" />
          </div>
        ) : error ? (
          <p className="text-sm text-red-600">{error}</p>
        ) : !report || (report.rows.length === 0 && report.totals.openNow === 0) ? (
          <EmptyState
            title={filtrando ? "Nada neste recorte" : "Sem movimento no período"}
            description={
              filtrando
                ? "Os filtros CRUZAM: a conversa precisa estar no departamento e na conexão marcados ao mesmo tempo. Desmarque um deles para alargar o recorte."
                : "Nenhum atendente enviou mensagens nas datas selecionadas."
            }
          />
        ) : (
          <>
            <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
              <SummaryCard label="Recebidas" value={report.totals.messagesReceived} />
              <SummaryCard label="Enviadas" value={report.totals.messagesSent} />
              <SummaryCard label="Concluídas" value={report.totals.conversationsResolved} />
              <SummaryCard label="Na fila agora" value={report.totals.openNow} />
            </div>

            {report.truncated && (
              <p className="mb-3 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-700">
                O período selecionado tem mensagens demais e os números estão parciais. Escolha um
                intervalo menor para o relatório ficar exato.
              </p>
            )}

            <Card className="overflow-x-auto">
              <table className="w-full min-w-[900px] text-sm">
                <thead>
                  <tr className="border-b border-slate-100 text-left text-xs uppercase tracking-wide text-slate-400">
                    <th className="px-4 py-3 font-medium">Atendente</th>
                    <th className="px-4 py-3 text-right font-medium">Mensagens</th>
                    <th className="px-4 py-3 text-right font-medium">Conversas</th>
                    <th className="px-4 py-3 text-right font-medium">Tempo médio</th>
                    <th className="px-4 py-3 text-right font-medium">Concluídas</th>
                    {/*
                     * Fila atual, separada por status. O total vem no próprio
                     * cabeçalho ("ABERTO (35)") e soma a coluna INTEIRA,
                     * inclusive as duas linhas sem dono: número de cabeçalho
                     * que não fecha com o que está na tela vira desconfiança
                     * no relatório todo.
                     */}
                    {QUEUE_COLUMNS.map((column, index) => (
                      <th
                        key={column.status}
                        className={
                          index === 0
                            ? "border-l border-slate-100 px-4 py-3 text-right font-medium"
                            : "px-4 py-3 text-right font-medium"
                        }
                      >
                        {CONVERSATION_STATUS_LABELS[column.status]} (
                        {report.totals.queue[column.field]})
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {/*
                   * As duas linhas sem dono vêm no topo: elas são a fila que
                   * ninguém está olhando, e é justamente essa que precisa
                   * aparecer primeiro.
                   */}
                  <QueueOnlyRow
                    row={{ kind: "unassigned" }}
                    queue={report.unassigned.queue}
                    hint="Conversas esperando alguém assumir."
                    columnMax={columnMax}
                    slice={slice}
                    onOpen={openSlice}
                  />
                  <QueueOnlyRow
                    row={{ kind: "all_users" }}
                    queue={report.allUsers.queue}
                    hint={ALL_USERS_ASSIGNEE_HINT}
                    columnMax={columnMax}
                    slice={slice}
                    onOpen={openSlice}
                  />
                  {report.rows.map((row) => (
                    <AgentRow
                      key={row.user.id}
                      row={row}
                      from={report.from}
                      to={report.to}
                      columnMax={columnMax}
                      slice={slice}
                      onOpen={openSlice}
                    />
                  ))}
                </tbody>
              </table>
            </Card>

            <div className="mt-3 space-y-1 text-xs text-slate-400">
              <p>
                <strong>Conversas</strong>: em quantas conversas distintas a pessoa respondeu no
                período. <strong>Tempo médio</strong>: da mensagem do cliente até a resposta dela; o
                número entre parênteses é quantas respostas entraram na média.
              </p>
              <p>
                <strong>Aberto</strong>, <strong>AG. Cliente</strong> e{" "}
                <strong>AG. Operacional</strong> são o retrato de agora — a fila atual da pessoa em
                cada etapa —, e não dependem do período escolhido. <strong>Concluídas</strong>, sim:
                conta quantas ela concluiu dentro das datas selecionadas.
              </p>
              <p>
                Clique em qualquer número maior que zero para ver, ao lado, quais conversas formam
                aquele recorte. Célula zerada não abre nada.
              </p>
            </div>
          </>
        )}
      </div>

      {slice && (
        <ReportSlicePanel
          slice={slice}
          filters={filters}
          onClose={() => setSlice(null)}
          reloadToken={reloadToken}
        />
      )}
    </div>
  );
}

/** Linha de um atendente. */
function AgentRow({
  row,
  from,
  to,
  columnMax,
  slice,
  onOpen,
}: {
  row: AgentReportRowDto;
  from: string;
  to: string;
  columnMax: QueueByStatusDto;
  slice: ReportSlice | null;
  onOpen: (slice: ReportSlice) => void;
}) {
  const ref: ReportRowRef = { kind: "user", userId: row.user.id, name: row.user.name };
  const resolved = resolvedSlice(ref, row.conversationsResolved, from, to);
  return (
    <tr>
      <td className="px-4 py-3">
        <div className="flex items-center gap-2">
          <UserAvatar
            userId={row.user.id}
            name={row.user.name}
            hasAvatar={row.user.hasAvatar}
            className="h-7 w-7 text-[10px]"
          />
          <div className="min-w-0">
            <p className="truncate font-medium text-slate-900">
              {row.user.name}
              {/* Desativado que ainda tem fila continua na tabela: sumir com
                  ele esconderia trabalho parado na mão de quem saiu. */}
              {row.user.status === "inactive" && (
                <span className="ml-1 rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-normal text-slate-500">
                  Inativo
                </span>
              )}
            </p>
            <p className="truncate text-xs text-slate-400">{row.user.email}</p>
          </div>
        </div>
      </td>
      <td className="px-4 py-3 text-right tabular-nums text-slate-600">{row.messagesSent}</td>
      <td className="px-4 py-3 text-right tabular-nums text-slate-600">
        {row.conversationsHandled}
      </td>
      <td className="px-4 py-3 text-right tabular-nums text-slate-600">
        {formatDuration(row.avgResponseSeconds)}
        {row.responsesMeasured > 0 && (
          <span className="ml-1 text-[10px] text-slate-400">({row.responsesMeasured})</span>
        )}
      </td>
      <ResolvedCell slice={resolved} selected={slice?.key === resolved.key} onOpen={onOpen} />
      {QUEUE_COLUMNS.map((column, index) => {
        const cell = queueSlice(ref, column.status, row.queue[column.field]);
        return (
          <QueueCell
            key={column.status}
            slice={cell}
            columnMax={columnMax[column.field]}
            status={column.status}
            first={index === 0}
            selected={slice?.key === cell.key}
            onOpen={onOpen}
          />
        );
      })}
    </tr>
  );
}

/**
 * Linha que não é de ninguém: órfãs e coletivo.
 *
 * Mensagens, Conversas, Tempo médio e Concluídas ficam em traço, e não em
 * zero: são medidas de uma PESSOA, e um zero ali seria lido como "não
 * trabalhou" quando o certo é "não se aplica".
 */
function QueueOnlyRow({
  row,
  queue,
  hint,
  columnMax,
  slice,
  onOpen,
}: {
  row: ReportRowRef;
  queue: QueueByStatusDto;
  hint: string;
  columnMax: QueueByStatusDto;
  slice: ReportSlice | null;
  onOpen: (slice: ReportSlice) => void;
}) {
  return (
    <tr className="bg-slate-50/60">
      <td className="px-4 py-3">
        <p className="font-medium text-slate-700">{rowLabel(row)}</p>
        <p className="truncate text-xs text-slate-400">{hint}</p>
      </td>
      <td className="px-4 py-3 text-right text-slate-300">—</td>
      <td className="px-4 py-3 text-right text-slate-300">—</td>
      <td className="px-4 py-3 text-right text-slate-300">—</td>
      <td className="px-4 py-3 text-right text-slate-300">—</td>
      {QUEUE_COLUMNS.map((column, index) => {
        const cell = queueSlice(row, column.status, queue[column.field]);
        return (
          <QueueCell
            key={column.status}
            slice={cell}
            columnMax={columnMax[column.field]}
            status={column.status}
            first={index === 0}
            selected={slice?.key === cell.key}
            onOpen={onOpen}
          />
        );
      })}
    </tr>
  );
}

/**
 * Célula de fila. Com valor, ganha cor e vira botão; **zerada, fica apagada
 * e inerte** — não há conversa nenhuma para listar, e um botão que não faz
 * nada ensina a equipe a desconfiar dos que fazem.
 */
function QueueCell({
  slice,
  columnMax,
  status,
  first,
  selected,
  onOpen,
}: {
  slice: ReportSlice;
  columnMax: number;
  status: ConversationStatus;
  first: boolean;
  selected: boolean;
  onOpen: (slice: ReportSlice) => void;
}) {
  const value = slice.cellValue;
  const borda = first ? "border-l border-slate-100" : "";
  if (value <= 0) {
    return <td className={`${borda} px-4 py-3 text-right tabular-nums text-slate-300`}>0</td>;
  }
  return (
    <td className={`${borda} p-1`}>
      <button
        type="button"
        onClick={() => onOpen(slice)}
        style={queueCellStyle(value, columnMax, status)}
        className={`w-full rounded-md px-3 py-2 text-right text-sm font-medium tabular-nums text-slate-900 transition-shadow hover:brightness-95 ${
          selected ? "ring-2 ring-slate-900 ring-offset-1" : ""
        }`}
        aria-pressed={selected}
      >
        {value}
      </button>
    </td>
  );
}

/** Concluídas: contorno em vez de preenchimento — é do período, não de agora. */
function ResolvedCell({
  slice,
  selected,
  onOpen,
}: {
  slice: ReportSlice;
  selected: boolean;
  onOpen: (slice: ReportSlice) => void;
}) {
  const value = slice.cellValue;
  if (value <= 0) {
    return <td className="px-4 py-3 text-right tabular-nums text-slate-300">0</td>;
  }
  return (
    <td className="p-1">
      <button
        type="button"
        onClick={() => onOpen(slice)}
        style={resolvedCellStyle(value)}
        className={`w-full rounded-md border border-dashed px-3 py-2 text-right text-sm font-medium tabular-nums transition-colors hover:bg-slate-50 ${
          selected ? "ring-2 ring-slate-900 ring-offset-1" : ""
        }`}
        aria-pressed={selected}
      >
        {value}
      </button>
    </td>
  );
}

function SummaryCard({ label, value }: { label: string; value: number }) {
  return (
    <Card className="p-4">
      <p className="text-xs uppercase tracking-wide text-slate-400">{label}</p>
      <p className="mt-1 text-2xl font-bold text-slate-900 tabular-nums">{value}</p>
    </Card>
  );
}

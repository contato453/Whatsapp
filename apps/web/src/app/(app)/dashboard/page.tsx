"use client";

import { useCallback, useEffect, useState, type ReactNode } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  AlertTriangle,
  ArrowDownLeft,
  ArrowUpRight,
  CheckCircle2,
  CircleDot,
  Hourglass,
  MessagesSquare,
  Smartphone,
  TrendingUp,
  Users2,
  UserRound,
  X,
} from "lucide-react";
import {
  CONNECTION_STATUSES,
  CONNECTION_STATUS_COLORS,
  CONNECTION_STATUS_LABELS,
  CONVERSATION_STATUSES,
  CONVERSATION_STATUS_COLORS,
  CONVERSATION_STATUS_LABELS,
  DASHBOARD_PERIODS,
  DASHBOARD_PERIOD_LABELS,
  DASHBOARD_PERIOD_PHRASES,
  DATE_ONLY_PATTERN,
  FILTER_NONE,
  USER_ROLE_LABELS,
  hasRole,
  type ConversationStatus,
  type DashboardPeriod,
} from "@azvchat/shared";
import { api, dashboardApi, type DashboardFilters } from "@/lib/api";
import { useAuth } from "@/lib/auth-context";
import type {
  DashboardRankingRowDto,
  DashboardStatsDto,
  DashboardTopUserDto,
  DepartmentDto,
  InstanceDto,
  UserDirectoryDto,
} from "@/lib/types";
import { cn } from "@/lib/utils";
import { Card, EmptyState } from "@/components/ui";
import { UserAvatar } from "@/components/user-avatar";
import { MessagesTimeline } from "@/components/dashboard/messages-timeline";
import { HoursHeatmap } from "@/components/dashboard/hours-heatmap";

/**
 * Filtros da tela guardados por navegador, igual à barra lateral: mesmo
 * prefixo do token, nada de coluna em `User`. Quem abre o dashboard todo dia
 * olhando o mesmo departamento não deveria remontar o filtro toda vez.
 */
const FILTERS_STORAGE_KEY = "zapdesk.dashboard-filters";
/** Chave antiga, de quando só existia o período. Lida uma vez, para migrar. */
const LEGACY_PERIOD_KEY = "zapdesk.dashboard-period";

const DEFAULT_FILTERS: DashboardFilters = { period: "today" };

function isPeriod(value: unknown): value is DashboardPeriod {
  return typeof value === "string" && (DASHBOARD_PERIODS as readonly string[]).includes(value);
}

function isDate(value: unknown): value is string {
  return typeof value === "string" && DATE_ONLY_PATTERN.test(value);
}

/** Só devolve o que reconhece: storage adulterado não vira requisição inválida. */
function readFilters(): DashboardFilters {
  try {
    const raw = window.localStorage.getItem(FILTERS_STORAGE_KEY);
    if (!raw) {
      const legacy = window.localStorage.getItem(LEGACY_PERIOD_KEY);
      return isPeriod(legacy) ? { period: legacy } : DEFAULT_FILTERS;
    }
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return DEFAULT_FILTERS;
    const value = parsed as Record<string, unknown>;
    const filters: DashboardFilters = {
      period: isPeriod(value.period) ? value.period : "today",
    };
    if (isDate(value.from)) filters.from = value.from;
    if (isDate(value.to)) filters.to = value.to;
    if (typeof value.instanceId === "string") filters.instanceId = value.instanceId;
    if (typeof value.departmentId === "string") filters.departmentId = value.departmentId;
    if (typeof value.assignedUserId === "string") filters.assignedUserId = value.assignedUserId;
    // Personalizado sem as duas datas não é pedido válido: cai no padrão.
    if (filters.period === "custom" && (!filters.from || !filters.to)) return DEFAULT_FILTERS;
    return filters;
  } catch {
    // Storage bloqueado (aba privada) ou JSON estragado: vale o padrão, Hoje.
    return DEFAULT_FILTERS;
  }
}

function writeFilters(filters: DashboardFilters): void {
  try {
    window.localStorage.setItem(FILTERS_STORAGE_KEY, JSON.stringify(filters));
  } catch {
    // Sem storage a escolha vale só para esta aba — segue o jogo.
  }
}

/** Data de hoje no relógio de quem está olhando, no formato do campo. */
function todayInput(): string {
  const now = new Date();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${now.getFullYear()}-${month}-${day}`;
}

/**
 * A saudação segue o relógio de quem está olhando, e não o do servidor: quem
 * abre às 8h da manhã precisa ler "bom dia" mesmo que o container esteja em
 * UTC. Por isso ela é calculada depois da hidratação.
 */
function greetingFor(hour: number): string {
  if (hour >= 5 && hour < 12) return "Bom dia";
  if (hour >= 12 && hour < 18) return "Boa tarde";
  return "Boa noite";
}

/** Só o primeiro nome; nome de uma palavra só usa ela mesma. */
function firstNameOf(name: string): string {
  const [first] = name.trim().split(/\s+/);
  return first ?? name;
}

function fullDateOf(date: Date): string {
  const text = date.toLocaleDateString("pt-BR", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  });
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/**
 * Endereço da Inbox já recortada, para o card de status virar atalho.
 *
 * Vai só o que a Inbox sabe aplicar e mostrar: o status e, quando são ids de
 * verdade, o número e o departamento. "Sem departamento", "sem responsável" e
 * o filtro de responsável não têm controle equivalente lá, e mandar
 * parâmetro que ela ignoraria em silêncio seria pior do que não mandar.
 *
 * O período também não vai: a Inbox lista por status, não por atividade num
 * intervalo. Por isso a tela avisa que a lista pode vir maior que o card.
 */
function inboxHref(status: ConversationStatus, filters: DashboardFilters): string {
  const params = new URLSearchParams({ status });
  if (filters.instanceId) params.set("instanceId", filters.instanceId);
  if (filters.departmentId && filters.departmentId !== FILTER_NONE) {
    params.set("departmentId", filters.departmentId);
  }
  return `/inbox?${params.toString()}`;
}

/** Espera em tempo de expediente, do jeito que se fala: "2h14", "45min". */
function formatWaiting(minutes: number): string {
  if (minutes < 60) return `${minutes}min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return `${hours}h${String(rest).padStart(2, "0")}`;
}

// ---------- Peças da grade ----------

function SectionTitle({ children, note }: { children: ReactNode; note?: string }) {
  return (
    <div className="mb-2.5 mt-7 flex flex-wrap items-baseline gap-x-2.5 gap-y-0.5">
      <h2 className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">
        {children}
      </h2>
      {note && <span className="text-[11px] italic text-slate-400">{note}</span>}
    </div>
  );
}

/** Barra cinza no lugar do número enquanto os dados não chegam. */
function ValueSkeleton({ className }: { className?: string }) {
  return (
    <span
      aria-hidden
      className={cn(
        "block h-7 w-12 animate-pulse rounded bg-slate-200 motion-reduce:animate-none",
        className,
      )}
    />
  );
}

function StatCard({
  label,
  value,
  icon,
  accent,
  hint,
  pending,
  alert,
  href,
}: {
  label: string;
  value: number;
  icon: ReactNode;
  accent?: string;
  hint?: ReactNode;
  pending: boolean;
  alert?: boolean;
  /** Quando presente, o card vira link para a Inbox já filtrada. */
  href?: string;
}) {
  const color = accent ?? "#475569";
  const card = (
    <Card
      className={cn(
        "flex h-full flex-col gap-2 p-4",
        // Alerta só quando existe o que alertar: zero atrasado não é vermelho.
        alert && "border-red-300 bg-red-50/60",
        href &&
          "transition-colors hover:border-slate-300 hover:bg-slate-50 motion-reduce:transition-none",
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="text-[11px] font-medium uppercase tracking-wide text-slate-500">
          {label}
        </span>
        <span
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg"
          style={{ backgroundColor: `${color}1a`, color }}
        >
          {icon}
        </span>
      </div>
      {pending ? (
        <ValueSkeleton />
      ) : (
        // Fonte tabular: o número não dança de largura a cada atualização.
        <span className="text-3xl font-bold leading-none tabular-nums text-slate-900">{value}</span>
      )}
      {hint && <div className="text-[11px] leading-tight text-slate-500">{hint}</div>}
    </Card>
  );
  if (!href) return card;
  // Link de verdade, e não `onClick`: abrir em outra aba e o botão do meio
  // continuam funcionando, que é o que se espera de um atalho de navegação.
  return (
    <Link
      href={href}
      className="block rounded-xl focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/40"
    >
      {card}
    </Link>
  );
}

/** Barra proporcional ao primeiro colocado: dá a escala sem gráfico. */
function ShareBar({ share }: { share: number }) {
  return (
    <div className="mt-1.5 h-1 w-full overflow-hidden rounded-full bg-slate-100">
      <div
        className="h-full rounded-full bg-brand-500/70 transition-[width] duration-300 motion-reduce:transition-none"
        style={{ width: `${share}%` }}
      />
    </div>
  );
}

/** Posição na lista. Fonte tabular para os dois dígitos não desalinharem. */
function RankPosition({ position }: { position: number }) {
  return (
    <span className="w-4 shrink-0 text-right text-xs font-semibold tabular-nums text-slate-400">
      {position}
    </span>
  );
}

function RankingRow({
  row,
  position,
  leader,
  onOpen,
}: {
  row: DashboardRankingRowDto;
  position: number;
  leader: number;
  onOpen: () => void;
}) {
  const share = leader > 0 ? Math.round((row.total / leader) * 100) : 0;
  return (
    <button
      type="button"
      onClick={onOpen}
      className="block w-full px-4 py-2.5 text-left transition-colors hover:bg-slate-50 focus:outline-none focus-visible:bg-slate-50 motion-reduce:transition-none"
    >
      <div className="flex items-center gap-3">
        <RankPosition position={position} />
        <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-slate-100 text-slate-500">
          {row.type === "group" ? (
            <Users2 className="h-3.5 w-3.5" />
          ) : (
            <UserRound className="h-3.5 w-3.5" />
          )}
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium text-slate-900">{row.title}</p>
          <p className="flex items-center gap-1 truncate text-[11px] text-slate-500">
            <span className="shrink-0">
              {row.type === "group" ? "Grupo" : "Individual"}
              {row.instanceName ? ` · ${row.instanceName}` : ""}
            </span>
            <span className="shrink-0 text-slate-300">·</span>
            <UserRound className="h-3 w-3 shrink-0 text-slate-400" />
            {/* Mesmo tratamento da lista da Inbox: nome em cinza, e o âmbar
                reservado para a conversa que ninguém assumiu — ativa e sem
                dono é o caso que pede ação. */}
            {row.assignee ? (
              <span className="truncate text-slate-600">{row.assignee.name}</span>
            ) : (
              <span className="truncate font-medium text-amber-600">Sem responsável</span>
            )}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-3 text-xs tabular-nums text-slate-500">
          <span className="hidden items-center gap-1 sm:inline-flex" title="Recebidas">
            <ArrowDownLeft className="h-3 w-3 text-emerald-600" />
            {row.received}
          </span>
          <span className="hidden items-center gap-1 sm:inline-flex" title="Enviadas">
            <ArrowUpRight className="h-3 w-3 text-sky-600" />
            {row.sent}
          </span>
          <span className="w-10 text-right text-sm font-semibold text-slate-900">{row.total}</span>
        </div>
      </div>
      <ShareBar share={share} />
    </button>
  );
}

function TopUserRow({
  row,
  position,
  leader,
}: {
  row: DashboardTopUserDto;
  position: number;
  leader: number;
}) {
  const share = leader > 0 ? Math.round((row.total / leader) * 100) : 0;
  return (
    <div className="px-4 py-2.5">
      <div className="flex items-center gap-3">
        <RankPosition position={position} />
        <UserAvatar userId={row.userId} name={row.name} hasAvatar={row.hasAvatar} size="sm" />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium text-slate-900">{row.name}</p>
          <p className="truncate text-[11px] text-slate-500">{USER_ROLE_LABELS[row.role]}</p>
        </div>
        <div className="flex shrink-0 items-center gap-3 text-xs tabular-nums text-slate-500">
          <span
            className="hidden items-center gap-1 sm:inline-flex"
            title="Recebidas do cliente nas conversas dele"
          >
            <ArrowDownLeft className="h-3 w-3 text-emerald-600" />
            {row.received}
          </span>
          <span className="hidden items-center gap-1 sm:inline-flex" title="Enviadas por ele">
            <ArrowUpRight className="h-3 w-3 text-sky-600" />
            {row.sent}
          </span>
          <span className="w-10 text-right text-sm font-semibold text-slate-900">{row.total}</span>
        </div>
      </div>
      <ShareBar share={share} />
    </div>
  );
}

/** Seletor da barra de filtros — mesmo desenho do resto do kit. */
function FilterSelect({
  label,
  value,
  onChange,
  children,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  children: ReactNode;
}) {
  return (
    <label className="flex min-w-0 flex-col gap-1">
      <span className="text-[10px] font-medium uppercase tracking-wide text-slate-400">
        {label}
      </span>
      <select
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="w-full rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 text-xs text-slate-900 focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/20"
      >
        {children}
      </select>
    </label>
  );
}

// ---------- Tela ----------

export default function DashboardPage() {
  const { user } = useAuth();
  const router = useRouter();

  const [filters, setFilters] = useState<DashboardFilters>(DEFAULT_FILTERS);
  const [stats, setStats] = useState<DashboardStatsDto | null>(null);
  const [pending, setPending] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState<Date | null>(null);

  const [instances, setInstances] = useState<InstanceDto[]>([]);
  const [departments, setDepartments] = useState<DepartmentDto[]>([]);
  const [users, setUsers] = useState<UserDirectoryDto[]>([]);

  // Os filtros salvos e a hora local entram depois da hidratação: o HTML do
  // servidor não conhece nem o storage nem o relógio de quem está olhando.
  useEffect(() => {
    setFilters(readFilters());
    setNow(new Date());
  }, []);

  // As três listas já vêm recortadas pelo acesso de quem pediu, então o
  // seletor nunca oferece um número ou departamento que a pessoa não enxerga.
  useEffect(() => {
    api
      .get<{ instances: InstanceDto[] }>("/whatsapp-instances")
      .then((data) => setInstances(data.instances))
      .catch(() => undefined);
    api
      .get<{ departments: DepartmentDto[] }>("/departments/mine")
      .then((data) => setDepartments(data.departments))
      .catch(() => undefined);
    api
      .get<{ users: UserDirectoryDto[] }>("/users")
      .then((data) => setUsers(data.users))
      .catch(() => undefined);
  }, []);

  const load = useCallback((next: DashboardFilters) => {
    setPending(true);
    setError(null);
    dashboardApi
      .stats(next)
      // Os dados antigos continuam na tela até os novos chegarem: trocar o
      // filtro mostra esqueleto nos cards, não uma página em branco.
      .then(setStats)
      .catch((err) => setError(err instanceof Error ? err.message : "Erro ao carregar"))
      .finally(() => setPending(false));
  }, []);

  useEffect(() => {
    load(filters);
  }, [load, filters]);

  function apply(next: DashboardFilters): void {
    setFilters(next);
    writeFilters(next);
  }

  function choosePeriod(period: DashboardPeriod): void {
    if (period === "custom") {
      // Já entra com um intervalo válido (hoje a hoje): sem isso a tela
      // ficaria pedindo dois campos antes de mostrar qualquer número.
      const today = todayInput();
      apply({ ...filters, period, from: filters.from ?? today, to: filters.to ?? today });
      return;
    }
    apply({ ...filters, period });
  }

  function chooseScope(key: "instanceId" | "departmentId" | "assignedUserId", value: string): void {
    const next = { ...filters };
    if (value) next[key] = value;
    else delete next[key];
    apply(next);
  }

  const greeting = now ? `${greetingFor(now.getHours())}, ${firstNameOf(user?.name ?? "")}` : "";
  const byStatus = stats?.conversations.byStatus;
  const leader = stats?.ranking[0]?.total ?? 0;
  const topUsers = stats?.topUsers ?? null;
  const topUserLeader = topUsers?.[0]?.total ?? 0;
  const offline = stats ? stats.instances.disconnected : 0;
  const phrase = DASHBOARD_PERIOD_PHRASES[filters.period];
  const noAccess = stats !== null && stats.instances.connected + offline === 0;
  const hasScopeFilter = Boolean(
    filters.instanceId || filters.departmentId || filters.assignedUserId,
  );
  // Recortes que a Inbox não sabe reproduzir: o aviso abaixo dos cards de
  // status só aparece quando o clique realmente vai levar menos filtro.
  const carriesPartialScope = Boolean(
    filters.assignedUserId || filters.departmentId === FILTER_NONE,
  );
  // O bloco de equipe é de supervisor para cima, igual ao requireRole que a
  // API aplica — sem isso o atendente veria um card vazio sem saber por quê.
  const canSeeTeam = user ? hasRole(user.role, "supervisor") : false;

  return (
    <div className="thin-scroll h-full overflow-y-auto p-6 lg:p-8">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-h-[3.25rem]">
          <h1 className="text-2xl font-bold text-slate-900">{greeting || " "}</h1>
          <p className="text-sm text-slate-500">{now ? fullDateOf(now) : " "}</p>
        </div>
        <div
          className="inline-flex rounded-lg border border-slate-200 bg-white p-0.5 shadow-sm"
          role="group"
          aria-label="Período dos indicadores"
        >
          {DASHBOARD_PERIODS.map((option) => (
            <button
              key={option}
              type="button"
              aria-pressed={filters.period === option}
              onClick={() => choosePeriod(option)}
              className={cn(
                "rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors motion-reduce:transition-none sm:px-3",
                filters.period === option
                  ? "bg-slate-900 text-white"
                  : "text-slate-600 hover:bg-slate-100",
              )}
            >
              {DASHBOARD_PERIOD_LABELS[option]}
            </button>
          ))}
        </div>
      </div>

      <Card className="mt-4 p-3">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-5">
          {filters.period === "custom" && (
            <>
              <label className="flex min-w-0 flex-col gap-1">
                <span className="text-[10px] font-medium uppercase tracking-wide text-slate-400">
                  De
                </span>
                <input
                  type="date"
                  value={filters.from ?? ""}
                  max={filters.to}
                  onChange={(event) => apply({ ...filters, from: event.target.value })}
                  className="w-full rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 text-xs text-slate-900 focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/20"
                />
              </label>
              <label className="flex min-w-0 flex-col gap-1">
                <span className="text-[10px] font-medium uppercase tracking-wide text-slate-400">
                  Até
                </span>
                <input
                  type="date"
                  value={filters.to ?? ""}
                  min={filters.from}
                  onChange={(event) => apply({ ...filters, to: event.target.value })}
                  className="w-full rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 text-xs text-slate-900 focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/20"
                />
              </label>
            </>
          )}
          <FilterSelect
            label="Chip"
            value={filters.instanceId ?? ""}
            onChange={(value) => chooseScope("instanceId", value)}
          >
            <option value="">Todos os chips</option>
            {instances.map((instance) => (
              <option key={instance.id} value={instance.id}>
                {instance.name}
              </option>
            ))}
          </FilterSelect>
          <FilterSelect
            label="Departamento"
            value={filters.departmentId ?? ""}
            onChange={(value) => chooseScope("departmentId", value)}
          >
            <option value="">Todos os departamentos</option>
            {departments.map((department) => (
              <option key={department.id} value={department.id}>
                {department.name}
              </option>
            ))}
            {/* Conversa sem departamento existe quando o número não tem
                departamento padrão — precisa ser possível olhar só para ela. */}
            <option value={FILTER_NONE}>Sem departamento</option>
          </FilterSelect>
          <FilterSelect
            label="Responsável"
            value={filters.assignedUserId ?? ""}
            onChange={(value) => chooseScope("assignedUserId", value)}
          >
            <option value="">Todos os responsáveis</option>
            {users.map((option) => (
              <option key={option.id} value={option.id}>
                {option.name}
              </option>
            ))}
            <option value={FILTER_NONE}>Sem responsável</option>
          </FilterSelect>
          {hasScopeFilter && (
            <div className="flex items-end">
              <button
                type="button"
                onClick={() => apply({ period: filters.period, from: filters.from, to: filters.to })}
                className="inline-flex items-center gap-1 rounded-lg px-2.5 py-1.5 text-xs font-medium text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-700 motion-reduce:transition-none"
              >
                <X className="h-3.5 w-3.5" />
                Limpar filtros
              </button>
            </div>
          )}
        </div>
      </Card>

      {error && <p className="mt-4 text-sm text-red-600">{error}</p>}

      {/* Sem número liberado no login, todo indicador seria zero e a tela
          pareceria quebrada. Melhor dizer o motivo do que deixar adivinhar. */}
      {noAccess && !hasScopeFilter && (
        <Card className="mt-4 border-amber-200 bg-amber-50 p-4">
          <p className="text-sm font-medium text-amber-900">
            Nenhum número de WhatsApp liberado para o seu acesso.
          </p>
          <p className="mt-0.5 text-xs text-amber-800">
            Por isso todos os indicadores aparecem zerados. Peça a um administrador para
            vincular os números e departamentos ao seu usuário.
          </p>
        </Card>
      )}

      <SectionTitle>Atendimento</SectionTitle>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
        <StatCard
          label={`Conversas ativas ${phrase}`}
          value={stats?.conversations.active ?? 0}
          icon={<TrendingUp className="h-4 w-4" />}
          accent="#4f46e5"
          hint="Conversas com ao menos uma mensagem no período, agrupadas pelo status atual."
          pending={pending && !stats}
        />
        <StatCard
          label="Atrasados agora"
          value={stats?.overdue.count ?? 0}
          icon={<AlertTriangle className="h-4 w-4" />}
          accent={stats && stats.overdue.count > 0 ? "#dc2626" : "#64748b"}
          alert={Boolean(stats && stats.overdue.count > 0)}
          pending={pending && !stats}
          hint={
            <>
              {/* Este card não olha o período: é sempre o estado agora. */}
              <span className="block">
                Estado agora, sem filtro de período · limite: {stats?.responseLimitMinutes ?? 30}{" "}
                min
              </span>
              {stats?.overdue.oldestWaitingMinutes !== null &&
                stats?.overdue.oldestWaitingMinutes !== undefined && (
                  <span className="block font-medium text-red-700">
                    mais antigo: {formatWaiting(stats.overdue.oldestWaitingMinutes)}
                  </span>
                )}
            </>
          }
        />
        <StatCard
          label="Números fora do ar"
          value={offline}
          icon={<Smartphone className="h-4 w-4" />}
          accent={offline > 0 ? "#dc2626" : "#16a34a"}
          alert={offline > 0}
          pending={pending && !stats}
          hint={
            offline > 0
              ? "Número fora do ar trava atendimento — veja a quebra em Infraestrutura."
              : "Todos os números que você enxerga estão conectados."
          }
        />
      </div>

      <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {CONVERSATION_STATUSES.map((status: ConversationStatus) => (
          <StatCard
            key={status}
            label={CONVERSATION_STATUS_LABELS[status]}
            value={byStatus?.[status] ?? 0}
            icon={
              status === "resolved" ? (
                <CheckCircle2 className="h-4 w-4" />
              ) : status === "open" ? (
                <CircleDot className="h-4 w-4" />
              ) : (
                <Hourglass className="h-4 w-4" />
              )
            }
            accent={CONVERSATION_STATUS_COLORS[status]}
            pending={pending && !stats}
            href={inboxHref(status, filters)}
          />
        ))}
      </div>
      <p className="mt-1.5 text-[11px] text-slate-400">
        Clique em um status para abrir a Inbox filtrada. Lá a lista não usa o período, então
        ela pode vir maior que o número do card
        {carriesPartialScope ? ", e o filtro de responsável não é levado" : ""}.
      </p>

      <SectionTitle note="Quantidade não significa qualidade.">Mensagens</SectionTitle>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <StatCard
          label={`Recebidas ${phrase}`}
          value={stats?.messages.received ?? 0}
          icon={<ArrowDownLeft className="h-4 w-4" />}
          accent="#16a34a"
          pending={pending && !stats}
        />
        <StatCard
          label={`Enviadas ${phrase}`}
          value={stats?.messages.sent ?? 0}
          icon={<ArrowUpRight className="h-4 w-4" />}
          accent="#0891b2"
          pending={pending && !stats}
        />
      </div>

      {/* Os gráficos ficam sob os cards de mensagens: os cards dão o total do
          período, e estes mostram como esse total se distribuiu. */}
      <div className="mt-3 grid grid-cols-1 gap-3 xl:grid-cols-2">
        {pending && !stats ? (
          <>
            <div
              aria-hidden
              className="h-56 animate-pulse rounded-xl border border-slate-200 bg-slate-50 motion-reduce:animate-none"
            />
            <div
              aria-hidden
              className="h-56 animate-pulse rounded-xl border border-slate-200 bg-slate-50 motion-reduce:animate-none"
            />
          </>
        ) : (
          stats && (
            <>
              <MessagesTimeline points={stats.timeline} periodLabel={phrase} />
              <HoursHeatmap cells={stats.hourly} periodLabel={phrase} />
            </>
          )
        )}
      </div>

      <SectionTitle>Infraestrutura</SectionTitle>
      <Card className="p-4">
        <div className="flex flex-wrap items-center gap-x-8 gap-y-3">
          <div>
            <p className="text-[11px] font-medium uppercase tracking-wide text-slate-500">
              Números conectados
            </p>
            {pending && !stats ? (
              <ValueSkeleton />
            ) : (
              <p className="text-3xl font-bold leading-none tabular-nums text-slate-900">
                {stats?.instances.connected ?? 0}
                <span className="ml-1 text-base font-medium text-slate-400">
                  /{(stats?.instances.connected ?? 0) + offline}
                </span>
              </p>
            )}
          </div>
          {/* A quebra só aparece quando existe algo fora do ar — lista de
              zeros não informa nada. */}
          {stats && offline > 0 && (
            <div className="flex flex-wrap gap-2">
              {CONNECTION_STATUSES.filter(
                (status) => status !== "connected" && stats.instances.byStatus[status] > 0,
              ).map((status) => (
                <span
                  key={status}
                  className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium tabular-nums"
                  style={{
                    backgroundColor: `${CONNECTION_STATUS_COLORS[status]}1a`,
                    color: CONNECTION_STATUS_COLORS[status],
                  }}
                >
                  <span
                    className="h-1.5 w-1.5 rounded-full"
                    style={{ backgroundColor: CONNECTION_STATUS_COLORS[status] }}
                  />
                  {CONNECTION_STATUS_LABELS[status]}: {stats.instances.byStatus[status]}
                </span>
              ))}
            </div>
          )}
          {stats && offline === 0 && (
            <p className="text-xs text-slate-500">Nenhum número fora do ar.</p>
          )}
        </div>
      </Card>

      <div className={cn("mb-8 grid grid-cols-1 gap-x-4", canSeeTeam && "xl:grid-cols-2")}>
        <div className="min-w-0">
          <SectionTitle>Conversas mais ativas {phrase}</SectionTitle>
          <Card className="divide-y divide-slate-100 overflow-hidden">
            {pending && !stats ? (
              <div className="space-y-3 p-4">
                {[0, 1, 2, 3, 4].map((row) => (
                  <div
                    key={row}
                    aria-hidden
                    className="h-8 animate-pulse rounded bg-slate-100 motion-reduce:animate-none"
                  />
                ))}
              </div>
            ) : stats && stats.ranking.length === 0 ? (
              <EmptyState
                icon={<MessagesSquare className="h-6 w-6" />}
                title="Nenhuma conversa com movimento"
                description={`Não houve mensagens ${phrase}.`}
              />
            ) : (
              stats?.ranking.map((row, index) => (
                <RankingRow
                  key={row.conversationId}
                  row={row}
                  position={index + 1}
                  leader={leader}
                  onOpen={() => router.push(`/inbox/${row.conversationId}`)}
                />
              ))
            )}
          </Card>
        </div>

        {canSeeTeam && (
          <div className="min-w-0">
            <SectionTitle note="recebidas = do cliente nas conversas dele">
              Usuários mais ativos {phrase}
            </SectionTitle>
            <Card className="divide-y divide-slate-100 overflow-hidden">
              {pending && !stats ? (
                <div className="space-y-3 p-4">
                  {[0, 1, 2, 3, 4].map((row) => (
                    <div
                      key={row}
                      aria-hidden
                      className="h-8 animate-pulse rounded bg-slate-100 motion-reduce:animate-none"
                    />
                  ))}
                </div>
              ) : topUsers && topUsers.length > 0 ? (
                topUsers.map((row, index) => (
                  <TopUserRow
                    key={row.userId}
                    row={row}
                    position={index + 1}
                    leader={topUserLeader}
                  />
                ))
              ) : (
                <EmptyState
                  icon={<Users2 className="h-6 w-6" />}
                  title="Nenhum usuário com movimento"
                  description={`Ninguém enviou nem recebeu mensagens ${phrase}.`}
                />
              )}
            </Card>
          </div>
        )}
      </div>
    </div>
  );
}

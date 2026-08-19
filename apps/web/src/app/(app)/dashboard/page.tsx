"use client";

import { useCallback, useEffect, useState, type ReactNode } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  AlertCircle,
  AlertTriangle,
  Archive,
  ArrowDownLeft,
  ArrowUpRight,
  CheckCircle2,
  CircleDot,
  Database,
  Hourglass,
  Info,
  ListFilter,
  Mail,
  MessagesSquare,
  PhoneOff,
  QrCode,
  RadioTower,
  RotateCcw,
  SlidersHorizontal,
  TrendingUp,
  Users2,
  UserRound,
} from "lucide-react";
import {
  CONNECTION_STATUSES,
  CONNECTION_STATUS_COLORS,
  CONNECTION_STATUS_LABELS,
  CONVERSATION_STATUSES,
  ALL_USERS_ASSIGNEE_LABEL,
  CONVERSATION_STATUS_COLORS,
  CONVERSATION_STATUS_LABELS,
  DASHBOARD_EMPTY_CROSS_MESSAGE,
  DASHBOARD_EMPTY_FILTER_MESSAGE,
  DASHBOARD_FILTER_LABELS,
  DASHBOARD_NO_DEPARTMENT_LABEL,
  DASHBOARD_PERIODS,
  DASHBOARD_PERIOD_LABELS,
  DASHBOARD_PERIOD_PHRASES,
  DASHBOARD_UNASSIGNED_LABEL,
  FILTER_ALL_USERS,
  FILTER_NONE,
  USER_ROLE_LABELS,
  type ConnectionStatus,
  type ConversationStatus,
  type DashboardPeriod,
} from "@azvchat/shared";
import { api, dashboardApi } from "@/lib/api";
import {
  clearDashboardFilters,
  DEFAULT_DASHBOARD_FILTERS,
  hasActiveDashboardFilters,
  pruneDashboardFilters,
  readDashboardFilters,
  saveDashboardFilters,
  type DashboardFilters,
} from "@/lib/dashboard-filters";
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
import { Card, EmptyState, MultiSelect, type MultiSelectGroup } from "@/components/ui";
import { UserAvatar } from "@/components/user-avatar";
import { MessagesTimeline } from "@/components/dashboard/messages-timeline";
import { HoursHeatmap } from "@/components/dashboard/hours-heatmap";
import { Sparkline } from "@/components/dashboard/sparkline";
import { ConnectivityRing } from "@/components/dashboard/connectivity-ring";

/**
 * O Dashboard fica no INDIGO de propósito, fora da paleta de marca.
 *
 * Ele é a tela de leitura da operação: os números convivem com o verde de
 * estado ("Aberto", "conectado") e com o verde das barras de recebidas, e um
 * acento de marca verde ao lado deles faria a tela inteira virar um degradê
 * de verdes sem hierarquia. O indigo é neutro em relação ao semáforo do
 * atendimento — não diz nada sobre o status, só emoldura o bloco.
 *
 * Por isso estes hexes não saem de `lib/brand.ts`: não são cor de marca, e
 * puxá-los de lá faria o Dashboard mudar junto na próxima troca de marca.
 */
const DASHBOARD_ACCENT = "#4f46e5";
/** Um degrau mais claro, para o card que não pede a mesma ênfase. */
const DASHBOARD_ACCENT_SOFT = "#6366f1";

/** A cada quanto a tela se recarrega sozinha — ver o efeito na página. */
const AUTO_REFRESH_MS = 60_000;

/** As duas cores das mensagens — o mesmo par validado dos gráficos. */
const RECEIVED_COLOR = "#16a34a";
const SENT_COLOR = "#0891b2";

/**
 * Legenda curta de cada status no fluxo de atendimento. É texto desta tela
 * (o rótulo de domínio continua vindo de `CONVERSATION_STATUS_LABELS`), não
 * um enum novo — por isso mora aqui e não no shared.
 */
const STATUS_FLOW_HINTS: Record<ConversationStatus, string> = {
  open: "Em andamento",
  waiting_client: "Aguardando cliente",
  waiting_internal: "Aguardando operação",
  resolved: "Finalizadas",
};

/**
 * O que cada estado fora do ar significa na prática, para o bloco de
 * infraestrutura não obrigar ninguém a decorar os nomes técnicos.
 */
const CONNECTION_ISSUE_HINTS: Record<ConnectionStatus, string> = {
  disconnected: "Número desconectado por alguém da equipe.",
  connecting: "Número abrindo a conexão agora.",
  qr_required: "Aguardando a leitura do QR Code.",
  connected: "Número no ar.",
  reconnecting: "Número em processo de reconexão.",
  error: "Conexão com erro — veja a tela de Conexões.",
};

const CONNECTION_ISSUE_ICONS: Record<ConnectionStatus, ReactNode> = {
  disconnected: <PhoneOff className="h-4 w-4" />,
  connecting: <RadioTower className="h-4 w-4" />,
  qr_required: <QrCode className="h-4 w-4" />,
  connected: <RadioTower className="h-4 w-4" />,
  reconnecting: <RadioTower className="h-4 w-4" />,
  error: <AlertCircle className="h-4 w-4" />,
};

const numberFormatter = new Intl.NumberFormat("pt-BR");

/** Data de hoje no relógio de quem está olhando, no formato do campo. */
function todayInput(): string {
  const now = new Date();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${now.getFullYear()}-${month}-${day}`;
}

/**
 * O que o atalho para a Inbox consegue carregar: o número e o departamento,
 * os dois em lista (a Inbox lê parâmetro repetido). "Sem departamento" vai
 * junto, porque lá ele existe como token do filtro de atendimento.
 *
 * O RESPONSÁVEL fica de fora de propósito, e não por falta de controle na
 * Inbox: lá departamento e responsável são um filtro só que SOMA, então
 * mandar os dois viraria "o Contábil MAIS a fulana" — o contrário do
 * cruzamento que o número do card representa. Melhor levar menos filtro e
 * avisar do que levar um recorte diferente do que a pessoa estava lendo.
 *
 * O período também não vai: a Inbox lista por status, não por atividade num
 * intervalo. Por isso a tela avisa que a lista pode vir maior que o card.
 */
function inboxScopeParams(filters: DashboardFilters): URLSearchParams {
  const params = new URLSearchParams();
  for (const instanceId of filters.instanceIds) params.append("instanceId", instanceId);
  for (const departmentId of filters.departmentIds) {
    params.append("departmentId", departmentId);
  }
  return params;
}

/** Endereço da Inbox já recortada, para o card de status virar atalho. */
function inboxHref(status: ConversationStatus, filters: DashboardFilters): string {
  const params = inboxScopeParams(filters);
  params.append("status", status);
  return `/inbox?${params.toString()}`;
}

/** O card de arquivadas abre a Inbox direto na visão de arquivadas. */
function archivedInboxHref(filters: DashboardFilters): string {
  const params = inboxScopeParams(filters);
  params.set("archived", "true");
  return `/inbox?${params.toString()}`;
}

/**
 * O card de atraso abre a lista das MESMAS conversas que ele contou: a régua
 * do atraso é uma só (`api/src/lib/overdue.ts`), e a Inbox filtra por ela com
 * `?overdue=true`. Aproximar por "as não resolvidas" abriria uma lista muito
 * maior que o número do card, e ainda ordenada ao contrário do que interessa.
 */
function overdueInboxHref(filters: DashboardFilters): string {
  const params = inboxScopeParams(filters);
  params.set("overdue", "true");
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

/** Cabeçalho padrão dos blocos grandes: ícone, título e uma linha de contexto. */
function BlockHeader({
  icon,
  accent,
  title,
  subtitle,
}: {
  icon: ReactNode;
  accent: string;
  title: string;
  subtitle: string;
}) {
  return (
    <div className="flex items-center gap-3">
      <span
        className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full"
        style={{ backgroundColor: `${accent}1a`, color: accent }}
      >
        {icon}
      </span>
      <div className="min-w-0">
        <h2 className="text-sm font-bold text-slate-900">{title}</h2>
        <p className="text-xs text-slate-500">{subtitle}</p>
      </div>
    </div>
  );
}

function StatCard({
  label,
  sublabel,
  value,
  icon,
  accent,
  hint,
  pending,
  alert,
  href,
}: {
  label: string;
  /** Linha fina sob o título — normalmente a frase do período. */
  sublabel?: string;
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
        "relative flex h-full flex-col gap-3 overflow-hidden p-5 pb-6",
        // Alerta só quando existe o que alertar: zero atrasado não é vermelho.
        alert && "border-red-200 bg-red-50/60",
        href &&
          "transition-colors hover:border-slate-300 hover:bg-slate-50 motion-reduce:transition-none",
      )}
    >
      <div className="flex items-start gap-3">
        <span
          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl"
          style={{ backgroundColor: `${color}1a`, color }}
        >
          {icon}
        </span>
        <div className="min-w-0">
          <p className="text-sm font-bold leading-tight text-slate-900">{label}</p>
          {sublabel && <p className="text-xs text-slate-500">{sublabel}</p>}
        </div>
      </div>
      {pending ? (
        <ValueSkeleton className="h-9 w-16" />
      ) : (
        // Fonte tabular: o número não dança de largura a cada atualização.
        <span
          className={cn(
            "text-4xl font-bold leading-none tabular-nums",
            alert ? "text-red-700" : "text-slate-900",
          )}
        >
          {numberFormatter.format(value)}
        </span>
      )}
      {hint && <div className="text-xs leading-snug text-slate-500">{hint}</div>}
      {/* Filete de cor na base — assinatura visual do card, só decoração. */}
      <span
        aria-hidden
        className="absolute inset-x-0 bottom-0 h-1"
        style={{ backgroundColor: alert ? "#dc2626" : color }}
      />
    </Card>
  );
  if (!href) return card;
  // Link de verdade, e não `onClick`: abrir em outra aba e o botão do meio
  // continuam funcionando, que é o que se espera de um atalho de navegação.
  return (
    <Link
      href={href}
      className="block rounded-xl focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/40"
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
        className="h-full rounded-full bg-indigo-500/70 transition-[width] duration-300 motion-reduce:transition-none"
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
            ) : row.assignedToAll ? (
              <span className="shrink-0 rounded bg-indigo-50 px-1.5 py-0.5 text-[10px] font-bold text-indigo-700">
                {ALL_USERS_ASSIGNEE_LABEL}
              </span>
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
        className="w-full rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 text-xs text-slate-900 focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/20"
      >
        {children}
      </select>
    </label>
  );
}

/**
 * Rótulo em cima do seletor múltiplo, para a barra ficar igual à do período.
 * O `MultiSelect` do kit é um botão, e não um `<select>`, então o rótulo não
 * pode ser um `<label>` envolvendo tudo — seria um clique que abre a lista
 * sem o navegador saber o que está rotulando.
 */
function FilterField({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <span className="text-[10px] font-medium uppercase tracking-wide text-slate-400">
        {label}
      </span>
      {children}
    </div>
  );
}

/** Card interno de Recebidas/Enviadas, com a miniatura da série do período. */
function MessageTile({
  label,
  value,
  color,
  icon,
  series,
  pending,
}: {
  label: string;
  value: number;
  color: string;
  icon: ReactNode;
  series: number[];
  pending: boolean;
}) {
  return (
    <div className="flex flex-col gap-2 rounded-xl border border-slate-200 p-4">
      <div className="flex items-center gap-2.5">
        <span
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg"
          style={{ backgroundColor: `${color}1a`, color }}
        >
          {icon}
        </span>
        <span className="text-xs font-semibold text-slate-700">{label}</span>
      </div>
      {pending ? (
        <ValueSkeleton className="h-8 w-14" />
      ) : (
        <span className="text-3xl font-bold leading-none tabular-nums text-slate-900">
          {numberFormatter.format(value)}
        </span>
      )}
      <Sparkline values={series} color={color} />
    </div>
  );
}

// ---------- Tela ----------

export default function DashboardPage() {
  const { can, user } = useAuth();
  const router = useRouter();

  const [filters, setFilters] = useState<DashboardFilters>(DEFAULT_DASHBOARD_FILTERS);
  const [stats, setStats] = useState<DashboardStatsDto | null>(null);
  const [pending, setPending] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [instances, setInstances] = useState<InstanceDto[]>([]);
  const [departments, setDepartments] = useState<DepartmentDto[]>([]);
  const [users, setUsers] = useState<UserDirectoryDto[]>([]);

  /**
   * Os filtros salvos entram depois da hidratação: o HTML do servidor não
   * conhece o storage de quem está olhando. E a chave inclui o usuário, então
   * a leitura espera a sessão — máquina compartilhada é o caso normal do
   * escritório, e abrir o dashboard com o recorte do colega é lista curta sem
   * explicação nenhuma.
   */
  const userId = user?.id ?? null;
  useEffect(() => {
    if (!userId) return;
    setFilters(readDashboardFilters(userId));
  }, [userId]);

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

  /**
   * Item marcado que deixou de existir — chip apagado, departamento excluído,
   * pessoa desativada — sai do recorte em SILÊNCIO, assim que as listas
   * chegam. Quem poda é a tela, porque só ela sabe o que ainda existe, e ela
   * poda antes de virar consulta: a API recusa id desconhecido com 400, e
   * esse erro não pode aparecer para quem só voltou à tela depois de um
   * cadastro ter mudado.
   */
  useEffect(() => {
    if (instances.length === 0 && departments.length === 0 && users.length === 0) return;
    setFilters((current) => {
      const podado = pruneDashboardFilters(current, {
        instanceIds: instances.map((instance) => instance.id),
        departmentIds: departments.map((department) => department.id),
        userIds: users.map((option) => option.id),
      });
      if (podado !== current && userId) saveDashboardFilters(userId, podado);
      return podado;
    });
  }, [instances, departments, users, userId]);

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

  // A tela se recarrega sozinha: o dashboard fica aberto na TV ou numa
  // segunda aba, e ninguém volta nela para apertar F5. A recarga é
  // silenciosa — os números só trocam quando os novos chegam.
  useEffect(() => {
    const timer = window.setInterval(() => load(filters), AUTO_REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [load, filters]);

  function apply(next: DashboardFilters): void {
    setFilters(next);
    if (userId) saveDashboardFilters(userId, next);
  }

  /** Troca UM filtro, mantendo o resto do recorte. */
  function chooseList(field: "instanceIds" | "departmentIds" | "assignedUserIds", values: string[]): void {
    apply({ ...filters, [field]: values });
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


  const byStatus = stats?.conversations.byStatus;
  const leader = stats?.ranking[0]?.total ?? 0;
  const topUsers = stats?.topUsers ?? null;
  const topUserLeader = topUsers?.[0]?.total ?? 0;
  const offline = stats ? stats.instances.disconnected : 0;
  const connected = stats?.instances.connected ?? 0;
  const phrase = DASHBOARD_PERIOD_PHRASES[filters.period];
  const noAccess = stats !== null && connected + offline === 0;
  const hasScopeFilter = hasActiveDashboardFilters(filters);
  // Recortes que a Inbox não reproduz: o aviso abaixo do fluxo de status só
  // aparece quando o clique realmente vai levar menos filtro. O responsável
  // nunca é levado, porque lá ele SOMA com o departamento em vez de cruzar.
  const carriesPartialScope = filters.assignedUserIds.length > 0;

  /**
   * Recorte que não devolveu nada. Zero com filtro ligado é resposta, não
   * ausência de atendimento — e sem o aviso a pessoa lê a tela zerada como
   * "não teve movimento". Quando departamento e responsável estão marcados
   * juntos, o texto muda: ali o zero costuma ser o CRUZAMENTO (alguém que não
   * atende naquele departamento), e é a explicação que evita o chamado de
   * "o dashboard quebrou".
   */
  const emptyResult =
    stats !== null &&
    hasScopeFilter &&
    stats.conversations.active === 0 &&
    stats.messages.received === 0 &&
    stats.messages.sent === 0;
  const crossedEmpty =
    emptyResult && filters.departmentIds.length > 0 && filters.assignedUserIds.length > 0;
  // A MESMA chave que a API consulta para decidir se consulta o bloco: sem
  // isso a pessoa veria um card vazio sem saber por quê — e ligar a chave na
  // tela de Permissões não faria o bloco aparecer.
  const canSeeTeam = can("dashboard.view_team");
  const initialPending = pending && !stats;

  /**
   * Quem pode marcar OUTRA pessoa no filtro de responsável. Para o "Usuário"
   * a lista traz só ele e os dois coletivos: as conversas que ele enxerga são
   * as dele mais as sem responsável, então marcar um colega devolveria zero
   * sempre — e filtro que nunca acha nada é pior do que filtro nenhum. As
   * listas de número e de departamento já vêm recortadas pela API, então elas
   * aparecem para todo mundo sem revelar nada.
   */
  const canFilterOtherUsers = user?.role === "admin" || user?.role === "supervisor";
  const assigneeOptions = (canFilterOtherUsers ? users : users.filter((row) => row.id === userId))
    // Inativo não aparece: ele não recebe conversa nova, e a lista existe
    // para recortar atendimento, não para consultar quem já saiu.
    .filter((row) => row.status === "active" || row.id === userId);

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

  const assigneeGroups: MultiSelectGroup[] = [
    {
      label: "Atendimento",
      options: [
        // "Sem responsável" conta só as verdadeiramente órfãs; as coletivas
        // têm valor próprio, e nunca somam com elas.
        { value: FILTER_NONE, label: DASHBOARD_UNASSIGNED_LABEL },
        { value: FILTER_ALL_USERS, label: ALL_USERS_ASSIGNEE_LABEL },
      ],
    },
    {
      label: "Usuários",
      options: assigneeOptions.map((option) => ({
        value: option.id,
        label: option.name,
        hint: USER_ROLE_LABELS[option.role],
      })),
    },
  ].filter((group) => group.options.length > 0);

  /**
   * Resumo do recorte ativo, em uma linha. Com multisseleção o rótulo fechado
   * mostra "CS +2", que diz quantos e não quais: sem este resumo a pessoa lê
   * os números sem saber o que está vendo.
   *
   * O texto entre os filtros é " e ", e não " ou ": ele descreve o CRUZAMENTO,
   * que é como filtros diferentes combinam aqui.
   */
  const nomeDoDepartamento = (value: string): string =>
    value === FILTER_NONE
      ? DASHBOARD_NO_DEPARTMENT_LABEL
      : (departments.find((row) => row.id === value)?.name ?? value);
  const nomeDoResponsavel = (value: string): string => {
    if (value === FILTER_NONE) return DASHBOARD_UNASSIGNED_LABEL;
    if (value === FILTER_ALL_USERS) return ALL_USERS_ASSIGNEE_LABEL;
    return users.find((row) => row.id === value)?.name ?? value;
  };
  const activeSummary: Array<{ label: string; value: string }> = [
    ...(filters.statuses.length > 0
      ? [
          {
            label: DASHBOARD_FILTER_LABELS.status,
            value: filters.statuses.map((status) => CONVERSATION_STATUS_LABELS[status]).join(", "),
          },
        ]
      : []),
    ...(filters.departmentIds.length > 0
      ? [
          {
            label: DASHBOARD_FILTER_LABELS.department,
            value: filters.departmentIds.map(nomeDoDepartamento).join(", "),
          },
        ]
      : []),
    ...(filters.assignedUserIds.length > 0
      ? [
          {
            label: DASHBOARD_FILTER_LABELS.assignee,
            value: filters.assignedUserIds.map(nomeDoResponsavel).join(", "),
          },
        ]
      : []),
    ...(filters.instanceIds.length > 0
      ? [
          {
            label: DASHBOARD_FILTER_LABELS.instance,
            value: filters.instanceIds
              .map((id) => instances.find((row) => row.id === id)?.name ?? id)
              .join(", "),
          },
        ]
      : []),
  ];

  return (
    <div className="thin-scroll h-full overflow-y-auto p-6 lg:p-8">
      {/* O período tem UM controle só, e ele fica na barra de filtros. Ele já
          morou também aqui no topo: eram dois seletores ligados ao MESMO
          estado, então nunca discordaram, mas dois campos dizendo "Hoje" na
          mesma tela fazem quem olha procurar a diferença entre os dois. Ficou
          o da barra, que é onde os campos "De" e "Até" do período
          personalizado aparecem. */}
      <div>
        <h1 className="text-2xl font-bold text-slate-900">Dashboard de Atendimento</h1>
        <p className="text-sm text-slate-500">
          Visão geral do atendimento e da operação em tempo real
        </p>
      </div>

      <Card className="mt-4 p-3">
        <div className="flex flex-wrap items-end gap-x-3 gap-y-2">
          <span className="inline-flex items-center gap-1.5 self-center pb-0.5 pr-1 text-sm font-semibold text-slate-700">
            <SlidersHorizontal className="h-4 w-4 text-indigo-600" aria-hidden />
            Filtros
          </span>
          <span aria-hidden className="hidden self-stretch border-l border-slate-200 sm:block" />
          <div className="grid min-w-0 flex-1 grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-5">
            <FilterSelect
              label="Período"
              value={filters.period}
              onChange={(value) => choosePeriod(value as DashboardPeriod)}
            >
              {DASHBOARD_PERIODS.map((option) => (
                <option key={option} value={option}>
                  {DASHBOARD_PERIOD_LABELS[option]}
                </option>
              ))}
            </FilterSelect>
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
                    className="w-full rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 text-xs text-slate-900 focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/20"
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
                    className="w-full rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 text-xs text-slate-900 focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/20"
                  />
                </label>
              </>
            )}
            {/* Os quatro filtros abaixo são MULTISSELEÇÃO, com caixa de
                seleção: o que está marcado dentro de um deles SOMA (OU), e
                filtros diferentes CRUZAM (E). Departamento e responsável são
                dois filtros separados de propósito — ver o comentário do
                resumo, logo abaixo da barra. */}
            <FilterField label={DASHBOARD_FILTER_LABELS.status}>
              <MultiSelect
                label="Todos"
                groups={[
                  {
                    label: null,
                    options: CONVERSATION_STATUSES.map((status) => ({
                      value: status,
                      label: CONVERSATION_STATUS_LABELS[status],
                    })),
                  },
                ]}
                selected={filters.statuses}
                onChange={(statuses) =>
                  apply({ ...filters, statuses: statuses as ConversationStatus[] })
                }
              />
            </FilterField>
            <FilterField label={DASHBOARD_FILTER_LABELS.department}>
              <MultiSelect
                label="Todos"
                groups={departmentGroups}
                selected={filters.departmentIds}
                onChange={(departmentIds) => chooseList("departmentIds", departmentIds)}
                searchPlaceholder="Buscar departamento..."
                emptyLabel="Nenhum departamento com esse nome."
              />
            </FilterField>
            <FilterField label={DASHBOARD_FILTER_LABELS.assignee}>
              <MultiSelect
                label="Todos"
                groups={assigneeGroups}
                selected={filters.assignedUserIds}
                onChange={(assignedUserIds) => chooseList("assignedUserIds", assignedUserIds)}
                searchPlaceholder="Buscar pessoa..."
                emptyLabel="Ninguém com esse nome."
              />
            </FilterField>
            <FilterField label={DASHBOARD_FILTER_LABELS.instance}>
              <MultiSelect
                label="Todos"
                groups={[
                  {
                    label: null,
                    options: instances.map((instance) => ({
                      value: instance.id,
                      label: instance.name,
                    })),
                  },
                ]}
                selected={filters.instanceIds}
                onChange={(instanceIds) => chooseList("instanceIds", instanceIds)}
                searchPlaceholder="Buscar número..."
                emptyLabel="Nenhum número com esse nome."
              />
            </FilterField>
          </div>
          {hasScopeFilter && (
            <button
              type="button"
              onClick={() => apply(clearDashboardFilters(filters))}
              className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-medium text-slate-600 transition-colors hover:bg-slate-100 hover:text-slate-800 motion-reduce:transition-none"
            >
              <RotateCcw className="h-3.5 w-3.5" aria-hidden />
              Limpar filtros
            </button>
          )}
        </div>
        {/* Resumo do recorte ativo. Fica DENTRO do card, colado na barra, para
            ser lido antes dos números — é ele que responde "o que estou
            vendo?" quando os seletores mostram "CS +2". */}
        {activeSummary.length > 0 && (
          <p className="mt-2 border-t border-slate-100 pt-2 text-[11px] leading-snug text-slate-500">
            <span className="font-medium text-slate-600">Vendo:</span> {phrase}
            {activeSummary.map((item) => (
              <span key={item.label}>
                {" · "}
                {item.label}: <span className="text-slate-700">{item.value}</span>
              </span>
            ))}
            {/* A regra, dita em uma frase, onde ela é sentida. */}
            <span className="block text-slate-400">
              Vários valores no mesmo filtro somam; filtros diferentes se cruzam.
            </span>
          </p>
        )}
      </Card>

      {error && <p className="mt-4 text-sm text-red-600">{error}</p>}

      {/* Zero com filtro ligado é resposta, e não falta de atendimento. Sem
          este aviso a tela zerada parece defeito — e no cruzamento de
          departamento com responsável ela parece defeito de verdade. */}
      {emptyResult && (
        <Card className="mt-4 border-slate-200 bg-slate-50 p-4">
          <p className="flex items-start gap-2 text-xs text-slate-600">
            <Info className="mt-0.5 h-3.5 w-3.5 shrink-0 text-slate-400" aria-hidden />
            {crossedEmpty ? DASHBOARD_EMPTY_CROSS_MESSAGE : DASHBOARD_EMPTY_FILTER_MESSAGE}
          </p>
        </Card>
      )}

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

      <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          label="Conversas ativas"
          sublabel={phrase}
          value={stats?.conversations.active ?? 0}
          icon={<TrendingUp className="h-5 w-5" />}
          accent={DASHBOARD_ACCENT}
          hint="Conversas com ao menos uma mensagem no período, agrupadas pelo status atual."
          pending={initialPending}
        />
        <StatCard
          label="Atrasados agora"
          value={stats?.overdue.count ?? 0}
          icon={<AlertTriangle className="h-5 w-5" />}
          accent={stats && stats.overdue.count > 0 ? "#dc2626" : "#64748b"}
          alert={Boolean(stats && stats.overdue.count > 0)}
          pending={initialPending}
          // Só vira link quando há o que abrir: um card zerado que leva a uma
          // lista vazia é clique que não responde nada.
          href={stats && stats.overdue.count > 0 ? overdueInboxHref(filters) : undefined}
          hint={
            <>
              {/* Este card não olha o período: é sempre o estado agora. */}
              <span className="block">
                Estado agora, sem filtro de período · limite: {stats?.responseLimitMinutes ?? 30}{" "}
                min
              </span>
              {stats?.overdue.oldestWaitingMinutes !== null &&
                stats?.overdue.oldestWaitingMinutes !== undefined && (
                  <span className="block font-semibold text-red-700">
                    mais antigo: {formatWaiting(stats.overdue.oldestWaitingMinutes)}
                  </span>
                )}
              {/* A lista abre exatamente estas conversas — mesma régua de
                  atraso. Só o filtro de responsável não vai junto, porque na
                  Inbox ele soma com o departamento em vez de cruzar. */}
              {stats && stats.overdue.count > 0 && (
                <span className="block text-slate-500">
                  Clique para abrir a lista delas
                  {carriesPartialScope ? " (sem o filtro de responsável)" : ""}.
                </span>
              )}
            </>
          }
        />
        <StatCard
          label="Números fora do ar"
          value={offline}
          icon={<PhoneOff className="h-5 w-5" />}
          accent={offline > 0 ? "#dc2626" : "#16a34a"}
          alert={offline > 0}
          pending={initialPending}
          hint={
            offline > 0
              ? "Número fora do ar trava atendimento — veja a quebra em Infraestrutura."
              : "Todos os números que você enxerga estão conectados."
          }
        />
        {/* Fora da soma de ativas de propósito: arquivada não é atendimento.
            Visual neutro — arquivar é ação deliberada, não problema. */}
        <StatCard
          label="Conversas arquivadas"
          value={stats?.conversations.archived ?? 0}
          icon={<Archive className="h-5 w-5" />}
          accent={DASHBOARD_ACCENT_SOFT}
          hint="Estado agora, sem filtro de período. Fora de todos os demais números."
          pending={initialPending}
          href={archivedInboxHref(filters)}
        />
      </div>

      <Card className="mt-4 overflow-hidden p-0">
        <div className="border-b border-slate-100 px-5 py-4">
          <BlockHeader
            icon={<ListFilter className="h-4 w-4" />}
            accent={DASHBOARD_ACCENT}
            title="Fluxo de atendimento"
            subtitle="Distribuição das conversas por status atual"
          />
        </div>
        <div className="grid grid-cols-1 divide-y divide-slate-100 xl:grid-cols-4 xl:divide-x xl:divide-y-0">
          {CONVERSATION_STATUSES.map((status: ConversationStatus) => {
            const color = CONVERSATION_STATUS_COLORS[status];
            return (
              <Link
                key={status}
                href={inboxHref(status, filters)}
                className="flex items-center gap-3 px-5 py-4 transition-colors hover:bg-slate-50 focus:outline-none focus-visible:bg-slate-50 motion-reduce:transition-none"
              >
                <span
                  className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl"
                  style={{ backgroundColor: `${color}1a`, color }}
                >
                  {status === "resolved" ? (
                    <CheckCircle2 className="h-5 w-5" />
                  ) : status === "open" ? (
                    <CircleDot className="h-5 w-5" />
                  ) : (
                    <Hourglass className="h-5 w-5" />
                  )}
                </span>
                <div className="flex min-w-0 flex-col gap-1">
                  <span className="text-sm font-semibold text-slate-900">
                    {CONVERSATION_STATUS_LABELS[status]}
                  </span>
                  {initialPending ? (
                    <ValueSkeleton className="h-7 w-10" />
                  ) : (
                    <span className="text-2xl font-bold leading-none tabular-nums text-slate-900">
                      {numberFormatter.format(byStatus?.[status] ?? 0)}
                    </span>
                  )}
                  <span
                    className="w-fit rounded-md px-1.5 py-0.5 text-[10px] font-medium"
                    style={{ backgroundColor: `${color}1a`, color }}
                  >
                    {STATUS_FLOW_HINTS[status]}
                  </span>
                </div>
              </Link>
            );
          })}
        </div>
      </Card>
      <p className="mt-1.5 text-[11px] text-slate-400">
        Clique em um status para abrir Conversas já filtradas. Lá a lista não usa o período, então
        ela pode vir maior que o número do card
        {carriesPartialScope ? ", e o filtro de responsável não é levado" : ""}.
      </p>

      <div className="mt-4 grid grid-cols-1 gap-4 xl:grid-cols-2">
        <Card className="p-5">
          <BlockHeader
            icon={<Mail className="h-4 w-4" />}
            accent={DASHBOARD_ACCENT}
            title="Mensagens"
            subtitle={`Atividade de mensagens ${phrase}`}
          />
          <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
            <MessageTile
              label={`Recebidas ${phrase}`}
              value={stats?.messages.received ?? 0}
              color={RECEIVED_COLOR}
              icon={<ArrowDownLeft className="h-4 w-4" />}
              series={stats?.timeline.map((point) => point.received) ?? []}
              pending={initialPending}
            />
            <MessageTile
              label={`Enviadas ${phrase}`}
              value={stats?.messages.sent ?? 0}
              color={SENT_COLOR}
              icon={<ArrowUpRight className="h-4 w-4" />}
              series={stats?.timeline.map((point) => point.sent) ?? []}
              pending={initialPending}
            />
          </div>
        </Card>

        <Card className="p-5">
          <BlockHeader
            icon={<Database className="h-4 w-4" />}
            accent={DASHBOARD_ACCENT}
            title="Infraestrutura"
            subtitle="Conectividade e disponibilidade dos números"
          />
          <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="flex items-center gap-4 rounded-xl border border-slate-200 p-4">
              {initialPending ? (
                <ValueSkeleton className="h-16 w-16 rounded-full" />
              ) : (
                <ConnectivityRing connected={connected} total={connected + offline} />
              )}
              <div className="flex min-w-0 flex-col gap-1">
                <span className="text-sm font-semibold text-slate-900">Números conectados</span>
                <span className="text-xs text-slate-500">
                  {connected} de {connected + offline} conectados
                </span>
                {!initialPending && (
                  <span
                    className={cn(
                      "w-fit rounded-md px-1.5 py-0.5 text-[10px] font-medium",
                      offline === 0
                        ? "bg-emerald-100 text-emerald-700"
                        : "bg-amber-100 text-amber-700",
                    )}
                  >
                    {offline === 0 ? "Operação normal" : `${offline} fora do ar`}
                  </span>
                )}
              </div>
            </div>
            {/* A quebra só aparece quando existe algo fora do ar — lista de
                zeros não informa nada. */}
            {stats && offline > 0 ? (
              CONNECTION_STATUSES.filter(
                (status) => status !== "connected" && stats.instances.byStatus[status] > 0,
              ).map((status) => {
                const color = CONNECTION_STATUS_COLORS[status];
                return (
                  <div
                    key={status}
                    className="flex items-center gap-3 rounded-xl border p-4"
                    style={{ borderColor: `${color}33`, backgroundColor: `${color}0d` }}
                  >
                    <span
                      className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full"
                      style={{ backgroundColor: `${color}1a`, color }}
                    >
                      {CONNECTION_ISSUE_ICONS[status]}
                    </span>
                    <div className="min-w-0">
                      <p className="text-sm font-semibold text-slate-900">
                        {CONNECTION_STATUS_LABELS[status]}{" "}
                        <span className="tabular-nums" style={{ color }}>
                          {stats.instances.byStatus[status]}
                        </span>
                      </p>
                      <p className="text-xs text-slate-500">{CONNECTION_ISSUE_HINTS[status]}</p>
                    </div>
                  </div>
                );
              })
            ) : (
              <div className="flex items-center rounded-xl border border-slate-200 p-4">
                <p className="text-xs text-slate-500">Nenhum número fora do ar.</p>
              </div>
            )}
          </div>
        </Card>
      </div>

      {/* Os gráficos ficam sob os cards de mensagens: os cards dão o total do
          período, e estes mostram como esse total se distribuiu. */}
      <SectionTitle>Análise do período</SectionTitle>
      <div className="grid grid-cols-1 gap-3 xl:grid-cols-2">
        {initialPending ? (
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
              <HoursHeatmap cells={stats.hourly} />
            </>
          )
        )}
      </div>

      <div className={cn("grid grid-cols-1 gap-x-4", canSeeTeam && "xl:grid-cols-2")}>
        <div className="min-w-0">
          <SectionTitle>Conversas mais ativas {phrase}</SectionTitle>
          <Card className="divide-y divide-slate-100 overflow-hidden">
            {initialPending ? (
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
              {initialPending ? (
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

      <p className="mb-2 mt-8 flex items-center justify-center gap-1.5 text-xs text-slate-400">
        <Info className="h-3.5 w-3.5" aria-hidden />
        Os dados são atualizados automaticamente a cada minuto.
      </p>
    </div>
  );
}

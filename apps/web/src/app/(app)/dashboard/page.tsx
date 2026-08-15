"use client";

import { useCallback, useEffect, useState, type ReactNode } from "react";
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
  type ConversationStatus,
  type DashboardPeriod,
} from "@azvchat/shared";
import { dashboardApi } from "@/lib/api";
import { useAuth } from "@/lib/auth-context";
import type { DashboardRankingRowDto, DashboardStatsDto } from "@/lib/types";
import { cn } from "@/lib/utils";
import { Card, EmptyState } from "@/components/ui";

/**
 * Escolha de período é preferência de apresentação de um navegador, igual à
 * barra lateral: mesmo prefixo do token, nada de coluna em `User`.
 */
const PERIOD_STORAGE_KEY = "zapdesk.dashboard-period";

function isPeriod(value: string | null): value is DashboardPeriod {
  return value !== null && (DASHBOARD_PERIODS as readonly string[]).includes(value);
}

function readPeriod(): DashboardPeriod {
  try {
    const stored = window.localStorage.getItem(PERIOD_STORAGE_KEY);
    return isPeriod(stored) ? stored : "today";
  } catch {
    // Storage bloqueado (aba privada): vale o padrão, Hoje.
    return "today";
  }
}

function writePeriod(period: DashboardPeriod): void {
  try {
    window.localStorage.setItem(PERIOD_STORAGE_KEY, period);
  } catch {
    // Sem storage a escolha vale só para esta aba — segue o jogo.
  }
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

/** Espera em tempo de expediente, do jeito que se fala: "2h14", "45min". */
function formatWaiting(minutes: number): string {
  if (minutes < 60) return `${minutes}min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return `${hours}h${String(rest).padStart(2, "0")}`;
}

// ---------- Peças da grade ----------

function SectionTitle({ children }: { children: ReactNode }) {
  return (
    <h2 className="mb-2.5 mt-7 text-[11px] font-semibold uppercase tracking-wider text-slate-400">
      {children}
    </h2>
  );
}

/** Barra cinza no lugar do número enquanto os dados não chegam. */
function ValueSkeleton({ className }: { className?: string }) {
  return (
    <span
      aria-hidden
      className={cn("block h-7 w-12 animate-pulse rounded bg-slate-200 motion-reduce:animate-none", className)}
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
}: {
  label: string;
  value: number;
  icon: ReactNode;
  accent?: string;
  hint?: ReactNode;
  pending: boolean;
  alert?: boolean;
}) {
  const color = accent ?? "#475569";
  return (
    <Card
      className={cn(
        "flex flex-col gap-2 p-4",
        // Alerta só quando existe o que alertar: zero atrasado não é vermelho.
        alert && "border-red-300 bg-red-50/60",
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
}

function RankingRow({
  row,
  leader,
  onOpen,
}: {
  row: DashboardRankingRowDto;
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
        <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-slate-100 text-slate-500">
          {row.type === "group" ? (
            <Users2 className="h-3.5 w-3.5" />
          ) : (
            <UserRound className="h-3.5 w-3.5" />
          )}
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium text-slate-900">{row.title}</p>
          <p className="truncate text-[11px] text-slate-500">
            {row.type === "group" ? "Grupo" : "Individual"}
            {row.instanceName ? ` · ${row.instanceName}` : ""}
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
      {/* Barra proporcional ao primeiro colocado: dá a escala sem gráfico. */}
      <div className="mt-1.5 h-1 w-full overflow-hidden rounded-full bg-slate-100">
        <div
          className="h-full rounded-full bg-brand-500/70 transition-[width] duration-300 motion-reduce:transition-none"
          style={{ width: `${share}%` }}
        />
      </div>
    </button>
  );
}

// ---------- Tela ----------

export default function DashboardPage() {
  const { user } = useAuth();
  const router = useRouter();

  const [period, setPeriod] = useState<DashboardPeriod>("today");
  const [stats, setStats] = useState<DashboardStatsDto | null>(null);
  const [pending, setPending] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState<Date | null>(null);

  // O período salvo e a hora local entram depois da hidratação: o HTML do
  // servidor não conhece nem o storage nem o relógio de quem está olhando.
  useEffect(() => {
    setPeriod(readPeriod());
    setNow(new Date());
  }, []);

  const load = useCallback((next: DashboardPeriod) => {
    setPending(true);
    setError(null);
    dashboardApi
      .stats(next)
      // Os dados antigos continuam na tela até os novos chegarem: trocar o
      // período mostra esqueleto nos cards, não uma página em branco.
      .then(setStats)
      .catch((err) => setError(err instanceof Error ? err.message : "Erro ao carregar"))
      .finally(() => setPending(false));
  }, []);

  useEffect(() => {
    load(period);
  }, [load, period]);

  function choosePeriod(next: DashboardPeriod): void {
    setPeriod(next);
    writePeriod(next);
  }

  const greeting = now ? `${greetingFor(now.getHours())}, ${firstNameOf(user?.name ?? "")}` : "";
  const byStatus = stats?.conversations.byStatus;
  const leader = stats?.ranking[0]?.total ?? 0;
  const offline = stats ? stats.instances.disconnected : 0;
  const phrase = DASHBOARD_PERIOD_PHRASES[period];
  const noAccess = stats !== null && stats.instances.connected + offline === 0;

  return (
    <div className="thin-scroll h-full overflow-y-auto p-6 lg:p-8">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-h-[3.25rem]">
          <h1 className="text-2xl font-bold text-slate-900">{greeting || " "}</h1>
          <p className="text-sm text-slate-500">{now ? fullDateOf(now) : " "}</p>
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
              aria-pressed={period === option}
              onClick={() => choosePeriod(option)}
              className={cn(
                "rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors motion-reduce:transition-none sm:px-3",
                period === option
                  ? "bg-slate-900 text-white"
                  : "text-slate-600 hover:bg-slate-100",
              )}
            >
              {DASHBOARD_PERIOD_LABELS[option]}
            </button>
          ))}
        </div>
      </div>

      {error && <p className="mt-4 text-sm text-red-600">{error}</p>}

      {/* Sem número liberado no login, todo indicador seria zero e a tela
          pareceria quebrada. Melhor dizer o motivo do que deixar adivinhar. */}
      {noAccess && (
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
          /* Sem link para a Inbox: hoje ela não aceita status pela URL, e
             inventar parâmetro aqui seria criar contrato novo por conta. */
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
          />
        ))}
      </div>

      <SectionTitle>Mensagens</SectionTitle>
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

      <SectionTitle>Conversas mais ativas {phrase}</SectionTitle>
      <Card className="mb-8 divide-y divide-slate-100 overflow-hidden">
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
          stats?.ranking.map((row) => (
            <RankingRow
              key={row.conversationId}
              row={row}
              leader={leader}
              onOpen={() => router.push(`/inbox/${row.conversationId}`)}
            />
          ))
        )}
      </Card>
    </div>
  );
}

import {
  DEFAULT_TIMEZONE,
  hasRole,
  type AttendanceSettings,
  type LoginHours,
  type UserRole,
  type Weekday,
} from "@azvchat/shared";

/**
 * Horário permitido de login — quem pode **entrar** no sistema agora.
 *
 * Fonte única da regra: a rota de login pergunta aqui, e qualquer outro
 * caminho de entrada que exista no futuro (SSO, app) pergunta no mesmo lugar.
 * Regra de acesso espalhada é como se abre buraco sem ninguém perceber.
 *
 * Duas isenções, ambas de propósito:
 *
 * 1. **supervisor para cima entra sempre.** É quem destranca a porta na tela
 *    de Parâmetros; se a janela pudesse trancá-lo, um sábado desligado por
 *    engano deixaria o escritório inteiro fora do sistema até segunda.
 * 2. **restrição desligada libera todo mundo**, que é o estado inicial.
 */
export interface LoginScheduleCheck {
  allowed: boolean;
  /** A faixa do dia, quando existe — vai para a auditoria da tentativa. */
  window: LoginHours | null;
}

/**
 * O que o relógio de parede do escritório marca neste instante: dia da
 * semana e minutos desde a meia-noite, no fuso configurado.
 *
 * Nunca o fuso do servidor: o container roda em UTC, e às 22:00 de Brasília
 * já é o dia seguinte lá — a janela de segunda liberaria o domingo à noite.
 */
export function officeClock(
  timeZone: string,
  at: Date,
): { weekday: Weekday; minutes: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).formatToParts(at);
  const values: Record<string, string> = {};
  for (const part of parts) {
    if (part.type !== "literal") values[part.type] = part.value;
  }
  // O dia da semana sai da data civil já traduzida para o fuso, e não de um
  // `weekday` formatado: assim não depende do idioma do runtime.
  const weekday = new Date(
    Date.UTC(Number(values.year), Number(values.month) - 1, Number(values.day)),
  ).getUTCDay() as Weekday;
  return { weekday, minutes: Number(values.hour) * 60 + Number(values.minute) };
}

/** Minutos desde a meia-noite de uma hora "HH:MM". */
function minutesOfDay(time: string): number {
  const [hours, minutes] = time.split(":");
  return Number(hours) * 60 + Number(minutes);
}

/** Fuso inválido no banco não pode trancar ninguém: cai no padrão da casa. */
function safeTimeZone(timezone: string): string {
  try {
    new Intl.DateTimeFormat("pt-BR", { timeZone: timezone }).format(new Date());
    return timezone;
  } catch {
    return DEFAULT_TIMEZONE;
  }
}

export function checkLoginSchedule(
  settings: AttendanceSettings,
  role: UserRole,
  at: Date,
): LoginScheduleCheck {
  if (!settings.loginRestrictionEnabled) return { allowed: true, window: null };
  if (hasRole(role, "supervisor")) return { allowed: true, window: null };

  const { weekday, minutes } = officeClock(safeTimeZone(settings.timezone), at);
  const day = settings.loginHours.find((entry) => entry.weekday === weekday) ?? null;
  if (!day || !day.active) return { allowed: false, window: day };

  // Faixa fechada no início e aberta no fim: entrar exatamente no minuto de
  // abertura vale, e no minuto de fechamento não — é o mesmo corte que a
  // pessoa lê na tela ("das 07:00 às 19:00" termina quando dá 19:00).
  const start = minutesOfDay(day.startTime);
  const end = minutesOfDay(day.endTime);
  return { allowed: minutes >= start && minutes < end, window: day };
}

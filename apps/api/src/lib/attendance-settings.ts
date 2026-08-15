import type { PrismaClient } from "@azvchat/database";
import {
  DEFAULT_ATTENDANCE_SETTINGS,
  defaultBusinessHoursFor,
  WEEKDAYS,
  type AttendanceSettings,
  type BusinessHours,
} from "@azvchat/shared";

/**
 * Leitura dos parâmetros de atendimento da organização.
 *
 * **Sempre do banco, a cada requisição.** Nada de carregar no boot nem de
 * cache em memória: mudar o limite de resposta na tela de Parâmetros tem que
 * valer no dashboard da próxima carga, e não depois de reiniciar o container
 * — que é exatamente o problema que a tela veio resolver. O custo é uma
 * consulta por chave única, com sete linhas filhas.
 *
 * Organização que ainda não tem linha recebe os padrões de `@azvchat/shared`:
 * o dashboard não pode quebrar por falta de configuração.
 */
export async function loadAttendanceSettings(
  prisma: PrismaClient,
  organizationId: string,
): Promise<AttendanceSettings> {
  const row = await prisma.attendanceSettings.findUnique({
    where: { organizationId },
    include: { businessHours: true },
  });
  if (!row) return DEFAULT_ATTENDANCE_SETTINGS;
  return {
    responseLimitMinutes: row.responseLimitMinutes,
    timezone: row.timezone,
    businessHours: normalizeBusinessHours(row.businessHours),
  };
}

/**
 * Devolve sempre os sete dias, de domingo a sábado, em ordem.
 *
 * O banco garante um registro por dia, mas não garante que os sete existam
 * (linha semeada à mão, dia removido em manutenção). Faltando algum, entra o
 * padrão daquele dia — a tela e o cálculo de tempo útil assumem a semana
 * inteira e ficariam com buraco silencioso.
 */
export function normalizeBusinessHours(
  rows: Array<{ weekday: number; active: boolean; startTime: string; endTime: string }>,
): BusinessHours[] {
  const byWeekday = new Map(rows.map((row) => [row.weekday, row]));
  return WEEKDAYS.map((weekday) => {
    const row = byWeekday.get(weekday);
    if (!row) return defaultBusinessHoursFor(weekday);
    return {
      weekday,
      active: row.active,
      startTime: row.startTime,
      endTime: row.endTime,
    };
  });
}

/**
 * O fuso é conferido contra a lista do runtime, não aceito como texto livre:
 * um fuso inventado faria todo corte de data do dashboard cair no UTC do
 * servidor sem ninguém perceber.
 */
export function isValidTimezone(timezone: string): boolean {
  try {
    // `timeZoneName` força o runtime a resolver o fuso de verdade; sem ele
    // alguns valores estranhos passam batido.
    new Intl.DateTimeFormat("pt-BR", { timeZone: timezone, timeZoneName: "short" }).format(
      new Date(),
    );
    return true;
  } catch {
    return false;
  }
}

/** Minutos desde a meia-noite de uma hora "HH:MM". */
export function minutesOfDay(time: string): number {
  const [hours, minutes] = time.split(":");
  return Number(hours) * 60 + Number(minutes);
}

export { DEFAULT_ATTENDANCE_SETTINGS };

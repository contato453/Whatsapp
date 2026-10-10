import { holidayMatcher, type BusinessCalendar, type BusinessHours, type Weekday } from "@azvchat/shared";
import {
  addCivilDays,
  civilDateIn,
  safeTimeZone,
  weekdayOf,
  zonedTimeToUtc,
  type CivilDate,
} from "../modules/dashboard/metrics.js";

/**
 * "Cai fora do expediente? Manda no início do próximo horário útil." —
 * seções 19/20 do pedido de follow-up automático.
 *
 * Reaproveita as MESMAS contas de fuso e dia civil do dashboard
 * (`modules/dashboard/metrics.ts`, `businessMinutesBetween` e
 * `scanOverdueConversations`): "expediente" só pode ter uma definição no
 * sistema inteiro, senão o follow-up respeitaria um horário e o card de
 * atraso outro.
 *
 * Feriado conta como dia desligado, pela MESMA lista do atraso
 * (`holidayMatcher`, em `@azvchat/shared`): follow-up e disparo em massa não
 * mandam mensagem no feriado, e saem na abertura do próximo dia útil.
 */

function minutesOfDay(time: string): number {
  const [hours, minutes] = time.split(":");
  return Number(hours) * 60 + Number(minutes);
}

/** Dias realmente úteis: ativos e com fim depois do início. */
function usableDays(businessHours: BusinessHours[]): Map<Weekday, BusinessHours> {
  const usable = new Map<Weekday, BusinessHours>();
  for (const day of businessHours) {
    if (day.active && minutesOfDay(day.endTime) > minutesOfDay(day.startTime)) {
      usable.set(day.weekday, day);
    }
  }
  return usable;
}

/** Teto de dias varridos — mesmo valor do dashboard, mesmo motivo (nunca laço infinito). */
const MAX_DAYS_SCANNED = 400;

/**
 * O instante em que `moment` cai dentro do expediente — ele mesmo, se já
 * estiver dentro; senão a ABERTURA do próximo dia útil (seção 20: "enviar
 * no início do próximo expediente").
 *
 * Semana inteira desligada devolve `null` em vez de procurar um horário
 * que não existe — mesma guarda do cálculo de atraso.
 */
export function nextBusinessMoment(
  moment: Date,
  settings: BusinessCalendar,
): Date | null {
  const days = usableDays(settings.businessHours);
  if (days.size === 0) return null;
  const isHoliday = holidayMatcher(settings.holidays);

  const timeZone = safeTimeZone(settings.timezone);
  let cursor: CivilDate = civilDateIn(timeZone, moment);

  for (let scanned = 0; scanned < MAX_DAYS_SCANNED; scanned += 1) {
    const config = isHoliday(cursor) ? undefined : days.get(weekdayOf(cursor));
    if (config) {
      const opens = zonedTimeToUtc(
        timeZone,
        cursor,
        Math.floor(minutesOfDay(config.startTime) / 60),
        minutesOfDay(config.startTime) % 60,
      );
      const closes = zonedTimeToUtc(
        timeZone,
        cursor,
        Math.floor(minutesOfDay(config.endTime) / 60),
        minutesOfDay(config.endTime) % 60,
      );
      if (moment.getTime() < closes.getTime()) {
        // Ou já está dentro do expediente (devolve o próprio instante), ou
        // ainda é cedo demais neste mesmo dia útil (devolve a abertura).
        return moment.getTime() >= opens.getTime() ? moment : opens;
      }
    }
    cursor = addCivilDays(cursor, 1);
  }
  return null;
}

/** Está dentro do expediente agora? Atalho para quem só precisa do booleano. */
export function isWithinBusinessHours(
  moment: Date,
  settings: BusinessCalendar,
): boolean {
  const resolved = nextBusinessMoment(moment, settings);
  return resolved !== null && resolved.getTime() === moment.getTime();
}

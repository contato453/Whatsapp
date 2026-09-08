import type { AttendanceSettings } from "@azvchat/shared";
import { civilDateIn, weekdayOf } from "../../modules/dashboard/metrics.js";
import { minutesOfDay, isValidTimezone, DEFAULT_ATTENDANCE_SETTINGS } from "../attendance-settings.js";

/**
 * "Dentro do expediente agora?" para o bloco Condição e para os gatilhos de
 * saudação/fora do expediente — a MESMA definição de expediente do dashboard
 * (`lib/overdue.ts`), só que respondida como booleano num instante, em vez de
 * acumulada em minutos de espera. Não duplica a régua: lê a mesma
 * `AttendanceSettings.businessHours`, no mesmo fuso.
 */
export function isWithinBusinessHours(
  settings: Pick<AttendanceSettings, "timezone" | "businessHours">,
  now: Date,
): boolean {
  const timezone = isValidTimezone(settings.timezone) ? settings.timezone : DEFAULT_ATTENDANCE_SETTINGS.timezone;
  const civil = civilDateIn(timezone, now);
  const weekday = weekdayOf(civil);
  const day = settings.businessHours.find((row) => row.weekday === weekday);
  if (!day || !day.active) return false;
  const nowMinutes = minutesOfDayInTimeZone(timezone, now);
  return nowMinutes >= minutesOfDay(day.startTime) && nowMinutes < minutesOfDay(day.endTime);
}

/** Minutos desde a meia-noite civil, no fuso dado, para o instante `now`. */
function minutesOfDayInTimeZone(timeZone: string, now: Date): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    hour: "2-digit",
    minute: "2-digit",
  }).formatToParts(now);
  const hour = Number(parts.find((part) => part.type === "hour")?.value ?? "0");
  const minute = Number(parts.find((part) => part.type === "minute")?.value ?? "0");
  return hour * 60 + minute;
}

/**
 * Início da próxima janela de expediente ATIVA a partir de `now` (inclusive)
 * — usado pelo nó "Aguardar até o próximo expediente". Varre no máximo os
 * próximos 8 dias: uma semana inteira desligada é configuração de quem
 * fechou o escritório, não bug — devolve `null` nesse caso, em vez de
 * procurar um dia útil que não existe.
 */
export function nextBusinessWindowStart(
  settings: Pick<AttendanceSettings, "timezone" | "businessHours">,
  now: Date,
): Date | null {
  const timezone = isValidTimezone(settings.timezone) ? settings.timezone : DEFAULT_ATTENDANCE_SETTINGS.timezone;
  for (let offset = 0; offset < 8; offset += 1) {
    const candidateInstant = new Date(now.getTime() + offset * 24 * 60 * 60 * 1000);
    const civil = civilDateIn(timezone, candidateInstant);
    const weekday = weekdayOf(civil);
    const day = settings.businessHours.find((row) => row.weekday === weekday);
    if (!day || !day.active) continue;
    const start = zonedTimeToUtcLocal(timezone, civil, day.startTime);
    const end = zonedTimeToUtcLocal(timezone, civil, day.endTime);
    if (offset === 0 && now >= end) continue;
    if (offset === 0 && now >= start && now < end) return now;
    if (start >= now) return start;
  }
  return null;
}

function zonedTimeToUtcLocal(
  timeZone: string,
  civil: { year: number; month: number; day: number },
  time: string,
): Date {
  const minutes = minutesOfDay(time);
  const hour = Math.floor(minutes / 60);
  const minute = minutes % 60;
  const guess = Date.UTC(civil.year, civil.month - 1, civil.day, hour, minute);
  // Mesma correção de fuso em duas passadas usada no resto do dashboard
  // (ver `zonedTimeToUtc` em `modules/dashboard/metrics.ts`) — evita o dia da
  // virada do horário de verão sair deslocado.
  const offset1 = tzOffsetMs(timeZone, new Date(guess));
  const candidate = guess - offset1;
  const offset2 = tzOffsetMs(timeZone, new Date(candidate));
  return new Date(offset1 === offset2 ? candidate : guess - offset2);
}

function tzOffsetMs(timeZone: string, date: Date): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(date);
  const values: Record<string, string> = {};
  for (const part of parts) if (part.type !== "literal") values[part.type] = part.value;
  const asUtc = Date.UTC(
    Number(values.year),
    Number(values.month) - 1,
    Number(values.day),
    Number(values.hour),
    Number(values.minute),
    Number(values.second),
  );
  return asUtc - Math.floor(date.getTime() / 1000) * 1000;
}

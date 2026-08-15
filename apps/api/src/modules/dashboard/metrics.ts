import {
  DASHBOARD_PERIOD_DAYS,
  DEFAULT_TIMEZONE,
  type AttendanceSettings,
  type BusinessHours,
  type DashboardFixedPeriod,
  type DashboardPeriod,
  type Weekday,
} from "@azvchat/shared";

/**
 * Contas de data do dashboard.
 *
 * Separado das rotas para ser testável sem banco: o risco desta tela é o
 * número plausível e errado, e aqui moram as duas definições que mais fáceis
 * de errar — o corte do período e o tempo útil de espera.
 *
 * **Nada aqui usa o fuso do servidor.** Todo corte de data acontece no fuso
 * configurado nos parâmetros de atendimento: "hoje" para o escritório é o dia
 * civil dele, não o dia UTC do container.
 */

/**
 * Uma conversa parada há mais de um ano já estourou qualquer limite
 * imaginável — a varredura para por aqui em vez de percorrer década por
 * década. O total satura, e a conversa continua marcada como atrasada.
 */
const MAX_BUSINESS_DAYS_SCANNED = 400;

interface CivilDate {
  year: number;
  month: number;
  day: number;
}

/** Fuso guardado no banco pode ter ficado inválido; o padrão evita quebrar a tela. */
export function safeTimeZone(timezone: string): string {
  try {
    new Intl.DateTimeFormat("pt-BR", { timeZone: timezone }).format(new Date());
    return timezone;
  } catch {
    return DEFAULT_TIMEZONE;
  }
}

/** Quantos milissegundos o fuso está à frente do UTC no instante dado. */
function timeZoneOffsetMs(timeZone: string, date: Date): number {
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
  for (const part of parts) {
    if (part.type !== "literal") values[part.type] = part.value;
  }
  const asUtc = Date.UTC(
    Number(values.year),
    Number(values.month) - 1,
    Number(values.day),
    Number(values.hour),
    Number(values.minute),
    Number(values.second),
  );
  // O instante formatado não tem milissegundos: truncamos o outro lado da
  // conta também, senão o offset viria com resto e o ida-e-volta não fecharia.
  return asUtc - Math.floor(date.getTime() / 1000) * 1000;
}

/** A data civil (ano/mês/dia) que o relógio do fuso marca neste instante. */
export function civilDateIn(timeZone: string, date: Date): CivilDate {
  const offset = timeZoneOffsetMs(timeZone, date);
  const local = new Date(date.getTime() + offset);
  return {
    year: local.getUTCFullYear(),
    month: local.getUTCMonth() + 1,
    day: local.getUTCDate(),
  };
}

/**
 * O instante UTC de uma hora de parede do fuso.
 *
 * A segunda passada existe por causa do horário de verão: no dia da virada o
 * palpite inicial pode cair com o offset do outro lado da mudança, e sem
 * corrigir o expediente sairia uma hora deslocado justamente no dia em que
 * ninguém confere.
 */
export function zonedTimeToUtc(
  timeZone: string,
  date: CivilDate,
  hour: number,
  minute: number,
): Date {
  const guess = Date.UTC(date.year, date.month - 1, date.day, hour, minute);
  const firstOffset = timeZoneOffsetMs(timeZone, new Date(guess));
  const candidate = guess - firstOffset;
  const secondOffset = timeZoneOffsetMs(timeZone, new Date(candidate));
  return new Date(firstOffset === secondOffset ? candidate : guess - secondOffset);
}

/** Dia da semana civil (0 = domingo), sem depender do fuso do servidor. */
export function weekdayOf(date: CivilDate): Weekday {
  return new Date(Date.UTC(date.year, date.month - 1, date.day)).getUTCDay() as Weekday;
}

function addCivilDays(date: CivilDate, days: number): CivilDate {
  const moved = new Date(Date.UTC(date.year, date.month - 1, date.day + days));
  return {
    year: moved.getUTCFullYear(),
    month: moved.getUTCMonth() + 1,
    day: moved.getUTCDate(),
  };
}

/** Intervalo do dashboard. `end` nulo = "até agora", sem corte superior. */
export interface PeriodRange {
  start: Date;
  end: Date | null;
}

/** Datas civis do intervalo personalizado, no formato "AAAA-MM-DD". */
export interface CustomRange {
  from: string;
  to: string;
}

function parseCivilDate(value: string): CivilDate {
  const [year, month, day] = value.split("-");
  return { year: Number(year), month: Number(month), day: Number(day) };
}

/**
 * Início e fim do período, no fuso do escritório.
 *
 * "Hoje" é da meia-noite local até agora. Os atalhos são os últimos N dias
 * civis contando o atual — 7 dias é hoje mais os seis anteriores, começando
 * na meia-noite do primeiro deles.
 *
 * Os atalhos não têm corte superior de propósito: o relógio do WhatsApp pode
 * vir alguns segundos à frente do nosso, e um `lte: agora` faria a mensagem
 * que acabou de chegar sumir do próprio dia dela.
 *
 * O personalizado tem os dois cortes: começa na meia-noite do primeiro dia e
 * termina no último instante do último dia, ambos no fuso configurado — quem
 * escolhe "01/08 a 07/08" espera os dois dias inteiros dentro da conta.
 */
export function periodRange(
  period: DashboardPeriod,
  now: Date,
  timezone: string,
  custom?: CustomRange,
): PeriodRange {
  const timeZone = safeTimeZone(timezone);
  if (period === "custom") {
    // Sem as datas (só acontece se alguém burlar o Zod) vale o dia de hoje,
    // que é o padrão da tela — nunca a base inteira.
    if (!custom) return periodRange("today", now, timezone);
    const from = parseCivilDate(custom.from);
    const to = parseCivilDate(custom.to);
    return {
      start: zonedTimeToUtc(timeZone, from, 0, 0),
      // Meia-noite do dia seguinte menos 1ms: pega o último dia inteiro sem
      // depender de 23:59:59 e sem invadir o dia de depois.
      end: new Date(zonedTimeToUtc(timeZone, addCivilDays(to, 1), 0, 0).getTime() - 1),
    };
  }
  const today = civilDateIn(timeZone, now);
  const days = DASHBOARD_PERIOD_DAYS[period as DashboardFixedPeriod];
  const first = addCivilDays(today, -(days - 1));
  return { start: zonedTimeToUtc(timeZone, first, 0, 0), end: null };
}

/** Atalho de leitura para quem só precisa do começo do período. */
export function periodStart(period: DashboardPeriod, now: Date, timezone: string): Date {
  return periodRange(period, now, timezone).start;
}

function minutesOfDay(time: string): number {
  const [hours, minutes] = time.split(":");
  return Number(hours) * 60 + Number(minutes);
}

/** Dias que realmente acumulam tempo: ativos e com fim depois do início. */
function usableDays(businessHours: BusinessHours[]): Map<Weekday, BusinessHours> {
  const usable = new Map<Weekday, BusinessHours>();
  for (const day of businessHours) {
    if (day.active && minutesOfDay(day.endTime) > minutesOfDay(day.startTime)) {
      usable.set(day.weekday, day);
    }
  }
  return usable;
}

/**
 * Minutos de expediente entre dois instantes.
 *
 * É assim que "sem resposta há 30 minutos" vira uma medida honesta: mensagem
 * que chega 17h50 de sexta não acumula durante a noite nem no fim de semana,
 * ela volta a contar na abertura do próximo dia ativo. Dia desligado não
 * acumula nada.
 *
 * Feriado **não** é tratado nesta entrega: conta como dia normal. Se um dia
 * passar a ser tratado, o lugar é aqui.
 *
 * Com todos os dias desligados o resultado é zero e a função devolve na hora
 * — sem isso a varredura ficaria procurando um próximo horário útil que não
 * existe.
 */
export function businessMinutesBetween(
  from: Date,
  to: Date,
  settings: Pick<AttendanceSettings, "timezone" | "businessHours">,
): number {
  if (to.getTime() <= from.getTime()) return 0;
  const days = usableDays(settings.businessHours);
  if (days.size === 0) return 0;

  const timeZone = safeTimeZone(settings.timezone);
  let cursor = civilDateIn(timeZone, from);
  let total = 0;

  for (let scanned = 0; scanned < MAX_BUSINESS_DAYS_SCANNED; scanned += 1) {
    const config = days.get(weekdayOf(cursor));
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
      const start = Math.max(opens.getTime(), from.getTime());
      const end = Math.min(closes.getTime(), to.getTime());
      if (end > start) total += (end - start) / 60_000;
    }
    const next = addCivilDays(cursor, 1);
    // A meia-noite do próximo dia já passou do fim do intervalo: acabou.
    if (zonedTimeToUtc(timeZone, next, 0, 0).getTime() >= to.getTime()) break;
    cursor = next;
  }

  return total;
}

/** Conversa candidata a atraso: a última mensagem dela é do cliente. */
export interface WaitingConversation {
  conversationId: string;
  lastInboundAt: Date;
}

export interface OverdueResult {
  count: number;
  /** Maior espera **em minutos de expediente**, ou null quando não há atraso. */
  oldestWaitingMinutes: number | null;
}

/**
 * Quantas conversas passaram do limite e há quanto tempo espera a mais
 * antiga. A espera é sempre em tempo útil — comparar contra tempo de relógio
 * marcaria como atrasado tudo o que chegou depois do expediente.
 */
export function computeOverdue(
  waiting: WaitingConversation[],
  settings: Pick<AttendanceSettings, "timezone" | "businessHours" | "responseLimitMinutes">,
  now: Date,
): OverdueResult {
  let count = 0;
  let oldest: number | null = null;
  for (const conversation of waiting) {
    const minutes = businessMinutesBetween(conversation.lastInboundAt, now, settings);
    if (minutes <= settings.responseLimitMinutes) continue;
    count += 1;
    if (oldest === null || minutes > oldest) oldest = minutes;
  }
  return { count, oldestWaitingMinutes: oldest === null ? null : Math.floor(oldest) };
}

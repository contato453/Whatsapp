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

export interface CivilDate {
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

export function addCivilDays(date: CivilDate, days: number): CivilDate {
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
  if (period === "yesterday") {
    // Único atalho com corte SUPERIOR: os outros são "últimos N dias
    // contando hoje, até agora"; ontem é um dia civil fechado que não
    // inclui hoje — sem o corte, "ontem" mostraria ontem mais o dia inteiro
    // de hoje.
    const day = addCivilDays(civilDateIn(timeZone, now), -1);
    return {
      start: zonedTimeToUtc(timeZone, day, 0, 0),
      end: new Date(zonedTimeToUtc(timeZone, addCivilDays(day, 1), 0, 0).getTime() - 1),
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

/** Uma linha da agregação por dia/hora que o banco devolve. */
export interface ActivityBucket {
  /** Dia civil "AAAA-MM-DD" no fuso do escritório. */
  day: string;
  /** 0 = domingo ... 6 = sábado, no fuso do escritório. */
  weekday: number;
  /** 0 a 23, no fuso do escritório. */
  hour: number;
  direction: string;
  total: number;
}

export interface TimelinePoint {
  date: string;
  received: number;
  sent: number;
}

export interface HourlyCell {
  weekday: Weekday;
  hour: number;
  received: number;
  sent: number;
}

/** Dias civis do intervalo, do primeiro ao último, no fuso do escritório. */
export function civilDaysOfRange(range: PeriodRange, now: Date, timezone: string): string[] {
  const timeZone = safeTimeZone(timezone);
  const last = civilDateIn(timeZone, range.end ?? now);
  let cursor = civilDateIn(timeZone, range.start);
  const days: string[] = [];
  // O teto é o mesmo do cálculo de expediente: intervalo maior que isso não
  // chega aqui (o Zod barra em 366 dias), e o limite evita laço solto.
  for (let scanned = 0; scanned < MAX_BUSINESS_DAYS_SCANNED; scanned += 1) {
    days.push(formatCivilDate(cursor));
    if (cursor.year === last.year && cursor.month === last.month && cursor.day === last.day) break;
    cursor = addCivilDays(cursor, 1);
  }
  return days;
}

function formatCivilDate(date: CivilDate): string {
  const month = String(date.month).padStart(2, "0");
  const day = String(date.day).padStart(2, "0");
  return `${date.year}-${month}-${day}`;
}

/**
 * Série por dia, com **todos** os dias do período — inclusive os zerados.
 *
 * Dia sem movimento precisa aparecer como zero, e não sumir: um gráfico que
 * pula o domingo faz a semana parecer contínua e esconde justamente o dia em
 * que ninguém atendeu.
 */
export function foldTimeline(buckets: ActivityBucket[], days: string[]): TimelinePoint[] {
  const byDay = new Map<string, TimelinePoint>(
    days.map((date) => [date, { date, received: 0, sent: 0 }]),
  );
  for (const bucket of buckets) {
    const point = byDay.get(bucket.day);
    // Mensagem fora da lista de dias só acontece com fuso trocado no meio do
    // caminho; ignorar é melhor do que inventar um dia que a tela não desenha.
    if (!point) continue;
    if (bucket.direction === "inbound") point.received += bucket.total;
    else point.sent += bucket.total;
  }
  return days.map((date) => byDay.get(date) ?? { date, received: 0, sent: 0 });
}

/**
 * Mapa dia da semana × hora, somando todos os dias do período.
 *
 * Devolve só as células com movimento: a grade cheia são 168 posições, e a
 * tela sabe desenhar o vazio sozinha. Menos dado no fio, mesma figura.
 */
export function foldHourly(buckets: ActivityBucket[]): HourlyCell[] {
  const cells = new Map<string, HourlyCell>();
  for (const bucket of buckets) {
    if (bucket.weekday < 0 || bucket.weekday > 6) continue;
    if (bucket.hour < 0 || bucket.hour > 23) continue;
    const key = `${bucket.weekday}:${bucket.hour}`;
    const cell = cells.get(key) ?? {
      weekday: bucket.weekday as Weekday,
      hour: bucket.hour,
      received: 0,
      sent: 0,
    };
    if (bucket.direction === "inbound") cell.received += bucket.total;
    else cell.sent += bucket.total;
    cells.set(key, cell);
  }
  return [...cells.values()].sort(
    (a, b) => a.weekday - b.weekday || a.hour - b.hour,
  );
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
 * QUAIS conversas passaram do limite, e há quanto tempo cada uma espera.
 *
 * A espera é sempre em tempo útil — comparar contra tempo de relógio marcaria
 * como atrasado tudo o que chegou depois do expediente. É a fonte única da
 * definição de "atrasada": o card do dashboard conta o que sai daqui, e a
 * lista de conversas filtra por estes mesmos ids. Duas contas separadas
 * dariam ao clique no card uma lista que não bate com o número dele.
 */
export function selectOverdue(
  waiting: WaitingConversation[],
  settings: Pick<AttendanceSettings, "timezone" | "businessHours" | "responseLimitMinutes">,
  now: Date,
): Array<{ conversationId: string; minutes: number }> {
  const atrasadas: Array<{ conversationId: string; minutes: number }> = [];
  for (const conversation of waiting) {
    const minutes = businessMinutesBetween(conversation.lastInboundAt, now, settings);
    if (minutes <= settings.responseLimitMinutes) continue;
    atrasadas.push({ conversationId: conversation.conversationId, minutes });
  }
  return atrasadas;
}

/** Quantas passaram do limite e há quanto tempo espera a mais antiga. */
export function computeOverdue(
  waiting: WaitingConversation[],
  settings: Pick<AttendanceSettings, "timezone" | "businessHours" | "responseLimitMinutes">,
  now: Date,
): OverdueResult {
  const atrasadas = selectOverdue(waiting, settings, now);
  const oldest = atrasadas.reduce<number | null>(
    (maior, row) => (maior === null || row.minutes > maior ? row.minutes : maior),
    null,
  );
  return {
    count: atrasadas.length,
    oldestWaitingMinutes: oldest === null ? null : Math.floor(oldest),
  };
}

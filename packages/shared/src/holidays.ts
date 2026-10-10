/**
 * FERIADOS — dias em que o escritório não atende, mesmo caindo num dia da
 * semana que o expediente marca como ativo.
 *
 * Existe porque, sem isto, o relógio do atraso andava no feriado: a mensagem
 * que chegava na véspera de um feriado em dia útil virava "Atrasados agora"
 * no dia em que ninguém trabalhava, e o Quality cobrava a espera do atendente.
 *
 * Três fontes, e só três:
 *  1. os feriados NACIONAIS, calculados aqui (ligados por padrão) — fixos e a
 *     Sexta-feira da Paixão, que depende da Páscoa;
 *  2. os PONTOS FACULTATIVOS nacionais (Carnaval e Corpus Christi), também
 *     calculados, mas desligados por padrão: nem todo escritório fecha neles;
 *  3. as datas PRÓPRIAS do escritório — feriado estadual ou municipal, recesso
 *     — cadastradas na tela, com a opção de repetir todo ano.
 *
 * As datas nacionais NÃO são gravadas no banco, e é de propósito: calculadas,
 * elas valem para qualquer ano sem ninguém precisar cadastrar o ano seguinte.
 * Gravadas, alguém teria de lembrar de semear 2027 em dezembro de 2026.
 *
 * Esta é a fonte única do que é feriado: o cálculo de atraso (dashboard e
 * Quality), o "dentro do expediente?" das automações e o próximo horário útil
 * do follow-up e dos disparos consultam `holidayMatcher`. A janela de LOGIN
 * não consulta, de propósito: trancar a equipe do lado de fora num feriado
 * em que alguém precisou trabalhar seria pior do que deixar entrar.
 */

/** Data civil "AAAA-MM-DD", no fuso do escritório. */
export const HOLIDAY_DATE_PATTERN = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

/** Teto de datas próprias cadastradas — o caso real são algumas dezenas. */
export const MAX_CUSTOM_HOLIDAYS = 200;

/** Teto do nome de um feriado próprio. */
export const MAX_HOLIDAY_NAME_LENGTH = 80;

export interface CustomHoliday {
  /** "AAAA-MM-DD". Quando `recurring`, só o mês e o dia importam. */
  date: string;
  name: string;
  /** Repete todo ano no mesmo dia e mês (aniversário da cidade, por exemplo). */
  recurring: boolean;
}

export interface HolidaySettings {
  /** Feriados nacionais calculados (fixos + Sexta-feira da Paixão). */
  nationalEnabled: boolean;
  /** Pontos facultativos nacionais: Carnaval (segunda e terça) e Corpus Christi. */
  optionalEnabled: boolean;
  custom: CustomHoliday[];
}

export const DEFAULT_HOLIDAY_SETTINGS: HolidaySettings = {
  nationalEnabled: true,
  optionalEnabled: false,
  custom: [],
};

export type HolidayKind = "national" | "optional" | "custom";

export const HOLIDAY_KIND_LABELS: Record<HolidayKind, string> = {
  national: "Nacional",
  optional: "Ponto facultativo",
  custom: "Do escritório",
};

export interface ResolvedHoliday {
  /** "AAAA-MM-DD" já no ano pedido. */
  date: string;
  name: string;
  kind: HolidayKind;
}

interface CivilDay {
  year: number;
  month: number;
  day: number;
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

function formatDate(date: CivilDay): string {
  return `${date.year}-${pad(date.month)}-${pad(date.day)}`;
}

/**
 * Domingo de Páscoa (calendário gregoriano), pelo algoritmo de Meeus/Jones/
 * Butcher. É dele que saem as três datas móveis: Sexta-feira da Paixão
 * (Páscoa − 2), Carnaval (Páscoa − 48 e − 47) e Corpus Christi (Páscoa + 60).
 */
export function easterSunday(year: number): CivilDay {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return { year, month, day };
}

function shift(date: CivilDay, days: number): CivilDay {
  const moved = new Date(Date.UTC(date.year, date.month - 1, date.day + days));
  return { year: moved.getUTCFullYear(), month: moved.getUTCMonth() + 1, day: moved.getUTCDate() };
}

/**
 * Feriados nacionais de um ano (Lei 662/1949, Lei 6.802/1980 e Lei
 * 14.759/2023 — Consciência Negra, nacional a partir de 2024), mais a
 * Sexta-feira da Paixão, que o país inteiro observa.
 */
export function nationalHolidaysForYear(year: number): ResolvedHoliday[] {
  const fixed: Array<[number, number, string]> = [
    [1, 1, "Confraternização Universal"],
    [4, 21, "Tiradentes"],
    [5, 1, "Dia do Trabalho"],
    [9, 7, "Independência do Brasil"],
    [10, 12, "Nossa Senhora Aparecida"],
    [11, 2, "Finados"],
    [11, 15, "Proclamação da República"],
    [12, 25, "Natal"],
  ];
  if (year >= 2024) fixed.push([11, 20, "Dia Nacional de Zumbi e da Consciência Negra"]);
  const holidays: ResolvedHoliday[] = fixed.map(([month, day, name]) => ({
    date: formatDate({ year, month, day }),
    name,
    kind: "national",
  }));
  holidays.push({
    date: formatDate(shift(easterSunday(year), -2)),
    name: "Sexta-feira da Paixão",
    kind: "national",
  });
  return holidays.sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * Pontos facultativos nacionais em que escritório costuma fechar. A
 * Quarta-feira de Cinzas fica de fora: é meio expediente, e marcá-la inteira
 * esconderia a manhã de trabalho.
 */
export function optionalHolidaysForYear(year: number): ResolvedHoliday[] {
  const easter = easterSunday(year);
  return [
    { date: formatDate(shift(easter, -48)), name: "Carnaval (segunda-feira)", kind: "optional" as const },
    { date: formatDate(shift(easter, -47)), name: "Carnaval (terça-feira)", kind: "optional" as const },
    { date: formatDate(shift(easter, 60)), name: "Corpus Christi", kind: "optional" as const },
  ];
}

/**
 * Todos os feriados que valem num ano, já resolvidos para datas daquele ano,
 * em ordem. É o que a tela mostra e o que o cálculo consulta — a mesma lista,
 * para o que aparece na tela nunca divergir do que o atraso respeita.
 */
export function holidaysForYear(
  settings: HolidaySettings | undefined,
  year: number,
): ResolvedHoliday[] {
  if (!settings) return [];
  const result: ResolvedHoliday[] = [];
  if (settings.nationalEnabled) result.push(...nationalHolidaysForYear(year));
  if (settings.optionalEnabled) result.push(...optionalHolidaysForYear(year));
  for (const holiday of settings.custom) {
    if (!HOLIDAY_DATE_PATTERN.test(holiday.date)) continue;
    const [y, m, d] = holiday.date.split("-");
    if (holiday.recurring) {
      // 29/02 recorrente só existe em ano bissexto; nos outros não cai em dia
      // nenhum, em vez de escorregar sozinho para 01/03.
      const candidate = new Date(Date.UTC(year, Number(m) - 1, Number(d)));
      if (candidate.getUTCMonth() !== Number(m) - 1) continue;
      result.push({ date: `${year}-${m}-${d}`, name: holiday.name, kind: "custom" });
    } else if (Number(y) === year) {
      result.push({ date: holiday.date, name: holiday.name, kind: "custom" });
    }
  }
  return result.sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * Função de consulta "este dia é feriado?", com a lista de cada ano montada
 * uma vez só. É a forma que o cálculo de atraso usa: ele percorre dia a dia,
 * e recalcular a Páscoa a cada dia seria desperdício.
 *
 * `settings` ausente (objeto montado à mão, fake de teste antigo) significa
 * "sem feriados" — nunca um erro, e nunca os nacionais por suposição.
 */
export function holidayMatcher(
  settings: HolidaySettings | undefined,
): (date: CivilDay) => boolean {
  if (!settings) return () => false;
  if (!settings.nationalEnabled && !settings.optionalEnabled && settings.custom.length === 0) {
    return () => false;
  }
  const byYear = new Map<number, Set<string>>();
  return (date) => {
    let days = byYear.get(date.year);
    if (!days) {
      days = new Set(holidaysForYear(settings, date.year).map((holiday) => holiday.date));
      byYear.set(date.year, days);
    }
    return days.has(formatDate(date));
  };
}

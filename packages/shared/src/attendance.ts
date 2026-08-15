/**
 * Parâmetros de atendimento — SLA de resposta e expediente do escritório.
 *
 * Estes valores são **padrão**, não verdade: o que vale em runtime é sempre
 * a linha do banco (`attendance_settings`). Eles servem para dois usos:
 *
 * 1. semear a linha da organização na migration;
 * 2. responder o GET e alimentar o cálculo do dashboard enquanto a linha
 *    ainda não existe — organização recém-criada não pode derrubar a tela.
 *
 * A política muda com o tempo (o escritório pode passar a atender sábado de
 * manhã), por isso ela mora no banco e não aqui dentro.
 */

/**
 * 0 = domingo ... 6 = sábado. Mesma convenção de `Date#getDay()` e do
 * `EXTRACT(DOW)` do Postgres, para não existir tradução no meio do caminho.
 */
export const WEEKDAYS = [0, 1, 2, 3, 4, 5, 6] as const;
export type Weekday = (typeof WEEKDAYS)[number];

export const WEEKDAY_LABELS: Record<Weekday, string> = {
  0: "Domingo",
  1: "Segunda-feira",
  2: "Terça-feira",
  3: "Quarta-feira",
  4: "Quinta-feira",
  5: "Sexta-feira",
  6: "Sábado",
};

/** Versão curta, para caber na coluna estreita da tela de parâmetros. */
export const WEEKDAY_SHORT_LABELS: Record<Weekday, string> = {
  0: "Dom",
  1: "Seg",
  2: "Ter",
  3: "Qua",
  4: "Qui",
  5: "Sex",
  6: "Sáb",
};

/** Hora do expediente no formato "HH:MM", 24 horas. */
export const TIME_OF_DAY_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

/** Limite padrão de resposta: meia hora de expediente sem responder o cliente. */
export const DEFAULT_RESPONSE_LIMIT_MINUTES = 30;

/**
 * Teto e piso do limite. Um minuto é o menor valor que ainda mede alguma
 * coisa; 1440 (24 horas de expediente, quase três dias úteis de 8 horas) é o
 * maior que ainda produz um indicador útil. Fora disso o card viraria enfeite.
 */
export const RESPONSE_LIMIT_MIN_MINUTES = 1;
export const RESPONSE_LIMIT_MAX_MINUTES = 1440;

/**
 * Faixa em que o valor é plausível para um escritório. Fora dela a tela
 * avisa, mas grava e calcula normalmente — é escolha da supervisão, não erro.
 */
export const RESPONSE_LIMIT_USUAL_MIN_MINUTES = 5;
export const RESPONSE_LIMIT_USUAL_MAX_MINUTES = 480;

export const DEFAULT_TIMEZONE = "America/Sao_Paulo";

export interface BusinessHours {
  weekday: Weekday;
  active: boolean;
  /** "HH:MM" no fuso configurado. */
  startTime: string;
  /** "HH:MM" no fuso configurado, sempre maior que `startTime` quando ativo. */
  endTime: string;
}

export interface AttendanceSettings {
  responseLimitMinutes: number;
  timezone: string;
  /** Sempre os sete dias, do domingo ao sábado, em ordem. */
  businessHours: BusinessHours[];
}

/** Segunda a sexta das 08:00 às 18:00; sábado e domingo desligados. */
export function defaultBusinessHoursFor(weekday: Weekday): BusinessHours {
  return {
    weekday,
    active: weekday >= 1 && weekday <= 5,
    startTime: "08:00",
    // Dia desligado guarda horário mesmo assim: ligar o sábado na tela já vem
    // com valores razoáveis em vez de campo vazio.
    endTime: "18:00",
  };
}

export const DEFAULT_BUSINESS_HOURS: BusinessHours[] = WEEKDAYS.map(defaultBusinessHoursFor);

export const DEFAULT_ATTENDANCE_SETTINGS: AttendanceSettings = {
  responseLimitMinutes: DEFAULT_RESPONSE_LIMIT_MINUTES,
  timezone: DEFAULT_TIMEZONE,
  businessHours: DEFAULT_BUSINESS_HOURS,
};

/**
 * Atalhos de período do dashboard. São janelas contadas para trás a partir
 * de hoje, sempre no fuso do escritório.
 */
export const DASHBOARD_FIXED_PERIODS = ["today", "7d", "15d", "30d"] as const;
export type DashboardFixedPeriod = (typeof DASHBOARD_FIXED_PERIODS)[number];

/**
 * `custom` é o intervalo escolhido na mão, com data de início e fim. Ele
 * convive com os atalhos em vez de substituí-los: no dia a dia a pergunta é
 * "e hoje?", e obrigar a preencher duas datas para isso seria pior.
 */
export const DASHBOARD_PERIODS = [...DASHBOARD_FIXED_PERIODS, "custom"] as const;
export type DashboardPeriod = (typeof DASHBOARD_PERIODS)[number];

export const DASHBOARD_PERIOD_LABELS: Record<DashboardPeriod, string> = {
  today: "Hoje",
  "7d": "7 dias",
  "15d": "15 dias",
  "30d": "30 dias",
  custom: "Personalizado",
};

/** Como o período aparece dentro da frase de um rótulo ("recebidas hoje"). */
export const DASHBOARD_PERIOD_PHRASES: Record<DashboardPeriod, string> = {
  today: "hoje",
  "7d": "nos últimos 7 dias",
  "15d": "nos últimos 15 dias",
  "30d": "nos últimos 30 dias",
  custom: "no período escolhido",
};

/** Quantos dias civis cada atalho cobre, contando o dia atual. */
export const DASHBOARD_PERIOD_DAYS: Record<DashboardFixedPeriod, number> = {
  today: 1,
  "7d": 7,
  "15d": 15,
  "30d": 30,
};

/**
 * Janela fixa do mapa de calor de dia × hora.
 *
 * Padrão de horário só aparece com repetição: um dia mostra um dia, e não o
 * hábito do cliente. Por isso este bloco é o único da tela que **não** segue
 * o período escolhido — os filtros de número, departamento e responsável
 * continuam valendo nele.
 */
export const DASHBOARD_HEATMAP_DAYS = 30;

/** Data civil "AAAA-MM-DD" — o intervalo personalizado é escolhido em dias. */
export const DATE_ONLY_PATTERN = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

/**
 * Teto do intervalo personalizado. Um ano cobre qualquer pergunta real do
 * escritório e evita que um clique errado mande varrer a base inteira.
 */
export const MAX_CUSTOM_RANGE_DAYS = 366;

/** Valor de filtro para "sem departamento" e "sem responsável". */
export const FILTER_NONE = "none";

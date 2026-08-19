"use client";

/**
 * Filtros do Dashboard de Atendimento, guardados no navegador por usuário.
 *
 * Mesma mecânica dos filtros da Inbox (`lib/inbox-filters.ts`) e pelos mesmos
 * motivos: é estado de apresentação de uma máquina, não dado do atendimento —
 * nada de coluna em `User` nem de rota gravando preferência. **A chave inclui
 * o usuário**, porque máquina compartilhada é o caso normal do escritório, e
 * é uma chave PRÓPRIA: filtrar a Inbox não pode mexer no Dashboard, e o
 * contrário também não. As duas telas respondem perguntas diferentes.
 *
 * ## A REGRA DE COMBINAÇÃO
 *
 * **OU dentro de um filtro, E entre filtros diferentes.** Marcar dois chips
 * mostra os dois somados; marcar um chip e o status "Aberto" mostra só as
 * abertas daquele chip. Filtro sem nada marcado é "todos".
 *
 * **Departamento e responsável ficam SEPARADOS e cruzam**, ao contrário da
 * Inbox, onde os dois viraram um filtro só que soma. O porquê está em
 * `@azvchat/shared/dashboard-filters`: lá a pergunta é de triagem e o
 * resultado é uma lista; aqui é de análise e o resultado é um número, e somar
 * recortes diferentes dentro do mesmo total produz número sem significado.
 */

import {
  conversationStatusIsValid,
  FILTER_ALL_USERS,
  FILTER_NONE,
  dashboardAssigneeValueIsValid,
  dashboardDepartmentValueIsValid,
  DASHBOARD_PERIODS,
  DATE_ONLY_PATTERN,
  type ConversationStatus,
  type DashboardPeriod,
} from "@azvchat/shared";

export interface DashboardFilters {
  /**
   * ÚNICO de propósito, e não vira lista: período é intervalo, não conjunto.
   * "Hoje" mais "30 dias" não significa nada.
   */
  period: DashboardPeriod;
  /** Só valem com `period: "custom"`. */
  from?: string;
  to?: string;
  instanceIds: string[];
  statuses: ConversationStatus[];
  /** Ids de departamento, mais o sentinela "sem departamento". */
  departmentIds: string[];
  /** Ids de pessoa, mais "sem responsável" e o coletivo "@todos". */
  assignedUserIds: string[];
}

export const DEFAULT_DASHBOARD_FILTERS: DashboardFilters = {
  period: "today",
  instanceIds: [],
  statuses: [],
  departmentIds: [],
  assignedUserIds: [],
};

/** Mesmo prefixo do token (`zapdesk.`), como a Inbox e a barra lateral. */
const STORAGE_PREFIX = "zapdesk.dashboard-filters.";
/**
 * Chaves antigas, sem usuário: a primeira guardava o formato de valor único e
 * a segunda, de quando só existia o período. Lidas para migrar, nunca escritas.
 */
const LEGACY_SHARED_KEY = "zapdesk.dashboard-filters";
const LEGACY_PERIOD_KEY = "zapdesk.dashboard-period";

function keyFor(userId: string): string {
  return `${STORAGE_PREFIX}${userId}`;
}

/**
 * `localStorage` estoura em aba privada ou com a cota cheia. Perder um filtro
 * é ruim; derrubar o dashboard por causa dele seria pior.
 */
function safely<T>(action: () => T, fallback: T): T {
  if (typeof window === "undefined") return fallback;
  try {
    return action();
  } catch {
    return fallback;
  }
}

function isPeriod(value: unknown): value is DashboardPeriod {
  return typeof value === "string" && (DASHBOARD_PERIODS as readonly string[]).includes(value);
}

function isDate(value: unknown): value is string {
  return typeof value === "string" && DATE_ONLY_PATTERN.test(value);
}

/** Lista de textos, com os itens que não passam no teste descartados. */
function readList(value: unknown, valido: (item: string) => boolean): string[] {
  if (!Array.isArray(value)) return [];
  const vistos = new Set<string>();
  for (const item of value) {
    if (typeof item === "string" && valido(item)) vistos.add(item);
  }
  return [...vistos];
}

/**
 * O formato antigo guardava UM valor por filtro (`instanceId: "abc"`). Quem já
 * tinha um recorte salvo não pode perdê-lo na primeira abertura depois do
 * deploy: cada valor único vira lista de um item.
 *
 * Código de transição — pode sair quando ninguém mais tiver o formato velho no
 * navegador. Até lá, descartar em vez de converter apagaria em silêncio o
 * recorte que a pessoa montou.
 */
function readLegacy(parsed: Record<string, unknown>, atual: DashboardFilters): DashboardFilters {
  const unico = (valor: unknown, valido: (item: string) => boolean): string[] =>
    typeof valor === "string" && valor.length > 0 && valido(valor) ? [valor] : [];
  const migrado = { ...atual };
  if (migrado.instanceIds.length === 0) {
    migrado.instanceIds = unico(parsed.instanceId, () => true);
  }
  if (migrado.statuses.length === 0) {
    migrado.statuses = unico(parsed.status, conversationStatusIsValid) as ConversationStatus[];
  }
  if (migrado.departmentIds.length === 0) {
    migrado.departmentIds = unico(parsed.departmentId, dashboardDepartmentValueIsValid);
  }
  if (migrado.assignedUserIds.length === 0) {
    migrado.assignedUserIds = unico(parsed.assignedUserId, dashboardAssigneeValueIsValid);
  }
  return migrado;
}

function parseFilters(raw: string): DashboardFilters {
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== "object" || parsed === null) return DEFAULT_DASHBOARD_FILTERS;
  const value = parsed as Record<string, unknown>;
  const base: DashboardFilters = {
    period: isPeriod(value.period) ? value.period : "today",
    instanceIds: readList(value.instanceIds, () => true),
    statuses: readList(value.statuses, conversationStatusIsValid) as ConversationStatus[],
    departmentIds: readList(value.departmentIds, dashboardDepartmentValueIsValid),
    assignedUserIds: readList(value.assignedUserIds, dashboardAssigneeValueIsValid),
  };
  if (isDate(value.from)) base.from = value.from;
  if (isDate(value.to)) base.to = value.to;
  const filters = readLegacy(value, base);
  // Personalizado sem as duas datas não é pedido válido: cai em "hoje" em vez
  // de virar uma requisição que a API recusaria.
  if (filters.period === "custom" && (!filters.from || !filters.to)) {
    return { ...filters, period: "today" };
  }
  return filters;
}

export function readDashboardFilters(userId: string): DashboardFilters {
  return safely(() => {
    const raw = window.localStorage.getItem(keyFor(userId));
    if (raw) return parseFilters(raw);
    // Sem chave por usuário: procura o que as versões anteriores deixaram.
    const legacy = window.localStorage.getItem(LEGACY_SHARED_KEY);
    if (legacy) return parseFilters(legacy);
    const period = window.localStorage.getItem(LEGACY_PERIOD_KEY);
    return isPeriod(period)
      ? { ...DEFAULT_DASHBOARD_FILTERS, period }
      : DEFAULT_DASHBOARD_FILTERS;
  }, DEFAULT_DASHBOARD_FILTERS);
}

/** Sem nenhum filtro ativo a entrada é apagada: padrão não é preferência. */
export function saveDashboardFilters(userId: string, filters: DashboardFilters): void {
  safely(() => {
    const key = keyFor(userId);
    if (!hasActiveDashboardFilters(filters) && filters.period === "today") {
      window.localStorage.removeItem(key);
    } else {
      window.localStorage.setItem(key, JSON.stringify(filters));
    }
    // As chaves antigas saem de cena assim que a nova é escrita: deixá-las
    // para trás faria o recorte velho ressuscitar em outro login da mesma
    // máquina.
    window.localStorage.removeItem(LEGACY_SHARED_KEY);
    window.localStorage.removeItem(LEGACY_PERIOD_KEY);
  }, undefined);
}

export const DASHBOARD_FILTER_FIELDS = [
  "statuses",
  "departmentIds",
  "assignedUserIds",
  "instanceIds",
] as const;
export type DashboardFilterField = (typeof DASHBOARD_FILTER_FIELDS)[number];

/** O período não conta: ele sempre tem valor, e "hoje" não é recorte. */
export function hasActiveDashboardFilters(filters: DashboardFilters): boolean {
  return DASHBOARD_FILTER_FIELDS.some((field) => filters[field].length > 0);
}

/** Zera os quatro filtros, preservando o período e as datas escolhidas. */
export function clearDashboardFilters(filters: DashboardFilters): DashboardFilters {
  return {
    ...DEFAULT_DASHBOARD_FILTERS,
    period: filters.period,
    ...(filters.from ? { from: filters.from } : {}),
    ...(filters.to ? { to: filters.to } : {}),
  };
}

/**
 * Tira do recorte o que deixou de existir — chip apagado, departamento
 * excluído, pessoa desativada. É a tela que poda, porque só ela sabe o que
 * ainda existe, e ela poda ANTES de virar consulta: a API recusa id
 * desconhecido com 400, e esse erro não pode aparecer para quem só voltou à
 * tela depois de um cadastro ter mudado.
 *
 * Os sentinelas ("sem departamento", "sem responsável", "@todos") sobrevivem
 * sempre: eles não são id de nada.
 */
export function pruneDashboardFilters(
  filters: DashboardFilters,
  existentes: {
    instanceIds: readonly string[];
    departmentIds: readonly string[];
    userIds: readonly string[];
  },
): DashboardFilters {
  const podar = (valores: string[], conhecidos: readonly string[], sentinelas: string[]): string[] =>
    valores.filter((valor) => sentinelas.includes(valor) || conhecidos.includes(valor));

  const next: DashboardFilters = {
    ...filters,
    instanceIds: podar(filters.instanceIds, existentes.instanceIds, []),
    departmentIds: podar(filters.departmentIds, existentes.departmentIds, [FILTER_NONE]),
    assignedUserIds: podar(filters.assignedUserIds, existentes.userIds, [
      FILTER_NONE,
      FILTER_ALL_USERS,
    ]),
  };
  // Só devolve objeto novo quando algo saiu: igual, evita uma recarga inteira
  // do dashboard a cada chegada das listas.
  const igual = DASHBOARD_FILTER_FIELDS.every(
    (field) => next[field].length === filters[field].length,
  );
  return igual ? filters : next;
}

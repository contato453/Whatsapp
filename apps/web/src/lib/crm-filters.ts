"use client";

/**
 * Filtros do CRM, guardados no navegador por usuário.
 *
 * Mesma mecânica dos filtros da Inbox e do Dashboard, e pelos mesmos motivos:
 * é estado de apresentação de uma máquina, não dado do atendimento — nada de
 * coluna em `User` nem de rota gravando preferência a cada clique. **A chave
 * inclui o usuário**, porque máquina compartilhada é o caso normal do
 * escritório, e é uma chave PRÓPRIA: recortar o Kanban não pode mexer na
 * Inbox nem no Dashboard.
 *
 * Guardar o funil escolhido é o que mais importa aqui: quem trabalha o funil
 * de Cobrança o dia inteiro não pode cair no Comercial a cada F5.
 *
 * A REGRA DE COMBINAÇÃO é a da Inbox: **OU dentro de um filtro, E entre
 * filtros diferentes**. Marcar duas pessoas mostra as duas; marcar uma pessoa
 * e uma etiqueta mostra o que tem as duas coisas. Nada marcado é "todos".
 */

export interface CrmFilterState {
  /** Funil aberto. Vazio = o padrão que a API devolver primeiro. */
  pipelineId: string;
  assignedUserIds: string[];
  departmentIds: string[];
  tagIds: string[];
  origins: string[];
  productIds: string[];
  /** Só os cards com atividade vencida — o "o que está pegando fogo". */
  overdueActivity: boolean;
  search: string;
}

export const DEFAULT_CRM_FILTERS: CrmFilterState = {
  pipelineId: "",
  assignedUserIds: [],
  departmentIds: [],
  tagIds: [],
  origins: [],
  productIds: [],
  overdueActivity: false,
  search: "",
};

const STORAGE_PREFIX = "zapdesk.crm-filters.";

function keyFor(userId: string): string {
  return `${STORAGE_PREFIX}${userId}`;
}

/** Storage estoura em aba privada: perder o filtro é aceitável, cair não. */
function safely<T>(action: () => T, fallback: T): T {
  if (typeof window === "undefined") return fallback;
  try {
    return action();
  } catch {
    return fallback;
  }
}

function readList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((item): item is string => typeof item === "string"))];
}

export function readCrmFilters(userId: string): CrmFilterState {
  return safely(() => {
    const raw = window.localStorage.getItem(keyFor(userId));
    if (!raw) return DEFAULT_CRM_FILTERS;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return DEFAULT_CRM_FILTERS;
    const value = parsed as Record<string, unknown>;
    return {
      pipelineId: typeof value.pipelineId === "string" ? value.pipelineId : "",
      assignedUserIds: readList(value.assignedUserIds),
      departmentIds: readList(value.departmentIds),
      tagIds: readList(value.tagIds),
      origins: readList(value.origins),
      productIds: readList(value.productIds),
      overdueActivity: value.overdueActivity === true,
      // A BUSCA NÃO É RESTAURADA de propósito: voltar à tela com um termo
      // digitado ontem faria o quadro parecer vazio sem explicação.
      search: "",
    };
  }, DEFAULT_CRM_FILTERS);
}

export function saveCrmFilters(userId: string, filters: CrmFilterState): void {
  safely(() => {
    window.localStorage.setItem(
      keyFor(userId),
      JSON.stringify({ ...filters, search: "" }),
    );
  }, undefined);
}

const LIST_FIELDS = [
  "assignedUserIds",
  "departmentIds",
  "tagIds",
  "origins",
  "productIds",
] as const;

/** O funil escolhido não conta como recorte: ele sempre tem um valor. */
export function hasActiveCrmFilters(filters: CrmFilterState): boolean {
  return (
    LIST_FIELDS.some((field) => filters[field].length > 0) ||
    filters.overdueActivity ||
    filters.search.trim().length > 0
  );
}

export function clearCrmFilters(filters: CrmFilterState): CrmFilterState {
  return { ...DEFAULT_CRM_FILTERS, pipelineId: filters.pipelineId };
}

/**
 * Tira do recorte o que deixou de existir — pessoa desativada, etiqueta
 * apagada, serviço removido.
 *
 * A poda é da TELA, e acontece ANTES de virar consulta: a API recusa id
 * desconhecido, e esse erro não pode aparecer para quem só voltou ao CRM
 * depois de um cadastro ter mudado. O sentinela "none" ("sem responsável",
 * "sem departamento") sobrevive sempre — ele não é id de nada.
 */
export function pruneCrmFilters(
  filters: CrmFilterState,
  existentes: {
    userIds: readonly string[];
    departmentIds: readonly string[];
    tagIds: readonly string[];
    productIds: readonly string[];
    pipelineIds: readonly string[];
  },
): CrmFilterState {
  const podar = (valores: string[], conhecidos: readonly string[]): string[] =>
    valores.filter((valor) => valor === "none" || conhecidos.includes(valor));

  const next: CrmFilterState = {
    ...filters,
    pipelineId:
      filters.pipelineId && existentes.pipelineIds.includes(filters.pipelineId)
        ? filters.pipelineId
        : "",
    assignedUserIds: podar(filters.assignedUserIds, existentes.userIds),
    departmentIds: podar(filters.departmentIds, existentes.departmentIds),
    tagIds: podar(filters.tagIds, existentes.tagIds),
    productIds: podar(filters.productIds, existentes.productIds),
  };

  const igual =
    next.pipelineId === filters.pipelineId &&
    LIST_FIELDS.every((field) => next[field].length === filters[field].length);
  return igual ? filters : next;
}

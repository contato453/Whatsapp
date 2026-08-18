/**
 * Contrato dos filtros da lista de conversas.
 *
 * ## A regra de combinação, e ela é a coisa que alguém vai inverter um dia
 *
 * **DENTRO de um filtro os valores marcados somam (OU); ENTRE filtros
 * diferentes eles cruzam (E).** Marcar Contábil e Fiscal mostra os dois
 * departamentos; marcar Contábil e o status "Aberto" mostra só as abertas do
 * Contábil. Filtro sem nada marcado significa "todos" naquele filtro, e não
 * "nenhum" — é o estado inicial da tela.
 *
 * Se alguém trocar isso por E dentro do filtro, a Inbox passa a devolver
 * lista vazia em quase toda marcação múltipla (uma conversa não está em dois
 * departamentos ao mesmo tempo), e o defeito vai parecer "o filtro não acha
 * nada" em vez de "a regra está invertida".
 *
 * ## Por que departamento e responsável são UM filtro só
 *
 * O caso mais comum do escritório é "quero ver o Contábil inteiro MAIS a
 * fulana", e fulana pode ser de outro departamento. Com dois filtros
 * separados isso é impossível: eles cruzariam por E, e o resultado seria
 * "as conversas do Contábil que são da fulana", que costuma ser vazio.
 * Juntando os dois num filtro só, tudo que está marcado ali soma — é a
 * mesma lista do programa antigo que a equipe usava, e a diferença entre
 * somar e cruzar é justamente o motivo de eles terem virado um.
 */

import { CONVERSATION_STATUSES, type ConversationStatus } from "./enums.js";

/** Conversa sem responsável (a fila de quem precisa de dono). */
export const ASSIGNMENT_UNASSIGNED = "none";
/** Atendimento coletivo "@todos". */
export const ASSIGNMENT_ALL_USERS = "all_users";
/** Conversa que não foi classificada em departamento nenhum. */
export const ASSIGNMENT_NO_DEPARTMENT = "no_department";

const DEPARTMENT_PREFIX = "dept:";
const USER_PREFIX = "user:";

export function departmentAssignmentToken(id: string): string {
  return `${DEPARTMENT_PREFIX}${id}`;
}

export function userAssignmentToken(id: string): string {
  return `${USER_PREFIX}${id}`;
}

/** Um uuid v4 do jeito que o resto do sistema gera. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function assignmentTokenIsValid(token: string): boolean {
  if (
    token === ASSIGNMENT_UNASSIGNED ||
    token === ASSIGNMENT_ALL_USERS ||
    token === ASSIGNMENT_NO_DEPARTMENT
  ) {
    return true;
  }
  if (token.startsWith(DEPARTMENT_PREFIX)) return UUID.test(token.slice(DEPARTMENT_PREFIX.length));
  if (token.startsWith(USER_PREFIX)) return UUID.test(token.slice(USER_PREFIX.length));
  return false;
}

export interface ParsedAssignment {
  unassigned: boolean;
  allUsers: boolean;
  noDepartment: boolean;
  departmentIds: string[];
  userIds: string[];
}

/**
 * Quebra os tokens marcados nos cinco tipos de recorte. Os ids saem sem
 * repetição: marcar a mesma pessoa duas vezes (o que a tela não permite, mas
 * um valor guardado antigo pode conter) não pode virar `IN` com duplicata.
 */
export function parseAssignmentTokens(tokens: readonly string[]): ParsedAssignment {
  const departmentIds = new Set<string>();
  const userIds = new Set<string>();
  let unassigned = false;
  let allUsers = false;
  let noDepartment = false;
  for (const token of tokens) {
    if (token === ASSIGNMENT_UNASSIGNED) unassigned = true;
    else if (token === ASSIGNMENT_ALL_USERS) allUsers = true;
    else if (token === ASSIGNMENT_NO_DEPARTMENT) noDepartment = true;
    else if (token.startsWith(DEPARTMENT_PREFIX)) departmentIds.add(token.slice(DEPARTMENT_PREFIX.length));
    else if (token.startsWith(USER_PREFIX)) userIds.add(token.slice(USER_PREFIX.length));
  }
  return {
    unassigned,
    allUsers,
    noDepartment,
    departmentIds: [...departmentIds],
    userIds: [...userIds],
  };
}

/** Tipos de conversa, para o seletor de tipo aceitar os dois marcados. */
export const CONVERSATION_TYPE_FILTERS = ["individual", "group"] as const;
export type ConversationTypeFilter = (typeof CONVERSATION_TYPE_FILTERS)[number];

export function conversationStatusIsValid(value: string): value is ConversationStatus {
  return (CONVERSATION_STATUSES as readonly string[]).includes(value);
}

/** Rótulos dos blocos do filtro unificado, iguais nos dois lados do muro. */
export const ASSIGNMENT_GROUP_LABELS = {
  situation: "Atendimento",
  departments: "Departamentos",
  users: "Usuários",
} as const;

export const ASSIGNMENT_FILTER_LABEL = "Departamento e responsável";
export const ASSIGNMENT_NO_DEPARTMENT_LABEL = "Sem departamento";

/**
 * Rótulo do seletor fechado: um marcado mostra o nome, vários mostram o
 * primeiro mais a conta do resto. Nome longo é cortado por CSS, não aqui —
 * cortar no texto esconderia a diferença entre dois departamentos parecidos.
 */
export function multiSelectSummary(labels: readonly string[], empty: string): string {
  if (labels.length === 0) return empty;
  if (labels.length === 1) return labels[0] ?? empty;
  return `${labels[0]} +${labels.length - 1}`;
}

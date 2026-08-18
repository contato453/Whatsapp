"use client";

/**
 * Filtros da tela de Usuários (chip, tipo de usuário e departamento),
 * guardados no navegador por usuário.
 *
 * **A filtragem é no cliente, sobre a lista já carregada.** `GET /users`
 * devolve a organização inteira de uma vez, com os vínculos de números e
 * departamentos de cada pessoa dentro da própria resposta — são algumas
 * dezenas de linhas. Levar o recorte para o servidor exigiria parâmetro de
 * consulta, paginação e uma segunda régua de filtro na API para responder
 * exatamente o que o navegador já tem em memória: infraestrutura sem ganho
 * nenhum para quem usa. Se um dia a lista passar de algumas centenas de
 * pessoas, a decisão muda — e o lugar de mudá-la é aqui.
 *
 * Mesma mecânica dos filtros da Inbox (`lib/inbox-filters.ts`), com chave
 * própria: a chave inclui o usuário (máquina compartilhada é o caso normal
 * do escritório) e a leitura valida campo a campo, então valor corrompido
 * ou de versão antiga vira o padrão em silêncio, sem estourar a tela.
 *
 * Quem poda id que deixou de existir é a tela, não este módulo: só ela sabe
 * quais números e departamentos ainda existem.
 */

import { USER_ROLES, type UserRole } from "@azvchat/shared";
import type { UserWithAccessDto } from "@/lib/types";

export interface UsersFilters {
  /** "" = todos — mesmo vazio dos seletores da barra da Inbox. */
  instanceId: string;
  role: UserRole | "";
  departmentId: string;
}

export const EMPTY_USERS_FILTERS: UsersFilters = {
  instanceId: "",
  role: "",
  departmentId: "",
};

function isUserRole(value: unknown): value is UserRole {
  return typeof value === "string" && (USER_ROLES as readonly string[]).includes(value);
}

/** Mesmo prefixo do token (`zapdesk.`), como o rascunho e os filtros da Inbox. */
const STORAGE_PREFIX = "zapdesk.users-filters.";

function keyFor(userId: string): string {
  return `${STORAGE_PREFIX}${userId}`;
}

/**
 * `localStorage` estoura em modo restrito ou com a cota cheia, e perder um
 * filtro é ruim — derrubar a tela de cadastro por causa dele seria pior.
 */
function safely<T>(action: () => T, fallback: T): T {
  if (typeof window === "undefined") return fallback;
  try {
    return action();
  } catch {
    return fallback;
  }
}

export function readUsersFilters(userId: string): UsersFilters {
  return safely(() => {
    const raw = window.localStorage.getItem(keyFor(userId));
    if (!raw) return EMPTY_USERS_FILTERS;
    const parsed = JSON.parse(raw) as Partial<Record<keyof UsersFilters, unknown>>;
    return {
      instanceId: typeof parsed.instanceId === "string" ? parsed.instanceId : "",
      role: isUserRole(parsed.role) ? parsed.role : "",
      departmentId: typeof parsed.departmentId === "string" ? parsed.departmentId : "",
    };
  }, EMPTY_USERS_FILTERS);
}

/** Sem nenhum filtro ativo a entrada é apagada — padrão não é preferência. */
export function saveUsersFilters(userId: string, filters: UsersFilters): void {
  safely(() => {
    const key = keyFor(userId);
    if (!hasActiveUsersFilters(filters)) {
      window.localStorage.removeItem(key);
      return;
    }
    window.localStorage.setItem(key, JSON.stringify(filters));
  }, undefined);
}

export function hasActiveUsersFilters(filters: UsersFilters): boolean {
  return filters.instanceId !== "" || filters.role !== "" || filters.departmentId !== "";
}

/**
 * Os três filtros combinam por E, e os dois multivalorados casam por
 * **contém**: um usuário tem vários chips e vários departamentos, então
 * filtrar por "CHIP ESCRITÓRIO" tem que mostrar quem tem esse chip entre os
 * dele, mesmo que tenha outros. Exigir igualdade da lista inteira só
 * encontraria quem tivesse exatamente aquele vínculo e mais nenhum —
 * justamente o contrário do que a pergunta "quem está ligado a este chip?"
 * quer saber.
 *
 * Consequência aceita: quem não tem chip nem departamento (o administrador
 * de acesso total é o caso) aparece na lista sem filtro e some assim que se
 * filtra por um chip ou departamento específico. Ele não está vinculado a
 * nenhum, e mostrá-lo em toda resposta faria a lista mentir.
 */
/**
 * Aceita o usuário sem os vínculos porque `GET /users` só os devolve para o
 * administrador: quem abre a lista pela chave `user.deactivate` recebe a
 * agenda interna, sem números nem departamentos. Ausente conta como lista
 * vazia — a barra de filtros nem é desenhada nesse caso, e tratar ausência
 * como "casa com tudo" faria o filtro mentir se um dia ela for.
 */
export function userMatchesFilters(
  user: Pick<UserWithAccessDto, "role"> &
    Partial<Pick<UserWithAccessDto, "whatsappInstanceIds" | "departmentIds">>,
  filters: UsersFilters,
): boolean {
  if (filters.instanceId && !(user.whatsappInstanceIds ?? []).includes(filters.instanceId)) {
    return false;
  }
  if (filters.role && user.role !== filters.role) return false;
  if (filters.departmentId && !(user.departmentIds ?? []).includes(filters.departmentId)) {
    return false;
  }
  return true;
}

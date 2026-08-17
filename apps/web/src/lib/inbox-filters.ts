"use client";

/**
 * Filtros da lista de conversas da Inbox, guardados no navegador por usuário.
 *
 * Ficam no navegador, e não na API, pelo mesmo motivo da barra lateral
 * recolhida e do rascunho do composer: é estado de apresentação de uma
 * máquina, não dado do atendimento. Nada de coluna em `User` nem de rota
 * gravando preferência de filtro.
 *
 * **A chave inclui o usuário.** Máquina compartilhada é o caso normal do
 * escritório: sem isso, quem entrasse depois encontraria a Inbox recortada
 * pelo filtro do colega — lista curta sem explicação nenhuma.
 *
 * **A leitura valida campo a campo.** Valor corrompido ou de versão antiga
 * vira o padrão daquele campo em silêncio; id de departamento, etiqueta ou
 * número que deixou de existir é podado por quem lê as listas (a Inbox),
 * porque só ela sabe o que ainda existe.
 */

import type { ConversationDto } from "@/lib/types";

/** O seletor "Todas" — atendimento, tipo e status num seletor só. */
export type QuickFilter =
  | "all"
  | "mine"
  | "unassigned"
  | "all_users"
  | "groups"
  | "individual"
  | "unread"
  | "archived"
  | "open"
  | "waiting_client"
  | "waiting_internal"
  | "resolved";

const QUICK_FILTERS: QuickFilter[] = [
  "all",
  "mine",
  "unassigned",
  "all_users",
  "groups",
  "individual",
  "unread",
  "archived",
  "open",
  "waiting_client",
  "waiting_internal",
  "resolved",
];

function isQuickFilter(value: unknown): value is QuickFilter {
  return typeof value === "string" && (QUICK_FILTERS as string[]).includes(value);
}

export interface InboxFilters {
  quick: QuickFilter;
  /** "" = todos — mesmo vazio dos seletores da barra. */
  instanceId: string;
  departmentId: string;
  tagId: string;
  search: string;
}

export const EMPTY_INBOX_FILTERS: InboxFilters = {
  quick: "all",
  instanceId: "",
  departmentId: "",
  tagId: "",
  search: "",
};

/** Mesmo prefixo do token (`zapdesk.`), como o rascunho e a barra lateral. */
const STORAGE_PREFIX = "zapdesk.inbox-filters.";

function keyFor(userId: string): string {
  return `${STORAGE_PREFIX}${userId}`;
}

/**
 * `localStorage` estoura em modo restrito ou com a cota cheia, e perder um
 * filtro é ruim — derrubar a Inbox por causa dele seria pior.
 */
function safely<T>(action: () => T, fallback: T): T {
  if (typeof window === "undefined") return fallback;
  try {
    return action();
  } catch {
    return fallback;
  }
}

export function readInboxFilters(userId: string): InboxFilters {
  return safely(() => {
    const raw = window.localStorage.getItem(keyFor(userId));
    if (!raw) return EMPTY_INBOX_FILTERS;
    const parsed = JSON.parse(raw) as Partial<Record<keyof InboxFilters, unknown>>;
    return {
      quick: isQuickFilter(parsed.quick) ? parsed.quick : "all",
      instanceId: typeof parsed.instanceId === "string" ? parsed.instanceId : "",
      departmentId: typeof parsed.departmentId === "string" ? parsed.departmentId : "",
      tagId: typeof parsed.tagId === "string" ? parsed.tagId : "",
      search: typeof parsed.search === "string" ? parsed.search : "",
    };
  }, EMPTY_INBOX_FILTERS);
}

/** Sem nenhum filtro ativo a entrada é apagada — padrão não é preferência. */
export function saveInboxFilters(userId: string, filters: InboxFilters): void {
  safely(() => {
    const key = keyFor(userId);
    if (!hasActiveInboxFilters(filters)) {
      window.localStorage.removeItem(key);
      return;
    }
    window.localStorage.setItem(key, JSON.stringify(filters));
  }, undefined);
}

export function hasActiveInboxFilters(filters: InboxFilters): boolean {
  return (
    filters.quick !== "all" ||
    filters.instanceId !== "" ||
    filters.departmentId !== "" ||
    filters.tagId !== "" ||
    filters.search.trim() !== ""
  );
}

/** Quantos filtros estão ativos — o aviso "lista filtrada" diz o número. */
export function countActiveInboxFilters(filters: InboxFilters): number {
  return [
    filters.quick !== "all",
    filters.instanceId !== "",
    filters.departmentId !== "",
    filters.tagId !== "",
    filters.search.trim() !== "",
  ].filter(Boolean).length;
}

/**
 * Termo que a consulta realmente usa: a API só recebe `q` com 2+ caracteres,
 * então abaixo disso a busca não recorta nada — nem aqui nem no servidor.
 */
function effectiveSearchTerm(filters: InboxFilters): string {
  const term = filters.search.trim();
  return term.length >= 2 ? term.toLowerCase() : "";
}

/**
 * A mesma pergunta que `GET /conversations` responde, feita no cliente: os
 * eventos de tempo real inserem e removem linha da lista sem recarregar
 * tudo, e para isso precisam saber se a conversa casa com o filtro ativo.
 *
 * A busca espelha exatamente o `q` da rota (título do WhatsApp, título da
 * equipe e código do cadastro, sem caixa) — espelhar menos removeria da
 * lista uma linha que o servidor devolveria; espelhar mais inventaria linha
 * que um F5 faria sumir.
 *
 * Isto é recorte de apresentação sobre o que já chegou pelo socket dentro do
 * acesso da pessoa — nenhum filtro daqui revela conversa fora do recorte.
 */
export function conversationMatchesFilters(
  conversation: ConversationDto,
  filters: InboxFilters,
  meId: string | null,
): boolean {
  // Arquivamento primeiro, e dos dois lados: a visão padrão só tem não
  // arquivadas e a "Arquivadas", só arquivadas — nunca misturadas. Sem
  // isto a mensagem nova numa conversa arquivada (o chip de backup recebe
  // o dia inteiro) a traria de volta para a lista de quem está com a
  // Inbox aberta, exatamente o que o arquivamento veio impedir.
  if ((conversation.archivedAt != null) !== (filters.quick === "archived")) return false;
  switch (filters.quick) {
    case "mine":
      if (!meId || conversation.assignedUser?.id !== meId) return false;
      break;
    case "unassigned":
      // Coletiva não é órfã: ela tem `assignedUser` nulo, mas o destino dela
      // foi decidido, e misturá-la aqui inflaria de volta a fila que a
      // marcação veio limpar.
      if (conversation.assignedUser !== null || conversation.assignedToAll) return false;
      break;
    case "all_users":
      if (!conversation.assignedToAll) return false;
      break;
    case "groups":
      if (conversation.type !== "group") return false;
      break;
    case "individual":
      if (conversation.type !== "individual") return false;
      break;
    case "unread":
      if (conversation.unreadCount === 0) return false;
      break;
    case "open":
    case "waiting_client":
    case "waiting_internal":
    case "resolved":
      if (conversation.status !== filters.quick) return false;
      break;
    case "all":
      break;
  }
  if (filters.instanceId && conversation.whatsappInstanceId !== filters.instanceId) return false;
  if (filters.departmentId && conversation.department?.id !== filters.departmentId) return false;
  if (filters.tagId && !conversation.tags.some((tag) => tag.id === filters.tagId)) return false;

  const term = effectiveSearchTerm(filters);
  if (term) {
    const haystack = [
      conversation.whatsappTitle,
      conversation.customTitle,
      conversation.externalReference,
    ];
    if (!haystack.some((value) => value?.toLowerCase().includes(term))) return false;
  }
  return true;
}

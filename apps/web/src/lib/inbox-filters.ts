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
 * pelo filtro do colega, lista curta sem explicação nenhuma.
 *
 * **A leitura valida campo a campo.** Valor corrompido ou de versão antiga
 * vira o padrão daquele campo em silêncio; id de departamento, etiqueta,
 * número ou pessoa que deixou de existir é podado por quem lê as listas (a
 * Inbox), porque só ela sabe o que ainda existe.
 *
 * ## A REGRA DE COMBINAÇÃO
 *
 * **OU dentro de um filtro, E entre filtros diferentes.** Marcar Contábil e
 * Fiscal mostra os dois; marcar Contábil e o status "Aberto" mostra só as
 * abertas do Contábil. Filtro sem nada marcado é "todos" naquele filtro.
 * O porquê completo, e o motivo de departamento e responsável terem virado
 * um filtro só, estão em `@azvchat/shared/inbox-filters`.
 */

import {
  ASSIGNMENT_ALL_USERS,
  ASSIGNMENT_UNASSIGNED,
  assignmentTokenIsValid,
  conversationStatusIsValid,
  departmentAssignmentToken,
  parseAssignmentTokens,
  type ConversationStatus,
  type ConversationTypeFilter,
} from "@azvchat/shared";
import type { ConversationDto } from "@/lib/types";

/**
 * A "visão" da lista: o que resta do antigo seletor único depois que
 * atendimento e status viraram filtros próprios. Continua sendo escolha
 * ÚNICA de propósito: arquivadas é um recorte disjunto (a lista normal nunca
 * as mistura) e "não lidas" é uma pergunta sobre o estado pessoal, não um
 * valor que some com outro.
 */
export type InboxView = "all" | "unread" | "archived";

const VIEWS: InboxView[] = ["all", "unread", "archived"];

function isView(value: unknown): value is InboxView {
  return typeof value === "string" && (VIEWS as string[]).includes(value);
}

export interface InboxFilters {
  view: InboxView;
  search: string;
  /**
   * O filtro unificado de departamento e responsável, em tokens
   * (`none`, `all_users`, `no_department`, `dept:<id>`, `user:<id>`).
   * Tudo que está aqui SOMA, atravessando os três blocos da lista.
   */
  assignment: string[];
  instanceIds: string[];
  tagIds: string[];
  statuses: ConversationStatus[];
  types: ConversationTypeFilter[];
  /** Característica do cliente no Azevedo-OS; `none` é "sem informação". */
  taxRegime: string[];
  payroll: string[];
  /** Atalho do aviso: só conversas sem empresa vinculada. */
  unlinked: boolean;
  /**
   * Só as ATRASADAS — o atalho do card "Atrasados agora" do dashboard. Quem
   * decide o que é atraso é o servidor (não resolvida, última mensagem do
   * cliente, esperando além do limite em tempo de expediente), então este
   * campo é um pedido, e não um critério que a tela saiba avaliar sozinha.
   */
  overdue: boolean;
}

export const EMPTY_INBOX_FILTERS: InboxFilters = {
  view: "all",
  search: "",
  assignment: [],
  instanceIds: [],
  tagIds: [],
  statuses: [],
  types: [],
  taxRegime: [],
  payroll: [],
  unlinked: false,
  overdue: false,
};

/**
 * Junta a mudança ao estado atual mantendo a exclusão entre o recorte por
 * empresa e o "sem empresa vinculada": a conversa sem vínculo não tem regime
 * nenhum, e a API recusa a combinação. Quem foi tocado por último vence, para
 * o clique fazer exatamente o que promete em vez de não fazer nada.
 */
export function mergeInboxFilters(current: InboxFilters, patch: Partial<InboxFilters>): InboxFilters {
  const next = { ...current, ...patch };
  if (patch.unlinked === true) return { ...next, taxRegime: [], payroll: [] };
  if (patch.taxRegime?.length || patch.payroll?.length) return { ...next, unlinked: false };
  return next;
}

/** O recorte que só o servidor sabe avaliar está ligado? */
export function hasCompanyFilter(filters: InboxFilters): boolean {
  return filters.taxRegime.length > 0 || filters.payroll.length > 0 || filters.unlinked;
}

/**
 * Recortes que a tela NÃO consegue avaliar sozinha, e que por isso impedem o
 * tempo real de INSERIR linha nova na lista. O regime do cliente mora no
 * Azevedo-OS; o atraso depende do expediente e da direção da última mensagem.
 * Chutar que a conversa que acabou de chegar casa mostraria linha errada até
 * o próximo F5. Linha que já veio do servidor continua sendo atualizada.
 */
export function hasServerOnlyFilter(filters: InboxFilters): boolean {
  return hasCompanyFilter(filters) || filters.overdue;
}

/** Mesmo prefixo do token (`zapdesk.`), como o rascunho e a barra lateral. */
const STORAGE_PREFIX = "zapdesk.inbox-filters.";

function keyFor(userId: string): string {
  return `${STORAGE_PREFIX}${userId}`;
}

/**
 * `localStorage` estoura em modo restrito ou com a cota cheia, e perder um
 * filtro é ruim; derrubar a Inbox por causa dele seria pior.
 */
function safely<T>(action: () => T, fallback: T): T {
  if (typeof window === "undefined") return fallback;
  try {
    return action();
  } catch {
    return fallback;
  }
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
 * O formato antigo guardava UM valor por filtro (`instanceId: "abc"`), e o
 * antigo seletor `quick` misturava atendimento, tipo, status e visão numa
 * escolha só. Quem já tinha filtro salvo não pode perdê-lo na primeira
 * abertura depois do deploy: cada valor único vira lista de um item, e o
 * `quick` é traduzido para o campo que passou a responder por ele.
 *
 * Isto é código de transição e pode sair quando ninguém mais tiver o formato
 * velho no navegador. Até lá, descartar em vez de converter apagaria em
 * silêncio o recorte que a pessoa montou.
 */
function readLegacy(parsed: Record<string, unknown>, atual: InboxFilters): InboxFilters {
  const migrado = { ...atual };
  const unico = (valor: unknown): string[] =>
    typeof valor === "string" && valor.length > 0 ? [valor] : [];

  if (migrado.instanceIds.length === 0) migrado.instanceIds = unico(parsed.instanceId);
  if (migrado.tagIds.length === 0) migrado.tagIds = unico(parsed.tagId);
  if (migrado.taxRegime.length === 0) migrado.taxRegime = unico(parsed.taxRegime);
  if (migrado.payroll.length === 0) migrado.payroll = unico(parsed.payroll);
  if (migrado.assignment.length === 0 && typeof parsed.departmentId === "string" && parsed.departmentId) {
    migrado.assignment = [departmentAssignmentToken(parsed.departmentId)];
  }

  const quick = typeof parsed.quick === "string" ? parsed.quick : null;
  if (!quick || quick === "all") return migrado;
  if (quick === "archived" || quick === "unread") {
    return { ...migrado, view: quick };
  }
  if (quick === "groups" || quick === "individual") {
    return { ...migrado, types: [quick === "groups" ? "group" : "individual"] };
  }
  if (conversationStatusIsValid(quick)) {
    return { ...migrado, statuses: [quick] };
  }
  if (quick === "unassigned") {
    return { ...migrado, assignment: [...migrado.assignment, ASSIGNMENT_UNASSIGNED] };
  }
  if (quick === "all_users") {
    return { ...migrado, assignment: [...migrado.assignment, ASSIGNMENT_ALL_USERS] };
  }
  // "mine" dependia de saber quem está logado, e a leitura não sabe. Ele vira
  // "todas": melhor abrir a lista inteira do que abrir a de outra pessoa.
  return migrado;
}

export function readInboxFilters(userId: string): InboxFilters {
  return safely(() => {
    const raw = window.localStorage.getItem(keyFor(userId));
    if (!raw) return EMPTY_INBOX_FILTERS;
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const base: InboxFilters = {
      view: isView(parsed.view) ? parsed.view : "all",
      search: typeof parsed.search === "string" ? parsed.search : "",
      assignment: readList(parsed.assignment, assignmentTokenIsValid),
      instanceIds: readList(parsed.instanceIds, () => true),
      tagIds: readList(parsed.tagIds, () => true),
      statuses: readList(parsed.statuses, conversationStatusIsValid) as ConversationStatus[],
      types: readList(parsed.types, (item) => item === "individual" || item === "group") as ConversationTypeFilter[],
      taxRegime: readList(parsed.taxRegime, () => true),
      payroll: readList(parsed.payroll, () => true),
      unlinked: parsed.unlinked === true,
      overdue: parsed.overdue === true,
    };
    return readLegacy(parsed, base);
  }, EMPTY_INBOX_FILTERS);
}

/** Sem nenhum filtro ativo a entrada é apagada: padrão não é preferência. */
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

/** Cada filtro ativo, com o rótulo do que ele recorta e como zerar só ele. */
export const INBOX_FILTER_FIELDS = [
  "view",
  "search",
  "assignment",
  "instanceIds",
  "tagIds",
  "statuses",
  "types",
  "taxRegime",
  "payroll",
  "unlinked",
  "overdue",
] as const;
export type InboxFilterField = (typeof INBOX_FILTER_FIELDS)[number];

export function filterFieldIsActive(filters: InboxFilters, field: InboxFilterField): boolean {
  switch (field) {
    case "view":
      return filters.view !== "all";
    case "search":
      return filters.search.trim() !== "";
    case "unlinked":
      return filters.unlinked;
    case "overdue":
      return filters.overdue;
    default:
      return filters[field].length > 0;
  }
}

/** Zera UM filtro sem abrir a lista dele (o "x" do resumo do recorte). */
export function clearFilterField(filters: InboxFilters, field: InboxFilterField): InboxFilters {
  switch (field) {
    case "view":
      return { ...filters, view: "all" };
    case "search":
      return { ...filters, search: "" };
    case "unlinked":
      return { ...filters, unlinked: false };
    case "overdue":
      return { ...filters, overdue: false };
    default:
      return { ...filters, [field]: [] };
  }
}

export function hasActiveInboxFilters(filters: InboxFilters): boolean {
  return INBOX_FILTER_FIELDS.some((field) => filterFieldIsActive(filters, field));
}

/** Quantos filtros estão ativos: o aviso "lista filtrada" diz o número. */
export function countActiveInboxFilters(filters: InboxFilters): number {
  return INBOX_FILTER_FIELDS.filter((field) => filterFieldIsActive(filters, field)).length;
}

/**
 * Termo que a consulta realmente usa: a API só recebe `q` com 2+ caracteres,
 * então abaixo disso a busca não recorta nada, nem aqui nem no servidor.
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
 * **Espelha a regra do servidor: OU dentro de cada filtro, E entre filtros.**
 * Cada bloco abaixo é um filtro, e basta um deles reprovar para a conversa
 * sair; dentro do bloco, um valor marcado que case já aprova. Espelhar menos
 * removeria da lista uma linha que o servidor devolveria; espelhar mais
 * inventaria linha que um F5 faria sumir.
 *
 * Isto é recorte de apresentação sobre o que já chegou pelo socket dentro do
 * acesso da pessoa: nenhum filtro daqui revela conversa fora do recorte.
 *
 * **Regime e folha ficam de fora, e não por esquecimento.** Eles moram no
 * Azevedo-OS, em outro banco, e a conversa que chega pelo socket não carrega
 * o dado: não há como responder aqui se ela casa. Fingir que casa colocaria
 * na lista filtrada a conversa de um cliente de outro regime, e o F5 a faria
 * sumir sem explicação. Quem trata isso é o `inbox-shell`, que para de
 * INSERIR linha nova enquanto o recorte por empresa está ligado (ver
 * `hasCompanyFilter`); atualizar linha que já está na lista continua valendo,
 * porque ela já passou pelo servidor.
 */
export function conversationMatchesFilters(
  conversation: ConversationDto,
  filters: InboxFilters,
  meId: string | null,
  /**
   * Não lidas DESTA pessoa. Chega como parâmetro porque o contador é por
   * usuário e não vive no DTO: o mesmo DTO vai por socket para todo mundo
   * que enxerga a conversa.
   */
  unreadCount = 0,
): boolean {
  // Arquivamento primeiro, e dos dois lados: a visão padrão só tem não
  // arquivadas e a "Arquivadas", só arquivadas, nunca misturadas. Sem isto a
  // mensagem nova numa conversa arquivada (o chip de backup recebe o dia
  // inteiro) a traria de volta para a lista de quem está com a Inbox aberta,
  // exatamente o que o arquivamento veio impedir.
  if ((conversation.archivedAt != null) !== (filters.view === "archived")) return false;
  if (filters.view === "unread" && unreadCount === 0) return false;

  if (filters.statuses.length > 0 && !filters.statuses.includes(conversation.status)) return false;
  if (filters.types.length > 0 && !filters.types.includes(conversation.type)) return false;
  if (filters.instanceIds.length > 0 && !filters.instanceIds.includes(conversation.whatsappInstanceId)) {
    return false;
  }
  if (filters.tagIds.length > 0 && !conversation.tags.some((tag) => filters.tagIds.includes(tag.id))) {
    return false;
  }

  // O ATRASO não é avaliado aqui, de propósito: ele depende do expediente e
  // da direção da última mensagem, que o DTO não carrega. Quem decide é o
  // servidor — por isso `hasServerOnlyFilter` impede a INSERÇÃO de linha nova
  // enquanto o filtro está ligado, e a linha que já veio de lá segue sendo
  // atualizada (a resposta da equipe aparece na hora; a saída dela da lista
  // acontece na próxima carga).

  // O filtro unificado: basta UM item marcado casar. É aqui que "o Contábil
  // inteiro mais a fulana" soma em vez de cruzar, e por isso os ramos são
  // avaliados com OU e não em sequência de recusas.
  if (filters.assignment.length > 0) {
    const alvo = parseAssignmentTokens(filters.assignment);
    const orfa = conversation.assignedUser === null && !conversation.assignedToAll;
    const casa =
      (alvo.unassigned && orfa) ||
      (alvo.allUsers && conversation.assignedToAll) ||
      (alvo.noDepartment && conversation.department === null) ||
      (conversation.department !== null && alvo.departmentIds.includes(conversation.department.id)) ||
      (conversation.assignedUser !== null && alvo.userIds.includes(conversation.assignedUser.id));
    if (!casa) return false;
  }
  // `meId` continua no contrato porque a Inbox marca "Eu" na lista de
  // usuários, e quem chama já resolve isso em token de usuário.
  void meId;

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

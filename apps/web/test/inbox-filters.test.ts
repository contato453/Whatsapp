import { beforeEach, describe, expect, it } from "vitest";
import {
  EMPTY_INBOX_FILTERS,
  conversationMatchesFilters,
  countActiveInboxFilters,
  hasActiveInboxFilters,
  hasCompanyFilter,
  mergeInboxFilters,
  readInboxFilters,
  saveInboxFilters,
  type InboxFilters,
} from "@/lib/inbox-filters";
import type { ConversationDto } from "@/lib/types";

/**
 * O que estes testes fixam: o filtro montado pelo atendente sobrevive ao F5,
 * volta para o usuário certo, e valor corrompido ou de versão antiga vira o
 * padrão em silêncio — nunca uma Inbox vazia sem explicação, nunca um erro.
 *
 * E o casamento de conversa com filtro (usado pelos eventos de socket)
 * espelha o recorte do servidor: espelhar menos removeria da lista uma linha
 * que um F5 traria de volta; espelhar mais inventaria linha que ele sumiria.
 */

/** `localStorage` de mentira, suficiente para o módulo (que só usa isto). */
function fakeStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    key: (index: number) => [...map.keys()][index] ?? null,
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => void map.set(key, value),
    removeItem: (key: string) => void map.delete(key),
    clear: () => map.clear(),
  } as Storage;
}

const ANA = "user-ana";
const BRUNO = "user-bruno";

const FILTRADO: InboxFilters = {
  quick: "mine",
  instanceId: "instancia-1",
  departmentId: "depto-comercial",
  tagId: "etiqueta-urgente",
  search: "empresa",
  taxRegime: "simples",
  payroll: "folha_fixa",
  unlinked: false,
};

function conversa(overrides: Partial<ConversationDto> = {}): ConversationDto {
  return {
    id: "conversa-1",
    whatsappInstanceId: "instancia-1",
    instanceName: "Comercial",
    instanceStatus: "connected",
    externalChatId: "5511999@s.whatsapp.net",
    type: "group",
    title: "EMPRESA 001 - Geral",
    customTitle: null,
    whatsappTitle: "EMPRESA 001 - Geral",
    hasAvatar: false,
    status: "open",
    assignedUser: null,
    assignedToAll: false,
    department: null,
    tags: [],
    unreadCount: 0,
    archivedAt: null,
    archivedBy: null,
    lastMessageAt: null,
    lastMessagePreview: null,
    externalReference: null,
    externalSource: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("filtros da Inbox no navegador", () => {
  beforeEach(() => {
    // O módulo lê `window.localStorage`; em ambiente node ele não existe.
    globalThis.window = { localStorage: fakeStorage() } as unknown as Window & typeof globalThis;
  });

  it("sem nada guardado devolve o padrão", () => {
    expect(readInboxFilters(ANA)).toEqual(EMPTY_INBOX_FILTERS);
  });

  it("guarda e devolve o recorte completo, por usuário", () => {
    saveInboxFilters(ANA, FILTRADO);
    expect(readInboxFilters(ANA)).toEqual(FILTRADO);
    // Máquina compartilhada: o filtro de uma pessoa não vaza para a outra.
    expect(readInboxFilters(BRUNO)).toEqual(EMPTY_INBOX_FILTERS);
  });

  it("sem filtro ativo apaga a entrada — padrão não é preferência", () => {
    saveInboxFilters(ANA, FILTRADO);
    saveInboxFilters(ANA, EMPTY_INBOX_FILTERS);
    expect(window.localStorage.length).toBe(0);
  });

  it("valor corrompido é tratado como ausente, sem estourar", () => {
    window.localStorage.setItem(`zapdesk.inbox-filters.${ANA}`, "{isto não é json");
    expect(readInboxFilters(ANA)).toEqual(EMPTY_INBOX_FILTERS);
  });

  it("campo de tipo errado ou desconhecido volta ao padrão daquele campo", () => {
    window.localStorage.setItem(
      `zapdesk.inbox-filters.${ANA}`,
      JSON.stringify({ quick: "um-filtro-que-não-existe", departmentId: 42, tagId: "etiqueta-1" }),
    );
    expect(readInboxFilters(ANA)).toEqual({
      ...EMPTY_INBOX_FILTERS,
      tagId: "etiqueta-1",
    });
  });

  it("busca só de espaços não conta como filtro ativo", () => {
    expect(hasActiveInboxFilters({ ...EMPTY_INBOX_FILTERS, search: "   " })).toBe(false);
    expect(hasActiveInboxFilters({ ...EMPTY_INBOX_FILTERS, search: "empresa" })).toBe(true);
    expect(hasActiveInboxFilters(EMPTY_INBOX_FILTERS)).toBe(false);
  });
});

describe("casamento de conversa com o filtro ativo (tempo real)", () => {
  it("sem filtro ativo tudo casa", () => {
    expect(conversationMatchesFilters(conversa(), EMPTY_INBOX_FILTERS, ANA)).toBe(true);
  });

  it("Minhas exige a conversa atribuída a quem olha", () => {
    const filtro: InboxFilters = { ...EMPTY_INBOX_FILTERS, quick: "mine" };
    const minha = conversa({
      assignedUser: { id: ANA, name: "Ana", role: "agent", status: "active", hasAvatar: false },
    });
    expect(conversationMatchesFilters(minha, filtro, ANA)).toBe(true);
    expect(conversationMatchesFilters(minha, filtro, BRUNO)).toBe(false);
    expect(conversationMatchesFilters(conversa(), filtro, ANA)).toBe(false);
  });

  it("status, tipo e não lidas seguem o campo atual da conversa", () => {
    expect(
      conversationMatchesFilters(conversa({ status: "resolved" }), { ...EMPTY_INBOX_FILTERS, quick: "resolved" }, ANA),
    ).toBe(true);
    expect(
      conversationMatchesFilters(conversa({ status: "open" }), { ...EMPTY_INBOX_FILTERS, quick: "resolved" }, ANA),
    ).toBe(false);
    expect(
      conversationMatchesFilters(conversa({ type: "individual" }), { ...EMPTY_INBOX_FILTERS, quick: "groups" }, ANA),
    ).toBe(false);
    expect(
      conversationMatchesFilters(conversa({ unreadCount: 3 }), { ...EMPTY_INBOX_FILTERS, quick: "unread" }, ANA),
    ).toBe(true);
    expect(
      conversationMatchesFilters(conversa({ unreadCount: 0 }), { ...EMPTY_INBOX_FILTERS, quick: "unread" }, ANA),
    ).toBe(false);
  });

  it("número, departamento e etiqueta recortam pelos ids", () => {
    const alvo = conversa({
      department: {
        id: "depto-comercial",
        name: "Comercial",
        description: null,
        color: "#123456",
        defaultAssigneeId: null,
      },
      tags: [{ id: "etiqueta-urgente", name: "Urgente", color: "#ff0000", isGeneral: true, departments: [] }],
    });
    const filtro: InboxFilters = {
      ...EMPTY_INBOX_FILTERS,
      instanceId: "instancia-1",
      departmentId: "depto-comercial",
      tagId: "etiqueta-urgente",
    };
    expect(conversationMatchesFilters(alvo, filtro, ANA)).toBe(true);
    // Conversa sem departamento não casa com filtro de departamento.
    expect(conversationMatchesFilters(conversa(), filtro, ANA)).toBe(false);
    expect(
      conversationMatchesFilters({ ...alvo, whatsappInstanceId: "instancia-2" }, filtro, ANA),
    ).toBe(false);
  });

  it("arquivada nunca casa com a visão padrão, e é a única que casa com Arquivadas", () => {
    const arquivada = conversa({ archivedAt: "2026-08-16T12:00:00.000Z" });
    // Mensagem nova no chip de backup não pode devolver a conversa à lista.
    expect(conversationMatchesFilters(arquivada, EMPTY_INBOX_FILTERS, ANA)).toBe(false);
    const visaoArquivadas: InboxFilters = { ...EMPTY_INBOX_FILTERS, quick: "archived" };
    expect(conversationMatchesFilters(arquivada, visaoArquivadas, ANA)).toBe(true);
    expect(conversationMatchesFilters(conversa(), visaoArquivadas, ANA)).toBe(false);
  });

  it("a busca espelha o q do servidor: títulos e código do cadastro, sem caixa", () => {
    const filtro: InboxFilters = { ...EMPTY_INBOX_FILTERS, search: "empresa 001" };
    expect(conversationMatchesFilters(conversa(), filtro, ANA)).toBe(true);
    expect(
      conversationMatchesFilters(
        conversa({ whatsappTitle: "Outro grupo", customTitle: "Apelido da EMPRESA 001" }),
        filtro,
        ANA,
      ),
    ).toBe(true);
    expect(
      conversationMatchesFilters(
        conversa({ whatsappTitle: "Outro grupo", externalReference: "EMPRESA 001" }),
        filtro,
        ANA,
      ),
    ).toBe(true);
    expect(
      conversationMatchesFilters(conversa({ whatsappTitle: "Outro grupo" }), filtro, ANA),
    ).toBe(false);
    // Abaixo de 2 caracteres a API nem recebe o q — aqui também não recorta.
    expect(
      conversationMatchesFilters(conversa({ whatsappTitle: "Outro grupo" }), { ...EMPTY_INBOX_FILTERS, search: "x" }, ANA),
    ).toBe(true);
  });
});

/**
 * Atendimento coletivo ("@todos"): a conversa fica sem responsável por
 * decisão, e não por falta de dono. O filtro do tempo real precisa saber
 * separar as duas — senão a lista "Sem responsável" volta a misturar a fila
 * de verdade com os grupos que já têm destino.
 */
describe("@todos nos filtros da lista", () => {
  it('"Sem responsável" não traz a coletiva', () => {
    const filtro: InboxFilters = { ...EMPTY_INBOX_FILTERS, quick: "unassigned" };
    expect(conversationMatchesFilters(conversa(), filtro, ANA)).toBe(true);
    expect(conversationMatchesFilters(conversa({ assignedToAll: true }), filtro, ANA)).toBe(false);
  });

  it('"@todos" traz só as coletivas', () => {
    const filtro: InboxFilters = { ...EMPTY_INBOX_FILTERS, quick: "all_users" };
    expect(conversationMatchesFilters(conversa({ assignedToAll: true }), filtro, ANA)).toBe(true);
    expect(conversationMatchesFilters(conversa(), filtro, ANA)).toBe(false);
  });
});

describe("recorte por característica do cliente (Azevedo-OS)", () => {
  it("persiste junto com os demais, na mesma entrada do usuário", () => {
    saveInboxFilters(ANA, { ...EMPTY_INBOX_FILTERS, taxRegime: "simples", payroll: "folha_fixa" });
    const lido = readInboxFilters(ANA);
    expect(lido.taxRegime).toBe("simples");
    expect(lido.payroll).toBe("folha_fixa");
    // Sem mecanismo próprio: é a mesma chave dos outros filtros.
    expect(readInboxFilters(BRUNO).taxRegime).toBe("");
  });

  it("valor corrompido no storage vira o padrão, sem derrubar o resto", () => {
    window.localStorage.setItem(
      `zapdesk.inbox-filters.${ANA}`,
      JSON.stringify({ quick: "mine", taxRegime: 42, unlinked: "sim" }),
    );
    const lido = readInboxFilters(ANA);
    expect(lido.quick).toBe("mine");
    expect(lido.taxRegime).toBe("");
    expect(lido.unlinked).toBe(false);
  });

  it("conta como filtro ativo e some do storage quando limpo", () => {
    const comRegime = { ...EMPTY_INBOX_FILTERS, taxRegime: "simples" };
    expect(hasActiveInboxFilters(comRegime)).toBe(true);
    expect(countActiveInboxFilters(comRegime)).toBe(1);
    saveInboxFilters(ANA, comRegime);
    saveInboxFilters(ANA, EMPTY_INBOX_FILTERS);
    expect(window.localStorage.getItem(`zapdesk.inbox-filters.${ANA}`)).toBeNull();
  });

  it("os três somam com os antigos, nunca no lugar deles", () => {
    expect(countActiveInboxFilters(FILTRADO)).toBe(7);
  });

  it("'sem empresa' e o recorte por regime se excluem — o último vence", () => {
    // A API recusa a combinação (conversa sem vínculo não tem regime), então
    // o clique tem que desligar o outro em vez de não fazer nada.
    const comRegime = mergeInboxFilters(EMPTY_INBOX_FILTERS, { taxRegime: "simples" });
    const semVinculo = mergeInboxFilters(comRegime, { unlinked: true });
    expect(semVinculo.unlinked).toBe(true);
    expect(semVinculo.taxRegime).toBe("");

    const deVolta = mergeInboxFilters(semVinculo, { payroll: "folha_fixa" });
    expect(deVolta.unlinked).toBe(false);
    expect(deVolta.payroll).toBe("folha_fixa");
  });

  it("mudança que não é de empresa não mexe no recorte já escolhido", () => {
    const atual = { ...EMPTY_INBOX_FILTERS, taxRegime: "simples" };
    expect(mergeInboxFilters(atual, { search: "azevedo" })).toEqual({
      ...atual,
      search: "azevedo",
    });
  });

  it("hasCompanyFilter reconhece os três estados", () => {
    expect(hasCompanyFilter(EMPTY_INBOX_FILTERS)).toBe(false);
    expect(hasCompanyFilter({ ...EMPTY_INBOX_FILTERS, taxRegime: "simples" })).toBe(true);
    expect(hasCompanyFilter({ ...EMPTY_INBOX_FILTERS, payroll: "none" })).toBe(true);
    expect(hasCompanyFilter({ ...EMPTY_INBOX_FILTERS, unlinked: true })).toBe(true);
  });

  it("o casamento no cliente ignora regime e folha — só o servidor sabe", () => {
    // A conversa que chega pelo socket não carrega o regime do cliente: ele
    // mora no outro banco. Se esta regra passasse a "não casa", o tempo real
    // apagaria da lista filtrada linha que o servidor tinha devolvido.
    const conversa1 = conversa();
    expect(
      conversationMatchesFilters(conversa1, { ...EMPTY_INBOX_FILTERS, taxRegime: "simples" }, null),
    ).toBe(true);
    expect(
      conversationMatchesFilters(conversa1, { ...EMPTY_INBOX_FILTERS, unlinked: true }, null),
    ).toBe(true);
  });
});

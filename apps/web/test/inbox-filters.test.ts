import { beforeEach, describe, expect, it } from "vitest";
import {
  EMPTY_INBOX_FILTERS,
  conversationMatchesFilters,
  clearFilterField,
  countActiveInboxFilters,
  filterFieldIsActive,
  hasActiveInboxFilters,
  hasCompanyFilter,
  mergeInboxFilters,
  readInboxFilters,
  saveInboxFilters,
  type InboxFilters,
} from "@/lib/inbox-filters";
import type { ConversationDto, DepartmentDto, TagDto, UserDirectoryDto } from "@/lib/types";

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

const DEPTO = "55555555-5555-4555-8555-555555555555";
const DEPTO_2 = "66666666-6666-4666-8666-666666666666";
const PESSOA = "77777777-7777-4777-8777-777777777777";

const FILTRADO: InboxFilters = {
  view: "unread",
  search: "empresa",
  assignment: [`dept:${DEPTO}`, `user:${PESSOA}`],
  instanceIds: ["instancia-1", "instancia-2"],
  tagIds: ["etiqueta-urgente"],
  statuses: ["open", "waiting_client"],
  types: ["group"],
  taxRegime: ["simples"],
  payroll: ["folha_fixa"],
  unlinked: false,
  overdue: false,
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

/** Departamento e etiqueta de mentira, com os campos que o DTO exige. */
function depto(id: string, name: string): DepartmentDto {
  return { id, name, color: "#000000", description: null, defaultAssigneeId: null };
}

function pessoa(id: string, name: string): UserDirectoryDto {
  return { id, name, role: "agent", status: "active", hasAvatar: false };
}

function etiqueta(id: string): TagDto {
  return { id, name: "Urgente", color: "#000000", isGeneral: true, departments: [] };
}

describe("filtros da Inbox no navegador", () => {
  beforeEach(() => {
    // O módulo lê `window.localStorage`; em ambiente node ele não existe.
    globalThis.window = { localStorage: fakeStorage() } as unknown as Window & typeof globalThis;
  });

  it("sem nada guardado devolve o padrão", () => {
    expect(readInboxFilters(ANA)).toEqual(EMPTY_INBOX_FILTERS);
  });

  it("guarda e devolve o recorte múltiplo inteiro, por usuário", () => {
    saveInboxFilters(ANA, FILTRADO);
    expect(readInboxFilters(ANA)).toEqual(FILTRADO);
    // Máquina compartilhada: o filtro de uma pessoa não vaza para a outra.
    expect(readInboxFilters(BRUNO)).toEqual(EMPTY_INBOX_FILTERS);
  });

  it("sem filtro ativo apaga a entrada — padrão não é preferência", () => {
    saveInboxFilters(ANA, FILTRADO);
    saveInboxFilters(ANA, EMPTY_INBOX_FILTERS);
    expect(readInboxFilters(ANA)).toEqual(EMPTY_INBOX_FILTERS);
  });

  it("item corrompido na lista é descartado sem levar o resto junto", () => {
    window.localStorage.setItem(
      `zapdesk.inbox-filters.${ANA}`,
      JSON.stringify({
        view: "arquivadinha",
        statuses: ["open", "inventado", 42],
        assignment: [`dept:${DEPTO}`, "coisa-torta"],
        tagIds: ["a", null],
      }),
    );
    const lido = readInboxFilters(ANA);
    expect(lido.view).toBe("all");
    expect(lido.statuses).toEqual(["open"]);
    expect(lido.assignment).toEqual([`dept:${DEPTO}`]);
    expect(lido.tagIds).toEqual(["a"]);
  });

  it("conta cada filtro ativo uma vez, e limpa um sem mexer nos outros", () => {
    expect(countActiveInboxFilters(FILTRADO)).toBe(9);
    expect(filterFieldIsActive(FILTRADO, "statuses")).toBe(true);
    const semStatus = clearFilterField(FILTRADO, "statuses");
    expect(semStatus.statuses).toEqual([]);
    expect(semStatus.assignment).toEqual(FILTRADO.assignment);
    expect(hasActiveInboxFilters(semStatus)).toBe(true);
    expect(hasActiveInboxFilters(EMPTY_INBOX_FILTERS)).toBe(false);
  });
});

describe("formato antigo, de valor único", () => {
  beforeEach(() => {
    globalThis.window = { localStorage: fakeStorage() } as unknown as Window & typeof globalThis;
  });

  function guardarAntigo(valor: Record<string, unknown>) {
    window.localStorage.setItem(`zapdesk.inbox-filters.${ANA}`, JSON.stringify(valor));
  }

  it("cada valor único vira lista de um item, em vez de ser descartado", () => {
    guardarAntigo({
      instanceId: "instancia-1",
      tagId: "etiqueta-1",
      departmentId: DEPTO,
      taxRegime: "simples",
      payroll: "folha_fixa",
    });
    const lido = readInboxFilters(ANA);
    expect(lido.instanceIds).toEqual(["instancia-1"]);
    expect(lido.tagIds).toEqual(["etiqueta-1"]);
    expect(lido.assignment).toEqual([`dept:${DEPTO}`]);
    expect(lido.taxRegime).toEqual(["simples"]);
    expect(lido.payroll).toEqual(["folha_fixa"]);
  });

  it("o antigo seletor único vira o campo que passou a responder por ele", () => {
    guardarAntigo({ quick: "resolved" });
    expect(readInboxFilters(ANA).statuses).toEqual(["resolved"]);

    guardarAntigo({ quick: "groups" });
    expect(readInboxFilters(ANA).types).toEqual(["group"]);

    guardarAntigo({ quick: "archived" });
    expect(readInboxFilters(ANA).view).toBe("archived");

    guardarAntigo({ quick: "unassigned" });
    expect(readInboxFilters(ANA).assignment).toEqual(["none"]);
  });

  it("o antigo 'minhas' abre a lista inteira, e não a de outra pessoa", () => {
    // A leitura do storage não sabe quem está logado, então converter "mine"
    // exigiria adivinhar o usuário. Abrir tudo é o erro seguro.
    guardarAntigo({ quick: "mine" });
    expect(readInboxFilters(ANA)).toEqual(EMPTY_INBOX_FILTERS);
  });
});

describe("a regra de combinação: OU dentro, E entre", () => {
  const eu = "user-ana";

  it("dois status marcados somam", () => {
    const filtros: InboxFilters = { ...EMPTY_INBOX_FILTERS, statuses: ["open", "resolved"] };
    expect(conversationMatchesFilters(conversa({ status: "open" }), filtros, eu)).toBe(true);
    expect(conversationMatchesFilters(conversa({ status: "resolved" }), filtros, eu)).toBe(true);
    expect(conversationMatchesFilters(conversa({ status: "waiting_client" }), filtros, eu)).toBe(false);
  });

  it("dois números marcados somam", () => {
    const filtros: InboxFilters = { ...EMPTY_INBOX_FILTERS, instanceIds: ["a", "b"] };
    expect(conversationMatchesFilters(conversa({ whatsappInstanceId: "b" }), filtros, eu)).toBe(true);
    expect(conversationMatchesFilters(conversa({ whatsappInstanceId: "c" }), filtros, eu)).toBe(false);
  });

  it("O CASO DECISIVO: departamento mais pessoa de OUTRO departamento soma", () => {
    // Se isto virar interseção, o resultado fica vazio e o filtro parece
    // quebrado. É a diferença entre um filtro unificado e dois separados.
    const filtros: InboxFilters = {
      ...EMPTY_INBOX_FILTERS,
      assignment: [`dept:${DEPTO}`, `user:${PESSOA}`],
    };
    const doDepartamento = conversa({
      department: depto(DEPTO, "CS"),
      assignedUser: null,
    });
    const daPessoa = conversa({
      department: depto(DEPTO_2, "Fiscal"),
      assignedUser: pessoa(PESSOA, "Damiana"),
    });
    const deNenhum = conversa({ department: depto(DEPTO_2, "Fiscal") });

    expect(conversationMatchesFilters(doDepartamento, filtros, eu)).toBe(true);
    expect(conversationMatchesFilters(daPessoa, filtros, eu)).toBe(true);
    expect(conversationMatchesFilters(deNenhum, filtros, eu)).toBe(false);
  });

  it("'sem responsável' marcado junto com uma pessoa mostra as duas coisas", () => {
    const filtros: InboxFilters = { ...EMPTY_INBOX_FILTERS, assignment: ["none", `user:${PESSOA}`] };
    const orfa = conversa({ assignedUser: null, assignedToAll: false });
    const coletiva = conversa({ assignedUser: null, assignedToAll: true });
    const dela = conversa({
      assignedUser: pessoa(PESSOA, "Damiana"),
    });
    expect(conversationMatchesFilters(orfa, filtros, eu)).toBe(true);
    expect(conversationMatchesFilters(dela, filtros, eu)).toBe(true);
    // Coletiva não é órfã: ela tem destino decidido.
    expect(conversationMatchesFilters(coletiva, filtros, eu)).toBe(false);
  });

  it("filtros DIFERENTES cruzam por E", () => {
    const filtros: InboxFilters = {
      ...EMPTY_INBOX_FILTERS,
      assignment: [`dept:${DEPTO}`],
      statuses: ["open"],
    };
    const dentro = conversa({ department: depto(DEPTO, "CS"), status: "open" });
    const foraPeloStatus = conversa({
      department: depto(DEPTO, "CS"),
      status: "resolved",
    });
    expect(conversationMatchesFilters(dentro, filtros, eu)).toBe(true);
    expect(conversationMatchesFilters(foraPeloStatus, filtros, eu)).toBe(false);
  });

  it("filtro sem nada marcado é 'todos', nunca 'nenhum'", () => {
    expect(conversationMatchesFilters(conversa(), EMPTY_INBOX_FILTERS, eu)).toBe(true);
  });

  it("etiqueta: basta a conversa ter UMA das marcadas", () => {
    const filtros: InboxFilters = { ...EMPTY_INBOX_FILTERS, tagIds: ["t1", "t2"] };
    const comUma = conversa({ tags: [etiqueta("t2")] });
    expect(conversationMatchesFilters(comUma, filtros, eu)).toBe(true);
    expect(conversationMatchesFilters(conversa({ tags: [] }), filtros, eu)).toBe(false);
  });

  it("regime e folha ficam de fora do casamento no cliente", () => {
    // A conversa que chega pelo socket não carrega o regime: ele mora no
    // outro banco. Recusar aqui apagaria da lista linha que o servidor
    // tinha devolvido.
    const filtros: InboxFilters = { ...EMPTY_INBOX_FILTERS, taxRegime: ["simples"] };
    expect(conversationMatchesFilters(conversa(), filtros, eu)).toBe(true);
    expect(hasCompanyFilter(filtros)).toBe(true);
    expect(hasCompanyFilter(EMPTY_INBOX_FILTERS)).toBe(false);
  });

  it("arquivadas e não lidas continuam recortes disjuntos", () => {
    const arquivadas: InboxFilters = { ...EMPTY_INBOX_FILTERS, view: "archived" };
    expect(conversationMatchesFilters(conversa({ archivedAt: "2026-01-01" }), arquivadas, eu)).toBe(true);
    expect(conversationMatchesFilters(conversa(), arquivadas, eu)).toBe(false);

    const naoLidas: InboxFilters = { ...EMPTY_INBOX_FILTERS, view: "unread" };
    expect(conversationMatchesFilters(conversa(), naoLidas, eu, 0)).toBe(false);
    expect(conversationMatchesFilters(conversa(), naoLidas, eu, 3)).toBe(true);
  });

  it("'sem empresa' e o recorte por regime se excluem — o último vence", () => {
    const comRegime = mergeInboxFilters(EMPTY_INBOX_FILTERS, { taxRegime: ["simples"] });
    const semVinculo = mergeInboxFilters(comRegime, { unlinked: true });
    expect(semVinculo.unlinked).toBe(true);
    expect(semVinculo.taxRegime).toEqual([]);

    const deVolta = mergeInboxFilters(semVinculo, { payroll: ["folha_fixa"] });
    expect(deVolta.unlinked).toBe(false);
    expect(deVolta.payroll).toEqual(["folha_fixa"]);
  });
});

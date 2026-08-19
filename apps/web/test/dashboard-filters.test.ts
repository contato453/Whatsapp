import { beforeEach, describe, expect, it } from "vitest";
import { FILTER_ALL_USERS, FILTER_NONE } from "@azvchat/shared";
import {
  clearDashboardFilters,
  DEFAULT_DASHBOARD_FILTERS,
  hasActiveDashboardFilters,
  pruneDashboardFilters,
  readDashboardFilters,
  saveDashboardFilters,
  type DashboardFilters,
} from "@/lib/dashboard-filters";

/**
 * O que estes testes fixam: o recorte montado no Dashboard sobrevive à saída
 * da tela, volta para o usuário certo, **não se mistura com o da Inbox**, e o
 * que estiver guardado no formato antigo (um valor por filtro) é CONVERTIDO
 * em lista de um item — nunca descartado em silêncio.
 *
 * E o item que deixou de existir some do recorte na reidratação, sem erro: a
 * API recusa id desconhecido com 400, e esse erro não pode aparecer para quem
 * só voltou à tela depois de um cadastro ter mudado.
 */

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
const PESSOA = "77777777-7777-4777-8777-777777777777";

const FILTRADO: DashboardFilters = {
  period: "7d",
  instanceIds: ["instancia-1", "instancia-2"],
  statuses: ["open", "waiting_client"],
  departmentIds: [DEPTO, FILTER_NONE],
  assignedUserIds: [PESSOA, FILTER_ALL_USERS],
};

describe("filtros do Dashboard guardados no navegador", () => {
  beforeEach(() => {
    globalThis.window = { localStorage: fakeStorage() } as unknown as Window & typeof globalThis;
  });

  it("sem nada guardado devolve o padrão", () => {
    expect(readDashboardFilters(ANA)).toEqual(DEFAULT_DASHBOARD_FILTERS);
  });

  it("o recorte volta inteiro na próxima visita", () => {
    saveDashboardFilters(ANA, FILTRADO);
    expect(readDashboardFilters(ANA)).toEqual(FILTRADO);
  });

  it("cada usuário tem o próprio recorte", () => {
    saveDashboardFilters(ANA, FILTRADO);
    // Máquina compartilhada é o caso normal do escritório: quem entra depois
    // não pode encontrar o dashboard recortado pelo filtro do colega.
    expect(readDashboardFilters(BRUNO)).toEqual(DEFAULT_DASHBOARD_FILTERS);
  });

  it("não encosta na chave dos filtros da Inbox", () => {
    saveDashboardFilters(ANA, FILTRADO);
    expect(window.localStorage.getItem(`zapdesk.inbox-filters.${ANA}`)).toBeNull();
    expect(window.localStorage.getItem(`zapdesk.dashboard-filters.${ANA}`)).not.toBeNull();
  });

  it("converte o formato antigo, de um valor por filtro, em lista de um item", () => {
    window.localStorage.setItem(
      "zapdesk.dashboard-filters",
      JSON.stringify({
        period: "30d",
        instanceId: "instancia-1",
        status: "open",
        departmentId: DEPTO,
        assignedUserId: FILTER_NONE,
      }),
    );
    expect(readDashboardFilters(ANA)).toEqual({
      period: "30d",
      instanceIds: ["instancia-1"],
      statuses: ["open"],
      departmentIds: [DEPTO],
      assignedUserIds: [FILTER_NONE],
    });
  });

  it("a chave mais antiga, só com o período, também é aproveitada", () => {
    window.localStorage.setItem("zapdesk.dashboard-period", "15d");
    expect(readDashboardFilters(ANA)).toEqual({ ...DEFAULT_DASHBOARD_FILTERS, period: "15d" });
  });

  it("valor corrompido vira o padrão em silêncio, e nunca um erro", () => {
    window.localStorage.setItem(`zapdesk.dashboard-filters.${ANA}`, "{ não é json");
    expect(readDashboardFilters(ANA)).toEqual(DEFAULT_DASHBOARD_FILTERS);

    window.localStorage.setItem(
      `zapdesk.dashboard-filters.${ANA}`,
      JSON.stringify({ period: "sempre", statuses: ["arquivado", "open"], departmentIds: "x" }),
    );
    const lido = readDashboardFilters(ANA);
    expect(lido.period).toBe("today");
    // Item fora do enum sai; o válido ao lado dele fica.
    expect(lido.statuses).toEqual(["open"]);
    expect(lido.departmentIds).toEqual([]);
  });

  it("período personalizado sem as duas datas cai em hoje", () => {
    window.localStorage.setItem(
      `zapdesk.dashboard-filters.${ANA}`,
      JSON.stringify({ period: "custom", from: "2026-08-01" }),
    );
    expect(readDashboardFilters(ANA).period).toBe("today");
  });

  it("limpar zera os quatro filtros e apaga o que estava guardado", () => {
    saveDashboardFilters(ANA, FILTRADO);
    const limpo = clearDashboardFilters(FILTRADO);
    saveDashboardFilters(ANA, limpo);
    expect(hasActiveDashboardFilters(limpo)).toBe(false);
    // O período escolhido não é filtro, e sobrevive à limpeza.
    expect(limpo.period).toBe("7d");
    expect(readDashboardFilters(ANA)).toEqual(limpo);
  });

  it("item que deixou de existir é descartado em silêncio, e o sentinela fica", () => {
    const podado = pruneDashboardFilters(FILTRADO, {
      instanceIds: ["instancia-1"],
      departmentIds: [],
      userIds: [],
    });
    expect(podado.instanceIds).toEqual(["instancia-1"]);
    // Chip apagado, departamento excluído e pessoa desativada saem; "sem
    // departamento", "sem responsável" e o coletivo não são id de nada e ficam.
    expect(podado.departmentIds).toEqual([FILTER_NONE]);
    expect(podado.assignedUserIds).toEqual([FILTER_ALL_USERS]);
  });

  it("nada a podar devolve o MESMO objeto, para não recarregar a tela à toa", () => {
    const podado = pruneDashboardFilters(FILTRADO, {
      instanceIds: ["instancia-1", "instancia-2"],
      departmentIds: [DEPTO],
      userIds: [PESSOA],
    });
    expect(podado).toBe(FILTRADO);
  });
});

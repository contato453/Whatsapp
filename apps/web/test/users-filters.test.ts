import { beforeEach, describe, expect, it } from "vitest";
import {
  EMPTY_USERS_FILTERS,
  hasActiveUsersFilters,
  readUsersFilters,
  saveUsersFilters,
  userMatchesFilters,
  type UsersFilters,
} from "@/lib/users-filters";
import type { UserWithAccessDto } from "@/lib/types";

/**
 * O que estes testes fixam: o recorte da tela de Usuários casa por CONTÉM
 * nos dois campos multivalorados (chip e departamento), os três filtros
 * somam por E, e o que está guardado no navegador volta por usuário — sem
 * estourar com valor corrompido.
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

function usuario(overrides: Partial<UserWithAccessDto> & { id: string }): UserWithAccessDto {
  return {
    name: "Fulano",
    email: "fulano@example.com",
    role: "agent",
    status: "active",
    signMessages: false,
    notificationSound: "sound_1",
    notificationVolume: "medium",
    hasAvatar: false,
    lastLoginAt: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    whatsappInstanceIds: [],
    departmentIds: [],
    ...overrides,
  };
}

const CHIP_ESCRITORIO = "chip-escritorio";
const CHIP_BACKUP = "chip-backup";
const FISCAL = "dept-fiscal";
const CONTABIL = "dept-contabil";

function filtros(patch: Partial<UsersFilters>): UsersFilters {
  return { ...EMPTY_USERS_FILTERS, ...patch };
}

describe("filtros da tela de Usuários", () => {
  it("sem filtro nenhum, todo mundo passa — inclusive quem não tem vínculo", () => {
    const admin = usuario({ id: "admin", role: "admin" });
    expect(userMatchesFilters(admin, EMPTY_USERS_FILTERS)).toBe(true);
    expect(hasActiveUsersFilters(EMPTY_USERS_FILTERS)).toBe(false);
  });

  it("chip casa por contém: quem tem outros chips além do escolhido continua aparecendo", () => {
    const ana = usuario({ id: "ana", whatsappInstanceIds: [CHIP_ESCRITORIO, CHIP_BACKUP] });
    expect(userMatchesFilters(ana, filtros({ instanceId: CHIP_ESCRITORIO }))).toBe(true);
    expect(userMatchesFilters(ana, filtros({ instanceId: CHIP_BACKUP }))).toBe(true);
    expect(userMatchesFilters(ana, filtros({ instanceId: "chip-que-ela-nao-tem" }))).toBe(false);
  });

  it("departamento casa por contém, igual ao chip", () => {
    const bruno = usuario({ id: "bruno", departmentIds: [FISCAL, CONTABIL] });
    expect(userMatchesFilters(bruno, filtros({ departmentId: FISCAL }))).toBe(true);
    expect(userMatchesFilters(bruno, filtros({ departmentId: CONTABIL }))).toBe(true);
    expect(userMatchesFilters(bruno, filtros({ departmentId: "dept-dp" }))).toBe(false);
  });

  it("quem não tem chip nem departamento some assim que se filtra por um deles", () => {
    const admin = usuario({ id: "admin", role: "admin" });
    expect(userMatchesFilters(admin, filtros({ instanceId: CHIP_ESCRITORIO }))).toBe(false);
    expect(userMatchesFilters(admin, filtros({ departmentId: FISCAL }))).toBe(false);
    // Mas o filtro de tipo continua encontrando: ele não depende de vínculo.
    expect(userMatchesFilters(admin, filtros({ role: "admin" }))).toBe(true);
  });

  it("os três filtros somam por E", () => {
    const carla = usuario({
      id: "carla",
      role: "supervisor",
      whatsappInstanceIds: [CHIP_ESCRITORIO],
      departmentIds: [FISCAL],
    });
    const combinado = filtros({
      instanceId: CHIP_ESCRITORIO,
      role: "supervisor",
      departmentId: FISCAL,
    });
    expect(userMatchesFilters(carla, combinado)).toBe(true);
    // Basta um dos três não bater para a linha sair.
    expect(userMatchesFilters(carla, { ...combinado, role: "agent" })).toBe(false);
    expect(userMatchesFilters(carla, { ...combinado, departmentId: CONTABIL })).toBe(false);
    expect(userMatchesFilters(carla, { ...combinado, instanceId: CHIP_BACKUP })).toBe(false);
  });

  it("usuário desativado continua sendo tratado como qualquer outro", () => {
    const inativo = usuario({ id: "inativo", status: "inactive", departmentIds: [FISCAL] });
    expect(userMatchesFilters(inativo, EMPTY_USERS_FILTERS)).toBe(true);
    expect(userMatchesFilters(inativo, filtros({ departmentId: FISCAL }))).toBe(true);
  });
});

describe("persistência dos filtros da tela de Usuários", () => {
  beforeEach(() => {
    // O módulo lê `window.localStorage`; em ambiente node ele não existe.
    globalThis.window = { localStorage: fakeStorage() } as unknown as Window & typeof globalThis;
  });

  it("guarda e devolve os filtros do usuário", () => {
    saveUsersFilters("ana", filtros({ instanceId: CHIP_ESCRITORIO, role: "supervisor" }));
    expect(readUsersFilters("ana")).toEqual({
      instanceId: CHIP_ESCRITORIO,
      role: "supervisor",
      departmentId: "",
    });
  });

  it("não vaza o filtro de um usuário para outro na mesma máquina", () => {
    saveUsersFilters("ana", filtros({ departmentId: FISCAL }));
    expect(readUsersFilters("bruno")).toEqual(EMPTY_USERS_FILTERS);
  });

  it("sem filtro ativo a entrada é apagada", () => {
    saveUsersFilters("ana", filtros({ departmentId: FISCAL }));
    saveUsersFilters("ana", EMPTY_USERS_FILTERS);
    expect(window.localStorage.getItem("zapdesk.users-filters.ana")).toBeNull();
    expect(readUsersFilters("ana")).toEqual(EMPTY_USERS_FILTERS);
  });

  it("valor corrompido vira o padrão, sem estourar", () => {
    window.localStorage.setItem("zapdesk.users-filters.ana", "{isto não é json");
    expect(readUsersFilters("ana")).toEqual(EMPTY_USERS_FILTERS);

    window.localStorage.setItem(
      "zapdesk.users-filters.bruno",
      JSON.stringify({ instanceId: 42, role: "chefe", departmentId: null }),
    );
    expect(readUsersFilters("bruno")).toEqual(EMPTY_USERS_FILTERS);
  });
});

import { describe, expect, it } from "vitest";
import type { PrismaClient } from "@azvchat/database";
import {
  accessibleInstanceIds,
  canWriteGeneralResource,
  canWriteInAllDepartments,
  conversationScope,
  departmentResourceScope,
  groupScope,
  instanceIdScope,
  instanceScope,
  loadConversationAccess,
  type ConversationAccess,
} from "../src/lib/access.js";
import type { AuthTokenPayload } from "../src/lib/auth.js";

function fakePrisma(
  instances: Array<{ whatsappInstanceId: string }>,
  departments: Array<{ departmentId: string }> = [],
): PrismaClient {
  return {
    userWhatsAppInstance: { findMany: async () => instances },
    userDepartment: { findMany: async () => departments },
  } as unknown as PrismaClient;
}

function user(role: AuthTokenPayload["role"]): AuthTokenPayload {
  return {
    sub: "user-1",
    organizationId: "org-1",
    role,
    name: "Fulano",
    email: "fulano@example.com",
  };
}

describe("accessibleInstanceIds (escopo de conexões)", () => {
  it("admin nunca é restrito", async () => {
    const ids = await accessibleInstanceIds(fakePrisma([{ whatsappInstanceId: "a" }]), user("admin"));
    expect(ids).toBeNull();
  });

  it("usuário sem vínculo não enxerga número nenhum", async () => {
    expect(await accessibleInstanceIds(fakePrisma([]), user("agent"))).toEqual([]);
  });

  it("usuário com vínculo enxerga apenas os números liberados", async () => {
    const ids = await accessibleInstanceIds(
      fakePrisma([{ whatsappInstanceId: "a" }, { whatsappInstanceId: "b" }]),
      user("agent"),
    );
    expect(ids).toEqual(["a", "b"]);
  });
});

describe("filtros Prisma do escopo", () => {
  it("sem restrição não adiciona filtro", () => {
    expect(instanceScope(null)).toEqual({});
    expect(instanceIdScope(null)).toEqual({});
  });

  it("com restrição filtra pelos ids liberados", () => {
    expect(instanceScope(["a"])).toEqual({ whatsappInstanceId: { in: ["a"] } });
    expect(instanceIdScope(["a"])).toEqual({ id: { in: ["a"] } });
  });
});

describe("loadConversationAccess (papéis)", () => {
  it("admin não carrega restrição alguma", async () => {
    const access = await loadConversationAccess(fakePrisma([], []), user("admin"));
    expect(access).toEqual({
      instanceIds: null,
      departmentIds: null,
      ownOnly: false,
      userId: "user-1",
    });
  });

  it("supervisor é restrito por número e departamento, mas vê o time todo", async () => {
    const access = await loadConversationAccess(
      fakePrisma([{ whatsappInstanceId: "chip-a" }], [{ departmentId: "dep-1" }]),
      user("supervisor"),
    );
    expect(access.instanceIds).toEqual(["chip-a"]);
    expect(access.departmentIds).toEqual(["dep-1"]);
    expect(access.ownOnly).toBe(false);
  });

  it("usuário comum também fica restrito ao que é dele", async () => {
    const access = await loadConversationAccess(
      fakePrisma([{ whatsappInstanceId: "chip-a" }], [{ departmentId: "dep-1" }]),
      user("agent"),
    );
    expect(access.ownOnly).toBe(true);
  });
});

describe("conversationScope (regra de visibilidade)", () => {
  const supervisor: ConversationAccess = {
    instanceIds: ["chip-a"],
    departmentIds: ["dep-1"],
    ownOnly: false,
    userId: "user-1",
  };
  const agent: ConversationAccess = { ...supervisor, ownOnly: true };

  it("admin não recebe nenhum filtro", () => {
    expect(
      conversationScope({
        instanceIds: null,
        departmentIds: null,
        ownOnly: false,
        userId: "admin-1",
      }),
    ).toEqual({});
  });

  it("supervisor filtra por número e departamento, sem recorte de responsável", () => {
    expect(conversationScope(supervisor)).toEqual({
      AND: [
        { whatsappInstanceId: { in: ["chip-a"] } },
        { OR: [{ departmentId: null }, { departmentId: { in: ["dep-1"] } }] },
      ],
    });
  });

  it("usuário comum ganha o recorte de responsável", () => {
    expect(conversationScope(agent)).toEqual({
      AND: [
        { whatsappInstanceId: { in: ["chip-a"] } },
        { OR: [{ departmentId: null }, { departmentId: { in: ["dep-1"] } }] },
        { OR: [{ assignedUserId: "user-1" }, { assignedUserId: null }] },
      ],
    });
  });

  it("sem número marcado o filtro nunca casa — lista vazia, não acesso total", () => {
    const scope = conversationScope({ ...agent, instanceIds: [], departmentIds: [] });
    expect(scope).toEqual({
      AND: [
        { whatsappInstanceId: { in: [] } },
        { OR: [{ departmentId: null }, { departmentId: { in: [] } }] },
        { OR: [{ assignedUserId: "user-1" }, { assignedUserId: null }] },
      ],
    });
  });
});

describe("groupScope (filtro de grupo)", () => {
  const restrito: ConversationAccess = {
    instanceIds: ["chip-a"],
    departmentIds: ["dep-1"],
    ownOnly: true,
    userId: "user-1",
  };
  const admin: ConversationAccess = {
    instanceIds: null,
    departmentIds: null,
    ownOnly: false,
    userId: "admin-1",
  };

  it("usuário restrito: grupo sem conversa, ou com conversa que ele enxerga", () => {
    const filtro = groupScope(restrito);
    expect(filtro.whatsappInstanceId).toEqual({ in: ["chip-a"] });
    expect(filtro.OR).toEqual([
      { conversationId: null },
      { conversation: { is: conversationScope(restrito) } },
    ]);
  });

  it("admin enxerga grupo que já virou conversa", () => {
    // O `is` é o que faz o caso do admin funcionar: `conversation: {}` solto
    // dentro de um OR é descartado pelo Prisma, e sobraria `conversationId:
    // null` — que esconderia todo grupo com conversa. Com `is: {}` a
    // condição vira "existe conversa", que é o que se quer.
    const filtro = groupScope(admin);
    expect(filtro.whatsappInstanceId).toBeUndefined();
    expect(filtro.OR).toEqual([{ conversationId: null }, { conversation: { is: {} } }]);
  });
});

describe("departmentResourceScope (etiqueta e resposta rápida em N:N)", () => {
  it("admin não recebe filtro nenhum", () => {
    // Sem filtro ele enxerga inclusive o item que ficou sem departamento
    // depois de uma exclusão — é ele quem precisa arrumar.
    expect(departmentResourceScope(null)).toEqual({});
  });

  it("usuário enxerga o geral e o que está marcado para algum departamento dele", () => {
    expect(departmentResourceScope(["dep-1", "dep-2"])).toEqual({
      OR: [
        { isGeneral: true },
        { departments: { some: { departmentId: { in: ["dep-1", "dep-2"] } } } },
      ],
    });
  });

  it("usuário sem departamento continua enxergando só o geral", () => {
    // Lista vazia não pode virar "vê tudo": o ramo `in: []` não casa nada.
    expect(departmentResourceScope([])).toEqual({
      OR: [{ isGeneral: true }, { departments: { some: { departmentId: { in: [] } } } }],
    });
  });
});

describe("canWriteGeneralResource (quem cria item geral)", () => {
  it("só o admin, que é quem vem sem restrição", () => {
    expect(canWriteGeneralResource(null)).toBe(true);
    expect(canWriteGeneralResource(["dep-1"])).toBe(false);
    expect(canWriteGeneralResource([])).toBe(false);
  });
});

describe("canWriteInAllDepartments (escrita exige todos)", () => {
  it("admin grava em qualquer combinação", () => {
    expect(canWriteInAllDepartments(null, ["dep-1", "dep-2"])).toBe(true);
  });

  it("usuário grava quando tem acesso a todos os escolhidos", () => {
    expect(canWriteInAllDepartments(["dep-1", "dep-2"], ["dep-1", "dep-2"])).toBe(true);
    expect(canWriteInAllDepartments(["dep-1", "dep-2"], ["dep-1"])).toBe(true);
  });

  it("faltando um único departamento, recusa a gravação inteira", () => {
    // Supervisor só do Fiscal não pendura a etiqueta também no Contábil.
    expect(canWriteInAllDepartments(["dep-fiscal"], ["dep-fiscal", "dep-contabil"])).toBe(false);
  });

  it("nenhum departamento é estado inválido para item restrito", () => {
    expect(canWriteInAllDepartments(["dep-1"], [])).toBe(false);
    // Nem para o admin: item restrito sem departamento sumiria de todo mundo.
    expect(canWriteInAllDepartments(null, [])).toBe(false);
  });
});

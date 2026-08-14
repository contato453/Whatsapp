import { describe, expect, it } from "vitest";
import type { PrismaClient } from "@azvchat/database";
import {
  accessibleInstanceIds,
  conversationScope,
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

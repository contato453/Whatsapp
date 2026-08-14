import { describe, expect, it } from "vitest";
import type { PrismaClient } from "@azvchat/database";
import { accessibleInstanceIds, instanceIdScope, instanceScope } from "../src/lib/access.js";
import type { AuthTokenPayload } from "../src/lib/auth.js";

function fakePrisma(links: Array<{ whatsappInstanceId: string }>): PrismaClient {
  return {
    userWhatsAppInstance: {
      findMany: async () => links,
    },
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

  it("usuário sem vínculo enxerga todas as conexões", async () => {
    expect(await accessibleInstanceIds(fakePrisma([]), user("agent"))).toBeNull();
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

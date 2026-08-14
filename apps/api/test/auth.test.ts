import { describe, expect, it } from "vitest";
import type { PrismaClient } from "@azvchat/database";
import { createSessionVerifier, hasRole } from "../src/lib/auth.js";
import { UnauthorizedError } from "../src/lib/errors.js";

describe("hasRole (autorização por papel)", () => {
  it("admin tem acesso a tudo", () => {
    expect(hasRole("admin", "admin")).toBe(true);
    expect(hasRole("admin", "supervisor")).toBe(true);
    expect(hasRole("admin", "agent")).toBe(true);
  });

  it("supervisor não acessa recursos de admin", () => {
    expect(hasRole("supervisor", "admin")).toBe(false);
    expect(hasRole("supervisor", "supervisor")).toBe(true);
    expect(hasRole("supervisor", "agent")).toBe(true);
  });

  it("agent só acessa recursos de agent", () => {
    expect(hasRole("agent", "admin")).toBe(false);
    expect(hasRole("agent", "supervisor")).toBe(false);
    expect(hasRole("agent", "agent")).toBe(true);
  });
});

/** Prisma mínimo: só o findUnique que o verificador usa. */
function fakePrisma(user: Record<string, unknown> | null): PrismaClient {
  return { user: { findUnique: async () => user } } as unknown as PrismaClient;
}

const STORED = {
  id: "user-1",
  organizationId: "org-1",
  role: "supervisor" as const,
  name: "Nome Do Banco",
  email: "novo@example.com",
  status: "active" as const,
};

/** O que o token afirma — propositalmente desatualizado em tudo. */
const TOKEN = {
  sub: "user-1",
  organizationId: "org-1",
  role: "admin" as const,
  name: "Nome Antigo",
  email: "antigo@example.com",
};

describe("createSessionVerifier (o banco manda, não o token)", () => {
  it("devolve papel, nome e e-mail atuais, ignorando o que veio no token", async () => {
    const session = await createSessionVerifier(fakePrisma(STORED))(TOKEN);
    expect(session).toEqual({
      sub: "user-1",
      organizationId: "org-1",
      role: "supervisor",
      name: "Nome Do Banco",
      email: "novo@example.com",
    });
  });

  it("usuário desativado perde o acesso na hora, com token ainda válido", async () => {
    const verify = createSessionVerifier(fakePrisma({ ...STORED, status: "inactive" }));
    await expect(verify(TOKEN)).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it("usuário que não existe mais não entra", async () => {
    await expect(createSessionVerifier(fakePrisma(null))(TOKEN)).rejects.toBeInstanceOf(
      UnauthorizedError,
    );
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@azvchat/database";
import { DEFAULT_ATTENDANCE_SETTINGS } from "@azvchat/shared";
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

/** Organização sem parâmetros gravados — a restrição nasce desligada. */
const SEM_RESTRICAO = { attendanceSettings: null };

/** Restrição ligada, seg-sex 07:00-19:00 (o padrão da casa). */
const COM_RESTRICAO = {
  attendanceSettings: {
    timezone: "America/Sao_Paulo",
    loginRestrictionEnabled: true,
    loginHours: DEFAULT_ATTENDANCE_SETTINGS.loginHours,
  },
};

const STORED = {
  id: "user-1",
  organizationId: "org-1",
  role: "supervisor" as const,
  name: "Nome Do Banco",
  email: "novo@example.com",
  status: "active" as const,
  organization: SEM_RESTRICAO,
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

/**
 * A sessão aberta também obedece ao horário. Sem isto, quem entrasse às
 * 08:00 trabalharia a madrugada inteira e a restrição valeria só no papel.
 */
describe("createSessionVerifier (horário de uso encerra a sessão aberta)", () => {
  const AGENT = { ...STORED, role: "agent" as const, organization: COM_RESTRICAO };
  /** Token do próprio agent — o papel de verdade vem do banco de qualquer jeito. */
  const AGENT_TOKEN = { ...TOKEN, role: "agent" as const };

  beforeEach(() => {
    // O verificador olha o relógio na hora; congelá-lo é o que torna o teste
    // determinístico em qualquer máquina.
    vi.useFakeTimers();
  });

  it("derruba o agent fora da janela, com token ainda válido", async () => {
    // Sexta, 20:00 em São Paulo — a faixa padrão fecha às 19:00.
    vi.setSystemTime(new Date("2026-08-14T23:00:00Z"));
    const promise = createSessionVerifier(fakePrisma(AGENT))(AGENT_TOKEN);
    await expect(promise).rejects.toMatchObject({ code: "session_outside_schedule" });
  });

  it("mantém o agent dentro da janela", async () => {
    // Sexta, 12:00 em São Paulo.
    vi.setSystemTime(new Date("2026-08-14T15:00:00Z"));
    const session = await createSessionVerifier(fakePrisma(AGENT))(AGENT_TOKEN);
    expect(session.role).toBe("agent");
  });

  it("não derruba supervisor — é quem destranca a porta", async () => {
    vi.setSystemTime(new Date("2026-08-14T23:00:00Z"));
    const session = await createSessionVerifier(
      fakePrisma({ ...STORED, organization: COM_RESTRICAO }),
    )(TOKEN);
    expect(session.role).toBe("supervisor");
  });

  it("organização sem parâmetros gravados não tranca ninguém", async () => {
    vi.setSystemTime(new Date("2026-08-16T06:00:00Z"));
    const session = await createSessionVerifier(fakePrisma({ ...AGENT, organization: SEM_RESTRICAO }))(
      AGENT_TOKEN,
    );
    expect(session.sub).toBe("user-1");
  });

  afterEach(() => {
    vi.useRealTimers();
  });
});

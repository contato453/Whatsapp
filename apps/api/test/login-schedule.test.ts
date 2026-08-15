import { describe, expect, it } from "vitest";
import {
  DEFAULT_ATTENDANCE_SETTINGS,
  LOGIN_OUTSIDE_SCHEDULE_MESSAGE,
  LOGIN_SCHEDULE_WARNING_MINUTES,
  loginScheduleWarning,
  type AttendanceSettings,
  type LoginHours,
} from "@azvchat/shared";
import { checkLoginSchedule, officeClock } from "../src/lib/login-schedule.js";
import { normalizeLoginHours } from "../src/lib/attendance-settings.js";

/**
 * O que estes testes fixam: quem consegue entrar no sistema e quando.
 *
 * É regra de porta — errar aqui ou tranca a equipe inteira do lado de fora
 * no meio do expediente, ou deixa a restrição valendo só no papel. Por isso
 * a hora é sempre lida no fuso do escritório: o container roda em UTC, e às
 * 22:00 de Brasília lá já é o dia seguinte.
 */

/** Segunda a sexta das 07:00 às 19:00, com a restrição ligada. */
function settingsWith(overrides: Partial<AttendanceSettings> = {}): AttendanceSettings {
  return {
    ...DEFAULT_ATTENDANCE_SETTINGS,
    loginRestrictionEnabled: true,
    ...overrides,
  };
}

/** Instante UTC — o teste escreve em UTC e o código traduz para o fuso. */
function utc(iso: string): Date {
  return new Date(iso);
}

describe("checkLoginSchedule (horário permitido de login)", () => {
  it("libera todo mundo enquanto a restrição está desligada", () => {
    const settings = settingsWith({ loginRestrictionEnabled: false });
    // Domingo de madrugada em São Paulo: fora de qualquer faixa configurada.
    expect(checkLoginSchedule(settings, "agent", utc("2026-08-16T06:00:00Z")).allowed).toBe(true);
  });

  it("agent entra dentro da faixa do dia", () => {
    // Sexta, 12:00 em São Paulo (15:00 UTC).
    const check = checkLoginSchedule(settingsWith(), "agent", utc("2026-08-14T15:00:00Z"));
    expect(check.allowed).toBe(true);
  });

  it("agent não entra antes da abertura nem depois do fechamento", () => {
    // Sexta, 06:30 e 19:30 em São Paulo.
    expect(checkLoginSchedule(settingsWith(), "agent", utc("2026-08-14T09:30:00Z")).allowed).toBe(
      false,
    );
    expect(checkLoginSchedule(settingsWith(), "agent", utc("2026-08-14T22:30:00Z")).allowed).toBe(
      false,
    );
  });

  it("faixa fecha no minuto do fim e abre no minuto do início", () => {
    // 07:00 em São Paulo entra; 19:00 não — é o corte que a tela promete.
    expect(checkLoginSchedule(settingsWith(), "agent", utc("2026-08-14T10:00:00Z")).allowed).toBe(
      true,
    );
    expect(checkLoginSchedule(settingsWith(), "agent", utc("2026-08-14T22:00:00Z")).allowed).toBe(
      false,
    );
  });

  it("dia desligado não deixa entrar em hora nenhuma", () => {
    // Domingo (padrão desligado), 10:00 em São Paulo.
    const check = checkLoginSchedule(settingsWith(), "agent", utc("2026-08-16T13:00:00Z"));
    expect(check.allowed).toBe(false);
    expect(check.window?.weekday).toBe(0);
  });

  it("supervisor e admin entram sempre — são quem destranca a porta", () => {
    // Domingo de madrugada, com tudo fechado para o agent.
    const madrugada = utc("2026-08-16T06:00:00Z");
    expect(checkLoginSchedule(settingsWith(), "supervisor", madrugada).allowed).toBe(true);
    expect(checkLoginSchedule(settingsWith(), "admin", madrugada).allowed).toBe(true);
    expect(checkLoginSchedule(settingsWith(), "agent", madrugada).allowed).toBe(false);
  });

  it("a hora é a do fuso do escritório, não a do servidor", () => {
    // 23:30 UTC de sexta é 20:30 de sexta em São Paulo: fora da faixa. O
    // mesmo instante em UTC seria 23:30 de sexta — também fora, mas por
    // outro motivo. O caso que separa os dois é a virada do dia:
    // 02:00 UTC de sábado ainda é 23:00 de sexta no escritório.
    const viradaUtc = utc("2026-08-15T02:00:00Z");
    expect(
      checkLoginSchedule(settingsWith({ timezone: "America/Sao_Paulo" }), "agent", viradaUtc)
        .window?.weekday,
    ).toBe(5);
    expect(
      checkLoginSchedule(settingsWith({ timezone: "UTC" }), "agent", viradaUtc).window?.weekday,
    ).toBe(6);
  });

  it("fuso inválido no banco não tranca ninguém por acidente", () => {
    // Cai no padrão da casa em vez de estourar: sexta 12:00 em São Paulo.
    const check = checkLoginSchedule(
      settingsWith({ timezone: "Mundo/Lugar_Nenhum" }),
      "agent",
      utc("2026-08-14T15:00:00Z"),
    );
    expect(check.allowed).toBe(true);
  });

  it("dia faltando na configuração fecha, em vez de liberar em silêncio", () => {
    const semSexta = DEFAULT_ATTENDANCE_SETTINGS.loginHours.filter(
      (day) => day.weekday !== 5,
    ) as LoginHours[];
    const check = checkLoginSchedule(
      settingsWith({ loginHours: semSexta }),
      "agent",
      utc("2026-08-14T15:00:00Z"),
    );
    expect(check.allowed).toBe(false);
    // Na prática a leitura do banco normaliza a semana antes de chegar aqui,
    // e aí a sexta volta com o padrão e libera.
    const normalizado = checkLoginSchedule(
      settingsWith({ loginHours: normalizeLoginHours(semSexta) }),
      "agent",
      utc("2026-08-14T15:00:00Z"),
    );
    expect(normalizado.allowed).toBe(true);
  });

  it("a mensagem manda pedir autorização ao supervisor", () => {
    expect(LOGIN_OUTSIDE_SCHEDULE_MESSAGE).toContain("supervisor");
  });
});

describe("contagem para o fechamento (o aviso de 5 minutos)", () => {
  it("conta os minutos que faltam para fechar", () => {
    // Sexta, 18:57 em São Paulo; a faixa padrão fecha às 19:00.
    const status = checkLoginSchedule(settingsWith(), "agent", utc("2026-08-14T21:57:00Z"));
    expect(status.enforced).toBe(true);
    expect(status.allowed).toBe(true);
    expect(status.minutesUntilClose).toBe(3);
    expect(status.window?.endTime).toBe("19:00");
  });

  it("no meio do dia a contagem passa longe do limite do aviso", () => {
    const status = checkLoginSchedule(settingsWith(), "agent", utc("2026-08-14T15:00:00Z"));
    expect(status.minutesUntilClose).toBeGreaterThan(LOGIN_SCHEDULE_WARNING_MINUTES);
  });

  it("quem não é alcançado pela restrição não tem contagem — nem aviso", () => {
    const supervisor = checkLoginSchedule(settingsWith(), "supervisor", utc("2026-08-14T21:57:00Z"));
    expect(supervisor.enforced).toBe(false);
    expect(supervisor.minutesUntilClose).toBeNull();

    const desligada = checkLoginSchedule(
      settingsWith({ loginRestrictionEnabled: false }),
      "agent",
      utc("2026-08-14T21:57:00Z"),
    );
    expect(desligada.enforced).toBe(false);
    expect(desligada.minutesUntilClose).toBeNull();
  });

  it("já fora da faixa não conta nada — não há o que avisar", () => {
    const status = checkLoginSchedule(settingsWith(), "agent", utc("2026-08-14T23:00:00Z"));
    expect(status.allowed).toBe(false);
    expect(status.minutesUntilClose).toBeNull();
  });

  it("o texto do aviso acerta o plural e o último minuto", () => {
    expect(loginScheduleWarning(5)).toContain("5 minutos");
    expect(loginScheduleWarning(1)).toContain("menos de 1 minuto");
    expect(loginScheduleWarning(0)).toContain("menos de 1 minuto");
  });
});

describe("officeClock (relógio de parede do escritório)", () => {
  it("traduz o instante UTC para dia da semana e minutos do fuso", () => {
    // 2026-08-14T15:00:00Z é sexta, 12:00 em São Paulo.
    expect(officeClock("America/Sao_Paulo", utc("2026-08-14T15:00:00Z"))).toEqual({
      weekday: 5,
      minutes: 12 * 60,
    });
  });

  it("respeita a virada do dia do fuso, não a do UTC", () => {
    // 2026-08-15T02:00:00Z já é sábado em UTC, mas ainda é sexta 23:00 aqui.
    expect(officeClock("America/Sao_Paulo", utc("2026-08-15T02:00:00Z"))).toEqual({
      weekday: 5,
      minutes: 23 * 60,
    });
  });
});

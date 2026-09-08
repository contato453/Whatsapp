import { describe, expect, it } from "vitest";
import { DEFAULT_BUSINESS_HOURS, type AttendanceSettings } from "@azvchat/shared";
import { isWithinBusinessHours, nextBusinessMoment } from "../src/lib/business-schedule.js";

/**
 * Follow-up automático — seções 19/20 do pedido: "respeitar expediente?" e
 * "enviar no início do próximo expediente" quando a etapa vence fora dele.
 *
 * Mesmo fuso e mesma forma de configuração do dashboard (`America/Sao_Paulo`,
 * segunda a sexta 08:00–18:00 por padrão) — não existe uma segunda definição
 * de "expediente" só para o follow-up.
 */

const SETTINGS: Pick<AttendanceSettings, "timezone" | "businessHours"> = {
  timezone: "America/Sao_Paulo",
  businessHours: DEFAULT_BUSINESS_HOURS,
};

// 08:00 e 18:00 em America/Sao_Paulo (UTC-3, sem horário de verão hoje em dia).
function saoPauloTime(isoDateTimeUtcMinus3: string): Date {
  return new Date(`${isoDateTimeUtcMinus3}-03:00`);
}

describe("nextBusinessMoment", () => {
  it("dentro do expediente devolve o próprio instante", () => {
    // Quarta-feira, 10h da manhã — bem dentro do horário padrão.
    const moment = saoPauloTime("2026-09-09T10:00:00");
    expect(nextBusinessMoment(moment, SETTINGS)?.getTime()).toBe(moment.getTime());
  });

  it("vence fora do expediente (22h) e reagenda para a abertura do próximo dia útil", () => {
    // Sexta-feira 22h — expediente já fechado, e amanhã é sábado (fora do padrão).
    const fridayNight = saoPauloTime("2026-09-11T22:00:00");
    const resolved = nextBusinessMoment(fridayNight, SETTINGS);
    // Deveria cair na segunda-feira seguinte, às 08:00 (fuso do escritório).
    expect(resolved).toEqual(saoPauloTime("2026-09-14T08:00:00"));
  });

  it("cedo demais no mesmo dia útil (antes de abrir) empurra para a abertura do dia", () => {
    const earlyMorning = saoPauloTime("2026-09-09T05:00:00");
    const resolved = nextBusinessMoment(earlyMorning, SETTINGS);
    expect(resolved).toEqual(saoPauloTime("2026-09-09T08:00:00"));
  });

  it("semana inteira desligada devolve null em vez de procurar um horário que não existe", () => {
    const allOff = DEFAULT_BUSINESS_HOURS.map((day) => ({ ...day, active: false }));
    const moment = saoPauloTime("2026-09-09T10:00:00");
    expect(nextBusinessMoment(moment, { ...SETTINGS, businessHours: allOff })).toBeNull();
  });
});

describe("isWithinBusinessHours", () => {
  it("verdadeiro dentro do expediente, falso fora dele", () => {
    expect(isWithinBusinessHours(saoPauloTime("2026-09-09T10:00:00"), SETTINGS)).toBe(true);
    expect(isWithinBusinessHours(saoPauloTime("2026-09-11T22:00:00"), SETTINGS)).toBe(false);
    // Sábado: fora do padrão (só ativo seg-sex).
    expect(isWithinBusinessHours(saoPauloTime("2026-09-12T10:00:00"), SETTINGS)).toBe(false);
  });
});

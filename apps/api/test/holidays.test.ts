import { describe, expect, it } from "vitest";
import {
  DEFAULT_ATTENDANCE_SETTINGS,
  easterSunday,
  holidayMatcher,
  holidaysForYear,
  nationalHolidaysForYear,
  type HolidaySettings,
} from "@azvchat/shared";
import { businessMinutesBetween } from "../src/modules/dashboard/metrics.js";
import { nextBusinessMoment } from "../src/lib/business-schedule.js";
import { isWithinBusinessHours } from "../src/lib/automation/business-hours.js";

/**
 * O que estes testes fixam: feriado PARA o relógio do atraso. Sem isto, a
 * mensagem da véspera de um feriado virava "Atrasados agora" no próprio
 * feriado e o Quality cobrava a espera de quem não estava trabalhando.
 */

const NATIONAL: HolidaySettings = { nationalEnabled: true, optionalEnabled: false, custom: [] };
const NONE: HolidaySettings = { nationalEnabled: false, optionalEnabled: false, custom: [] };

const calendar = (holidays: HolidaySettings) => ({
  timezone: "America/Sao_Paulo",
  businessHours: DEFAULT_ATTENDANCE_SETTINGS.businessHours,
  holidays,
});

/** Horário de Brasília (UTC-3) → instante. */
const brt = (iso: string) => new Date(`${iso}-03:00`);

describe("calendário de feriados", () => {
  it("calcula a Páscoa e a Sexta-feira da Paixão", () => {
    expect(easterSunday(2026)).toEqual({ year: 2026, month: 4, day: 5 });
    expect(easterSunday(2027)).toEqual({ year: 2027, month: 3, day: 28 });
    const dates = nationalHolidaysForYear(2026).map((holiday) => holiday.date);
    expect(dates).toContain("2026-04-03");
    expect(dates).toContain("2026-11-20");
    expect(dates).toHaveLength(10);
  });

  it("Consciência Negra só é nacional a partir de 2024", () => {
    expect(nationalHolidaysForYear(2023).map((holiday) => holiday.date)).not.toContain("2023-11-20");
  });

  it("pontos facultativos só entram ligados", () => {
    expect(holidaysForYear(NATIONAL, 2026).some((holiday) => holiday.kind === "optional")).toBe(false);
    const optional = holidaysForYear({ ...NATIONAL, optionalEnabled: true }, 2026)
      .filter((holiday) => holiday.kind === "optional")
      .map((holiday) => holiday.date);
    expect(optional).toEqual(["2026-02-16", "2026-02-17", "2026-06-04"]);
  });

  it("data própria recorrente vale em todo ano; a avulsa, só no dela", () => {
    const settings: HolidaySettings = {
      ...NONE,
      custom: [
        { date: "2020-01-25", name: "Aniversário da cidade", recurring: true },
        { date: "2026-12-24", name: "Recesso", recurring: false },
      ],
    };
    const isHoliday = holidayMatcher(settings);
    expect(isHoliday({ year: 2031, month: 1, day: 25 })).toBe(true);
    expect(isHoliday({ year: 2026, month: 12, day: 24 })).toBe(true);
    expect(isHoliday({ year: 2027, month: 12, day: 24 })).toBe(false);
  });

  it("sem configuração de feriados, nada é feriado", () => {
    expect(holidayMatcher(undefined)({ year: 2026, month: 12, day: 25 })).toBe(false);
  });
});

describe("feriado no tempo de expediente", () => {
  it("o relógio do atraso para no feriado em dia útil", () => {
    // Sexta 09/10/2026 às 17:50, véspera do fim de semana que emenda em
    // Nossa Senhora Aparecida (segunda 12/10). Sem feriado a segunda conta
    // inteira (600 min); com feriado, só os 10 de sexta e os 20 de terça.
    const from = brt("2026-10-09T17:50:00"); // sexta-feira
    const to = brt("2026-10-13T08:20:00"); // terça-feira, depois do feriado
    expect(businessMinutesBetween(from, to, calendar(NONE))).toBe(10 + 600 + 20);
    expect(businessMinutesBetween(from, to, calendar(NATIONAL))).toBe(10 + 20);
  });

  it("follow-up e disparo pulam o feriado para o próximo dia útil", () => {
    const moment = brt("2026-12-25T10:00:00"); // Natal, sexta-feira
    expect(nextBusinessMoment(moment, calendar(NATIONAL))?.toISOString()).toBe(
      brt("2026-12-28T08:00:00").toISOString(),
    );
    expect(nextBusinessMoment(moment, calendar(NONE))?.getTime()).toBe(moment.getTime());
  });

  it("no feriado o escritório está fora do expediente", () => {
    const moment = brt("2026-12-25T10:00:00");
    expect(isWithinBusinessHours(calendar(NATIONAL), moment)).toBe(false);
    expect(isWithinBusinessHours(calendar(NONE), moment)).toBe(true);
  });
});

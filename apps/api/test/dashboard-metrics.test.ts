import { describe, expect, it } from "vitest";
import {
  DEFAULT_ATTENDANCE_SETTINGS,
  defaultBusinessHoursFor,
  WEEKDAYS,
  type AttendanceSettings,
} from "@azvchat/shared";
import {
  businessMinutesBetween,
  civilDateIn,
  computeOverdue,
  periodStart,
  safeTimeZone,
  weekdayOf,
  zonedTimeToUtc,
} from "../src/modules/dashboard/metrics.js";

/**
 * O risco do dashboard é o número plausível e errado. Estes testes fixam as
 * duas definições que sustentam a tela: onde o período começa e quanto tempo
 * de expediente correu sem resposta.
 */

const SP = "America/Sao_Paulo";

/** Padrão da casa: seg-sex das 08:00 às 18:00, fuso de São Paulo. */
const PADRAO: AttendanceSettings = DEFAULT_ATTENDANCE_SETTINGS;

function comExpediente(overrides: Partial<AttendanceSettings>): AttendanceSettings {
  return { ...PADRAO, ...overrides };
}

/** Instante a partir da hora de parede de São Paulo (UTC-3 fora do verão). */
function sp(iso: string): Date {
  return new Date(`${iso}-03:00`);
}

describe("cortes de data no fuso configurado", () => {
  it("hoje começa à meia-noite local, não à meia-noite UTC", () => {
    // 02:00 UTC de 15/08 ainda é 23:00 de 14/08 em São Paulo.
    const now = new Date("2026-08-15T02:00:00Z");
    expect(periodStart("today", now, SP).toISOString()).toBe("2026-08-14T03:00:00.000Z");
  });

  it("7 dias conta o dia atual mais os seis anteriores", () => {
    const now = sp("2026-08-15T10:00:00");
    // 15, 14, 13, 12, 11, 10 e 09 — sete dias civis, começando dia 09.
    expect(periodStart("7d", now, SP).toISOString()).toBe("2026-08-09T03:00:00.000Z");
    expect(periodStart("15d", now, SP).toISOString()).toBe("2026-08-01T03:00:00.000Z");
    expect(periodStart("30d", now, SP).toISOString()).toBe("2026-07-17T03:00:00.000Z");
  });

  it("atravessa a virada do mês sem estranhar", () => {
    const now = sp("2026-03-02T09:00:00");
    expect(periodStart("7d", now, SP).toISOString()).toBe("2026-02-24T03:00:00.000Z");
  });

  it("fuso inválido no banco cai no padrão em vez de derrubar a tela", () => {
    expect(safeTimeZone("Mundo/Lugar_Nenhum")).toBe(DEFAULT_ATTENDANCE_SETTINGS.timezone);
    expect(safeTimeZone(SP)).toBe(SP);
    expect(() => periodStart("today", new Date(), "Mundo/Lugar_Nenhum")).not.toThrow();
  });

  it("converte data civil e hora de parede nos dois sentidos", () => {
    const instante = zonedTimeToUtc(SP, { year: 2026, month: 8, day: 14 }, 17, 50);
    expect(instante.toISOString()).toBe("2026-08-14T20:50:00.000Z");
    expect(civilDateIn(SP, instante)).toEqual({ year: 2026, month: 8, day: 14 });
    // 14/08/2026 é uma sexta-feira.
    expect(weekdayOf({ year: 2026, month: 8, day: 14 })).toBe(5);
  });
});

describe("tempo de expediente entre dois instantes", () => {
  it("conta minuto a minuto dentro do horário", () => {
    // Sexta, 09:00 às 10:30.
    const minutos = businessMinutesBetween(
      sp("2026-08-14T09:00:00"),
      sp("2026-08-14T10:30:00"),
      PADRAO,
    );
    expect(minutos).toBe(90);
  });

  it("não acumula fora do expediente do próprio dia", () => {
    // Das 17:50 às 23:00 de sexta: só os 10 minutos até as 18:00.
    const minutos = businessMinutesBetween(
      sp("2026-08-14T17:50:00"),
      sp("2026-08-14T23:00:00"),
      PADRAO,
    );
    expect(minutos).toBe(10);
  });

  it("pula o fim de semana e retoma na abertura da segunda", () => {
    // Sexta 17:50 até segunda 08:05: 10 minutos da sexta + 5 da segunda.
    const minutos = businessMinutesBetween(
      sp("2026-08-14T17:50:00"),
      sp("2026-08-17T08:05:00"),
      PADRAO,
    );
    expect(minutos).toBe(15);
  });

  it("mensagem que chega depois do fechamento só começa a contar na abertura", () => {
    // Sexta 19:00 até sábado 12:00: nada, porque nem sexta nem sábado sobrou
    // expediente.
    expect(
      businessMinutesBetween(sp("2026-08-14T19:00:00"), sp("2026-08-15T12:00:00"), PADRAO),
    ).toBe(0);
    // Até segunda 08:30 são só os 30 minutos da segunda.
    expect(
      businessMinutesBetween(sp("2026-08-14T19:00:00"), sp("2026-08-17T08:30:00"), PADRAO),
    ).toBe(30);
  });

  it("dia desligado não acumula tempo nenhum", () => {
    // Sexta desligada: quinta 17:50 até sexta 17:00 vale só os 10 minutos da
    // quinta. É o caso de quem desliga a sexta no expediente.
    const semSexta = comExpediente({
      businessHours: PADRAO.businessHours.map((day) =>
        day.weekday === 5 ? { ...day, active: false } : day,
      ),
    });
    expect(
      businessMinutesBetween(sp("2026-08-13T17:50:00"), sp("2026-08-14T17:00:00"), semSexta),
    ).toBe(10);
  });

  it("todos os dias desligados devolve zero, sem laço infinito", () => {
    const semanaFechada = comExpediente({
      businessHours: PADRAO.businessHours.map((day) => ({ ...day, active: false })),
    });
    expect(
      businessMinutesBetween(sp("2026-01-01T09:00:00"), sp("2026-12-31T18:00:00"), semanaFechada),
    ).toBe(0);
  });

  it("sábado ligado passa a acumular, sem mexer nos outros dias", () => {
    const comSabado = comExpediente({
      businessHours: PADRAO.businessHours.map((day) =>
        day.weekday === 6 ? { ...day, active: true, startTime: "08:00", endTime: "12:00" } : day,
      ),
    });
    // Sexta 17:50 até sábado 09:00: 10 minutos da sexta + 60 do sábado.
    expect(
      businessMinutesBetween(sp("2026-08-14T17:50:00"), sp("2026-08-15T09:00:00"), comSabado),
    ).toBe(70);
  });

  it("intervalo invertido ou vazio vale zero", () => {
    expect(businessMinutesBetween(sp("2026-08-14T10:00:00"), sp("2026-08-14T10:00:00"), PADRAO)).toBe(0);
    expect(businessMinutesBetween(sp("2026-08-14T12:00:00"), sp("2026-08-14T09:00:00"), PADRAO)).toBe(0);
  });

  it("ignora dia ativo com fim menor ou igual ao início — não existe expediente ali", () => {
    const invertido = comExpediente({
      businessHours: WEEKDAYS.map((weekday) =>
        weekday === 5
          ? { ...defaultBusinessHoursFor(weekday), startTime: "18:00", endTime: "08:00" }
          : defaultBusinessHoursFor(weekday),
      ),
    });
    expect(
      businessMinutesBetween(sp("2026-08-14T09:00:00"), sp("2026-08-14T17:00:00"), invertido),
    ).toBe(0);
  });
});

describe("card de atendimentos em atraso", () => {
  const agora = sp("2026-08-14T10:00:00");

  it("marca só quem passou do limite configurado", () => {
    const resultado = computeOverdue(
      [
        // 20 minutos de espera: dentro do limite de 30.
        { conversationId: "c1", lastInboundAt: sp("2026-08-14T09:40:00") },
        // 90 minutos: atrasada.
        { conversationId: "c2", lastInboundAt: sp("2026-08-14T08:30:00") },
      ],
      PADRAO,
      agora,
    );
    expect(resultado.count).toBe(1);
    expect(resultado.oldestWaitingMinutes).toBe(90);
  });

  it("limite menor faz o mesmo dado virar atraso, sem reiniciar nada", () => {
    const espera = [{ conversationId: "c1", lastInboundAt: sp("2026-08-14T09:40:00") }];
    expect(computeOverdue(espera, PADRAO, agora).count).toBe(0);
    // É o que a supervisão faz na tela de Parâmetros: baixa para 5 minutos.
    expect(computeOverdue(espera, comExpediente({ responseLimitMinutes: 5 }), agora).count).toBe(1);
  });

  it("mensagem de sexta à noite não vira atraso com a sexta desligada", () => {
    const semSexta = comExpediente({
      businessHours: PADRAO.businessHours.map((day) =>
        day.weekday === 5 ? { ...day, active: false } : day,
      ),
    });
    // Chegou quinta 17:55 (5 minutos de expediente antes de fechar) e a
    // conferência é na sexta de manhã, que não conta.
    const resultado = computeOverdue(
      [{ conversationId: "c1", lastInboundAt: sp("2026-08-13T17:55:00") }],
      semSexta,
      sp("2026-08-14T09:00:00"),
    );
    expect(resultado.count).toBe(0);
    expect(resultado.oldestWaitingMinutes).toBeNull();
  });

  it("com todos os dias desligados ninguém fica atrasado", () => {
    const semanaFechada = comExpediente({
      businessHours: PADRAO.businessHours.map((day) => ({ ...day, active: false })),
    });
    const resultado = computeOverdue(
      [{ conversationId: "c1", lastInboundAt: sp("2026-01-02T09:00:00") }],
      semanaFechada,
      sp("2026-08-14T10:00:00"),
    );
    expect(resultado).toEqual({ count: 0, oldestWaitingMinutes: null });
  });

  it("limite altíssimo não quebra: ninguém atrasa", () => {
    const resultado = computeOverdue(
      [{ conversationId: "c1", lastInboundAt: sp("2026-08-14T08:00:00") }],
      comExpediente({ responseLimitMinutes: 1440 }),
      agora,
    );
    expect(resultado.count).toBe(0);
  });

  it("limite de um minuto marca praticamente tudo, sem quebrar", () => {
    const resultado = computeOverdue(
      [{ conversationId: "c1", lastInboundAt: sp("2026-08-14T09:50:00") }],
      comExpediente({ responseLimitMinutes: 1 }),
      agora,
    );
    expect(resultado.count).toBe(1);
    expect(resultado.oldestWaitingMinutes).toBe(10);
  });

  it("lista vazia devolve zero", () => {
    expect(computeOverdue([], PADRAO, agora)).toEqual({ count: 0, oldestWaitingMinutes: null });
  });
});

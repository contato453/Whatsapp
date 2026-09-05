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
  civilDaysOfRange,
  computeOverdue,
  foldHourly,
  foldTimeline,
  periodRange,
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

  it("intervalo personalizado pega os dois dias inteiros, nas pontas", () => {
    const range = periodRange("custom", sp("2026-08-15T10:00:00"), SP, {
      from: "2026-08-01",
      to: "2026-08-07",
    });
    expect(range.start.toISOString()).toBe("2026-08-01T03:00:00.000Z");
    // Último instante de 07/08 em São Paulo, sem invadir o dia 08.
    expect(range.end?.toISOString()).toBe("2026-08-08T02:59:59.999Z");
  });

  it("intervalo personalizado de um dia só é o dia inteiro", () => {
    const range = periodRange("custom", sp("2026-08-15T10:00:00"), SP, {
      from: "2026-08-14",
      to: "2026-08-14",
    });
    expect(range.start.toISOString()).toBe("2026-08-14T03:00:00.000Z");
    expect(range.end?.toISOString()).toBe("2026-08-15T02:59:59.999Z");
  });

  it("atalho não tem corte superior — mensagem recém-chegada não some", () => {
    expect(periodRange("today", sp("2026-08-15T10:00:00"), SP).end).toBeNull();
    expect(periodRange("30d", sp("2026-08-15T10:00:00"), SP).end).toBeNull();
  });

  it("ontem é o único atalho com corte superior — um dia civil fechado, sem hoje dentro", () => {
    const range = periodRange("yesterday", sp("2026-08-15T10:00:00"), SP);
    // Mesmas bordas do "personalizado de um dia só" (14/08), porque é
    // exatamente o mesmo dia civil visto de hoje = 15/08.
    expect(range.start.toISOString()).toBe("2026-08-14T03:00:00.000Z");
    expect(range.end?.toISOString()).toBe("2026-08-15T02:59:59.999Z");
  });

  it("personalizado sem datas cai no dia de hoje, nunca na base inteira", () => {
    const now = sp("2026-08-15T10:00:00");
    expect(periodRange("custom", now, SP).start.toISOString()).toBe(
      periodRange("today", now, SP).start.toISOString(),
    );
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

describe("série por dia e mapa dia × hora", () => {
  const dias = ["2026-08-12", "2026-08-13", "2026-08-14"];

  it("lista os dias civis do intervalo, do primeiro ao último", () => {
    const range = periodRange("custom", sp("2026-08-15T10:00:00"), SP, {
      from: "2026-08-12",
      to: "2026-08-14",
    });
    expect(civilDaysOfRange(range, sp("2026-08-15T10:00:00"), SP)).toEqual(dias);
  });

  it("no atalho sem fim, vai até o dia de hoje no fuso do escritório", () => {
    const now = sp("2026-08-15T10:00:00");
    const range = periodRange("7d", now, SP);
    const days = civilDaysOfRange(range, now, SP);
    expect(days).toHaveLength(7);
    expect(days[0]).toBe("2026-08-09");
    expect(days[6]).toBe("2026-08-15");
  });

  it("dia sem movimento aparece zerado, e não some da série", () => {
    const serie = foldTimeline(
      [
        { day: "2026-08-12", weekday: 3, hour: 9, direction: "inbound", total: 5 },
        { day: "2026-08-12", weekday: 3, hour: 9, direction: "outbound", total: 2 },
        { day: "2026-08-14", weekday: 5, hour: 14, direction: "inbound", total: 1 },
      ],
      dias,
    );
    expect(serie).toEqual([
      { date: "2026-08-12", received: 5, sent: 2 },
      // O dia 13 não teve mensagem: precisa aparecer como zero, senão o
      // gráfico emenda 12 com 14 e some com o dia parado.
      { date: "2026-08-13", received: 0, sent: 0 },
      { date: "2026-08-14", received: 1, sent: 0 },
    ]);
  });

  it("soma as horas do mesmo dia da semana ao longo do período", () => {
    const celulas = foldHourly([
      { day: "2026-08-12", weekday: 3, hour: 9, direction: "inbound", total: 4 },
      { day: "2026-08-19", weekday: 3, hour: 9, direction: "inbound", total: 6 },
      { day: "2026-08-19", weekday: 3, hour: 9, direction: "outbound", total: 3 },
      { day: "2026-08-14", weekday: 5, hour: 17, direction: "inbound", total: 2 },
    ]);
    expect(celulas).toEqual([
      { weekday: 3, hour: 9, received: 10, sent: 3 },
      { weekday: 5, hour: 17, received: 2, sent: 0 },
    ]);
  });

  it("devolve as células em ordem de dia e hora", () => {
    const celulas = foldHourly([
      { day: "2026-08-14", weekday: 5, hour: 17, direction: "inbound", total: 1 },
      { day: "2026-08-10", weekday: 1, hour: 8, direction: "inbound", total: 1 },
      { day: "2026-08-14", weekday: 5, hour: 8, direction: "inbound", total: 1 },
    ]);
    expect(celulas.map((cell) => [cell.weekday, cell.hour])).toEqual([
      [1, 8],
      [5, 8],
      [5, 17],
    ]);
  });

  it("ignora dia ou hora fora da grade e dia fora do período", () => {
    expect(
      foldHourly([{ day: "x", weekday: 9, hour: 9, direction: "inbound", total: 5 }]),
    ).toEqual([]);
    expect(
      foldHourly([{ day: "x", weekday: 3, hour: 99, direction: "inbound", total: 5 }]),
    ).toEqual([]);
    // Dia que não está na lista não inventa ponto novo na série.
    expect(
      foldTimeline([{ day: "1999-01-01", weekday: 5, hour: 9, direction: "inbound", total: 9 }], dias),
    ).toEqual([
      { date: "2026-08-12", received: 0, sent: 0 },
      { date: "2026-08-13", received: 0, sent: 0 },
      { date: "2026-08-14", received: 0, sent: 0 },
    ]);
  });

  it("período sem mensagem nenhuma devolve a série inteira zerada", () => {
    expect(foldTimeline([], dias)).toEqual([
      { date: "2026-08-12", received: 0, sent: 0 },
      { date: "2026-08-13", received: 0, sent: 0 },
      { date: "2026-08-14", received: 0, sent: 0 },
    ]);
    expect(foldHourly([])).toEqual([]);
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

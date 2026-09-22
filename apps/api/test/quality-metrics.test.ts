import { describe, expect, it } from "vitest";
import type { AttendanceSettings } from "@azvchat/shared";
import { computeQualityMetrics, resolveQualityOutcome } from "../src/lib/quality/metrics.js";
import { parseQualityAiResponse } from "../src/lib/quality/response.js";

/**
 * As MÉTRICAS OBJETIVAS e a validação da resposta da IA.
 *
 * As primeiras entram no material como fato, para a nota não contradizer o que
 * foi medido; a segunda é a trava que impede resposta fora do formato de virar
 * linha no banco.
 */

/** Seg a sex, 08:00 às 18:00, fuso do escritório. Limite de resposta: 30 min. */
const SETTINGS: Pick<AttendanceSettings, "timezone" | "businessHours" | "responseLimitMinutes"> = {
  timezone: "America/Sao_Paulo",
  responseLimitMinutes: 30,
  businessHours: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({
    weekday: weekday as 0 | 1 | 2 | 3 | 4 | 5 | 6,
    active: weekday >= 1 && weekday <= 5,
    startTime: "08:00",
    endTime: "18:00",
  })),
};

/** Quarta-feira, 10:00 em São Paulo (13:00 UTC) — bem dentro do expediente. */
const QUARTA_10H = new Date("2026-09-02T13:00:00Z");

function at(minutes: number): Date {
  return new Date(QUARTA_10H.getTime() + minutes * 60_000);
}

describe("métricas objetivas do Quality", () => {
  it("mede a primeira resposta e a média em minutos de expediente", () => {
    const metrics = computeQualityMetrics(
      [
        { id: "m1", direction: "inbound", sentByUserId: null, timestamp: at(0) },
        { id: "m2", direction: "outbound", sentByUserId: "ana", timestamp: at(10) },
        { id: "m3", direction: "inbound", sentByUserId: null, timestamp: at(20) },
        { id: "m4", direction: "outbound", sentByUserId: "ana", timestamp: at(60) },
      ],
      "ana",
      SETTINGS,
    );
    expect(metrics.firstResponseMinutes).toBe(10);
    expect(metrics.responsesMeasured).toBe(2);
    expect(metrics.avgResponseMinutes).toBe(25);
    // Só a segunda resposta (40 min) passou do limite de 30.
    expect(metrics.limitBreaches).toBe(1);
    expect(metrics.messagesSent).toBe(2);
  });

  it("não cobra do atendente o tempo fora do expediente", () => {
    // Cliente escreve às 17h50 de quarta; a resposta sai às 8h10 de quinta.
    const quarta1750 = new Date("2026-09-02T20:50:00Z");
    const quinta0810 = new Date("2026-09-03T11:10:00Z");
    const metrics = computeQualityMetrics(
      [
        { id: "m1", direction: "inbound", sentByUserId: null, timestamp: quarta1750 },
        { id: "m2", direction: "outbound", sentByUserId: "ana", timestamp: quinta0810 },
      ],
      "ana",
      SETTINGS,
    );
    // 10 minutos até fechar + 10 minutos depois de abrir = 20, não 14 horas.
    expect(metrics.firstResponseMinutes).toBe(20);
    expect(metrics.limitBreaches).toBe(0);
  });

  it("três mensagens seguidas do cliente contam como UMA pergunta", () => {
    const metrics = computeQualityMetrics(
      [
        { id: "m1", direction: "inbound", sentByUserId: null, timestamp: at(0) },
        { id: "m2", direction: "inbound", sentByUserId: null, timestamp: at(5) },
        { id: "m3", direction: "inbound", sentByUserId: null, timestamp: at(9) },
        { id: "m4", direction: "outbound", sentByUserId: "ana", timestamp: at(12) },
      ],
      "ana",
      SETTINGS,
    );
    expect(metrics.firstResponseMinutes).toBe(12);
    expect(metrics.responsesMeasured).toBe(1);
  });

  it("resposta de outro atendente fecha a pergunta sem virar atraso de ninguém", () => {
    const messages = [
      { id: "m1", direction: "inbound" as const, sentByUserId: null, timestamp: at(0) },
      { id: "m2", direction: "outbound" as const, sentByUserId: "bruno", timestamp: at(5) },
      { id: "m3", direction: "outbound" as const, sentByUserId: "ana", timestamp: at(90) },
    ];
    const ana = computeQualityMetrics(messages, "ana", SETTINGS);
    expect(ana.responsesMeasured).toBe(0);
    expect(ana.limitBreaches).toBe(0);
    expect(ana.messagesSent).toBe(1);

    const bruno = computeQualityMetrics(messages, "bruno", SETTINGS);
    expect(bruno.firstResponseMinutes).toBe(5);
  });

  it("envio automático, sem autor, não é atendimento de ninguém", () => {
    const metrics = computeQualityMetrics(
      [
        { id: "m1", direction: "inbound", sentByUserId: null, timestamp: at(0) },
        { id: "m2", direction: "outbound", sentByUserId: null, timestamp: at(1) },
      ],
      "ana",
      SETTINGS,
    );
    expect(metrics.messagesSent).toBe(0);
    expect(metrics.responsesMeasured).toBe(0);
  });

  it("desfecho: reaberta vence concluída, e sem resposta vence em atendimento", () => {
    expect(
      resolveQualityOutcome({ historyActions: ["resolved", "reopened"], lastMessageInbound: false, currentStatus: "open" }),
    ).toBe("reopened");
    expect(
      resolveQualityOutcome({ historyActions: ["resolved"], lastMessageInbound: false, currentStatus: "resolved" }),
    ).toBe("resolved");
    expect(resolveQualityOutcome({ historyActions: [], lastMessageInbound: true, currentStatus: "open" })).toBe(
      "unanswered",
    );
    expect(resolveQualityOutcome({ historyActions: [], lastMessageInbound: false, currentStatus: "open" })).toBe(
      "ongoing",
    );
  });
});

describe("validação da resposta da IA", () => {
  const references = new Map([
    ["M1", "id-real-1"],
    ["M2", "id-real-2"],
  ]);

  function resposta(overrides: Record<string, unknown> = {}): string {
    return JSON.stringify({
      overallScore: 8,
      criteria: [
        { key: "cordiality", score: 9, justification: "Tratou bem", messageIds: ["M1"] },
        { key: "clarity", score: 8, justification: "Explicou o passo", messageIds: ["M2"] },
        { key: "technical", score: 8, justification: "Coerente", messageIds: [] },
        { key: "resolution", score: 7, justification: "Resolveu", messageIds: [] },
        { key: "agility", score: 8, justification: "Respondeu rápido", messageIds: [] },
      ],
      subject: "fiscal",
      actionPlan: { improvements: [{ point: "Confirmar prazo", action: "Diga a data exata" }], strengths: ["Cordial"] },
      confidence: "high",
      ...overrides,
    });
  }

  it("aceita a resposta completa e traduz o apelido da mensagem para o id real", () => {
    const parsed = parseQualityAiResponse(resposta(), references);
    expect(parsed?.overallScore).toBe(8);
    expect(parsed?.criteria).toHaveLength(5);
    expect(parsed?.criteria[0]?.messageIds).toEqual(["id-real-1"]);
    expect(parsed?.subject).toBe("fiscal");
  });

  it("descarta apelido de mensagem que não existe no material", () => {
    const parsed = parseQualityAiResponse(
      resposta({
        criteria: [
          { key: "cordiality", score: 9, justification: "x", messageIds: ["M1", "M99"] },
          { key: "clarity", score: 8, justification: "x", messageIds: [] },
          { key: "technical", score: 8, justification: "x", messageIds: [] },
          { key: "resolution", score: 7, justification: "x", messageIds: [] },
          { key: "agility", score: 8, justification: "x", messageIds: [] },
        ],
      }),
      references,
    );
    expect(parsed?.criteria[0]?.messageIds).toEqual(["id-real-1"]);
  });

  it("descarta resposta com critério faltando", () => {
    const parsed = parseQualityAiResponse(
      resposta({
        criteria: [{ key: "cordiality", score: 9, justification: "x", messageIds: [] }],
      }),
      references,
    );
    expect(parsed).toBeNull();
  });

  it("descarta assunto fora do catálogo", () => {
    expect(parseQualityAiResponse(resposta({ subject: "tributário livre" }), references)).toBeNull();
  });

  it("descarta nota fora da escala e texto que não é JSON", () => {
    expect(parseQualityAiResponse(resposta({ overallScore: 42 }), references)).toBeNull();
    expect(parseQualityAiResponse("Claro! Aqui vai a avaliação: nota 10.", references)).toBeNull();
    expect(parseQualityAiResponse(null, references)).toBeNull();
  });

  it("tolera a cerca de código, que é erro de forma, não de conteúdo", () => {
    const parsed = parseQualityAiResponse("```json\n" + resposta() + "\n```", references);
    expect(parsed?.overallScore).toBe(8);
  });
});

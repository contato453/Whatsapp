import { describe, expect, it } from "vitest";
import { computeAgentTotals, formatDuration, type ReportMessage } from "../src/modules/reports/metrics.js";

/**
 * O risco de um relatório é o número plausível e errado. Estes testes
 * fixam a definição de cada métrica.
 */

const T0 = new Date("2026-08-14T12:00:00Z");
const at = (minutes: number): Date => new Date(T0.getTime() + minutes * 60_000);

function inbound(conversationId: string, minutes: number): ReportMessage {
  return { conversationId, direction: "inbound", sentByUserId: null, timestamp: at(minutes) };
}
function outbound(conversationId: string, minutes: number, userId: string | null): ReportMessage {
  return { conversationId, direction: "outbound", sentByUserId: userId, timestamp: at(minutes) };
}

describe("computeAgentTotals", () => {
  it("conta mensagens enviadas e conversas distintas", () => {
    const totals = computeAgentTotals([
      outbound("c1", 1, "u1"),
      outbound("c1", 2, "u1"),
      outbound("c2", 3, "u1"),
    ]);
    expect(totals.get("u1")?.messagesSent).toBe(3);
    expect(totals.get("u1")?.conversationsHandled).toBe(2);
  });

  it("mede o tempo entre a mensagem do cliente e a resposta", () => {
    const totals = computeAgentTotals([inbound("c1", 0), outbound("c1", 10, "u1")]);
    expect(totals.get("u1")?.avgResponseSeconds).toBe(600);
    expect(totals.get("u1")?.responsesMeasured).toBe(1);
  });

  it("mede desde a primeira pergunta quando o cliente manda várias seguidas", () => {
    const totals = computeAgentTotals([
      inbound("c1", 0),
      inbound("c1", 2),
      inbound("c1", 4),
      outbound("c1", 10, "u1"),
    ]);
    expect(totals.get("u1")?.avgResponseSeconds).toBe(600);
  });

  it("envios seguidos não entram na média", () => {
    // Se contassem, a segunda resposta entraria com ~0s e puxaria a média
    // para baixo sem o atendente ter respondido nada mais rápido.
    const totals = computeAgentTotals([
      inbound("c1", 0),
      outbound("c1", 10, "u1"),
      outbound("c1", 11, "u1"),
      outbound("c1", 12, "u1"),
    ]);
    expect(totals.get("u1")?.responsesMeasured).toBe(1);
    expect(totals.get("u1")?.avgResponseSeconds).toBe(600);
    expect(totals.get("u1")?.messagesSent).toBe(3);
  });

  it("conversa iniciada pelo atendente não conta tempo de resposta", () => {
    const totals = computeAgentTotals([outbound("c1", 0, "u1")]);
    expect(totals.get("u1")?.responsesMeasured).toBe(0);
    expect(totals.get("u1")?.avgResponseSeconds).toBeNull();
    expect(totals.get("u1")?.messagesSent).toBe(1);
  });

  it("mede cada conversa separadamente", () => {
    const totals = computeAgentTotals([
      inbound("c1", 0),
      inbound("c2", 0),
      outbound("c1", 2, "u1"),
      outbound("c2", 8, "u1"),
    ]);
    // (120s + 480s) / 2
    expect(totals.get("u1")?.avgResponseSeconds).toBe(300);
    expect(totals.get("u1")?.responsesMeasured).toBe(2);
  });

  it("separa os números de cada atendente", () => {
    const totals = computeAgentTotals([
      inbound("c1", 0),
      outbound("c1", 5, "u1"),
      inbound("c2", 0),
      outbound("c2", 20, "u2"),
    ]);
    expect(totals.get("u1")?.avgResponseSeconds).toBe(300);
    expect(totals.get("u2")?.avgResponseSeconds).toBe(1200);
  });

  it("envio automático sem autor não vira atendimento de ninguém", () => {
    const totals = computeAgentTotals([inbound("c1", 0), outbound("c1", 5, null)]);
    expect(totals.size).toBe(0);
  });

  it("ordena por horário antes de medir", () => {
    // Mensagens fora de ordem não podem gerar tempo negativo.
    const totals = computeAgentTotals([outbound("c1", 10, "u1"), inbound("c1", 0)]);
    expect(totals.get("u1")?.avgResponseSeconds).toBe(600);
  });

  it("lista vazia não gera linha", () => {
    expect(computeAgentTotals([]).size).toBe(0);
  });
});

describe("formatDuration", () => {
  it("mostra segundos, minutos e horas", () => {
    expect(formatDuration(45)).toBe("45s");
    expect(formatDuration(600)).toBe("10min");
    expect(formatDuration(3600)).toBe("1h");
    expect(formatDuration(8100)).toBe("2h 15min");
  });

  it("sem medição vira traço, não zero", () => {
    // "0s" diria que a pessoa responde instantaneamente — é o contrário.
    expect(formatDuration(null)).toBe("—");
  });
});

import { describe, expect, it } from "vitest";
import type { QualityEvaluationDto } from "@azvchat/shared";
import { foldQualityAgents, foldQualityDepartments } from "../src/lib/quality/fold.js";

/**
 * A LEITURA POR DEPARTAMENTO — o que estes casos trancam:
 *   1. o que é da CONVERSA (desfecho, mensagens recebidas) conta uma vez por
 *      conversa, mesmo com dois atendentes avaliados nela; o que é da PESSOA
 *      (nota, enviadas) conta por avaliação;
 *   2. o total do escritório NÃO é a soma das linhas em conversa e em pessoa,
 *      porque as duas são contagens de distintos;
 *   3. "sem departamento" é um recorte de verdade, e vai por último;
 *   4. o tempo médio é PONDERADO pelas respostas medidas, não média de médias;
 *   5. a média do setor bate com a média que a visão por atendente mostra.
 */

const CS = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const FISCAL = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

function avaliacao(patch: Partial<QualityEvaluationDto> & { id: string }): QualityEvaluationDto {
  return {
    runId: "r1",
    itemId: "i1",
    conversationId: "c1",
    periodFrom: "2026-08-01T00:00:00.000Z",
    periodTo: "2026-08-31T23:59:59.000Z",
    conversationTitle: "Cliente",
    userId: "u1",
    userName: "Ana",
    departmentId: CS,
    departmentName: "CS",
    overallScore: 8,
    criteria: [{ key: "cordiality", score: 8, justification: "x", messageIds: [] }],
    subject: "fiscal",
    actionPlan: { improvements: [], strengths: [] },
    confidence: "high",
    coveragePercent: 100,
    partial: false,
    metrics: {
      firstResponseMinutes: 10,
      avgResponseMinutes: 10,
      responsesMeasured: 1,
      limitBreaches: 0,
      messagesSent: 2,
      messagesReceived: 5,
      outcome: "resolved",
    },
    discardedAt: null,
    adminComment: null,
    createdAt: "2026-09-01T12:00:00.000Z",
    ...patch,
  };
}

describe("leitura por departamento", () => {
  it("conta a conversa uma vez só quando dois atendentes são avaliados nela", () => {
    // MESMA conversa, DUAS pessoas: a recebida e o desfecho são da conversa, e
    // somá-los por avaliação diria 10 mensagens recebidas onde chegaram 5.
    const { departments, overall } = foldQualityDepartments([
      avaliacao({ id: "e1", conversationId: "c1", userId: "u1", userName: "Ana" }),
      avaliacao({ id: "e2", conversationId: "c1", userId: "u2", userName: "Bia" }),
    ]);

    expect(departments).toHaveLength(1);
    const cs = departments[0]!;
    expect(cs.evaluations).toBe(2);
    expect(cs.conversations).toBe(1);
    expect(cs.agents).toBe(2);
    // Da CONVERSA: uma vez.
    expect(cs.metrics.messagesReceived).toBe(5);
    expect(cs.metrics.outcomes).toEqual([{ outcome: "resolved", total: 1 }]);
    // Da PESSOA: por avaliação.
    expect(cs.metrics.messagesSent).toBe(4);
    expect(overall.conversations).toBe(1);
  });

  it("o total do escritório não é a soma das linhas em pessoa e em conversa", () => {
    // A Ana atende nos dois setores: são duas linhas de setor e UMA pessoa no
    // escritório. Somar as linhas diria duas.
    const { departments, overall } = foldQualityDepartments([
      avaliacao({ id: "e1", conversationId: "c1", departmentId: CS, departmentName: "CS" }),
      avaliacao({ id: "e2", conversationId: "c2", departmentId: FISCAL, departmentName: "Fiscal" }),
    ]);

    expect(departments.map((d) => d.agents)).toEqual([1, 1]);
    expect(overall.agents).toBe(1);
    expect(overall.conversations).toBe(2);
    expect(overall.evaluations).toBe(2);
  });

  it("sem departamento é um recorte, e vai por último", () => {
    const { departments } = foldQualityDepartments([
      avaliacao({ id: "e1", conversationId: "c1", departmentId: null, departmentName: null }),
      avaliacao({ id: "e2", conversationId: "c2", departmentId: FISCAL, departmentName: "Fiscal" }),
      avaliacao({ id: "e3", conversationId: "c3", departmentId: CS, departmentName: "CS" }),
    ]);

    expect(departments.map((d) => d.departmentName)).toEqual(["CS", "Fiscal", "Sem departamento"]);
    expect(departments[2]?.departmentId).toBeNull();
    expect(departments[2]?.conversations).toBe(1);
  });

  it("o tempo médio é ponderado pelas respostas medidas, não média de médias", () => {
    // Uma conversa de 1 resposta em 60 min e outra de 9 respostas em 10 min.
    // Média de médias daria 35; ponderada dá 15, que é o tempo que o cliente
    // esperou de verdade.
    const { overall } = foldQualityDepartments([
      avaliacao({
        id: "e1",
        conversationId: "c1",
        metrics: {
          firstResponseMinutes: 60,
          avgResponseMinutes: 60,
          responsesMeasured: 1,
          limitBreaches: 1,
          messagesSent: 1,
          messagesReceived: 1,
          outcome: "resolved",
        },
      }),
      avaliacao({
        id: "e2",
        conversationId: "c2",
        metrics: {
          firstResponseMinutes: 10,
          avgResponseMinutes: 10,
          responsesMeasured: 9,
          limitBreaches: 0,
          messagesSent: 9,
          messagesReceived: 9,
          outcome: "ongoing",
        },
      }),
    ]);

    expect(overall.metrics.avgResponseMinutes).toBe(15);
    expect(overall.metrics.responsesMeasured).toBe(10);
    expect(overall.metrics.firstResponseMinutes).toBe(35);
    expect(overall.metrics.limitBreaches).toBe(1);
    expect(overall.metrics.breachedEvaluations).toBe(1);
  });

  it("sem nenhuma medida o tempo é nulo, nunca zero", () => {
    // "Ninguém respondeu" e "responderam na hora" são coisas opostas.
    const { overall } = foldQualityDepartments([
      avaliacao({
        id: "e1",
        metrics: {
          firstResponseMinutes: null,
          avgResponseMinutes: null,
          responsesMeasured: 0,
          limitBreaches: 0,
          messagesSent: 1,
          messagesReceived: 0,
          outcome: "unanswered",
        },
      }),
    ]);

    expect(overall.metrics.firstResponseMinutes).toBeNull();
    expect(overall.metrics.avgResponseMinutes).toBeNull();
    expect(overall.metrics.firstResponseMeasured).toBe(0);
  });

  it("a média do setor bate com a média que a visão por atendente mostra", () => {
    // As duas leituras somam as MESMAS avaliações pelo mesmo acumulador: se
    // divergirem, o painel do CS contradiz a linha da pessoa que atende no CS.
    const avaliacoes = [
      avaliacao({ id: "e1", conversationId: "c1", overallScore: 6 }),
      avaliacao({ id: "e2", conversationId: "c2", overallScore: 9 }),
    ];
    const [ana] = foldQualityAgents(avaliacoes);
    const { departments } = foldQualityDepartments(avaliacoes);

    expect(ana?.averageScore).toBe(7.5);
    expect(departments[0]?.averageScore).toBe(ana?.averageScore);
    expect(departments[0]?.evaluations).toBe(ana?.evaluations);
  });
});

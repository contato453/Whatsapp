import { describe, expect, it } from "vitest";
import type { QualityEvaluationDto, QualityRunDetailDto, QualityRunItemDto } from "@/lib/types";
import { buildQualityRunPdf, paraPapel, qualityPdfFileName } from "@/lib/quality-pdf";

/**
 * O RELATÓRIO EM PDF — o que estes casos trancam:
 *   1. o papel é A4 RETRATO, que é o formato pedido e o que o e-mail/impressora
 *      do escritório espera;
 *   2. conteúdo longo PAGINA em vez de transbordar a folha;
 *   3. o nome do arquivo é legível, sem acento e sem barra (barra vira
 *      diretório e o salvamento falha);
 *   4. o texto fora do WinAnsi vira equivalente legível em vez de lixo — as
 *      fontes padrão do PDF não escrevem seta nem emoji, e o nome de grupo do
 *      escritório tem seta;
 *   5. montar não depende de navegador: nenhuma das funções toca no DOM, então
 *      o teste roda no Node igual ao build do CI.
 */

function avaliacao(patch: Partial<QualityEvaluationDto> = {}): QualityEvaluationDto {
  return {
    id: "e1",
    runId: "r1",
    itemId: "i1",
    conversationId: "c1",
    periodFrom: "2026-08-01T00:00:00.000Z",
    periodTo: "2026-08-31T23:59:59.000Z",
    conversationTitle: "Cliente Ação & Cia",
    userId: "u1",
    userName: "Damiana Santos",
    departmentId: null,
    departmentName: "CS",
    overallScore: 8.5,
    criteria: [
      { key: "cordiality", score: 9, justification: "Cumprimentou e manteve o tom.", messageIds: [] },
      { key: "clarity", score: 7, justification: "A orientação sobre o DAS ficou confusa.", messageIds: [] },
    ],
    subject: "fiscal",
    actionPlan: {
      improvements: [{ point: "Confirmar o prazo por escrito", action: "Repetir a data no fim da conversa" }],
      strengths: ["Respondeu rápido"],
    },
    confidence: "high",
    coveragePercent: 100,
    partial: false,
    metrics: {
      firstResponseMinutes: 12,
      avgResponseMinutes: 9,
      responsesMeasured: 4,
      limitBreaches: 1,
      messagesSent: 8,
      messagesReceived: 11,
      outcome: "resolved",
    },
    discardedAt: null,
    adminComment: null,
    createdAt: "2026-09-01T12:00:00.000Z",
    ...patch,
  };
}

function item(patch: Partial<QualityRunItemDto> = {}): QualityRunItemDto {
  return {
    id: "i1",
    conversationId: "c1",
    conversationTitle: "Cliente Ação & Cia",
    status: "completed",
    skipReason: null,
    failureReason: null,
    coveragePercent: 100,
    partial: false,
    truncated: false,
    messageCount: 20,
    audioCount: 2,
    audioTranscribedCount: 2,
    promptChars: 4000,
    model: "gpt-4.1-mini",
    costMicros: 1200,
    evaluations: [avaliacao()],
    ...patch,
  };
}

function disparo(patch: Partial<QualityRunDetailDto> = {}): QualityRunDetailDto {
  return {
    id: "r1",
    status: "completed",
    periodFrom: "2026-08-01T00:00:00.000Z",
    periodTo: "2026-08-31T23:59:59.000Z",
    requestedByName: "Lincoln",
    model: "gpt-4.1-mini",
    conversationCount: 1,
    conversationTitles: ["Cliente Ação & Cia"],
    failureReason: null,
    startedAt: "2026-09-01T12:00:00.000Z",
    finishedAt: "2026-09-01T12:05:00.000Z",
    createdAt: "2026-09-01T12:00:00.000Z",
    items: [item()],
    ...patch,
  };
}

describe("relatório de qualidade em PDF", () => {
  it("sai em A4 retrato", async () => {
    const doc = await buildQualityRunPdf(disparo());
    const { width, height } = doc.internal.pageSize;
    // 210 x 297 mm: retrato, e não paisagem nem carta.
    expect(Math.round(width)).toBe(210);
    expect(Math.round(height)).toBe(297);
    expect(height).toBeGreaterThan(width);
    expect(doc.getNumberOfPages()).toBeGreaterThanOrEqual(1);
  });

  it("pagina quando o conteúdo passa de uma folha, em vez de transbordar", async () => {
    // Doze avaliações com justificativa longa: não cabe em A4 nenhuma.
    const longa = "Explicação detalhada da nota. ".repeat(30);
    const muitas = Array.from({ length: 12 }, (_, indice) =>
      item({
        id: `i${indice}`,
        conversationTitle: `Conversa ${indice}`,
        evaluations: [
          avaliacao({
            id: `e${indice}`,
            criteria: [{ key: "cordiality", score: 7, justification: longa, messageIds: [] }],
          }),
        ],
      }),
    );
    const doc = await buildQualityRunPdf(disparo({ items: muitas, conversationCount: 12 }));
    expect(doc.getNumberOfPages()).toBeGreaterThan(1);
  });

  it("monta mesmo quando nenhuma conversa gerou avaliação", async () => {
    // Disparo em que todas foram puladas: o documento explica, em vez de sair
    // com uma folha em branco.
    const doc = await buildQualityRunPdf(
      disparo({ items: [item({ status: "skipped", skipReason: "no_agent_messages", evaluations: [] })] }),
    );
    expect(doc.getNumberOfPages()).toBe(1);
  });

  it("o nome do arquivo é legível, sem acento e sem barra", () => {
    const nome = qualityPdfFileName(
      disparo({ conversationTitles: ["Ação/Contábil ⇄ Cliente"] }),
      new Date("2026-09-24T10:00:00"),
    );
    expect(nome).toBe("qualidade-acao-contabil-cliente-2026-09-24.pdf");
    expect(nome).not.toContain("/");
  });

  it("com mais de uma conversa o nome diz quantas, em vez de escolher uma", () => {
    const nome = qualityPdfFileName(
      disparo({ conversationTitles: ["Um", "Dois", "Três"] }),
      new Date("2026-09-24T10:00:00"),
    );
    expect(nome).toBe("qualidade-3-conversas-2026-09-24.pdf");
  });

  it("seta de nome de grupo vira texto legível, e emoji sai fora", () => {
    // "Deck ⇄ Contabilidade" é nome real de grupo aqui. Sem esta troca o jsPDF
    // reescreve a string inteira numa codificação que a fonte não tem, e o
    // título sai como "D e c k !Ä C o n t a b i l i d a d e" — ilegível, no
    // lugar mais visível do documento.
    expect(paraPapel("Deck ⇄ Contabilidade")).toBe("Deck - Contabilidade");
    expect(paraPapel("Fluxo → Fiscal")).toBe("Fluxo > Fiscal");
    // Emoji não tem equivalente: sai, e o espaço que sobra é colapsado.
    expect(paraPapel("📊 Financeiro 🚀")).toBe("Financeiro");
    // O português inteiro passa intacto: é isso que o WinAnsi cobre.
    expect(paraPapel("Precisão técnica, cobrança e ação")).toBe("Precisão técnica, cobrança e ação");
  });

  it("título com seta e emoji não quebra o documento", async () => {
    const doc = await buildQualityRunPdf(
      disparo({ conversationTitles: ["📊 Deck ⇄ Contabilidade"], items: [item({ conversationTitle: "📊 Deck ⇄ Contabilidade" })] }),
    );
    expect(doc.getNumberOfPages()).toBeGreaterThanOrEqual(1);
  });
});

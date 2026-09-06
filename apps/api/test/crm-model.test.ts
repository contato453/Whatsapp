import { describe, expect, it } from "vitest";
import {
  CRM_POSITION_STEP,
  CRM_STAGE_TYPES,
  DEFAULT_PIPELINE_STAGES,
  crmDaysInStage,
  crmEffectiveProbability,
  crmFinalValue,
  crmPositionBetween,
  crmStageActionNeedsConversation,
  crmStageSlaBroken,
  crmWeightedValue,
  isCrmActivityOverdue,
  isClosingStageType,
} from "@azvchat/shared";
import {
  averageDaysInStage,
  breakdown,
  realizedValue,
  summarizePeriod,
  totalsByStage,
  totalsOverall,
  type ClosedRow,
  type CrmMetricRow,
} from "../src/lib/crm-metrics.js";

/**
 * As CONTAS do CRM.
 *
 * Elas são puras e testadas sem banco de propósito: é o número do card, o do
 * topo da coluna e o do relatório, e os três precisam sair da mesma função.
 * O histórico do Dashboard (CLAUDE.md §13) mostra o que acontece quando cada
 * tela faz a sua conta — a soma de uma linha deixa de bater com o card, e a
 * equipe para de confiar no painel inteiro.
 */

function linha(overrides: Partial<CrmMetricRow> = {}): CrmMetricRow {
  return {
    stageId: "etapa-1",
    value: 1000,
    discount: null,
    probability: null,
    stageProbability: 50,
    ...overrides,
  };
}

describe("dinheiro: valor final e ponderado", () => {
  it("desconto abate do estimado e nunca deixa o valor negativo", () => {
    expect(crmFinalValue(1000, 200)).toBe(800);
    expect(crmFinalValue(1000, null)).toBe(1000);
    // Desconto maior que o valor é engano de digitação; o funil não pode
    // passar a somar dinheiro negativo por causa disso.
    expect(crmFinalValue(500, 900)).toBe(0);
  });

  it("ponderado é valor × probabilidade, com a chance presa entre 0 e 100", () => {
    expect(crmWeightedValue(10_000, 60)).toBe(6000);
    expect(crmWeightedValue(10_000, 0)).toBe(0);
    expect(crmWeightedValue(10_000, 150)).toBe(10_000);
    expect(crmWeightedValue(10_000, -20)).toBe(0);
  });

  it("a probabilidade da PESSOA vence a da etapa, e zero não vira 'sem valor'", () => {
    expect(crmEffectiveProbability(35, 80)).toBe(35);
    expect(crmEffectiveProbability(null, 80)).toBe(80);
    // Zero é decisão de quem negocia ("não vai fechar"), não ausência: cair
    // no `??` aqui devolveria 80 e inflaria o funil.
    expect(crmEffectiveProbability(0, 80)).toBe(0);
  });
});

describe("totais do quadro", () => {
  it("o total da coluna é a soma dos cards dela — por construção", () => {
    const linhas = [
      linha({ value: 1000 }),
      linha({ value: 2000, discount: 500 }),
      linha({ stageId: "etapa-2", value: 4000, probability: 25 }),
    ];
    const porEtapa = totalsByStage(linhas);
    expect(porEtapa.get("etapa-1")).toEqual({ count: 2, value: 2500, weightedValue: 1250 });
    expect(porEtapa.get("etapa-2")).toEqual({ count: 1, value: 4000, weightedValue: 1000 });

    const geral = totalsOverall(linhas);
    const soma = [...porEtapa.values()].reduce(
      (acc, item) => ({
        count: acc.count + item.count,
        value: acc.value + item.value,
        weightedValue: acc.weightedValue + item.weightedValue,
      }),
      { count: 0, value: 0, weightedValue: 0 },
    );
    expect(geral).toEqual(soma);
  });

  it("média de dias na etapa é o sinal de coluna travada", () => {
    const agora = new Date("2026-09-10T12:00:00Z");
    const rows = [
      linha({ stageEnteredAt: new Date("2026-09-08T12:00:00Z") }),
      linha({ stageEnteredAt: new Date("2026-09-06T12:00:00Z") }),
    ];
    expect(averageDaysInStage(rows, agora)).toBe(3);
    expect(averageDaysInStage([], agora)).toBe(0);
  });
});

describe("indicadores do período", () => {
  function fechada(overrides: Partial<ClosedRow> = {}): ClosedRow {
    return {
      status: "won",
      value: 1000,
      discount: null,
      closedValue: null,
      createdAt: new Date("2026-09-01T12:00:00Z"),
      closedAt: new Date("2026-09-06T12:00:00Z"),
      ...overrides,
    };
  }

  it("o valor FECHADO vence o estimado, e a falta dele não descarta a linha", () => {
    expect(realizedValue({ value: 1000, discount: 100, closedValue: 1500 })).toBe(1500);
    // Sem valor fechado registrado, o estimado é a melhor informação que
    // existe — descartar faria a receita do mês sumir por um campo em branco.
    expect(realizedValue({ value: 1000, discount: 100, closedValue: null })).toBe(900);
  });

  it("conversão, ticket médio e tempo de fechamento saem das fechadas do período", () => {
    const resumo = summarizePeriod({
      openRows: [linha({ value: 2000 })],
      closedRows: [
        fechada({ closedValue: 3000 }),
        fechada({ closedValue: 1000 }),
        fechada({ status: "lost" }),
      ],
      createdCount: 7,
    });
    expect(resumo.pipeline).toEqual({ count: 1, value: 2000, weightedValue: 1000 });
    expect(resumo.created).toBe(7);
    expect(resumo.won).toBe(2);
    expect(resumo.lost).toBe(1);
    expect(resumo.wonValue).toBe(4000);
    expect(resumo.conversionRate).toBeCloseTo(66.7, 1);
    expect(resumo.averageTicket).toBe(2000);
    expect(resumo.averageDaysToClose).toBe(5);
  });

  it("período sem nenhum fechamento devolve conversão ZERO, nunca 100%", () => {
    // Dividir por zero e arredondar para cima faria o mês vazio parecer o
    // melhor mês da história.
    const resumo = summarizePeriod({ openRows: [], closedRows: [], createdCount: 0 });
    expect(resumo.conversionRate).toBe(0);
    expect(resumo.averageTicket).toBe(0);
    expect(resumo.averageDaysToClose).toBe(0);
  });

  it("o recorte por responsável soma o mesmo total do geral", () => {
    const abertas = [
      { ...linha({ value: 1000 }), groupKey: "ana" },
      { ...linha({ value: 3000 }), groupKey: "bruno" },
    ];
    const fechadas = [
      { ...fechada({ closedValue: 500 }), groupKey: "ana" },
      { ...fechada({ status: "lost" as const }), groupKey: "bruno" },
    ];
    const linhas = breakdown(abertas, fechadas, (key) => key);
    expect(linhas.map((item) => item.key)).toEqual(["bruno", "ana"]);
    expect(linhas.reduce((soma, item) => soma + item.pipelineValue, 0)).toBe(
      totalsOverall(abertas).value,
    );
    expect(linhas.find((item) => item.key === "ana")?.conversionRate).toBe(100);
    expect(linhas.find((item) => item.key === "bruno")?.conversionRate).toBe(0);
  });
});

describe("tempo e prazo", () => {
  it("dias na etapa nunca é negativo, mesmo com relógio adiantado", () => {
    const agora = new Date("2026-09-10T12:00:00Z");
    expect(crmDaysInStage(new Date("2026-09-08T12:00:00Z"), agora)).toBe(2);
    expect(crmDaysInStage(new Date("2026-09-20T12:00:00Z"), agora)).toBe(0);
  });

  it("SLA nulo é etapa sem prazo, e não prazo zero", () => {
    const agora = new Date("2026-09-10T12:00:00Z");
    const entrada = new Date("2026-09-01T12:00:00Z");
    expect(crmStageSlaBroken(entrada, null, agora)).toBe(false);
    expect(crmStageSlaBroken(entrada, 0, agora)).toBe(false);
    expect(crmStageSlaBroken(entrada, 5, agora)).toBe(true);
    expect(crmStageSlaBroken(entrada, 30, agora)).toBe(false);
  });

  it("atraso de atividade é DERIVADO: só pendente com prazo vencido", () => {
    const agora = new Date("2026-09-10T12:00:00Z");
    expect(
      isCrmActivityOverdue({ status: "pending", dueAt: "2026-09-09T12:00:00Z" }, agora),
    ).toBe(true);
    expect(
      isCrmActivityOverdue({ status: "pending", dueAt: "2026-09-11T12:00:00Z" }, agora),
    ).toBe(false);
    // Concluir tira o vermelho sozinho — sem processo nenhum virando status.
    expect(isCrmActivityOverdue({ status: "done", dueAt: "2026-09-01T12:00:00Z" }, agora)).toBe(
      false,
    );
    expect(
      isCrmActivityOverdue({ status: "canceled", dueAt: "2026-09-01T12:00:00Z" }, agora),
    ).toBe(false);
  });
});

describe("ordem dos cards na coluna", () => {
  it("soltar entre dois cards produz a média — uma escrita, não a coluna toda", () => {
    expect(crmPositionBetween(1000, 2000)).toBe(1500);
    expect(crmPositionBetween(null, 1000)).toBe(1000 - CRM_POSITION_STEP);
    expect(crmPositionBetween(2000, null)).toBe(2000 + CRM_POSITION_STEP);
    expect(crmPositionBetween(null, null)).toBe(CRM_POSITION_STEP);
  });
});

describe("modelo inicial do funil", () => {
  it("tem exatamente uma etapa de ganho e uma de perda, nas pontas", () => {
    const ganhas = DEFAULT_PIPELINE_STAGES.filter((stage) => stage.type === "won");
    const perdidas = DEFAULT_PIPELINE_STAGES.filter((stage) => stage.type === "lost");
    expect(ganhas).toHaveLength(1);
    expect(perdidas).toHaveLength(1);
    expect(ganhas[0]?.probability).toBe(100);
    expect(perdidas[0]?.probability).toBe(0);
  });

  it("as probabilidades crescem até o fechamento", () => {
    const emJogo = DEFAULT_PIPELINE_STAGES.filter((stage) => stage.type !== "lost");
    const probabilidades = emJogo.map((stage) => stage.probability);
    expect([...probabilidades].sort((a, b) => a - b)).toEqual(probabilidades);
  });

  it("todo tipo de etapa do catálogo é conhecido, e só won/lost fecham", () => {
    for (const stage of DEFAULT_PIPELINE_STAGES) {
      expect(CRM_STAGE_TYPES).toContain(stage.type);
    }
    expect(isClosingStageType("won")).toBe(true);
    expect(isClosingStageType("lost")).toBe(true);
    expect(isClosingStageType("open")).toBe(false);
    expect(isClosingStageType("in_progress")).toBe(false);
  });
});

describe("automação de etapa", () => {
  it("ação que mexe no WhatsApp exige conversa vinculada", () => {
    // Sem isso a oportunidade avulsa (lead que ainda não escreveu) tentaria
    // mandar mensagem para lugar nenhum a cada movimentação.
    expect(crmStageActionNeedsConversation("schedule_message")).toBe(true);
    expect(crmStageActionNeedsConversation("add_tag")).toBe(true);
    expect(crmStageActionNeedsConversation("internal_note")).toBe(true);
    expect(crmStageActionNeedsConversation("assign_user")).toBe(false);
    expect(crmStageActionNeedsConversation("create_activity")).toBe(false);
  });
});

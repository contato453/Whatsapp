import {
  QUALITY_CRITERIA_KEYS,
  QUALITY_NO_DEPARTMENT_LABEL,
  isQualitySubject,
  type QualityAggregateDto,
  type QualityAgentSummaryDto,
  type QualityCriterionKey,
  type QualityDepartmentSummaryDto,
  type QualityEvaluationDto,
  type QualityOutcome,
  type QualitySubject,
} from "@azvchat/shared";

/**
 * AS LEITURAS AGREGADAS DO QUALITY — por atendente e por departamento.
 *
 * As duas somam as MESMAS avaliações e precisam concordar: a média do CS não
 * pode discordar da média das pessoas que atendem no CS. Por isso o
 * acumulador é um só, e cada leitura só projeta o que mostra. Duas somas
 * separadas divergiriam no primeiro ajuste que alguém esquecesse de repetir
 * do outro lado, e é esse tipo de desencontro que faz a equipe parar de
 * confiar no painel (o histórico do Dashboard está na seção 13 do CLAUDE.md).
 *
 * DUAS UNIDADES CONVIVEM, e confundi-las é o erro fácil aqui. A avaliação é
 * por (conversa, atendente): dois atendentes na mesma conversa rendem DUAS
 * linhas. Então o que é da PESSOA (nota, critérios, mensagens enviadas) soma
 * por avaliação, e o que é da CONVERSA (desfecho, mensagens recebidas) soma
 * por conversa DISTINTA. Somar o desfecho por avaliação faria o painel dizer
 * que o setor resolveu três conversas onde resolveu uma, e é exatamente a
 * mesma armadilha que `messagesReceived` já documenta na avaliação.
 */
interface Acumulador {
  total: number;
  sum: number;
  byCriterion: Map<QualityCriterionKey, { sum: number; total: number }>;
  byMonth: Map<string, { sum: number; total: number }>;
  subjects: Map<QualitySubject, number>;
  improvements: Map<string, number>;
  /** Pessoas distintas, pela mesma chave de agrupamento do fold por atendente. */
  agentKeys: Set<string>;
  partial: number;
  firstSum: number;
  firstCount: number;
  /** Numerador da média PONDERADA: soma de (média × respostas medidas). */
  avgWeightedSum: number;
  responsesMeasured: number;
  limitBreaches: number;
  breached: number;
  messagesSent: number;
  /** Por conversa distinta: a mesma conversa não pode entrar duas vezes. */
  receivedByConversation: Map<string, number>;
  outcomeByConversation: Map<string, QualityOutcome>;
}

function novoAcumulador(): Acumulador {
  return {
    total: 0,
    sum: 0,
    byCriterion: new Map(),
    byMonth: new Map(),
    subjects: new Map(),
    improvements: new Map(),
    agentKeys: new Set(),
    partial: 0,
    firstSum: 0,
    firstCount: 0,
    avgWeightedSum: 0,
    responsesMeasured: 0,
    limitBreaches: 0,
    breached: 0,
    messagesSent: 0,
    receivedByConversation: new Map(),
    outcomeByConversation: new Map(),
  };
}

/**
 * Atendente removido do cadastro (`userId` nulo) é agrupado pelo NOME copiado:
 * apagar a pessoa não pode apagar o histórico que o administrador guarda.
 */
export function agentKey(evaluation: QualityEvaluationDto): string {
  return evaluation.userId ?? `nome:${evaluation.userName}`;
}

function acumular(acc: Acumulador, evaluation: QualityEvaluationDto): void {
  acc.total += 1;
  acc.sum += evaluation.overallScore;
  acc.agentKeys.add(agentKey(evaluation));
  if (evaluation.partial) acc.partial += 1;

  for (const criterion of evaluation.criteria) {
    const current = acc.byCriterion.get(criterion.key) ?? { sum: 0, total: 0 };
    current.sum += criterion.score;
    current.total += 1;
    acc.byCriterion.set(criterion.key, current);
  }

  // O mês é o do FIM DO PERÍODO AVALIADO, não o da análise: ver o comentário
  // de `periodFrom`/`periodTo` em `QualityEvaluationDto`.
  const month = evaluation.periodTo.slice(0, 7);
  const monthly = acc.byMonth.get(month) ?? { sum: 0, total: 0 };
  monthly.sum += evaluation.overallScore;
  monthly.total += 1;
  acc.byMonth.set(month, monthly);

  if (isQualitySubject(evaluation.subject)) {
    acc.subjects.set(evaluation.subject, (acc.subjects.get(evaluation.subject) ?? 0) + 1);
  }

  for (const improvement of evaluation.actionPlan.improvements) {
    // Agrupa por ponto normalizado (minúsculas, sem pontuação final): a IA
    // escreve a mesma recomendação com palavras ligeiramente diferentes, e sem
    // normalizar nada se repetiria o suficiente para virar "mais frequente".
    const normalized = improvement.point.trim().toLowerCase().replace(/[.!?]+$/, "");
    if (!normalized) continue;
    acc.improvements.set(normalized, (acc.improvements.get(normalized) ?? 0) + 1);
  }

  const metrics = evaluation.metrics;
  if (metrics.firstResponseMinutes !== null) {
    acc.firstSum += metrics.firstResponseMinutes;
    acc.firstCount += 1;
  }
  if (metrics.avgResponseMinutes !== null && metrics.responsesMeasured > 0) {
    acc.avgWeightedSum += metrics.avgResponseMinutes * metrics.responsesMeasured;
    acc.responsesMeasured += metrics.responsesMeasured;
  }
  acc.limitBreaches += metrics.limitBreaches;
  if (metrics.limitBreaches > 0) acc.breached += 1;
  acc.messagesSent += metrics.messagesSent;

  // Da CONVERSA, não da pessoa: grava por id, e a segunda avaliação da mesma
  // conversa sobrescreve com o mesmo valor em vez de somar.
  acc.receivedByConversation.set(evaluation.conversationId, metrics.messagesReceived);
  acc.outcomeByConversation.set(evaluation.conversationId, metrics.outcome);
}

const round = (value: number): number => Math.round(value * 10) / 10;

function fechar(acc: Acumulador): QualityAggregateDto {
  let messagesReceived = 0;
  for (const total of acc.receivedByConversation.values()) messagesReceived += total;

  const outcomes = new Map<QualityOutcome, number>();
  for (const outcome of acc.outcomeByConversation.values()) {
    outcomes.set(outcome, (outcomes.get(outcome) ?? 0) + 1);
  }

  return {
    evaluations: acc.total,
    conversations: acc.outcomeByConversation.size,
    agents: acc.agentKeys.size,
    averageScore: acc.total > 0 ? round(acc.sum / acc.total) : 0,
    averageByCriterion: QUALITY_CRITERIA_KEYS.flatMap((key) => {
      const current = acc.byCriterion.get(key);
      return current && current.total > 0 ? [{ key, score: round(current.sum / current.total) }] : [];
    }),
    timeline: [...acc.byMonth.entries()]
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([month, value]) => ({
        month,
        score: round(value.sum / value.total),
        evaluations: value.total,
      })),
    subjects: [...acc.subjects.entries()]
      .map(([subject, total]) => ({ subject, total }))
      .sort((a, b) => b.total - a.total),
    recurringImprovements: [...acc.improvements.entries()]
      .map(([point, total]) => ({ point, total }))
      .sort((a, b) => b.total - a.total)
      .slice(0, 8),
    partialEvaluations: acc.partial,
    metrics: {
      // Sem nenhuma medida o valor é NULO, nunca zero: "não houve resposta
      // para medir" e "responderam na hora" são coisas opostas, e zerar diria
      // a segunda quando aconteceu a primeira.
      firstResponseMinutes: acc.firstCount > 0 ? round(acc.firstSum / acc.firstCount) : null,
      firstResponseMeasured: acc.firstCount,
      avgResponseMinutes:
        acc.responsesMeasured > 0 ? round(acc.avgWeightedSum / acc.responsesMeasured) : null,
      responsesMeasured: acc.responsesMeasured,
      limitBreaches: acc.limitBreaches,
      breachedEvaluations: acc.breached,
      messagesSent: acc.messagesSent,
      messagesReceived,
      outcomes: [...outcomes.entries()]
        .map(([outcome, total]) => ({ outcome, total }))
        .sort((a, b) => b.total - a.total),
    },
  };
}

/** A leitura por atendente: um bloco por pessoa avaliada. */
export function foldQualityAgents(evaluations: QualityEvaluationDto[]): QualityAgentSummaryDto[] {
  const buckets = new Map<string, { userId: string | null; userName: string; acc: Acumulador }>();

  for (const evaluation of evaluations) {
    const key = agentKey(evaluation);
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = { userId: evaluation.userId, userName: evaluation.userName, acc: novoAcumulador() };
      buckets.set(key, bucket);
    }
    acumular(bucket.acc, evaluation);
  }

  return [...buckets.values()]
    .map((bucket): QualityAgentSummaryDto => {
      const agregado = fechar(bucket.acc);
      return {
        userId: bucket.userId,
        userName: bucket.userName,
        evaluations: agregado.evaluations,
        averageScore: agregado.averageScore,
        averageByCriterion: agregado.averageByCriterion,
        timeline: agregado.timeline,
        subjects: agregado.subjects,
        recurringImprovements: agregado.recurringImprovements,
      };
    })
    .sort((a, b) => a.userName.localeCompare(b.userName, "pt-BR"));
}

/**
 * A leitura por departamento, mais a linha do escritório inteiro.
 *
 * O total NÃO é a soma das linhas: ele é o mesmo acumulador rodado sobre todas
 * as avaliações de uma vez. A diferença aparece em conversa e em pessoa, que
 * são contagens de DISTINTOS — alguém que atende no CS e no Fiscal é uma
 * pessoa no escritório e duas se somarmos as linhas.
 */
export function foldQualityDepartments(evaluations: QualityEvaluationDto[]): {
  departments: QualityDepartmentSummaryDto[];
  overall: QualityAggregateDto;
} {
  const buckets = new Map<string, { id: string | null; name: string; acc: Acumulador }>();
  const geral = novoAcumulador();

  for (const evaluation of evaluations) {
    // Sem departamento é um RECORTE, não uma sobra: a conversa que o número
    // não classificou é atendimento igual, e escondê-la do painel esconderia
    // justamente a que ninguém está olhando.
    const key = evaluation.departmentId ?? "none";
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = {
        id: evaluation.departmentId,
        name: evaluation.departmentName?.trim() || QUALITY_NO_DEPARTMENT_LABEL,
        acc: novoAcumulador(),
      };
      buckets.set(key, bucket);
    }
    acumular(bucket.acc, evaluation);
    acumular(geral, evaluation);
  }

  return {
    departments: [...buckets.values()]
      .map((bucket): QualityDepartmentSummaryDto => ({
        departmentId: bucket.id,
        departmentName: bucket.name,
        ...fechar(bucket.acc),
      }))
      // "Sem departamento" vai por último: é o resto, não um setor.
      .sort((a, b) =>
        a.departmentId === null
          ? 1
          : b.departmentId === null
            ? -1
            : a.departmentName.localeCompare(b.departmentName, "pt-BR"),
      ),
    overall: fechar(geral),
  };
}

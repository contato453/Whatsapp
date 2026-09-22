import type { AttendanceSettings, QualityOutcome } from "@azvchat/shared";
import { businessMinutesBetween } from "../../modules/dashboard/metrics.js";

/**
 * MÉTRICAS OBJETIVAS DO ATENDIMENTO — medidas pelo SISTEMA, antes da IA.
 *
 * Por que antes: número medido não se discute, e é ele que impede a nota de
 * contradizer o que aconteceu. As três métricas de tempo entram no material da
 * avaliação como CONTEXTO FACTUAL, então a IA julga "agilidade percebida"
 * sabendo que a primeira resposta levou 4 minutos ou 3 horas, em vez de
 * adivinhar pelo tom da conversa.
 *
 * A régua do tempo é de EXPEDIENTE, e sai de `businessMinutesBetween`
 * (`modules/dashboard/metrics.ts`) — a MESMA função do card "Atrasados agora" e
 * do follow-up automático. Não existe segunda definição de expediente no
 * sistema: mensagem que chega 17h50 de sexta volta a contar na abertura do
 * próximo dia ativo, aqui como lá. Medir em tempo de relógio faria este painel
 * reprovar a equipe pelo fim de semana.
 */

export interface QualityMetricsMessage {
  id: string;
  direction: "inbound" | "outbound";
  sentByUserId: string | null;
  timestamp: Date;
}

export interface QualityMetricsResult {
  /** Minutos de expediente até a PRIMEIRA resposta deste atendente. */
  firstResponseMinutes: number | null;
  /** Média, em minutos de expediente, das respostas dele no período. */
  avgResponseMinutes: number | null;
  responsesMeasured: number;
  /** Respostas dele que passaram do limite configurado nos Parâmetros. */
  limitBreaches: number;
  messagesSent: number;
}

/**
 * Tempo de resposta do atendente avaliado, no período.
 *
 * O pareamento é o MESMO do relatório por atendente (`modules/reports/
 * metrics.ts`): conta como resposta o primeiro envio depois de uma mensagem do
 * cliente, e a espera é medida desde a PRIMEIRA mensagem dele ainda sem
 * resposta — três mensagens seguidas do cliente são uma pergunta só. Envios
 * seguidos, sem o cliente falar no meio, não entram: são continuação da mesma
 * resposta e afundariam a média com valores perto de zero.
 *
 * Duas diferenças em relação ao relatório, as duas de propósito: aqui o tempo é
 * de EXPEDIENTE (o relatório usa relógio), e a resposta de OUTRO atendente
 * fecha a pergunta sem ser creditada a ninguém — quem respondeu primeiro
 * respondeu, e cronometrar a mesma pergunta duas vezes inventaria atraso para
 * quem chegou depois.
 *
 * O ESTOURO DO LIMITE conta só entre as respostas medidas. A última pergunta do
 * cliente que ficou sem resposta nenhuma não vira estouro de ninguém: ela é o
 * desfecho `unanswered`, que é onde aparece — atribuí-la a um atendente
 * específico seria escolha arbitrária entre os que passaram pela conversa.
 */
export function computeQualityMetrics(
  messages: QualityMetricsMessage[],
  evaluatedUserId: string,
  settings: Pick<AttendanceSettings, "timezone" | "businessHours" | "responseLimitMinutes">,
): QualityMetricsResult {
  const ordered = [...messages].sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
  let pendingInbound: Date | null = null;
  let firstResponseMinutes: number | null = null;
  let sum = 0;
  let measured = 0;
  let breaches = 0;
  let sent = 0;

  for (const message of ordered) {
    if (message.direction === "inbound") {
      if (pendingInbound === null) pendingInbound = message.timestamp;
      continue;
    }

    const mine = message.sentByUserId === evaluatedUserId;
    if (mine) sent += 1;

    if (pendingInbound === null) continue;

    if (mine) {
      const minutes = businessMinutesBetween(pendingInbound, message.timestamp, settings);
      if (firstResponseMinutes === null) firstResponseMinutes = Math.round(minutes);
      sum += minutes;
      measured += 1;
      if (minutes > settings.responseLimitMinutes) breaches += 1;
    }
    // Envio de outro atendente (ou automático) também FECHA a pergunta: ela já
    // foi respondida, e reaproveitá-la para a próxima resposta desta pessoa
    // mediria uma espera que o cliente não teve.
    pendingInbound = null;
  }

  return {
    firstResponseMinutes,
    avgResponseMinutes: measured > 0 ? Math.round(sum / measured) : null,
    responsesMeasured: measured,
    limitBreaches: breaches,
    messagesSent: sent,
  };
}

export interface QualityOutcomeInput {
  /** Ações de `ConversationAssignmentHistory` dentro do período, em ordem. */
  historyActions: string[];
  /** A última mensagem do período é do cliente? */
  lastMessageInbound: boolean;
  /** Status da conversa agora. */
  currentStatus: string;
}

/**
 * Como a conversa terminou o período. Mede o EVENTO, e não só o status de
 * agora: conversa concluída ontem e reaberta hoje é `reopened`, e é essa a
 * informação que interessa a quem avalia o atendimento daquele dia.
 */
export function resolveQualityOutcome(input: QualityOutcomeInput): QualityOutcome {
  if (input.historyActions.includes("reopened")) return "reopened";
  if (input.historyActions.includes("resolved") || input.currentStatus === "resolved") return "resolved";
  if (input.lastMessageInbound) return "unanswered";
  return "ongoing";
}

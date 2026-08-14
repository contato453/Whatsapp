/**
 * Cálculo das métricas do relatório de atendimentos.
 *
 * Separado das rotas para ser testável sem banco: o que importa aqui é a
 * definição de cada número — e definição errada num relatório é pior que
 * relatório nenhum, porque ninguém desconfia.
 */

export interface ReportMessage {
  conversationId: string;
  direction: string;
  sentByUserId: string | null;
  timestamp: Date;
}

export interface AgentTotals {
  /** Mensagens enviadas pelo atendente no período */
  messagesSent: number;
  /** Conversas distintas em que ele respondeu no período */
  conversationsHandled: number;
  /** Média de tempo entre a mensagem do cliente e a resposta dele */
  avgResponseSeconds: number | null;
  /** Quantidade de respostas que entraram na média */
  responsesMeasured: number;
}

/**
 * Percorre as mensagens em ordem cronológica por conversa e mede o tempo
 * de resposta de cada atendente.
 *
 * Conta como resposta o primeiro envio depois de uma mensagem do cliente.
 * Envios seguidos, sem o cliente falar no meio, não entram: são
 * continuação da mesma resposta, e inflariam a média com valores perto de
 * zero. Conversa que o atendente iniciou também não entra — não há
 * pergunta anterior para cronometrar.
 */
export function computeAgentTotals(messages: ReportMessage[]): Map<string, AgentTotals> {
  const totals = new Map<string, AgentTotals>();
  const conversationsByAgent = new Map<string, Set<string>>();
  const responseSum = new Map<string, number>();
  /** Última mensagem do cliente ainda sem resposta, por conversa */
  const pendingInbound = new Map<string, Date>();

  const ensure = (userId: string): AgentTotals => {
    let entry = totals.get(userId);
    if (!entry) {
      entry = {
        messagesSent: 0,
        conversationsHandled: 0,
        avgResponseSeconds: null,
        responsesMeasured: 0,
      };
      totals.set(userId, entry);
      conversationsByAgent.set(userId, new Set());
      responseSum.set(userId, 0);
    }
    return entry;
  };

  const ordered = [...messages].sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());

  for (const message of ordered) {
    if (message.direction === "inbound") {
      // Só a primeira pergunta sem resposta conta: se o cliente mandar três
      // mensagens seguidas, o tempo é medido desde a primeira.
      if (!pendingInbound.has(message.conversationId)) {
        pendingInbound.set(message.conversationId, message.timestamp);
      }
      continue;
    }

    // Envio automático (agendamento sem autor) não é atendimento de ninguém.
    if (!message.sentByUserId) {
      pendingInbound.delete(message.conversationId);
      continue;
    }

    const entry = ensure(message.sentByUserId);
    entry.messagesSent += 1;
    conversationsByAgent.get(message.sentByUserId)?.add(message.conversationId);

    const waiting = pendingInbound.get(message.conversationId);
    if (waiting) {
      const seconds = (message.timestamp.getTime() - waiting.getTime()) / 1000;
      if (seconds >= 0) {
        responseSum.set(message.sentByUserId, (responseSum.get(message.sentByUserId) ?? 0) + seconds);
        entry.responsesMeasured += 1;
      }
      pendingInbound.delete(message.conversationId);
    }
  }

  for (const [userId, entry] of totals) {
    entry.conversationsHandled = conversationsByAgent.get(userId)?.size ?? 0;
    entry.avgResponseSeconds =
      entry.responsesMeasured > 0
        ? Math.round((responseSum.get(userId) ?? 0) / entry.responsesMeasured)
        : null;
  }

  return totals;
}

/** "2h 15min", "3min", "45s" — duração legível para o relatório. */
export function formatDuration(seconds: number | null): string {
  if (seconds == null) return "—";
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest > 0 ? `${hours}h ${rest}min` : `${hours}h`;
}

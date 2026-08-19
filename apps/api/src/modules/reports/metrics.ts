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

/** Fila atual de uma linha do relatório, por status do atendimento. */
export interface QueueByStatus {
  open: number;
  waitingClient: number;
  waitingInternal: number;
}

export const emptyQueue = (): QueueByStatus => ({
  open: 0,
  waitingClient: 0,
  waitingInternal: 0,
});

/** Uma linha do `groupBy` da fila, como o Prisma a devolve. */
export interface QueueEntry {
  assignedUserId: string | null;
  assignedToAll: boolean;
  status: string;
  count: number;
}

/** As três formas de fila que a tabela mostra, já separadas. */
export interface QueueBuckets {
  /** Fila de cada pessoa, por id */
  byUser: Map<string, QueueByStatus>;
  /** Conversas órfãs: sem responsável e sem marcação coletiva */
  unassigned: QueueByStatus;
  /** Atendimento coletivo ("@todos"): sem dono por decisão, não por falta */
  allUsers: QueueByStatus;
}

/**
 * Separa a fila em pessoa, coletivo e órfã.
 *
 * **Esta partição é a mesma de `lib/report-slice.ts`**, e tem que continuar
 * sendo: cada balde aqui é o número da célula, e o predicado de lá é o que o
 * painel manda para `GET /conversations`. Se as duas divergirem, a célula
 * diz "4" e o painel lista 3.
 *
 * A ordem dos testes importa: `assignedToAll` só vale quando não há
 * responsável (o banco garante a exclusão mútua, mas ler na ordem certa
 * deixa a regra visível aqui também), e o que sobra é a órfã de verdade.
 */
export function bucketQueueEntries(entries: QueueEntry[]): QueueBuckets {
  const byUser = new Map<string, QueueByStatus>();
  const unassigned = emptyQueue();
  const allUsers = emptyQueue();

  for (const entry of entries) {
    let queue: QueueByStatus;
    if (entry.assignedUserId) {
      queue = byUser.get(entry.assignedUserId) ?? emptyQueue();
      byUser.set(entry.assignedUserId, queue);
    } else if (entry.assignedToAll) {
      queue = allUsers;
    } else {
      queue = unassigned;
    }
    if (entry.status === "open") queue.open += entry.count;
    if (entry.status === "waiting_client") queue.waitingClient += entry.count;
    if (entry.status === "waiting_internal") queue.waitingInternal += entry.count;
  }

  return { byUser, unassigned, allUsers };
}

/** Soma das três colunas de fila — "na fila agora" daquela linha. */
export function queueTotal(queue: QueueByStatus): number {
  return queue.open + queue.waitingClient + queue.waitingInternal;
}

/** Soma célula a célula, para o total do cabeçalho de cada coluna. */
export function sumQueues(queues: QueueByStatus[]): QueueByStatus {
  return queues.reduce<QueueByStatus>(
    (sum, queue) => ({
      open: sum.open + queue.open,
      waitingClient: sum.waitingClient + queue.waitingClient,
      waitingInternal: sum.waitingInternal + queue.waitingInternal,
    }),
    emptyQueue(),
  );
}

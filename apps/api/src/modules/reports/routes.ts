import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { conversationScope, loadConversationAccess } from "../../lib/access.js";
import { requirePermission } from "../../lib/permissions.js";
import { resolvedHistoryWhere } from "../../lib/report-slice.js";
import { serializeUser } from "../../lib/serialize.js";
import {
  bucketQueueEntries,
  computeAgentTotals,
  emptyQueue,
  queueTotal,
  sumQueues,
  type QueueEntry,
  type ReportMessage,
} from "./metrics.js";
import type { AppDeps } from "../../types.js";

/**
 * Relatório de atendimentos por atendente.
 *
 * Quem abre é decidido pela chave `reports.view` do catálogo de permissões
 * (padrão: supervisor para cima) — são números de desempenho da equipe.
 * O recorte de acesso do próprio supervisor continua valendo — ele só
 * enxerga o movimento dos números e departamentos que já enxerga.
 */

const rangeSchema = z.object({
  from: z.string().datetime(),
  to: z.string().datetime(),
});

/** Teto de mensagens lidas por consulta, para o relatório não travar a API. */
const MAX_MESSAGES = 100_000;

export async function reportRoutes(app: FastifyInstance, deps: AppDeps): Promise<void> {
  app.get("/reports/agents", { preHandler: requirePermission(deps, "reports.view") }, async (request) => {
    const { from, to } = rangeSchema.parse(request.query);
    const start = new Date(from);
    const end = new Date(to);
    const organizationId = request.user.organizationId;

    const access = await loadConversationAccess(deps.prisma, request.user);
    // Arquivada não conta como trabalho de ninguém: o filtro entra POR CIMA
    // do escopo de acesso, em todas as consultas do relatório de uma vez.
    const scope = { ...conversationScope(access), archivedAt: null };

    const [users, messages, resolvedEntries, queueEntries, receivedCount] = await Promise.all([
      deps.prisma.user.findMany({
        where: { organizationId },
        orderBy: { name: "asc" },
      }),
      deps.prisma.message.findMany({
        where: {
          organizationId,
          conversation: scope,
          timestamp: { gte: start, lte: end },
        },
        select: {
          conversationId: true,
          direction: true,
          sentByUserId: true,
          timestamp: true,
        },
        orderBy: { timestamp: "asc" },
        take: MAX_MESSAGES,
      }),
      /**
       * Concluídas: quem clicou em concluir, no período.
       *
       * O agrupamento é por (pessoa, CONVERSA), e não só por pessoa, porque
       * a célula abre um painel com as conversas que a formam: contando
       * linhas de histórico, concluir e reabrir a mesma conversa duas vezes
       * daria 2 na célula e 1 no painel. Contando pares distintos, o número
       * é "quantas conversas ela fechou", que é o que a pergunta significa
       * e o que o painel consegue listar.
       */
      deps.prisma.conversationAssignmentHistory.groupBy({
        by: ["performedByUserId", "conversationId"],
        where: {
          organizationId,
          ...resolvedHistoryWhere(start, end),
          conversation: scope,
        },
        _count: { _all: true },
      }),
      /**
       * Fila atual por status — retrato de agora, não do período.
       *
       * `assignedToAll` entra no agrupamento para as três formas de fila
       * saírem de UMA consulta só: a de cada pessoa, a coletiva ("@todos") e
       * a órfã. As duas últimas não cabem em nenhuma linha de atendente — a
       * coletiva é de todo o departamento por decisão e a órfã não é de
       * ninguém —, e distribuí-las entre as pessoas inflaria a fila de todo
       * mundo com a mesma conversa. Por isso elas ganharam LINHA PRÓPRIA na
       * tabela, separadas uma da outra: antes ficavam fora do relatório
       * inteiro, e o buraco era do tamanho da fila sem dono.
       */
      deps.prisma.conversation.groupBy({
        by: ["assignedUserId", "assignedToAll", "status"],
        where: {
          organizationId,
          ...scope,
          status: { not: "resolved" },
        },
        _count: { _all: true },
      }),
      deps.prisma.message.count({
        where: {
          organizationId,
          conversation: scope,
          direction: "inbound",
          timestamp: { gte: start, lte: end },
        },
      }),
    ]);

    const totals = computeAgentTotals(messages as ReportMessage[]);
    // Pares (pessoa, conversa) distintos: cada um é uma conversa concluída.
    const resolvedByUser = new Map<string, number>();
    for (const entry of resolvedEntries) {
      if (!entry.performedByUserId) continue;
      resolvedByUser.set(
        entry.performedByUserId,
        (resolvedByUser.get(entry.performedByUserId) ?? 0) + 1,
      );
    }
    const buckets = bucketQueueEntries(
      queueEntries.map(
        (entry): QueueEntry => ({
          assignedUserId: entry.assignedUserId,
          assignedToAll: entry.assignedToAll,
          status: entry.status,
          count: entry._count._all,
        }),
      ),
    );

    const rows = users
      .map((user) => {
        const agent = totals.get(user.id);
        const queue = buckets.byUser.get(user.id) ?? emptyQueue();
        return {
          user: serializeUser(user),
          messagesSent: agent?.messagesSent ?? 0,
          conversationsHandled: agent?.conversationsHandled ?? 0,
          avgResponseSeconds: agent?.avgResponseSeconds ?? null,
          responsesMeasured: agent?.responsesMeasured ?? 0,
          conversationsResolved: resolvedByUser.get(user.id) ?? 0,
          queue,
          openNow: queueTotal(queue),
        };
      })
      // Quem não teve movimento nem fila no período fica de fora do relatório.
      .filter(
        (row) =>
          row.messagesSent > 0 || row.conversationsResolved > 0 || row.openNow > 0,
      );

    /**
     * As duas linhas que não são de ninguém. Elas não têm mensagens, tempo
     * médio nem concluídas: essas medidas pertencem a uma PESSOA, e um zero
     * ali seria lido como "não trabalhou", quando o certo é "não se aplica".
     * A tela mostra traço.
     */
    const unassigned = { queue: buckets.unassigned, openNow: queueTotal(buckets.unassigned) };
    const allUsers = { queue: buckets.allUsers, openNow: queueTotal(buckets.allUsers) };

    // O total do cabeçalho tem que bater com a soma VISÍVEL da coluna, e as
    // duas linhas sem dono estão visíveis: elas entram na soma.
    const queue = sumQueues([
      ...rows.map((row) => row.queue),
      unassigned.queue,
      allUsers.queue,
    ]);

    return {
      from: start.toISOString(),
      to: end.toISOString(),
      rows,
      unassigned,
      allUsers,
      totals: {
        messagesReceived: receivedCount,
        messagesSent: rows.reduce((sum, row) => sum + row.messagesSent, 0),
        conversationsResolved: rows.reduce((sum, row) => sum + row.conversationsResolved, 0),
        openNow: queueTotal(queue),
        queue,
      },
      // Avisa quando o período é grande demais e os números ficaram parciais.
      truncated: messages.length >= MAX_MESSAGES,
    };
  });
}

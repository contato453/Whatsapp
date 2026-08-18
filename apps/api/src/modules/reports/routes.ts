import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { conversationScope, loadConversationAccess } from "../../lib/access.js";
import { requirePermission } from "../../lib/permissions.js";
import { serializeUser } from "../../lib/serialize.js";
import { computeAgentTotals, type ReportMessage } from "./metrics.js";
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

/** Fila atual do atendente, por status do atendimento. */
interface QueueByStatus {
  open: number;
  waitingClient: number;
  waitingInternal: number;
}

const emptyQueue = (): QueueByStatus => ({ open: 0, waitingClient: 0, waitingInternal: 0 });

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

    const [users, messages, resolvedEntries, openConversations, receivedCount] = await Promise.all([
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
      // Concluídas: quem clicou em concluir, no período.
      deps.prisma.conversationAssignmentHistory.groupBy({
        by: ["performedByUserId"],
        where: {
          organizationId,
          action: "resolved",
          createdAt: { gte: start, lte: end },
          conversation: scope,
        },
        _count: { _all: true },
      }),
      /**
       * Fila atual por status — retrato de agora, não do período.
       *
       * `assignedUserId: { not: null }` já deixa a conversa coletiva
       * ("@todos") de fora, e é assim que tem que ser: ela não é trabalho de
       * ninguém em particular, e distribuí-la entre as pessoas inflaria a
       * fila de todo mundo com a mesma conversa. Buraco no relatório não há —
       * conversa sem responsável nunca apareceu aqui, coletiva ou órfã —,
       * então também não há linha própria a inventar.
       */
      deps.prisma.conversation.groupBy({
        by: ["assignedUserId", "status"],
        where: {
          organizationId,
          ...scope,
          status: { not: "resolved" },
          assignedUserId: { not: null },
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
    const resolvedByUser = new Map(
      resolvedEntries
        .filter((entry) => entry.performedByUserId)
        .map((entry) => [entry.performedByUserId as string, entry._count._all]),
    );
    // Um registro por atendente com a contagem de cada status da fila.
    const queueByUser = new Map<string, QueueByStatus>();
    for (const entry of openConversations) {
      if (!entry.assignedUserId) continue;
      const queue = queueByUser.get(entry.assignedUserId) ?? emptyQueue();
      if (entry.status === "open") queue.open = entry._count._all;
      if (entry.status === "waiting_client") queue.waitingClient = entry._count._all;
      if (entry.status === "waiting_internal") queue.waitingInternal = entry._count._all;
      queueByUser.set(entry.assignedUserId, queue);
    }

    const rows = users
      .map((user) => {
        const agent = totals.get(user.id);
        const queue = queueByUser.get(user.id) ?? emptyQueue();
        return {
          user: serializeUser(user),
          messagesSent: agent?.messagesSent ?? 0,
          conversationsHandled: agent?.conversationsHandled ?? 0,
          avgResponseSeconds: agent?.avgResponseSeconds ?? null,
          responsesMeasured: agent?.responsesMeasured ?? 0,
          conversationsResolved: resolvedByUser.get(user.id) ?? 0,
          queue,
          openNow: queue.open + queue.waitingClient + queue.waitingInternal,
        };
      })
      // Quem não teve movimento nem fila no período fica de fora do relatório.
      .filter(
        (row) =>
          row.messagesSent > 0 || row.conversationsResolved > 0 || row.openNow > 0,
      );

    return {
      from: start.toISOString(),
      to: end.toISOString(),
      rows,
      totals: {
        messagesReceived: receivedCount,
        messagesSent: rows.reduce((sum, row) => sum + row.messagesSent, 0),
        conversationsResolved: rows.reduce((sum, row) => sum + row.conversationsResolved, 0),
        openNow: rows.reduce((sum, row) => sum + row.openNow, 0),
        queue: rows.reduce(
          (sum, row) => ({
            open: sum.open + row.queue.open,
            waitingClient: sum.waitingClient + row.queue.waitingClient,
            waitingInternal: sum.waitingInternal + row.queue.waitingInternal,
          }),
          emptyQueue(),
        ),
      },
      // Avisa quando o período é grande demais e os números ficaram parciais.
      truncated: messages.length >= MAX_MESSAGES,
    };
  });
}

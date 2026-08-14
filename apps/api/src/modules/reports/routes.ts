import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { conversationScope, loadConversationAccess } from "../../lib/access.js";
import { requireRole } from "../../lib/auth.js";
import { serializeUser } from "../../lib/serialize.js";
import { computeAgentTotals, type ReportMessage } from "./metrics.js";
import type { AppDeps } from "../../types.js";

/**
 * Relatório de atendimentos por atendente.
 *
 * Restrito a supervisor/admin: são números de desempenho da equipe.
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
  app.get("/reports/agents", { preHandler: requireRole("supervisor") }, async (request) => {
    const { from, to } = rangeSchema.parse(request.query);
    const start = new Date(from);
    const end = new Date(to);
    const organizationId = request.user.organizationId;

    const access = await loadConversationAccess(deps.prisma, request.user);
    const scope = conversationScope(access);

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
      // Fila atual — retrato de agora, não do período.
      deps.prisma.conversation.groupBy({
        by: ["assignedUserId"],
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
    const openByUser = new Map(
      openConversations
        .filter((entry) => entry.assignedUserId)
        .map((entry) => [entry.assignedUserId as string, entry._count._all]),
    );

    const rows = users
      .map((user) => {
        const agent = totals.get(user.id);
        return {
          user: serializeUser(user),
          messagesSent: agent?.messagesSent ?? 0,
          conversationsHandled: agent?.conversationsHandled ?? 0,
          avgResponseSeconds: agent?.avgResponseSeconds ?? null,
          responsesMeasured: agent?.responsesMeasured ?? 0,
          conversationsResolved: resolvedByUser.get(user.id) ?? 0,
          openNow: openByUser.get(user.id) ?? 0,
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
      },
      // Avisa quando o período é grande demais e os números ficaram parciais.
      truncated: messages.length >= MAX_MESSAGES,
    };
  });
}

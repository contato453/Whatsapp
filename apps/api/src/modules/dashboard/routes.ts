import type { FastifyInstance } from "fastify";
import { CONVERSATION_STATUSES_ACTIVE } from "@azvchat/shared";
import { accessibleInstanceIds, instanceIdScope, instanceScope } from "../../lib/access.js";
import { authenticate } from "../../lib/auth.js";
import type { AppDeps } from "../../types.js";

export async function dashboardRoutes(app: FastifyInstance, deps: AppDeps): Promise<void> {
  app.get("/dashboard/stats", { preHandler: authenticate }, async (request) => {
    const organizationId = request.user.organizationId;
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);

    // Números que o usuário enxerga — os indicadores seguem o mesmo recorte.
    const allowed = await accessibleInstanceIds(deps.prisma, request.user);
    const instanceFilter = instanceIdScope(allowed);
    const conversationFilter = instanceScope(allowed);
    const messageFilter = allowed
      ? { conversation: { whatsappInstanceId: { in: allowed } } }
      : {};

    const [
      instancesConnected,
      instancesDisconnected,
      conversationsOpen,
      conversationsWaitingClient,
      conversationsWaitingInternal,
      conversationsUnassigned,
      messagesReceivedToday,
      messagesSentToday,
      byDepartment,
    ] = await Promise.all([
      deps.prisma.whatsAppInstance.count({
        where: { organizationId, ...instanceFilter, status: "connected" },
      }),
      deps.prisma.whatsAppInstance.count({
        where: { organizationId, ...instanceFilter, status: { not: "connected" } },
      }),
      deps.prisma.conversation.count({
        where: { organizationId, ...conversationFilter, status: "open" },
      }),
      deps.prisma.conversation.count({
        where: { organizationId, ...conversationFilter, status: "waiting_client" },
      }),
      deps.prisma.conversation.count({
        where: { organizationId, ...conversationFilter, status: "waiting_internal" },
      }),
      deps.prisma.conversation.count({
        where: {
          organizationId,
          ...conversationFilter,
          assignedUserId: null,
          status: { in: [...CONVERSATION_STATUSES_ACTIVE] },
        },
      }),
      deps.prisma.message.count({
        where: {
          organizationId,
          ...messageFilter,
          direction: "inbound",
          timestamp: { gte: startOfDay },
        },
      }),
      deps.prisma.message.count({
        where: {
          organizationId,
          ...messageFilter,
          direction: "outbound",
          timestamp: { gte: startOfDay },
        },
      }),
      deps.prisma.conversation.groupBy({
        by: ["departmentId"],
        where: {
          organizationId,
          ...conversationFilter,
          status: { in: [...CONVERSATION_STATUSES_ACTIVE] },
        },
        _count: { _all: true },
      }),
    ]);

    const departments = await deps.prisma.department.findMany({
      where: { organizationId },
      select: { id: true, name: true },
    });
    const departmentNames = new Map(departments.map((dept) => [dept.id, dept.name]));

    return {
      instancesConnected,
      instancesDisconnected,
      conversationsOpen,
      conversationsWaitingClient,
      conversationsWaitingInternal,
      conversationsUnassigned,
      messagesReceivedToday,
      messagesSentToday,
      conversationsByDepartment: byDepartment.map((entry) => ({
        departmentId: entry.departmentId,
        departmentName: entry.departmentId
          ? (departmentNames.get(entry.departmentId) ?? "Removido")
          : "Sem departamento",
        count: entry._count._all,
      })),
    };
  });
}

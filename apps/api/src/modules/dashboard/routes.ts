import type { FastifyInstance } from "fastify";
import { authenticate } from "../../lib/auth.js";
import type { AppDeps } from "../../types.js";

export async function dashboardRoutes(app: FastifyInstance, deps: AppDeps): Promise<void> {
  app.get("/dashboard/stats", { preHandler: authenticate }, async (request) => {
    const organizationId = request.user.organizationId;
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);

    const [
      instancesConnected,
      instancesDisconnected,
      conversationsOpen,
      conversationsWaiting,
      conversationsUnassigned,
      messagesReceivedToday,
      messagesSentToday,
      byDepartment,
    ] = await Promise.all([
      deps.prisma.whatsAppInstance.count({
        where: { organizationId, status: "connected" },
      }),
      deps.prisma.whatsAppInstance.count({
        where: { organizationId, status: { not: "connected" } },
      }),
      deps.prisma.conversation.count({
        where: { organizationId, status: { in: ["new", "open"] } },
      }),
      deps.prisma.conversation.count({ where: { organizationId, status: "waiting" } }),
      deps.prisma.conversation.count({
        where: { organizationId, assignedUserId: null, status: { in: ["new", "open", "waiting"] } },
      }),
      deps.prisma.message.count({
        where: { organizationId, direction: "inbound", timestamp: { gte: startOfDay } },
      }),
      deps.prisma.message.count({
        where: { organizationId, direction: "outbound", timestamp: { gte: startOfDay } },
      }),
      deps.prisma.conversation.groupBy({
        by: ["departmentId"],
        where: { organizationId, status: { in: ["new", "open", "waiting"] } },
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
      conversationsWaiting,
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

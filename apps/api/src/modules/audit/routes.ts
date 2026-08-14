import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireRole } from "../../lib/auth.js";
import type { AppDeps } from "../../types.js";

const listSchema = z.object({
  limit: z.coerce.number().min(1).max(200).default(50),
  offset: z.coerce.number().min(0).default(0),
});

export async function auditRoutes(app: FastifyInstance, deps: AppDeps): Promise<void> {
  app.get("/audit-logs", { preHandler: requireRole("supervisor") }, async (request) => {
    const { limit, offset } = listSchema.parse(request.query);
    const logs = await deps.prisma.auditLog.findMany({
      where: { organizationId: request.user.organizationId },
      orderBy: { createdAt: "desc" },
      take: limit,
      skip: offset,
      include: { user: { select: { id: true, name: true } } },
    });
    return {
      logs: logs.map((log) => ({
        id: log.id,
        action: log.action,
        entityType: log.entityType,
        entityId: log.entityId,
        user: log.user,
        metadata: log.metadata,
        createdAt: log.createdAt.toISOString(),
      })),
    };
  });
}

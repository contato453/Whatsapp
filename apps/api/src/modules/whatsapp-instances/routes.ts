import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { accessibleInstanceIds, instanceIdScope } from "../../lib/access.js";
import { authenticate, requireRole } from "../../lib/auth.js";
import { NotFoundError } from "../../lib/errors.js";
import { serializeInstance } from "../../lib/serialize.js";
import type { AppDeps } from "../../types.js";

const createInstanceSchema = z.object({
  name: z.string().min(2).max(80),
});

export async function whatsappInstanceRoutes(app: FastifyInstance, deps: AppDeps): Promise<void> {
  async function findInstanceOr404(id: string, user: FastifyRequest["user"]) {
    const allowed = await accessibleInstanceIds(deps.prisma, user);
    const instance = await deps.prisma.whatsAppInstance.findFirst({
      where: { id, organizationId: user.organizationId, ...instanceIdScope(allowed) },
    });
    if (!instance) throw new NotFoundError("Instância de WhatsApp");
    return instance;
  }

  app.get("/whatsapp-instances", { preHandler: authenticate }, async (request) => {
    // Atendentes com acesso restrito só enxergam os números liberados para eles.
    const allowed = await accessibleInstanceIds(deps.prisma, request.user);
    const instances = await deps.prisma.whatsAppInstance.findMany({
      where: { organizationId: request.user.organizationId, ...instanceIdScope(allowed) },
      orderBy: { createdAt: "asc" },
    });
    return { instances: instances.map(serializeInstance) };
  });

  app.post(
    "/whatsapp-instances",
    { preHandler: requireRole("supervisor") },
    async (request, reply) => {
      const body = createInstanceSchema.parse(request.body);
      const instance = await deps.prisma.whatsAppInstance.create({
        data: {
          organizationId: request.user.organizationId,
          name: body.name,
          provider: "qrcode",
        },
      });
      deps.instanceManager.registerInstance(instance.id, instance.organizationId);
      deps.audit.record({
        organizationId: request.user.organizationId,
        userId: request.user.sub,
        action: "whatsapp.instance_created",
        entityType: "WhatsAppInstance",
        entityId: instance.id,
      });
      return reply.status(201).send({ instance: serializeInstance(instance) });
    },
  );

  app.post(
    "/whatsapp-instances/:id/connect",
    { preHandler: requireRole("supervisor") },
    async (request) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
      const instance = await findInstanceOr404(id, request.user);
      deps.instanceManager.registerInstance(instance.id, instance.organizationId);
      await deps.provider.connect(instance.id);
      const status = await deps.provider.getConnectionStatus(instance.id);
      const qrDataUrl = await deps.provider.getQRCode(instance.id);
      return { status, qrDataUrl };
    },
  );

  app.post(
    "/whatsapp-instances/:id/disconnect",
    { preHandler: requireRole("supervisor") },
    async (request) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
      await findInstanceOr404(id, request.user);
      await deps.provider.disconnect(id);
      deps.audit.record({
        organizationId: request.user.organizationId,
        userId: request.user.sub,
        action: "whatsapp.disconnected",
        entityType: "WhatsAppInstance",
        entityId: id,
      });
      return { ok: true };
    },
  );

  app.post(
    "/whatsapp-instances/:id/logout",
    { preHandler: requireRole("supervisor") },
    async (request) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
      await findInstanceOr404(id, request.user);
      await deps.provider.logout(id);
      deps.audit.record({
        organizationId: request.user.organizationId,
        userId: request.user.sub,
        action: "whatsapp.logged_out",
        entityType: "WhatsAppInstance",
        entityId: id,
      });
      return { ok: true };
    },
  );

  app.get("/whatsapp-instances/:id/qr", { preHandler: authenticate }, async (request) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    await findInstanceOr404(id, request.user);
    const [status, qrDataUrl] = await Promise.all([
      deps.provider.getConnectionStatus(id),
      deps.provider.getQRCode(id),
    ]);
    return { status, qrDataUrl };
  });

  app.delete(
    "/whatsapp-instances/:id",
    { preHandler: requireRole("admin") },
    async (request) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
      await findInstanceOr404(id, request.user);
      await deps.provider.logout(id).catch(() => undefined);
      await deps.prisma.whatsAppInstance.delete({ where: { id } });
      deps.audit.record({
        organizationId: request.user.organizationId,
        userId: request.user.sub,
        action: "whatsapp.instance_deleted",
        entityType: "WhatsAppInstance",
        entityId: id,
      });
      return { ok: true };
    },
  );
}

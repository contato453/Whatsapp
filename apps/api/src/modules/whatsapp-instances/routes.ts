import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { accessibleInstanceIds, instanceIdScope } from "../../lib/access.js";
import { authenticate, requireRole } from "../../lib/auth.js";
import { NotFoundError } from "../../lib/errors.js";
import { grantInstanceAccess } from "../../realtime/socket.js";
import { serializeInstance } from "../../lib/serialize.js";
import type { AppDeps } from "../../types.js";

const createInstanceSchema = z.object({
  name: z.string().min(2).max(80),
  /** Departamento em que as conversas deste número entram por padrão. */
  departmentId: z.string().uuid().nullable().optional(),
});

const updateInstanceSchema = z.object({
  name: z.string().min(2).max(80).optional(),
  departmentId: z.string().uuid().nullable().optional(),
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

  /** Garante que o departamento informado pertence à organização. */
  async function assertDepartmentInOrg(
    departmentId: string | null | undefined,
    organizationId: string,
  ): Promise<void> {
    if (!departmentId) return;
    const found = await deps.prisma.department.findFirst({
      where: { id: departmentId, organizationId },
      select: { id: true },
    });
    if (!found) throw new NotFoundError("Departamento");
  }

  app.post(
    "/whatsapp-instances",
    { preHandler: requireRole("supervisor") },
    async (request, reply) => {
      const body = createInstanceSchema.parse(request.body);
      await assertDepartmentInOrg(body.departmentId, request.user.organizationId);

      /**
       * Quem cria o número passa a enxergá-lo. Visibilidade sai só de
       * vínculo explícito, então sem isto o supervisor criava a conexão e
       * em seguida tomava 404 ao tentar conectá-la: o número não estava
       * em lugar nenhum até um administrador vinculá-lo à mão.
       *
       * Admin não precisa de vínculo — enxerga a organização inteira.
       */
      const linkCreator = request.user.role !== "admin";
      const instance = await deps.prisma.$transaction(async (tx) => {
        const created = await tx.whatsAppInstance.create({
          data: {
            organizationId: request.user.organizationId,
            name: body.name,
            departmentId: body.departmentId ?? null,
            provider: "qrcode",
          },
        });
        if (linkCreator) {
          await tx.userWhatsAppInstance.create({
            data: { userId: request.user.sub, whatsappInstanceId: created.id },
          });
        }
        return created;
      });

      deps.instanceManager.registerInstance(instance.id, instance.organizationId);
      if (linkCreator) {
        // O acesso vale para a sessão que já está aberta, não só na próxima.
        grantInstanceAccess(deps.io, request.user.sub, instance.id);
      }
      deps.audit.record({
        organizationId: request.user.organizationId,
        userId: request.user.sub,
        action: "whatsapp.instance_created",
        entityType: "WhatsAppInstance",
        entityId: instance.id,
        ...(linkCreator ? { metadata: { linkedToCreator: request.user.sub } } : {}),
      });
      return reply.status(201).send({ instance: serializeInstance(instance) });
    },
  );

  app.patch(
    "/whatsapp-instances/:id",
    { preHandler: requireRole("supervisor") },
    async (request) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
      const body = updateInstanceSchema.parse(request.body);
      await findInstanceOr404(id, request.user);
      await assertDepartmentInOrg(body.departmentId, request.user.organizationId);
      const instance = await deps.prisma.whatsAppInstance.update({
        where: { id },
        data: {
          ...(body.name ? { name: body.name } : {}),
          ...(body.departmentId !== undefined ? { departmentId: body.departmentId } : {}),
        },
      });
      deps.audit.record({
        organizationId: request.user.organizationId,
        userId: request.user.sub,
        action: "whatsapp.instance_updated",
        entityType: "WhatsAppInstance",
        entityId: id,
        metadata: { departmentId: body.departmentId ?? null },
      });
      return { instance: serializeInstance(instance) };
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

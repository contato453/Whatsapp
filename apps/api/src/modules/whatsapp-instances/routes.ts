import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { RealtimeEvents } from "@azvchat/shared";
import { accessibleInstanceIds, instanceIdScope } from "../../lib/access.js";
import { authenticate, requireRole } from "../../lib/auth.js";
import { AppError, NotFoundError } from "../../lib/errors.js";
import { grantInstanceAccess } from "../../realtime/socket.js";
import {
  serializeConversation,
  serializeInstance,
  serializeUserDirectory,
} from "../../lib/serialize.js";
import {
  eligibleAssigneeWhere,
  loadAssigneeReach,
  reachableConversationFilter,
} from "../../lib/default-assignee.js";
import { conversationInclude } from "../../lib/conversation-events.js";
import { conversationAudience } from "../../realtime/socket.js";
import type { AppDeps } from "../../types.js";

const createInstanceSchema = z.object({
  name: z.string().min(2).max(80),
  /** Departamento em que as conversas deste número entram por padrão. */
  departmentId: z.string().uuid().nullable().optional(),
  // Sem responsável padrão na criação de propósito: só quem tem o número
  // vinculado pode recebê-lo, e no instante da criação isso é só quem criou.
});

const updateInstanceSchema = z.object({
  name: z.string().min(2).max(80).optional(),
  departmentId: z.string().uuid().nullable().optional(),
  /** Responsável padrão das conversas deste número — null remove. */
  defaultAssigneeId: z.string().uuid().nullable().optional(),
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

  /**
   * Um responsável padrão que não enxerga o número receberia conversas
   * invisíveis para ele — a atribuição existiria só no banco. Mesma regra
   * do responsável padrão do departamento, aplicada ao número.
   */
  async function assertCanBeDefaultAssignee(
    userId: string,
    instanceId: string,
    organizationId: string,
  ): Promise<void> {
    const eligible = await deps.prisma.user.findFirst({
      where: eligibleAssigneeWhere({ userId, organizationId, whatsappInstanceId: instanceId }),
      select: { id: true },
    });
    if (eligible) return;
    // Distingue os dois motivos: o cadastro errado e o acesso faltando.
    const user = await deps.prisma.user.findFirst({
      where: { id: userId, organizationId },
      select: { status: true },
    });
    if (!user) throw new AppError("Usuário inválido", 400, "invalid_user");
    if (user.status !== "active") {
      throw new AppError("Usuário inativo não pode ser responsável", 400, "inactive_user");
    }
    throw new AppError(
      "Este usuário não tem acesso a este número",
      400,
      "user_without_instance_access",
    );
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
      if (body.defaultAssigneeId) {
        await assertCanBeDefaultAssignee(
          body.defaultAssigneeId,
          id,
          request.user.organizationId,
        );
      }
      const instance = await deps.prisma.whatsAppInstance.update({
        where: { id },
        data: {
          ...(body.name ? { name: body.name } : {}),
          ...(body.departmentId !== undefined ? { departmentId: body.departmentId } : {}),
          ...(body.defaultAssigneeId !== undefined
            ? { defaultAssigneeId: body.defaultAssigneeId }
            : {}),
        },
      });
      deps.audit.record({
        organizationId: request.user.organizationId,
        userId: request.user.sub,
        action: "whatsapp.instance_updated",
        entityType: "WhatsAppInstance",
        entityId: id,
        metadata: {
          departmentId: body.departmentId ?? null,
          ...(body.defaultAssigneeId !== undefined
            ? { defaultAssigneeId: body.defaultAssigneeId }
            : {}),
        },
      });
      return { instance: serializeInstance(instance) };
    },
  );

  /**
   * Quem pode ser responsável padrão deste número: os ativos que o têm
   * vinculado, mais os administradores, que enxergam tudo. A tela oferece
   * só o que a API vai aceitar, em vez de deixar escolher e recusar depois.
   */
  app.get(
    "/whatsapp-instances/:id/assignees",
    { preHandler: requireRole("supervisor") },
    async (request) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
      await findInstanceOr404(id, request.user);
      const users = await deps.prisma.user.findMany({
        where: {
          organizationId: request.user.organizationId,
          status: "active",
          OR: [{ role: "admin" }, { whatsappAccess: { some: { whatsappInstanceId: id } } }],
        },
        orderBy: { name: "asc" },
      });
      return { users: users.map(serializeUserDirectory) };
    },
  );

  /**
   * Aplica o responsável padrão às conversas que já existem sem responsável.
   *
   * O padrão só age na mensagem que chega, então a conversa parada ficaria
   * órfã até alguém escrever nela — justamente a que mais precisa de dono.
   * É explícito, e não automático ao salvar o cadastro, porque mexe em
   * conversa antiga em lote: quem clica sabe o que está fazendo.
   */
  app.post(
    "/whatsapp-instances/:id/apply-default-assignee",
    { preHandler: requireRole("supervisor") },
    async (request) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
      const instance = await findInstanceOr404(id, request.user);
      if (!instance.defaultAssigneeId) {
        throw new AppError(
          "Este número não tem responsável padrão configurado",
          400,
          "instance_without_default_assignee",
        );
      }
      const assigneeId = instance.defaultAssigneeId;
      const reach = await loadAssigneeReach(deps.prisma, {
        userId: assigneeId,
        organizationId: request.user.organizationId,
        whatsappInstanceId: id,
      });
      if (!reach) {
        throw new AppError(
          "O responsável padrão não tem mais acesso a este número",
          400,
          "user_without_instance_access",
        );
      }

      // Só as que essa pessoa enxerga: conversa de departamento em que ela
      // não atua sairia da fila e sumiria da tela de todo mundo.
      const targets = await deps.prisma.conversation.findMany({
        where: {
          organizationId: request.user.organizationId,
          whatsappInstanceId: id,
          assignedUserId: null,
          ...reachableConversationFilter(reach),
        },
        select: { id: true, departmentId: true },
      });
      if (targets.length === 0) return { assigned: 0 };

      const ids = targets.map((conversation) => conversation.id);
      await deps.prisma.$transaction([
        deps.prisma.conversation.updateMany({
          where: { id: { in: ids } },
          data: { assignedUserId: assigneeId },
        }),
        deps.prisma.conversationAssignmentHistory.createMany({
          data: targets.map((conversation) => ({
            organizationId: request.user.organizationId,
            conversationId: conversation.id,
            action: "assigned" as const,
            toUserId: assigneeId,
            toDepartmentId: conversation.departmentId,
            // Com "performedBy": diferente da atribuição automática, esta
            // saiu do clique de alguém.
            performedByUserId: request.user.sub,
            note: "Responsável padrão do número",
          })),
        }),
      ]);

      deps.audit.record({
        organizationId: request.user.organizationId,
        userId: request.user.sub,
        action: "whatsapp.default_assignee_applied",
        entityType: "WhatsAppInstance",
        entityId: id,
        metadata: { defaultAssigneeId: assigneeId, conversations: ids.length },
      });

      // A conversa muda de sala ao ganhar responsável; sem o evento, quem
      // está com a Inbox aberta continuaria vendo "Sem responsável".
      const updated = await deps.prisma.conversation.findMany({
        where: { id: { in: ids } },
        include: conversationInclude,
      });
      for (const conversation of updated) {
        deps.io
          .to(conversationAudience(request.user.organizationId, conversation))
          .emit(RealtimeEvents.ConversationUpdated, serializeConversation(conversation));
      }

      return { assigned: ids.length };
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

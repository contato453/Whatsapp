import type { FastifyInstance } from "fastify";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { authenticate, requireRole } from "../../lib/auth.js";
import { AppError, NotFoundError } from "../../lib/errors.js";
import { serializeUserWithAccess } from "../../lib/serialize.js";
import type { AppDeps } from "../../types.js";

/** Lista de conexões liberadas — vazia significa "todas". */
const instanceIdsSchema = z.array(z.string().uuid()).max(100);

const createUserSchema = z.object({
  name: z.string().min(2).max(120),
  email: z.string().email(),
  password: z.string().min(6, "Senha deve ter no mínimo 6 caracteres").max(72),
  role: z.enum(["admin", "supervisor", "agent"]).default("agent"),
  /** Prefixa as mensagens enviadas com o nome do atendente */
  signMessages: z.boolean().optional(),
  whatsappInstanceIds: instanceIdsSchema.optional(),
});

const updateUserSchema = z.object({
  name: z.string().min(2).max(120).optional(),
  email: z.string().email().optional(),
  password: z.string().min(6).max(72).optional(),
  role: z.enum(["admin", "supervisor", "agent"]).optional(),
  status: z.enum(["active", "inactive"]).optional(),
  signMessages: z.boolean().optional(),
  whatsappInstanceIds: instanceIdsSchema.optional(),
});

export async function userRoutes(app: FastifyInstance, deps: AppDeps): Promise<void> {
  /** Garante que todas as conexões informadas pertencem à organização. */
  async function assertInstancesInOrg(ids: string[], organizationId: string): Promise<string[]> {
    const unique = [...new Set(ids)];
    if (unique.length === 0) return [];
    const found = await deps.prisma.whatsAppInstance.findMany({
      where: { id: { in: unique }, organizationId },
      select: { id: true },
    });
    if (found.length !== unique.length) {
      throw new AppError("Conexão de WhatsApp inválida", 400, "invalid_instance");
    }
    return unique;
  }

  app.get("/users", { preHandler: authenticate }, async (request) => {
    const users = await deps.prisma.user.findMany({
      where: { organizationId: request.user.organizationId },
      orderBy: { name: "asc" },
      include: { whatsappAccess: { select: { whatsappInstanceId: true } } },
    });
    return { users: users.map(serializeUserWithAccess) };
  });

  app.post("/users", { preHandler: requireRole("admin") }, async (request, reply) => {
    const body = createUserSchema.parse(request.body);
    const existing = await deps.prisma.user.findUnique({ where: { email: body.email } });
    if (existing) {
      throw new AppError("Já existe um usuário com este e-mail", 409, "email_taken");
    }
    const instanceIds = await assertInstancesInOrg(
      body.whatsappInstanceIds ?? [],
      request.user.organizationId,
    );
    const user = await deps.prisma.user.create({
      data: {
        organizationId: request.user.organizationId,
        name: body.name,
        email: body.email,
        passwordHash: await bcrypt.hash(body.password, 10),
        role: body.role,
        signMessages: body.signMessages ?? false,
        whatsappAccess: {
          create: instanceIds.map((whatsappInstanceId) => ({ whatsappInstanceId })),
        },
      },
      include: { whatsappAccess: { select: { whatsappInstanceId: true } } },
    });
    deps.audit.record({
      organizationId: request.user.organizationId,
      userId: request.user.sub,
      action: "user.created",
      entityType: "User",
      entityId: user.id,
    });
    return reply.status(201).send({ user: serializeUserWithAccess(user) });
  });

  app.patch("/users/:id", { preHandler: requireRole("admin") }, async (request) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const body = updateUserSchema.parse(request.body);
    const user = await deps.prisma.user.findFirst({
      where: { id, organizationId: request.user.organizationId },
    });
    if (!user) throw new NotFoundError("Usuário");

    // Evita que o admin logado se tranque para fora do sistema.
    if (id === request.user.sub) {
      if (body.role && body.role !== user.role) {
        throw new AppError("Você não pode alterar o seu próprio papel", 400, "self_role_change");
      }
      if (body.status && body.status !== user.status) {
        throw new AppError("Você não pode desativar a si mesmo", 400, "self_status_change");
      }
    }

    if (body.email && body.email !== user.email) {
      const emailOwner = await deps.prisma.user.findUnique({ where: { email: body.email } });
      if (emailOwner) {
        throw new AppError("Já existe um usuário com este e-mail", 409, "email_taken");
      }
    }

    const instanceIds = body.whatsappInstanceIds
      ? await assertInstancesInOrg(body.whatsappInstanceIds, request.user.organizationId)
      : null;

    const updated = await deps.prisma.$transaction(async (tx) => {
      if (instanceIds) {
        await tx.userWhatsAppInstance.deleteMany({ where: { userId: id } });
        if (instanceIds.length > 0) {
          await tx.userWhatsAppInstance.createMany({
            data: instanceIds.map((whatsappInstanceId) => ({ userId: id, whatsappInstanceId })),
          });
        }
      }
      return tx.user.update({
        where: { id },
        data: {
          ...(body.name ? { name: body.name } : {}),
          ...(body.email ? { email: body.email } : {}),
          ...(body.role ? { role: body.role } : {}),
          ...(body.status ? { status: body.status } : {}),
          ...(body.signMessages === undefined ? {} : { signMessages: body.signMessages }),
          ...(body.password ? { passwordHash: await bcrypt.hash(body.password, 10) } : {}),
        },
        include: { whatsappAccess: { select: { whatsappInstanceId: true } } },
      });
    });

    deps.audit.record({
      organizationId: request.user.organizationId,
      userId: request.user.sub,
      action: "user.updated",
      entityType: "User",
      entityId: id,
      ...(instanceIds ? { metadata: { whatsappInstanceIds: instanceIds } } : {}),
    });
    return { user: serializeUserWithAccess(updated) };
  });
}

import type { FastifyInstance } from "fastify";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { hasRole } from "@azvchat/shared";
import { authenticate, requireRole } from "../../lib/auth.js";
import { AppError, NotFoundError } from "../../lib/errors.js";
import { serializeUserDirectory, serializeUserWithAccess } from "../../lib/serialize.js";
import type { AppDeps } from "../../types.js";

/** Conexões liberadas. Lista vazia = o usuário não enxerga conversa alguma. */
const instanceIdsSchema = z.array(z.string().uuid()).max(100);
/** Departamentos em que atua. Lista vazia = não enxerga conversa alguma. */
const departmentIdsSchema = z.array(z.string().uuid()).max(100);

const createUserSchema = z.object({
  name: z.string().min(2).max(120),
  email: z.string().email(),
  password: z.string().min(6, "Senha deve ter no mínimo 6 caracteres").max(72),
  role: z.enum(["admin", "supervisor", "agent"]).default("agent"),
  /** Prefixa as mensagens enviadas com o nome do atendente */
  signMessages: z.boolean().optional(),
  whatsappInstanceIds: instanceIdsSchema.optional(),
  departmentIds: departmentIdsSchema.optional(),
});

const updateUserSchema = z.object({
  name: z.string().min(2).max(120).optional(),
  email: z.string().email().optional(),
  password: z.string().min(6).max(72).optional(),
  role: z.enum(["admin", "supervisor", "agent"]).optional(),
  status: z.enum(["active", "inactive"]).optional(),
  signMessages: z.boolean().optional(),
  whatsappInstanceIds: instanceIdsSchema.optional(),
  departmentIds: departmentIdsSchema.optional(),
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

  /** Garante que todos os departamentos informados pertencem à organização. */
  async function assertDepartmentsInOrg(ids: string[], organizationId: string): Promise<string[]> {
    const unique = [...new Set(ids)];
    if (unique.length === 0) return [];
    const found = await deps.prisma.department.findMany({
      where: { id: { in: unique }, organizationId },
      select: { id: true },
    });
    if (found.length !== unique.length) {
      throw new AppError("Departamento inválido", 400, "invalid_department");
    }
    return unique;
  }

  /**
   * Duas listas na mesma rota, porque servem a duas coisas diferentes.
   *
   * Para o administrador é o cadastro: todo mundo, inclusive inativos, com
   * e-mail, último acesso e o mapa de números e departamentos de cada um.
   *
   * Para supervisor e usuário é só a agenda interna que abastece o seletor
   * de responsável — nome e nada mais, sem inativos (não faz sentido
   * atribuir conversa a quem não entra mais no sistema). Quem atende não
   * precisa saber o e-mail nem o recorte de acesso dos colegas.
   */
  app.get("/users", { preHandler: authenticate }, async (request) => {
    if (!hasRole(request.user.role, "admin")) {
      const directory = await deps.prisma.user.findMany({
        where: { organizationId: request.user.organizationId, status: "active" },
        orderBy: { name: "asc" },
      });
      return { users: directory.map(serializeUserDirectory) };
    }
    const users = await deps.prisma.user.findMany({
      where: { organizationId: request.user.organizationId },
      orderBy: { name: "asc" },
      include: {
        whatsappAccess: { select: { whatsappInstanceId: true } },
        departmentAccess: { select: { departmentId: true } },
      },
    });
    return { users: users.map(serializeUserWithAccess) };
  });

  app.post("/users", { preHandler: requireRole("admin") }, async (request, reply) => {
    const body = createUserSchema.parse(request.body);
    const existing = await deps.prisma.user.findUnique({ where: { email: body.email } });
    if (existing) {
      throw new AppError("Já existe um usuário com este e-mail", 409, "email_taken");
    }
    const [instanceIds, departmentIds] = await Promise.all([
      assertInstancesInOrg(body.whatsappInstanceIds ?? [], request.user.organizationId),
      assertDepartmentsInOrg(body.departmentIds ?? [], request.user.organizationId),
    ]);
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
        departmentAccess: {
          create: departmentIds.map((departmentId) => ({ departmentId })),
        },
      },
      include: {
        whatsappAccess: { select: { whatsappInstanceId: true } },
        departmentAccess: { select: { departmentId: true } },
      },
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
    const departmentIds = body.departmentIds
      ? await assertDepartmentsInOrg(body.departmentIds, request.user.organizationId)
      : null;

    /**
     * A organização nunca pode ficar sem administrador ativo — sem ninguém
     * para criar usuário, liberar número ou reativar quem foi desativado, o
     * conserto só sai no banco.
     *
     * A trava de auto-edição acima já cobre o caso simples (o último admin
     * não se rebaixa nem se desativa). O que sobra é dois administradores
     * se rebaixando um ao outro ao mesmo tempo, e é por isso que a
     * verificação vive dentro da transação, com as linhas travadas.
     */
    const removesAdmin =
      user.role === "admin" &&
      ((body.role != null && body.role !== "admin") || body.status === "inactive");

    const updated = await deps.prisma.$transaction(async (tx) => {
      if (removesAdmin) {
        // Segura os admins ativos até o fim da transação: sem o FOR UPDATE,
        // as duas requisições simultâneas leriam "ainda existe outro" e as
        // duas passariam, zerando a administração.
        await tx.$queryRaw`
          SELECT id FROM users
          WHERE "organizationId" = ${request.user.organizationId}
            AND role::text = 'admin'
            AND status::text = 'active'
          FOR UPDATE`;
        const remaining = await tx.user.count({
          where: {
            organizationId: request.user.organizationId,
            role: "admin",
            status: "active",
            id: { not: id },
          },
        });
        if (remaining === 0) {
          throw new AppError(
            "A organização precisa de pelo menos um administrador ativo",
            400,
            "last_admin",
          );
        }
      }
      if (instanceIds) {
        await tx.userWhatsAppInstance.deleteMany({ where: { userId: id } });
        if (instanceIds.length > 0) {
          await tx.userWhatsAppInstance.createMany({
            data: instanceIds.map((whatsappInstanceId) => ({ userId: id, whatsappInstanceId })),
          });
        }
      }
      if (departmentIds) {
        await tx.userDepartment.deleteMany({ where: { userId: id } });
        if (departmentIds.length > 0) {
          await tx.userDepartment.createMany({
            data: departmentIds.map((departmentId) => ({ userId: id, departmentId })),
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
        include: {
          whatsappAccess: { select: { whatsappInstanceId: true } },
          departmentAccess: { select: { departmentId: true } },
        },
      });
    });

    deps.audit.record({
      organizationId: request.user.organizationId,
      userId: request.user.sub,
      action: "user.updated",
      entityType: "User",
      entityId: id,
      ...(instanceIds || departmentIds
        ? {
            metadata: {
              ...(instanceIds ? { whatsappInstanceIds: instanceIds } : {}),
              ...(departmentIds ? { departmentIds } : {}),
            },
          }
        : {}),
    });
    return { user: serializeUserWithAccess(updated) };
  });
}

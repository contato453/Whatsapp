import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { accessibleDepartmentIds } from "../../lib/access.js";
import { authenticate, requireRole } from "../../lib/auth.js";
import { AppError, NotFoundError } from "../../lib/errors.js";
import { serializeDepartment } from "../../lib/serialize.js";
import type { AppDeps } from "../../types.js";

const departmentSchema = z.object({
  name: z.string().min(2).max(80),
  description: z.string().max(500).optional(),
  color: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/, "Cor deve estar no formato #RRGGBB")
    .optional(),
  /** Responsável padrão — null remove */
  defaultAssigneeId: z.string().uuid().nullable().optional(),
});

export async function departmentRoutes(app: FastifyInstance, deps: AppDeps): Promise<void> {
  /**
   * Um responsável padrão que não enxerga o próprio departamento receberia
   * conversas invisíveis para ele — a atribuição existiria só no banco.
   * Admin é a exceção: enxerga a organização inteira.
   */
  async function assertCanBeDefaultAssignee(
    userId: string,
    departmentId: string | null,
    organizationId: string,
  ): Promise<void> {
    const user = await deps.prisma.user.findFirst({
      where: { id: userId, organizationId },
      select: { role: true, status: true },
    });
    if (!user) throw new AppError("Usuário inválido", 400, "invalid_user");
    if (user.status !== "active") {
      throw new AppError("Usuário inativo não pode ser responsável", 400, "inactive_user");
    }
    if (user.role === "admin") return;
    // Departamento novo ainda não tem id: a checagem roda depois de criado.
    if (!departmentId) return;
    const link = await deps.prisma.userDepartment.findUnique({
      where: { userId_departmentId: { userId, departmentId } },
    });
    if (!link) {
      throw new AppError(
        "Este usuário não tem acesso a este departamento",
        400,
        "user_without_department_access",
      );
    }
  }

  app.get("/departments", { preHandler: authenticate }, async (request) => {
    const departments = await deps.prisma.department.findMany({
      where: { organizationId: request.user.organizationId },
      orderBy: { name: "asc" },
    });
    return { departments: departments.map(serializeDepartment) };
  });

  /**
   * Os departamentos em que a pessoa pode criar etiquetas e respostas
   * rápidas. Admin recebe todos. Serve para a tela oferecer só o que a API
   * vai aceitar, em vez de deixar escolher e recusar depois.
   */
  app.get("/departments/mine", { preHandler: authenticate }, async (request) => {
    const ids = await accessibleDepartmentIds(deps.prisma, request.user);
    const departments = await deps.prisma.department.findMany({
      where: {
        organizationId: request.user.organizationId,
        ...(ids ? { id: { in: ids } } : {}),
      },
      orderBy: { name: "asc" },
    });
    return { departments: departments.map(serializeDepartment) };
  });

  app.post("/departments", { preHandler: requireRole("supervisor") }, async (request, reply) => {
    const body = departmentSchema.parse(request.body);
    const existing = await deps.prisma.department.findUnique({
      where: {
        organizationId_name: {
          organizationId: request.user.organizationId,
          name: body.name,
        },
      },
    });
    if (existing) {
      throw new AppError("Já existe um departamento com este nome", 409, "department_exists");
    }
    if (body.defaultAssigneeId) {
      await assertCanBeDefaultAssignee(body.defaultAssigneeId, null, request.user.organizationId);
    }
    const department = await deps.prisma.department.create({
      data: { organizationId: request.user.organizationId, ...body },
    });
    // Com o departamento criado dá para exigir o vínculo de acesso.
    if (body.defaultAssigneeId) {
      await assertCanBeDefaultAssignee(
        body.defaultAssigneeId,
        department.id,
        request.user.organizationId,
      ).catch(async (err) => {
        await deps.prisma.department.update({
          where: { id: department.id },
          data: { defaultAssigneeId: null },
        });
        throw err;
      });
    }
    deps.audit.record({
      organizationId: request.user.organizationId,
      userId: request.user.sub,
      action: "department.created",
      entityType: "Department",
      entityId: department.id,
    });
    return reply.status(201).send({ department: serializeDepartment(department) });
  });

  app.patch("/departments/:id", { preHandler: requireRole("supervisor") }, async (request) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const body = departmentSchema.partial().parse(request.body);
    const department = await deps.prisma.department.findFirst({
      where: { id, organizationId: request.user.organizationId },
    });
    if (!department) throw new NotFoundError("Departamento");
    if (body.defaultAssigneeId) {
      await assertCanBeDefaultAssignee(body.defaultAssigneeId, id, request.user.organizationId);
    }
    const updated = await deps.prisma.department.update({ where: { id }, data: body });
    deps.audit.record({
      organizationId: request.user.organizationId,
      userId: request.user.sub,
      action: "department.updated",
      entityType: "Department",
      entityId: id,
    });
    return { department: serializeDepartment(updated) };
  });

  app.delete("/departments/:id", { preHandler: requireRole("admin") }, async (request) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const department = await deps.prisma.department.findFirst({
      where: { id, organizationId: request.user.organizationId },
    });
    if (!department) throw new NotFoundError("Departamento");
    await deps.prisma.department.delete({ where: { id } });
    deps.audit.record({
      organizationId: request.user.organizationId,
      userId: request.user.sub,
      action: "department.deleted",
      entityType: "Department",
      entityId: id,
    });
    return { ok: true };
  });
}

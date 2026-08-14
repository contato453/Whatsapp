import type { FastifyInstance } from "fastify";
import { z } from "zod";
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
});

export async function departmentRoutes(app: FastifyInstance, deps: AppDeps): Promise<void> {
  app.get("/departments", { preHandler: authenticate }, async (request) => {
    const departments = await deps.prisma.department.findMany({
      where: { organizationId: request.user.organizationId },
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
    const department = await deps.prisma.department.create({
      data: { organizationId: request.user.organizationId, ...body },
    });
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
    const updated = await deps.prisma.department.update({ where: { id }, data: body });
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

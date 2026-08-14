import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  accessibleDepartmentIds,
  canWriteInDepartment,
  departmentResourceScope,
} from "../../lib/access.js";
import { authenticate } from "../../lib/auth.js";
import { AppError, ForbiddenError, NotFoundError } from "../../lib/errors.js";
import { serializeTag } from "../../lib/serialize.js";
import type { AppDeps } from "../../types.js";

/**
 * Etiquetas pertencem a um departamento.
 *
 * Cada pessoa vê e cria as dos departamentos em que atua; o admin vê todas
 * e é o único que mexe nas gerais (departmentId null), que valem para a
 * organização inteira.
 */

const tagSchema = z.object({
  name: z.string().min(1).max(50),
  color: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .default("#6366f1"),
  /** null = geral (só admin) */
  departmentId: z.string().uuid().nullable().optional(),
});

export async function tagRoutes(app: FastifyInstance, deps: AppDeps): Promise<void> {
  app.get("/tags", { preHandler: authenticate }, async (request) => {
    const departmentIds = await accessibleDepartmentIds(deps.prisma, request.user);
    const tags = await deps.prisma.tag.findMany({
      where: {
        organizationId: request.user.organizationId,
        ...departmentResourceScope(departmentIds),
      },
      orderBy: [{ departmentId: "asc" }, { name: "asc" }],
    });
    return { tags: tags.map(serializeTag) };
  });

  app.post("/tags", { preHandler: authenticate }, async (request, reply) => {
    const body = tagSchema.parse(request.body);
    const departmentIds = await accessibleDepartmentIds(deps.prisma, request.user);
    const departmentId = body.departmentId ?? null;
    if (!canWriteInDepartment(departmentIds, departmentId)) {
      throw new ForbiddenError(
        departmentId
          ? "Você não tem acesso a este departamento"
          : "Apenas o administrador cria etiquetas gerais",
      );
    }
    if (departmentId) {
      const department = await deps.prisma.department.findFirst({
        where: { id: departmentId, organizationId: request.user.organizationId },
        select: { id: true },
      });
      if (!department) throw new AppError("Departamento inválido", 400, "invalid_department");
    }

    // O nome é único na organização, e não por departamento: a etiqueta
    // aparece na conversa sem dizer de quem é, então dois "URGENTE" de
    // departamentos diferentes seriam impossíveis de distinguir.
    const existing = await deps.prisma.tag.findUnique({
      where: {
        organizationId_name: {
          organizationId: request.user.organizationId,
          name: body.name,
        },
      },
    });
    if (existing) {
      throw new AppError("Já existe uma etiqueta com este nome", 409, "tag_exists");
    }
    const tag = await deps.prisma.tag.create({
      data: {
        organizationId: request.user.organizationId,
        name: body.name,
        color: body.color,
        departmentId,
      },
    });
    deps.audit.record({
      organizationId: request.user.organizationId,
      userId: request.user.sub,
      action: "tag.created",
      entityType: "Tag",
      entityId: tag.id,
    });
    return reply.status(201).send({ tag: serializeTag(tag) });
  });

  app.delete("/tags/:id", { preHandler: authenticate }, async (request) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const departmentIds = await accessibleDepartmentIds(deps.prisma, request.user);
    const tag = await deps.prisma.tag.findFirst({
      where: { id, organizationId: request.user.organizationId },
    });
    if (!tag) throw new NotFoundError("Etiqueta");
    if (!canWriteInDepartment(departmentIds, tag.departmentId)) {
      throw new ForbiddenError("Esta etiqueta é de outro departamento");
    }
    await deps.prisma.tag.delete({ where: { id } });
    deps.audit.record({
      organizationId: request.user.organizationId,
      userId: request.user.sub,
      action: "tag.deleted",
      entityType: "Tag",
      entityId: id,
    });
    return { ok: true };
  });
}

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  accessibleDepartmentIds,
  canWriteInDepartment,
  departmentResourceScope,
} from "../../lib/access.js";
import { authenticate } from "../../lib/auth.js";
import { AppError, ForbiddenError, NotFoundError } from "../../lib/errors.js";
import type { AppDeps } from "../../types.js";
import type { QuickReply } from "@azvchat/database";

/**
 * Respostas rápidas pertencem a um departamento.
 *
 * Cada pessoa vê e cria as dos departamentos em que atua; o admin vê todas
 * e é o único que mexe nas gerais (departmentId null).
 */

const quickReplySchema = z.object({
  shortcut: z
    .string()
    .min(1)
    .max(30)
    .regex(
      /^[a-z0-9_-]+$/,
      "Use apenas letras minúsculas, números, hífen e underline (sem espaços)",
    ),
  title: z.string().max(80).optional(),
  content: z.string().min(1).max(4000),
  /** null = geral (só admin) */
  departmentId: z.string().uuid().nullable().optional(),
});

function serializeQuickReply(reply: QuickReply) {
  return {
    id: reply.id,
    shortcut: reply.shortcut,
    title: reply.title,
    content: reply.content,
    departmentId: reply.departmentId,
    createdAt: reply.createdAt.toISOString(),
  };
}

export async function quickReplyRoutes(app: FastifyInstance, deps: AppDeps): Promise<void> {
  app.get("/quick-replies", { preHandler: authenticate }, async (request) => {
    const departmentIds = await accessibleDepartmentIds(deps.prisma, request.user);
    const replies = await deps.prisma.quickReply.findMany({
      where: {
        organizationId: request.user.organizationId,
        ...departmentResourceScope(departmentIds),
      },
      orderBy: [{ departmentId: "asc" }, { shortcut: "asc" }],
    });
    return { quickReplies: replies.map(serializeQuickReply) };
  });

  app.post("/quick-replies", { preHandler: authenticate }, async (request, reply) => {
    const body = quickReplySchema.parse(request.body);
    const departmentIds = await accessibleDepartmentIds(deps.prisma, request.user);
    const departmentId = body.departmentId ?? null;
    if (!canWriteInDepartment(departmentIds, departmentId)) {
      throw new ForbiddenError(
        departmentId
          ? "Você não tem acesso a este departamento"
          : "Apenas o administrador cria respostas gerais",
      );
    }
    if (departmentId) {
      const department = await deps.prisma.department.findFirst({
        where: { id: departmentId, organizationId: request.user.organizationId },
        select: { id: true },
      });
      if (!department) throw new AppError("Departamento inválido", 400, "invalid_department");
    }
    const existing = await deps.prisma.quickReply.findUnique({
      where: {
        organizationId_shortcut: {
          organizationId: request.user.organizationId,
          shortcut: body.shortcut,
        },
      },
    });
    if (existing) {
      throw new AppError(`O atalho /${body.shortcut} já existe`, 409, "shortcut_taken");
    }
    const created = await deps.prisma.quickReply.create({
      data: {
        organizationId: request.user.organizationId,
        shortcut: body.shortcut,
        title: body.title ?? null,
        content: body.content,
        departmentId,
        createdById: request.user.sub,
      },
    });
    deps.audit.record({
      organizationId: request.user.organizationId,
      userId: request.user.sub,
      action: "quick_reply.created",
      entityType: "QuickReply",
      entityId: created.id,
    });
    return reply.status(201).send({ quickReply: serializeQuickReply(created) });
  });

  app.patch("/quick-replies/:id", { preHandler: authenticate }, async (request) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const body = quickReplySchema.partial().parse(request.body);
    const departmentIds = await accessibleDepartmentIds(deps.prisma, request.user);
    const existing = await deps.prisma.quickReply.findFirst({
      where: { id, organizationId: request.user.organizationId },
    });
    if (!existing) throw new NotFoundError("Resposta rápida");
    if (!canWriteInDepartment(departmentIds, existing.departmentId)) {
      throw new ForbiddenError("Esta resposta é de outro departamento");
    }
    // Mudar de departamento exige acesso também ao departamento de destino,
    // senão daria para tirar uma resposta do alcance de quem a criou.
    if (body.departmentId !== undefined) {
      const target = body.departmentId ?? null;
      if (!canWriteInDepartment(departmentIds, target)) {
        throw new ForbiddenError(
          target
            ? "Você não tem acesso ao departamento de destino"
            : "Apenas o administrador cria respostas gerais",
        );
      }
    }
    if (body.shortcut && body.shortcut !== existing.shortcut) {
      const clash = await deps.prisma.quickReply.findUnique({
        where: {
          organizationId_shortcut: {
            organizationId: request.user.organizationId,
            shortcut: body.shortcut,
          },
        },
      });
      if (clash) {
        throw new AppError(`O atalho /${body.shortcut} já existe`, 409, "shortcut_taken");
      }
    }
    const updated = await deps.prisma.quickReply.update({
      where: { id },
      data: {
        ...(body.shortcut ? { shortcut: body.shortcut } : {}),
        ...(body.title !== undefined ? { title: body.title || null } : {}),
        ...(body.content ? { content: body.content } : {}),
        ...(body.departmentId === undefined ? {} : { departmentId: body.departmentId }),
      },
    });
    return { quickReply: serializeQuickReply(updated) };
  });

  app.delete("/quick-replies/:id", { preHandler: authenticate }, async (request) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const departmentIds = await accessibleDepartmentIds(deps.prisma, request.user);
    const existing = await deps.prisma.quickReply.findFirst({
      where: { id, organizationId: request.user.organizationId },
    });
    if (!existing) throw new NotFoundError("Resposta rápida");
    if (!canWriteInDepartment(departmentIds, existing.departmentId)) {
      throw new ForbiddenError("Esta resposta é de outro departamento");
    }
    await deps.prisma.quickReply.delete({ where: { id } });
    deps.audit.record({
      organizationId: request.user.organizationId,
      userId: request.user.sub,
      action: "quick_reply.deleted",
      entityType: "QuickReply",
      entityId: id,
    });
    return { ok: true };
  });
}

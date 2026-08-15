import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { accessibleDepartmentIds, departmentResourceScope } from "../../lib/access.js";
import { authenticate } from "../../lib/auth.js";
import {
  assertCanManageResource,
  auditDepartmentSnapshot,
  resolveDepartmentTarget,
} from "../../lib/department-resource.js";
import { AppError, NotFoundError } from "../../lib/errors.js";
import { serializeQuickReply } from "../../lib/serialize.js";
import type { AppDeps } from "../../types.js";

/**
 * Respostas rápidas valem para vários departamentos ao mesmo tempo — mesma
 * regra da etiqueta, inclusive a unicidade do atalho na organização inteira,
 * que é justamente o que hoje obriga a cadastrar o mesmo texto três vezes.
 */

/** Departamentos vêm juntos: a tela mostra um Badge por departamento. */
const withDepartments = { departments: { include: { department: true } } } as const;

const quickReplyFieldsSchema = z.object({
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
  /** Vale para todos os departamentos. Ligada, `departmentIds` fica vazio. */
  isGeneral: z.boolean().default(false),
  departmentIds: z.array(z.string().uuid()).default([]),
});

const WRITE_LABELS = {
  general: "Apenas o administrador cria respostas gerais",
  foreign: "Você não tem acesso a todos os departamentos selecionados",
};

const MANAGE_LABELS = {
  general: "Apenas o administrador mexe em respostas gerais",
  foreign: "Esta resposta está em departamentos que você não acessa",
  orphan: "Esta resposta ficou sem departamento — só o administrador pode ajustá-la",
};

export async function quickReplyRoutes(app: FastifyInstance, deps: AppDeps): Promise<void> {
  app.get("/quick-replies", { preHandler: authenticate }, async (request) => {
    const departmentIds = await accessibleDepartmentIds(deps.prisma, request.user);
    const replies = await deps.prisma.quickReply.findMany({
      where: {
        organizationId: request.user.organizationId,
        ...departmentResourceScope(departmentIds),
      },
      include: withDepartments,
      // Gerais primeiro: são as que valem para todo mundo.
      orderBy: [{ isGeneral: "desc" }, { shortcut: "asc" }],
    });
    return { quickReplies: replies.map(serializeQuickReply) };
  });

  app.post("/quick-replies", { preHandler: authenticate }, async (request, reply) => {
    const body = quickReplyFieldsSchema.parse(request.body);
    const accessible = await accessibleDepartmentIds(deps.prisma, request.user);
    const target = await resolveDepartmentTarget(
      deps.prisma,
      request.user,
      accessible,
      body,
      WRITE_LABELS,
    );

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
        isGeneral: target.isGeneral,
        createdById: request.user.sub,
        departments: {
          create: target.departmentIds.map((departmentId) => ({ departmentId })),
        },
      },
      include: withDepartments,
    });
    deps.audit.record({
      organizationId: request.user.organizationId,
      userId: request.user.sub,
      action: "quick_reply.created",
      entityType: "QuickReply",
      entityId: created.id,
      metadata: { depois: auditDepartmentSnapshot(created.isGeneral, created.departments) },
    });
    return reply.status(201).send({ quickReply: serializeQuickReply(created) });
  });

  app.patch("/quick-replies/:id", { preHandler: authenticate }, async (request) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const body = quickReplyFieldsSchema.partial().parse(request.body);
    const accessible = await accessibleDepartmentIds(deps.prisma, request.user);
    const existing = await deps.prisma.quickReply.findFirst({
      where: { id, organizationId: request.user.organizationId },
      include: withDepartments,
    });
    if (!existing) throw new NotFoundError("Resposta rápida");

    // Precisa poder mexer no estado atual — senão daria para editar resposta
    // de outro departamento — e também no estado de destino.
    const current = {
      isGeneral: existing.isGeneral,
      departmentIds: existing.departments.map((link) => link.departmentId),
    };
    assertCanManageResource(accessible, current, MANAGE_LABELS);

    const target = await resolveDepartmentTarget(
      deps.prisma,
      request.user,
      accessible,
      {
        isGeneral: body.isGeneral ?? current.isGeneral,
        departmentIds: body.departmentIds ?? current.departmentIds,
      },
      WRITE_LABELS,
    );

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

    // Em transação e substituindo o conjunto inteiro: apagar e recriar evita
    // duplicata e deixa o vínculo sempre igual ao que a tela mandou.
    const updated = await deps.prisma.$transaction(async (tx) => {
      await tx.quickReplyDepartment.deleteMany({ where: { quickReplyId: id } });
      return tx.quickReply.update({
        where: { id },
        data: {
          ...(body.shortcut ? { shortcut: body.shortcut } : {}),
          ...(body.title !== undefined ? { title: body.title || null } : {}),
          ...(body.content ? { content: body.content } : {}),
          isGeneral: target.isGeneral,
          departments: {
            create: target.departmentIds.map((departmentId) => ({ departmentId })),
          },
        },
        include: withDepartments,
      });
    });

    deps.audit.record({
      organizationId: request.user.organizationId,
      userId: request.user.sub,
      action: "quick_reply.updated",
      entityType: "QuickReply",
      entityId: id,
      metadata: {
        antes: auditDepartmentSnapshot(existing.isGeneral, existing.departments),
        depois: auditDepartmentSnapshot(updated.isGeneral, updated.departments),
      },
    });
    return { quickReply: serializeQuickReply(updated) };
  });

  app.delete("/quick-replies/:id", { preHandler: authenticate }, async (request) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const accessible = await accessibleDepartmentIds(deps.prisma, request.user);
    const existing = await deps.prisma.quickReply.findFirst({
      where: { id, organizationId: request.user.organizationId },
      include: withDepartments,
    });
    if (!existing) throw new NotFoundError("Resposta rápida");

    assertCanManageResource(
      accessible,
      {
        isGeneral: existing.isGeneral,
        departmentIds: existing.departments.map((link) => link.departmentId),
      },
      MANAGE_LABELS,
    );

    await deps.prisma.quickReply.delete({ where: { id } });
    deps.audit.record({
      organizationId: request.user.organizationId,
      userId: request.user.sub,
      action: "quick_reply.deleted",
      entityType: "QuickReply",
      entityId: id,
      metadata: { antes: auditDepartmentSnapshot(existing.isGeneral, existing.departments) },
    });
    return { ok: true };
  });
}

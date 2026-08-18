import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { accessibleDepartmentIds, departmentResourceScope } from "../../lib/access.js";
import { authenticate } from "../../lib/auth.js";
import { requirePermission } from "../../lib/permissions.js";
import {
  assertCanManageResource,
  auditDepartmentSnapshot,
  resolveDepartmentTarget,
} from "../../lib/department-resource.js";
import { AppError, NotFoundError } from "../../lib/errors.js";
import { serializeTag } from "../../lib/serialize.js";
import type { AppDeps } from "../../types.js";

/**
 * Etiquetas valem para vários departamentos ao mesmo tempo.
 *
 * A mesma "Urgente" serve para Contábil, Fiscal e DP sem precisar de três
 * cadastros — e como o nome é único na organização inteira, três cadastros
 * exigiriam três nomes diferentes.
 *
 * Cada pessoa vê a etiqueta geral e as marcadas para algum departamento
 * dela; para gravar, precisa de acesso a todos os departamentos marcados.
 * O admin vê tudo e é o único que mexe nas gerais.
 */

/** Departamentos vêm juntos: a tela mostra um Badge por departamento. */
const withDepartments = { departments: { include: { department: true } } } as const;

const tagFieldsSchema = z.object({
  name: z.string().min(1).max(50),
  // Cor de partida quando o corpo não manda nenhuma: azul-marinho da marca,
  // o mesmo valor inicial do formulário. Era o indigo `#6366f1`, que saiu com
  // o resto do roxo da interface. Não é verde de propósito — a etiqueta fica
  // ao lado do selo de status na conversa, e verde ali disputaria a leitura
  // com "Aberto". O `@default` da coluna no Prisma continua no valor antigo:
  // mudá-lo pediria migration, e este default aqui sempre vence.
  color: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .default("#102a4c"),
  /** Vale para todos os departamentos. Ligada, `departmentIds` fica vazio. */
  isGeneral: z.boolean().default(false),
  departmentIds: z.array(z.string().uuid()).default([]),
});

const WRITE_LABELS = {
  general: "Apenas o administrador cria etiquetas gerais",
  foreign: "Você não tem acesso a todos os departamentos selecionados",
};

const MANAGE_LABELS = {
  general: "Apenas o administrador mexe em etiquetas gerais",
  foreign: "Esta etiqueta está em departamentos que você não acessa",
  orphan: "Esta etiqueta ficou sem departamento — só o administrador pode ajustá-la",
};

export async function tagRoutes(app: FastifyInstance, deps: AppDeps): Promise<void> {
  app.get("/tags", { preHandler: authenticate }, async (request) => {
    const departmentIds = await accessibleDepartmentIds(deps.prisma, request.user);
    const tags = await deps.prisma.tag.findMany({
      where: {
        organizationId: request.user.organizationId,
        ...departmentResourceScope(departmentIds),
      },
      include: withDepartments,
      // Gerais primeiro: são as que valem para todo mundo.
      orderBy: [{ isGeneral: "desc" }, { name: "asc" }],
    });
    return { tags: tags.map(serializeTag) };
  });

  app.post(
    "/tags",
    { preHandler: requirePermission(deps, "tag.manage") },
    async (request, reply) => {
    const body = tagFieldsSchema.parse(request.body);
    const accessible = await accessibleDepartmentIds(deps.prisma, request.user);
    const target = await resolveDepartmentTarget(
      deps.prisma,
      request.user,
      accessible,
      body,
      WRITE_LABELS,
    );

    // O nome é único na organização, e não por departamento: a etiqueta
    // aparece na conversa sem dizer de quem é, então dois "URGENTE" de
    // departamentos diferentes seriam impossíveis de distinguir.
    const existing = await deps.prisma.tag.findUnique({
      where: {
        organizationId_name: { organizationId: request.user.organizationId, name: body.name },
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
        isGeneral: target.isGeneral,
        departments: {
          create: target.departmentIds.map((departmentId) => ({ departmentId })),
        },
      },
      include: withDepartments,
    });
    deps.audit.record({
      organizationId: request.user.organizationId,
      userId: request.user.sub,
      action: "tag.created",
      entityType: "Tag",
      entityId: tag.id,
      metadata: { depois: auditDepartmentSnapshot(tag.isGeneral, tag.departments) },
    });
    return reply.status(201).send({ tag: serializeTag(tag) });
  });

  app.patch(
    "/tags/:id",
    { preHandler: requirePermission(deps, "tag.manage") },
    async (request) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const body = tagFieldsSchema.partial().parse(request.body);
    const accessible = await accessibleDepartmentIds(deps.prisma, request.user);
    const existing = await deps.prisma.tag.findFirst({
      where: { id, organizationId: request.user.organizationId },
      include: withDepartments,
    });
    if (!existing) throw new NotFoundError("Etiqueta");

    // Precisa poder mexer no estado atual — senão daria para editar etiqueta
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

    if (body.name && body.name !== existing.name) {
      const clash = await deps.prisma.tag.findUnique({
        where: {
          organizationId_name: { organizationId: request.user.organizationId, name: body.name },
        },
      });
      if (clash) {
        throw new AppError("Já existe uma etiqueta com este nome", 409, "tag_exists");
      }
    }

    // Em transação e substituindo o conjunto inteiro: apagar e recriar evita
    // duplicata e deixa o vínculo sempre igual ao que a tela mandou.
    const updated = await deps.prisma.$transaction(async (tx) => {
      await tx.tagDepartment.deleteMany({ where: { tagId: id } });
      return tx.tag.update({
        where: { id },
        data: {
          ...(body.name ? { name: body.name } : {}),
          ...(body.color ? { color: body.color } : {}),
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
      action: "tag.updated",
      entityType: "Tag",
      entityId: id,
      metadata: {
        antes: auditDepartmentSnapshot(existing.isGeneral, existing.departments),
        depois: auditDepartmentSnapshot(updated.isGeneral, updated.departments),
      },
    });
    return { tag: serializeTag(updated) };
  });

  app.delete(
    "/tags/:id",
    { preHandler: requirePermission(deps, "tag.delete") },
    async (request) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const accessible = await accessibleDepartmentIds(deps.prisma, request.user);
    const tag = await deps.prisma.tag.findFirst({
      where: { id, organizationId: request.user.organizationId },
      include: withDepartments,
    });
    if (!tag) throw new NotFoundError("Etiqueta");

    assertCanManageResource(
      accessible,
      {
        isGeneral: tag.isGeneral,
        departmentIds: tag.departments.map((link) => link.departmentId),
      },
      MANAGE_LABELS,
    );

    await deps.prisma.tag.delete({ where: { id } });
    deps.audit.record({
      organizationId: request.user.organizationId,
      userId: request.user.sub,
      action: "tag.deleted",
      entityType: "Tag",
      entityId: id,
      metadata: { antes: auditDepartmentSnapshot(tag.isGeneral, tag.departments) },
    });
    return { ok: true };
  });
}

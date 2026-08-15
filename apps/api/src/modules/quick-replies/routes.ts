import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { quickReplyMediaTypeFromMime } from "@azvchat/shared";
import { accessibleDepartmentIds, departmentResourceScope } from "../../lib/access.js";
import { authenticate } from "../../lib/auth.js";
import {
  assertCanManageResource,
  auditDepartmentSnapshot,
  resolveDepartmentTarget,
} from "../../lib/department-resource.js";
import { AppError, NotFoundError } from "../../lib/errors.js";
import { extensionFromMime } from "../../lib/media-storage.js";
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

  /**
   * Carrega a resposta e garante que quem chamou pode mexer nela — a mesma
   * régua do PATCH: editar a mídia é editar a resposta.
   */
  async function findManageableOr404(id: string, user: FastifyRequest["user"]) {
    const accessible = await accessibleDepartmentIds(deps.prisma, user);
    const existing = await deps.prisma.quickReply.findFirst({
      where: { id, organizationId: user.organizationId },
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
    return existing;
  }

  app.post("/quick-replies/:id/media", { preHandler: authenticate }, async (request) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    await findManageableOr404(id, request.user);

    const file = await request.file();
    if (!file) {
      throw new AppError("Arquivo é obrigatório", 400, "file_required");
    }
    const buffer = await file.toBuffer();
    // A base do mime decide o tipo; documento fica de fora de propósito —
    // resposta rápida é conteúdo padronizado, não repositório de arquivos.
    const mimeType = file.mimetype || "application/octet-stream";
    const mediaType = quickReplyMediaTypeFromMime(mimeType);
    if (!mediaType) {
      throw new AppError(
        "Anexe uma imagem, um áudio ou um vídeo",
        400,
        "unsupported_media_type",
      );
    }

    // O diretório é da organização, não de um número: a mídia da resposta
    // não pertence a instância alguma e sobrevive à exclusão de qualquer uma.
    const mediaUrl = await deps.storage.save(buffer, {
      instanceId: `quick-replies-${request.user.organizationId}`,
      extension: file.filename?.split(".").pop() ?? extensionFromMime(mimeType),
    });

    const updated = await deps.prisma.quickReply.update({
      where: { id },
      data: { mediaUrl, mediaMimeType: mimeType, mediaFilename: file.filename ?? null },
      include: withDepartments,
    });
    deps.audit.record({
      organizationId: request.user.organizationId,
      userId: request.user.sub,
      action: "quick_reply.media_updated",
      entityType: "QuickReply",
      entityId: id,
      metadata: { mediaType, filename: file.filename ?? null },
    });
    return { quickReply: serializeQuickReply(updated) };
  });

  app.delete("/quick-replies/:id/media", { preHandler: authenticate }, async (request) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const existing = await findManageableOr404(id, request.user);

    // Sem mídia não há o que remover — devolver a resposta como está torna
    // a operação idempotente para a tela.
    if (!existing.mediaUrl) {
      return { quickReply: serializeQuickReply(existing) };
    }

    // O arquivo fica no storage, como na mensagem apagada: a linha some do
    // cadastro, o histórico de auditoria continua explicável.
    const updated = await deps.prisma.quickReply.update({
      where: { id },
      data: { mediaUrl: null, mediaMimeType: null, mediaFilename: null },
      include: withDepartments,
    });
    deps.audit.record({
      organizationId: request.user.organizationId,
      userId: request.user.sub,
      action: "quick_reply.media_removed",
      entityType: "QuickReply",
      entityId: id,
      metadata: { antes: { filename: existing.mediaFilename } },
    });
    return { quickReply: serializeQuickReply(updated) };
  });

  /**
   * Download/exibição da mídia (autenticado). A leitura usa o mesmo recorte
   * da listagem: quem enxerga a resposta baixa a mídia dela — inclusive o
   * atendente, que precisa dela para enviar ao cliente.
   */
  app.get("/quick-replies/:id/media", { preHandler: authenticate }, async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const departmentIds = await accessibleDepartmentIds(deps.prisma, request.user);
    const found = await deps.prisma.quickReply.findFirst({
      where: {
        id,
        organizationId: request.user.organizationId,
        ...departmentResourceScope(departmentIds),
      },
    });
    if (!found?.mediaUrl) throw new NotFoundError("Mídia");
    const data = await deps.storage.read(found.mediaUrl);
    reply.header("Content-Type", found.mediaMimeType ?? "application/octet-stream");
    if (found.mediaFilename) {
      reply.header(
        "Content-Disposition",
        `inline; filename="${encodeURIComponent(found.mediaFilename)}"`,
      );
    }
    // A URL é estável e a mídia pode ser trocada na edição: cache curto,
    // senão o atendente enviaria a versão antiga sem perceber.
    reply.header("Cache-Control", "private, max-age=60");
    return reply.send(data);
  });
}

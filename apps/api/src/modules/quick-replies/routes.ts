import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { authenticate } from "../../lib/auth.js";
import { AppError, NotFoundError } from "../../lib/errors.js";
import type { AppDeps } from "../../types.js";
import type { QuickReply } from "@zapdesk/database";

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
});

function serializeQuickReply(reply: QuickReply) {
  return {
    id: reply.id,
    shortcut: reply.shortcut,
    title: reply.title,
    content: reply.content,
    createdAt: reply.createdAt.toISOString(),
  };
}

export async function quickReplyRoutes(app: FastifyInstance, deps: AppDeps): Promise<void> {
  app.get("/quick-replies", { preHandler: authenticate }, async (request) => {
    const replies = await deps.prisma.quickReply.findMany({
      where: { organizationId: request.user.organizationId },
      orderBy: { shortcut: "asc" },
    });
    return { quickReplies: replies.map(serializeQuickReply) };
  });

  app.post("/quick-replies", { preHandler: authenticate }, async (request, reply) => {
    const body = quickReplySchema.parse(request.body);
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
    const existing = await deps.prisma.quickReply.findFirst({
      where: { id, organizationId: request.user.organizationId },
    });
    if (!existing) throw new NotFoundError("Resposta rápida");
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
      },
    });
    return { quickReply: serializeQuickReply(updated) };
  });

  app.delete("/quick-replies/:id", { preHandler: authenticate }, async (request) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const existing = await deps.prisma.quickReply.findFirst({
      where: { id, organizationId: request.user.organizationId },
    });
    if (!existing) throw new NotFoundError("Resposta rápida");
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

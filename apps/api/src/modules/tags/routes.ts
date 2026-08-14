import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { authenticate, requireRole } from "../../lib/auth.js";
import { AppError, NotFoundError } from "../../lib/errors.js";
import { serializeTag } from "../../lib/serialize.js";
import type { AppDeps } from "../../types.js";

const tagSchema = z.object({
  name: z.string().min(1).max(50),
  color: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .default("#6366f1"),
});

export async function tagRoutes(app: FastifyInstance, deps: AppDeps): Promise<void> {
  app.get("/tags", { preHandler: authenticate }, async (request) => {
    const tags = await deps.prisma.tag.findMany({
      where: { organizationId: request.user.organizationId },
      orderBy: { name: "asc" },
    });
    return { tags: tags.map(serializeTag) };
  });

  app.post("/tags", { preHandler: requireRole("supervisor") }, async (request, reply) => {
    const body = tagSchema.parse(request.body);
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
      data: { organizationId: request.user.organizationId, ...body },
    });
    return reply.status(201).send({ tag: serializeTag(tag) });
  });

  app.delete("/tags/:id", { preHandler: requireRole("supervisor") }, async (request) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const tag = await deps.prisma.tag.findFirst({
      where: { id, organizationId: request.user.organizationId },
    });
    if (!tag) throw new NotFoundError("Etiqueta");
    await deps.prisma.tag.delete({ where: { id } });
    return { ok: true };
  });
}

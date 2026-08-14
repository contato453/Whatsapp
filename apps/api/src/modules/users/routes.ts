import type { FastifyInstance } from "fastify";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { authenticate, requireRole } from "../../lib/auth.js";
import { AppError, NotFoundError } from "../../lib/errors.js";
import { serializeUser } from "../../lib/serialize.js";
import type { AppDeps } from "../../types.js";

const createUserSchema = z.object({
  name: z.string().min(2).max(120),
  email: z.string().email(),
  password: z.string().min(6, "Senha deve ter no mínimo 6 caracteres").max(72),
  role: z.enum(["admin", "supervisor", "agent"]).default("agent"),
});

const updateUserSchema = z.object({
  name: z.string().min(2).max(120).optional(),
  password: z.string().min(6).max(72).optional(),
  role: z.enum(["admin", "supervisor", "agent"]).optional(),
  status: z.enum(["active", "inactive"]).optional(),
});

export async function userRoutes(app: FastifyInstance, deps: AppDeps): Promise<void> {
  app.get("/users", { preHandler: authenticate }, async (request) => {
    const users = await deps.prisma.user.findMany({
      where: { organizationId: request.user.organizationId },
      orderBy: { name: "asc" },
    });
    return { users: users.map(serializeUser) };
  });

  app.post("/users", { preHandler: requireRole("admin") }, async (request, reply) => {
    const body = createUserSchema.parse(request.body);
    const existing = await deps.prisma.user.findUnique({ where: { email: body.email } });
    if (existing) {
      throw new AppError("Já existe um usuário com este e-mail", 409, "email_taken");
    }
    const user = await deps.prisma.user.create({
      data: {
        organizationId: request.user.organizationId,
        name: body.name,
        email: body.email,
        passwordHash: await bcrypt.hash(body.password, 10),
        role: body.role,
      },
    });
    deps.audit.record({
      organizationId: request.user.organizationId,
      userId: request.user.sub,
      action: "user.created",
      entityType: "User",
      entityId: user.id,
    });
    return reply.status(201).send({ user: serializeUser(user) });
  });

  app.patch("/users/:id", { preHandler: requireRole("admin") }, async (request) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const body = updateUserSchema.parse(request.body);
    const user = await deps.prisma.user.findFirst({
      where: { id, organizationId: request.user.organizationId },
    });
    if (!user) throw new NotFoundError("Usuário");
    const updated = await deps.prisma.user.update({
      where: { id },
      data: {
        ...(body.name ? { name: body.name } : {}),
        ...(body.role ? { role: body.role } : {}),
        ...(body.status ? { status: body.status } : {}),
        ...(body.password ? { passwordHash: await bcrypt.hash(body.password, 10) } : {}),
      },
    });
    deps.audit.record({
      organizationId: request.user.organizationId,
      userId: request.user.sub,
      action: "user.updated",
      entityType: "User",
      entityId: id,
    });
    return { user: serializeUser(updated) };
  });
}

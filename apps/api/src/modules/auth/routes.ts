import type { FastifyInstance } from "fastify";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { authenticate } from "../../lib/auth.js";
import { UnauthorizedError } from "../../lib/errors.js";
import { serializeUser } from "../../lib/serialize.js";
import type { AppDeps } from "../../types.js";

const loginSchema = z.object({
  email: z.string().email("E-mail inválido"),
  password: z.string().min(1, "Senha é obrigatória"),
});

export async function authRoutes(app: FastifyInstance, deps: AppDeps): Promise<void> {
  app.post(
    "/auth/login",
    {
      config: {
        // Proteção extra contra força bruta no login
        rateLimit: { max: 10, timeWindow: "1 minute" },
      },
    },
    async (request) => {
      const { email, password } = loginSchema.parse(request.body);
      const user = await deps.prisma.user.findUnique({ where: { email } });
      if (!user || user.status !== "active") {
        throw new UnauthorizedError("Credenciais inválidas");
      }
      const valid = await bcrypt.compare(password, user.passwordHash);
      if (!valid) {
        deps.audit.record({
          organizationId: user.organizationId,
          action: "auth.login_failed",
          entityType: "User",
          entityId: user.id,
          ip: request.ip,
        });
        throw new UnauthorizedError("Credenciais inválidas");
      }
      const token = await app.jwt.sign(
        {
          sub: user.id,
          organizationId: user.organizationId,
          role: user.role,
          name: user.name,
          email: user.email,
        },
        { expiresIn: deps.config.JWT_EXPIRES_IN },
      );
      deps.audit.record({
        organizationId: user.organizationId,
        userId: user.id,
        action: "auth.login",
        ip: request.ip,
      });
      // Registrado depois da autenticação: tentativa falha não conta como acesso.
      const loggedIn = await deps.prisma.user.update({
        where: { id: user.id },
        data: { lastLoginAt: new Date() },
      });
      return { token, user: serializeUser(loggedIn) };
    },
  );

  app.get("/auth/me", { preHandler: authenticate }, async (request) => {
    const user = await deps.prisma.user.findUnique({ where: { id: request.user.sub } });
    if (!user || user.status !== "active") {
      throw new UnauthorizedError();
    }
    return { user: serializeUser(user) };
  });

  app.post("/auth/logout", { preHandler: authenticate }, async (request) => {
    deps.audit.record({
      organizationId: request.user.organizationId,
      userId: request.user.sub,
      action: "auth.logout",
      ip: request.ip,
    });
    return { ok: true };
  });
}

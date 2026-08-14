import Fastify, { type FastifyBaseLogger, type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import jwt from "@fastify/jwt";
import multipart from "@fastify/multipart";
import rateLimit from "@fastify/rate-limit";
import { registerErrorHandler } from "./lib/errors.js";
import { authRoutes } from "./modules/auth/routes.js";
import { userRoutes } from "./modules/users/routes.js";
import { departmentRoutes } from "./modules/departments/routes.js";
import { tagRoutes } from "./modules/tags/routes.js";
import { whatsappInstanceRoutes } from "./modules/whatsapp-instances/routes.js";
import { conversationRoutes } from "./modules/conversations/routes.js";
import { messageRoutes } from "./modules/messages/routes.js";
import { dashboardRoutes } from "./modules/dashboard/routes.js";
import { searchRoutes } from "./modules/search/routes.js";
import { auditRoutes } from "./modules/audit/routes.js";
import type { AppDeps } from "./types.js";

/**
 * Monta a aplicação Fastify com todos os módulos registrados.
 * `deps.io` e `deps.instanceManager` são atribuídos após a criação do
 * servidor HTTP (late binding) — as rotas só os acessam por requisição.
 */
export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const app = Fastify({
    // pino.Logger é compatível com FastifyBaseLogger em runtime; o cast evita
    // propagar o generic de logger para todos os módulos de rota.
    loggerInstance: deps.logger as unknown as FastifyBaseLogger,
    trustProxy: true,
    bodyLimit: 1024 * 1024,
  });

  await app.register(cors, {
    origin: deps.config.corsOrigins,
    credentials: true,
  });

  await app.register(jwt, { secret: deps.config.JWT_SECRET });

  await app.register(rateLimit, {
    max: 300,
    timeWindow: "1 minute",
  });

  await app.register(multipart, {
    limits: { fileSize: deps.config.MEDIA_MAX_SIZE, files: 1 },
  });

  registerErrorHandler(app);

  app.get("/health", async () => ({ status: "ok" }));

  await app.register(async (instance) => {
    await authRoutes(instance, deps);
    await userRoutes(instance, deps);
    await departmentRoutes(instance, deps);
    await tagRoutes(instance, deps);
    await whatsappInstanceRoutes(instance, deps);
    await conversationRoutes(instance, deps);
    await messageRoutes(instance, deps);
    await dashboardRoutes(instance, deps);
    await searchRoutes(instance, deps);
    await auditRoutes(instance, deps);
  });

  return app;
}

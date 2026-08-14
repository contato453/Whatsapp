import "./lib/load-env.js";
import { mkdir } from "node:fs/promises";
import pino from "pino";
import { getPrisma, disconnectPrisma } from "@azvchat/database";
import { QrCodeWhatsAppProvider } from "@azvchat/whatsapp";
import { loadConfig } from "./config.js";
import { buildApp } from "./app.js";
import { createRealtime } from "./realtime/socket.js";
import { LocalMediaStorage } from "./lib/media-storage.js";
import { AuditService } from "./modules/audit/service.js";
import { MessageIngestService } from "./services/message-ingest.js";
import { InstanceManager } from "./services/instance-manager.js";
import { ScheduledMessageWorker } from "./services/scheduler.js";
import { accessibleInstanceIds } from "./lib/access.js";
import type { AuthTokenPayload } from "./lib/auth.js";
import type { AppDeps } from "./types.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = pino({ level: config.LOG_LEVEL });

  await mkdir(config.sessionDir, { recursive: true });
  await mkdir(config.mediaDir, { recursive: true });

  const prisma = getPrisma();
  const storage = new LocalMediaStorage(config.mediaDir);
  const audit = new AuditService(prisma, logger);
  const ingest = new MessageIngestService(prisma, storage, logger);

  // Único ponto do sistema que instancia um provider concreto.
  const provider = new QrCodeWhatsAppProvider({
    sessionDir: config.sessionDir,
    logger: logger.child({ module: "whatsapp-provider" }),
    proxyUrl: config.WHATSAPP_PROXY_URL,
  });

  // Container mutável: io e instanceManager dependem do servidor HTTP,
  // que só existe depois de buildApp. As rotas leem deps.* somente em
  // tempo de requisição, então o late binding é seguro.
  const deps = {
    config,
    prisma,
    provider,
    logger,
    storage,
    audit,
    ingest,
    // io e instanceManager são atribuídos logo abaixo, antes de listen().
  } as unknown as AppDeps;

  const app = await buildApp(deps);
  await app.ready();

  const io = createRealtime(app.server, {
    corsOrigins: config.corsOrigins,
    verifyToken: (token) => app.jwt.verify<AuthTokenPayload>(token),
    resolveInstanceAccess: (user) => accessibleInstanceIds(prisma, user),
    logger,
  });
  deps.io = io;

  const instanceManager = new InstanceManager(
    prisma,
    provider,
    ingest,
    io,
    audit,
    storage,
    logger,
  );
  instanceManager.wireProviderEvents();
  deps.instanceManager = instanceManager;

  const scheduler = new ScheduledMessageWorker(prisma, provider, io, logger);
  scheduler.start();

  await app.listen({ port: config.API_PORT, host: config.API_HOST });
  logger.info({ event: "api_started", port: config.API_PORT });

  // Retoma sessões de WhatsApp que estavam conectadas antes do restart —
  // requisito central: deploy nunca deve exigir novo QR Code.
  void instanceManager.resumeSessions();

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ event: "shutdown", signal });
    try {
      scheduler.stop();
      await provider.shutdownAll();
      io.close();
      await app.close();
      await disconnectPrisma();
    } finally {
      process.exit(0);
    }
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err) => {
  console.error("Falha fatal ao iniciar a API:", err);
  process.exit(1);
});

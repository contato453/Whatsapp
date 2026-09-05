import "./lib/load-env.js";
import { mkdir } from "node:fs/promises";
import pino from "pino";
import { getPrisma, disconnectPrisma } from "@azvchat/database";
import { AstraCallsProvider, QrCodeWhatsAppProvider, type WhatsAppProvider } from "@azvchat/whatsapp";
import { loadConfig } from "./config.js";
import { buildApp } from "./app.js";
import { createRealtime } from "./realtime/socket.js";
import { LocalMediaStorage } from "./lib/media-storage.js";
import { AuditService } from "./modules/audit/service.js";
import { MessageIngestService } from "./services/message-ingest.js";
import { InstanceManager } from "./services/instance-manager.js";
import { ScheduledMessageWorker } from "./services/scheduler.js";
import { SessionScheduleWatcher } from "./services/session-schedule-watcher.js";
import { createAzevedoOsClient } from "./services/azevedo-os-client.js";
import { loadConversationAccess } from "./lib/access.js";
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

  // Leitura do cadastro empresarial no Azevedo-OS. Nasce desligado quando
  // falta URL ou token — e desligado significa card avisando, não API
  // quebrada.
  const azevedoOs = createAzevedoOsClient({
    baseUrl: config.AZEVEDO_OS_API_URL,
    token: config.AZEVEDO_OS_API_TOKEN,
    webUrlTemplate: config.AZEVEDO_OS_WEB_URL,
    timeoutMs: config.AZEVEDO_OS_TIMEOUT_MS,
    logger: logger.child({ module: "azevedo-os" }),
  });

  // Único ponto do sistema que instancia um provider concreto. A escolha
  // entre Baileys (qrcode) e AstraCalls sai do WHATSAPP_PROVIDER — o resto do
  // sistema só conhece a interface WhatsAppProvider e não muda.
  let provider: WhatsAppProvider;
  if (config.WHATSAPP_PROVIDER === "astracalls") {
    if (!config.ASTRACALLS_API_URL || !config.ASTRACALLS_API_KEY) {
      throw new Error(
        "WHATSAPP_PROVIDER=astracalls exige ASTRACALLS_API_URL e ASTRACALLS_API_KEY no .env.",
      );
    }
    provider = new AstraCallsProvider({
      apiUrl: config.ASTRACALLS_API_URL,
      apiKey: config.ASTRACALLS_API_KEY,
      webhookUrl: config.ASTRACALLS_WEBHOOK_URL,
      sessionDir: config.sessionDir,
      logger: logger.child({ module: "whatsapp-provider" }),
    });
  } else {
    provider = new QrCodeWhatsAppProvider({
      sessionDir: config.sessionDir,
      logger: logger.child({ module: "whatsapp-provider" }),
      proxyUrl: config.WHATSAPP_PROXY_URL,
    });
  }

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
    azevedoOs,
    // io e instanceManager são atribuídos logo abaixo, antes de listen().
  } as unknown as AppDeps;

  const app = await buildApp(deps);
  await app.ready();

  const io = createRealtime(app.server, {
    corsOrigins: config.corsOrigins,
    verifyToken: (token) => app.jwt.verify<AuthTokenPayload>(token),
    verifySession: app.verifySession,
    resolveAccess: async (user) => {
      const access = await loadConversationAccess(prisma, user);
      return { instanceIds: access.instanceIds, departmentIds: access.departmentIds };
    },
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

  // Avisa e encerra as abas quando o horário de uso fecha. A API já recusa
  // requisição fora do horário; sem este vigia, a aba parada continuaria
  // recebendo mensagem pelo socket sem nunca perguntar nada ao servidor.
  const sessionScheduleWatcher = new SessionScheduleWatcher(io, prisma, logger);
  sessionScheduleWatcher.start();

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
      sessionScheduleWatcher.stop();
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

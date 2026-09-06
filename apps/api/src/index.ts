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
import { AutomationEngine } from "./services/automation/engine.js";
import { AutomationWorker } from "./services/automation/worker.js";
import { FollowUpScheduler } from "./services/follow-up-scheduler.js";
import { SessionScheduleWatcher } from "./services/session-schedule-watcher.js";
import { createAzevedoOsClient } from "./services/azevedo-os-client.js";
import { createSecretCipher } from "./lib/ai-secrets.js";
import { AiRuntime } from "./services/ai/runtime.js";
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
  // Antes de 03/09/2026 o defeito só aparecia quando alguém tentava
  // vincular uma empresa — quem administra a VPS não tinha como saber que
  // a integração estava desligada sem abrir a tela. Este aviso sai UMA vez,
  // no boot, destacado do resto do log de partida, com o NOME de quem
  // falta (nunca o valor).
  if (!azevedoOs.enabled) {
    logger.warn(
      { event: "azevedo_os_integration_disabled", missingVars: azevedoOs.missingVars },
      "Integração com o Azevedo-OS desligada: defina as variáveis que faltam no .env da VPS (ou nos segredos do GitHub, se o deploy por SSH estiver ligado)",
    );
  }

  // Cifra da chave de API dos provedores de IA. Sem AI_SECRETS_KEY ela cai
  // na derivação do JWT_SECRET — funciona, mas avisa: trocar o JWT_SECRET
  // nesse modo invalida a chave gravada.
  const aiCipher = createSecretCipher({ aiSecretsKey: config.AI_SECRETS_KEY, jwtSecret: config.JWT_SECRET });
  if (!aiCipher.dedicatedKey) {
    logger.warn(
      { event: "ai_secrets_key_missing" },
      "AI_SECRETS_KEY não definida: a chave do provedor de IA está cifrada com derivação do JWT_SECRET (gere uma com `openssl rand -hex 32`)",
    );
  }

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
    aiCipher,
    // io, instanceManager e aiRuntime são atribuídos logo abaixo, antes de listen().
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

  // Motor de automações (construtor visual de fluxos) — precisa do `io`
  // (eventos de tempo real) e do `provider` (envio das mensagens do fluxo),
  // então nasce aqui, depois do socket. `InstanceManager` o recebe para
  // acionar os gatilhos de mensagem logo depois que `ingest` grava a
  // mensagem recebida.
  const automation = new AutomationEngine(prisma, provider, io, logger);
  deps.automation = automation;

  // Motor do atendimento por IA: recebe a mensagem depois de gravada e
  // decide se algum agente responde. Nasce antes do instance-manager, que é
  // quem o avisa.
  const aiRuntime = new AiRuntime({ prisma, io, logger: logger.child({ module: "ai" }), provider, audit, azevedoOs, cipher: aiCipher });
  deps.aiRuntime = aiRuntime;

  const instanceManager = new InstanceManager(
    prisma,
    provider,
    ingest,
    io,
    audit,
    storage,
    logger,
    automation,
    azevedoOs,
    aiRuntime,
  );
  instanceManager.wireProviderEvents();
  deps.instanceManager = instanceManager;
  aiRuntime.start();

  const scheduler = new ScheduledMessageWorker(prisma, provider, io, logger);
  scheduler.start();

  const automationWorker = new AutomationWorker(automation, logger);
  automationWorker.start();

  const followUpScheduler = new FollowUpScheduler(prisma, provider, io, logger, azevedoOs);
  followUpScheduler.start();

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
      automationWorker.stop();
      followUpScheduler.stop();
      sessionScheduleWatcher.stop();
      aiRuntime.stop();
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

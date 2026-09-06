import type { PrismaClient } from "@azvchat/database";
import type { WhatsAppProvider } from "@azvchat/whatsapp";
import type { Server } from "socket.io";
import type { Logger } from "pino";
import type { AppConfig } from "./config.js";
import type { MediaStorage } from "./lib/media-storage.js";
import type { AuditService } from "./modules/audit/service.js";
import type { AzevedoOsClient } from "./services/azevedo-os-client.js";
import type { InstanceManager } from "./services/instance-manager.js";
import type { MessageIngestService } from "./services/message-ingest.js";
import type { AutomationEngine } from "./services/automation/engine.js";

/** Dependências compartilhadas injetadas em todos os módulos de rota. */
export interface AppDeps {
  config: AppConfig;
  prisma: PrismaClient;
  provider: WhatsAppProvider;
  io: Server;
  logger: Logger;
  storage: MediaStorage;
  audit: AuditService;
  instanceManager: InstanceManager;
  ingest: MessageIngestService;
  /** Leitura do cadastro empresarial no Azevedo-OS (ver azevedo-os-client). */
  azevedoOs: AzevedoOsClient;
  /** Motor de automações — construtor de fluxos + execução (ver services/automation). */
  automation: AutomationEngine;
}

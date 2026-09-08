import type { PrismaClient } from "@azvchat/database";
import type { WhatsAppProvider } from "@azvchat/whatsapp";
import type { Server } from "socket.io";
import type { Logger } from "pino";
import { processDueExecutions } from "../lib/follow-up-engine.js";
import type { AzevedoOsClient } from "./azevedo-os-client.js";

/**
 * Roda o Follow-up Automático NO BACKEND — seção 37 do pedido: a automação
 * não pode depender de aba de navegador aberta. Mesmo desenho do
 * `ScheduledMessageWorker` (`scheduler.ts`): um `setInterval` dentro do
 * próprio processo da API, suficiente para o volume de um escritório. Se um
 * dia existir mais de uma instância da API, o caminho é uma fila real
 * (BullMQ/Redis) — a interface pública desta classe não muda.
 *
 * Os timers SOBREVIVEM a reinício (seção 38): nada aqui é estado em
 * memória além do relógio do `setInterval` — a próxima ação de cada
 * execução mora em `FollowUpExecution.nextRunAt`, no banco. Reiniciar o
 * processo só reagenda a PRÓXIMA leitura da tabela; nenhum timer se perde.
 */
export class FollowUpScheduler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(
    private readonly prisma: PrismaClient,
    private readonly provider: WhatsAppProvider,
    private readonly io: Server,
    private readonly logger: Logger,
    private readonly azevedoOs: AzevedoOsClient,
    private readonly intervalMs: number = 30_000,
    private readonly batchSize: number = 20,
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), this.intervalMs);
    this.logger.info({ event: "follow_up_scheduler_started", intervalMs: this.intervalMs });
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const processed = await processDueExecutions(
        { prisma: this.prisma, io: this.io, logger: this.logger, provider: this.provider, azevedoOs: this.azevedoOs },
        this.batchSize,
      );
      if (processed > 0) {
        this.logger.info({ event: "follow_up_scheduler_tick", processed });
      }
    } catch (err) {
      this.logger.error({ event: "follow_up_scheduler_tick_failed", error: String(err) });
    } finally {
      this.running = false;
    }
  }
}

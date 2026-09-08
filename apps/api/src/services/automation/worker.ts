import type { Logger } from "pino";
import type { AutomationEngine } from "./engine.js";

/** Intervalo de varredura — mesma ordem de grandeza do `ScheduledMessageWorker`. */
const TICK_MS = 30_000;

/**
 * Roda o motor de automação periodicamente, para o que NÃO é reação direta a
 * uma mensagem chegando: retomar um "Aguardar" cujo prazo venceu e disparar o
 * gatilho "contato sem resposta". Mesmo padrão de `ScheduledMessageWorker`:
 * um `setInterval` no próprio processo da API, suficiente para o volume de
 * um escritório — nada aqui depende de página de navegador aberta.
 */
export class AutomationWorker {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(
    private readonly engine: AutomationEngine,
    private readonly logger: Logger,
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), TICK_MS);
    this.logger.info({ event: "automation_worker_started", intervalMs: TICK_MS });
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
      await this.engine.tick();
    } finally {
      this.running = false;
    }
  }
}

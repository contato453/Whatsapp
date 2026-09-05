import type { Logger } from "pino";

/**
 * Consumidor do stream SSE `/api/events` do AstraCalls. É por aqui que chega
 * o QR do pareamento (`session-qr`), o estado de autenticação (`auth-state`)
 * e os eventos de chamada — coisas que NÃO vêm pelo webhook (o webhook é por
 * sessão e cobre mensagem/receipt; o SSE é o canal global de sinalização).
 *
 * Uma conexão só cobre todas as instâncias: cada evento traz `sessionId`, e o
 * provider roteia por ele. Reconecta sozinho com backoff — stream que cai
 * (deploy do AstraCalls, rede) não pode deixar o pareamento mudo para sempre.
 */
export interface AstraSseEvent {
  type?: string;
  sessionId?: string;
  [key: string]: unknown;
}

export interface SseConsumerOptions {
  baseUrl: string;
  apiKey: string;
  clientId: string;
  onEvent: (event: AstraSseEvent) => void;
  logger?: Logger;
}

const MAX_BACKOFF_MS = 30_000;

export class SseConsumer {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly clientId: string;
  private readonly onEvent: (event: AstraSseEvent) => void;
  private readonly logger?: Logger;

  private running = false;
  private controller: AbortController | null = null;
  private backoff = 1_000;

  constructor(options: SseConsumerOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.apiKey = options.apiKey;
    this.clientId = options.clientId;
    this.onEvent = options.onEvent;
    this.logger = options.logger;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    void this.loop();
  }

  stop(): void {
    this.running = false;
    this.controller?.abort();
    this.controller = null;
  }

  private async loop(): Promise<void> {
    while (this.running) {
      try {
        await this.connectOnce();
        // Retorno normal = servidor fechou o stream; reconecta.
        this.backoff = 1_000;
      } catch (err) {
        if (!this.running) return;
        this.logger?.warn({ event: "astracalls_sse_error", error: String(err) });
      }
      if (!this.running) return;
      await this.sleep(this.backoff);
      this.backoff = Math.min(this.backoff * 2, MAX_BACKOFF_MS);
    }
  }

  private async connectOnce(): Promise<void> {
    this.controller = new AbortController();
    const url = `${this.baseUrl}/api/events?clientId=${encodeURIComponent(this.clientId)}`;
    const response = await fetch(url, {
      headers: { "X-API-Key": this.apiKey, Accept: "text/event-stream" },
      signal: this.controller.signal,
    });
    if (!response.ok || !response.body) {
      throw new Error(`SSE respondeu ${response.status}`);
    }
    this.logger?.info({ event: "astracalls_sse_connected" });
    this.backoff = 1_000;

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      buffer += decoder.decode(value, { stream: true });
      // Eventos SSE são separados por linha em branco; cada bloco tem
      // linhas `data: ...`. Processamos por linha `data:` — é como o
      // AstraCalls emite (um JSON por `data:`).
      let index: number;
      while ((index = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, index).trimEnd();
        buffer = buffer.slice(index + 1);
        if (!line.startsWith("data:")) continue;
        const json = line.slice(5).trim();
        if (!json) continue;
        try {
          this.onEvent(JSON.parse(json) as AstraSseEvent);
        } catch (err) {
          this.logger?.warn({ event: "astracalls_sse_parse_failed", error: String(err) });
        }
      }
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      // Não segura o processo no shutdown.
      if (typeof timer.unref === "function") timer.unref();
    });
  }
}

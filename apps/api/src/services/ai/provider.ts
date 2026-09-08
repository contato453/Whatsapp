import type { AiProviderKind } from "@azvchat/shared";

/**
 * Abstração do provedor de IA. O resto do AZVCHAT fala SÓ com esta
 * interface — nada fora de `services/ai/` conhece o formato da OpenAI. Um
 * provedor novo é uma classe nova que a implementa e uma linha no
 * `createAiProvider`, sem tocar no motor de atendimento.
 *
 * O contrato é o mínimo que o atendimento precisa: chat com ferramentas
 * (function calling), teste de credencial, lista de modelos e, quando o
 * provedor oferece, o custo faturado.
 */

export type AiProviderErrorCode =
  | "invalid_api_key"
  | "model_unavailable"
  | "rate_limited"
  | "timeout"
  | "insufficient_quota"
  | "invalid_response"
  | "provider_error";

/**
 * Erro do provedor, já classificado. A mensagem é em português e NUNCA
 * carrega o corpo da resposta do provedor: ele costuma ecoar o cabeçalho da
 * requisição, e o cabeçalho leva a chave.
 */
export class AiProviderError extends Error {
  constructor(
    public readonly code: AiProviderErrorCode,
    message: string,
    /** Status HTTP do provedor, quando houve resposta. */
    public readonly status?: number,
  ) {
    super(message);
    this.name = "AiProviderError";
  }

  /** Erro que não adianta repetir sem mexer na configuração. */
  get permanent(): boolean {
    return this.code === "invalid_api_key" || this.code === "model_unavailable" || this.code === "insufficient_quota";
  }
}

export interface AiToolDefinition {
  name: string;
  description: string;
  /** JSON Schema dos argumentos. */
  parameters: Record<string, unknown>;
}

export type AiChatMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | { role: "assistant"; content: string | null; toolCalls?: AiToolCall[] }
  | { role: "tool"; toolCallId: string; content: string };

export interface AiToolCall {
  id: string;
  name: string;
  /** Argumentos já decodificados; `{}` quando o modelo mandou JSON inválido. */
  arguments: Record<string, unknown>;
}

export interface AiChatRequest {
  apiKey: string;
  model: string;
  messages: AiChatMessage[];
  tools: AiToolDefinition[];
  temperature: number | null;
  maxOutputTokens: number;
  timeoutMs: number;
}

export interface AiChatResult {
  content: string | null;
  toolCalls: AiToolCall[];
  usage: { inputTokens: number; outputTokens: number };
  finishReason: string | null;
}

export interface AiProviderModel {
  id: string;
  /** Data de criação informada pelo provedor, quando existe. */
  createdAt: Date | null;
}

export interface AiProviderBilling {
  available: boolean;
  reason: string | null;
  monthCostMicros: number | null;
}

export interface AiProvider {
  readonly kind: AiProviderKind;
  /** Valida a credencial numa chamada barata. Lança `AiProviderError`. */
  testConnection(apiKey: string, timeoutMs: number): Promise<void>;
  /** Modelos de chat que a credencial alcança. */
  listModels(apiKey: string, timeoutMs: number): Promise<AiProviderModel[]>;
  chat(request: AiChatRequest): Promise<AiChatResult>;
  /**
   * Custo faturado no mês, quando o provedor expõe uma API para isso com o
   * tipo de credencial informada. `available: false` com o motivo quando
   * não expõe — nunca um número inventado.
   */
  fetchBilling(apiKey: string, monthStart: Date, timeoutMs: number): Promise<AiProviderBilling>;
}

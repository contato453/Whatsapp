import type { Logger } from "pino";
import {
  AiProviderError,
  type AiChatMessage,
  type AiChatRequest,
  type AiChatResult,
  type AiProvider,
  type AiProviderBilling,
  type AiProviderModel,
  type AiToolCall,
} from "./provider.js";

/**
 * OpenAI por HTTP puro (`fetch` do Node 22), sem SDK: a superfície usada é
 * pequena (chat completions com function calling, lista de modelos, custo da
 * organização) e uma dependência a mais só para isso traria versão para
 * acompanhar. Nenhum log aqui carrega a chave nem o corpo da resposta.
 */

const DEFAULT_BASE_URL = "https://api.openai.com/v1";

/** Modelos que não são de chat, para a lista não oferecer o que não serve. */
const NON_CHAT_PATTERNS = [
  /embedding/,
  /whisper/,
  /tts/,
  /audio/,
  /realtime/,
  /transcribe/,
  /moderation/,
  /image/,
  /dall-e/,
  /search/,
  /instruct/,
  /davinci/,
  /babbage/,
  /codex/,
  /computer-use/,
  /-preview/,
  /chat-latest/,
  /deep-research/,
  /sora/,
];

/** Só ids que começam com estas famílias entram na lista de chat. */
const CHAT_FAMILIES = [/^gpt-/, /^o[0-9]/];

function isChatModel(id: string): boolean {
  if (!CHAT_FAMILIES.some((pattern) => pattern.test(id))) return false;
  return !NON_CHAT_PATTERNS.some((pattern) => pattern.test(id));
}

/**
 * Modelos de raciocínio (o-série e gpt-5) não aceitam `temperature` fora do
 * padrão — mandar o parâmetro devolve 400. A detecção é por prefixo, que é
 * a única informação que a API dá.
 */
function supportsTemperature(model: string): boolean {
  return !/^o[0-9]/.test(model) && !/^gpt-5/.test(model);
}

interface OpenAiToolCallPayload {
  id: string;
  type: string;
  function: { name: string; arguments: string };
}

interface OpenAiChatResponse {
  choices?: Array<{
    message?: { content?: string | null; tool_calls?: OpenAiToolCallPayload[] };
    finish_reason?: string | null;
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

function toOpenAiMessage(message: AiChatMessage): Record<string, unknown> {
  switch (message.role) {
    case "system":
      return { role: "system", content: message.content };
    case "user":
      return { role: "user", content: message.content };
    case "assistant":
      return {
        role: "assistant",
        content: message.content,
        ...(message.toolCalls?.length
          ? {
              tool_calls: message.toolCalls.map((call) => ({
                id: call.id,
                type: "function",
                function: { name: call.name, arguments: JSON.stringify(call.arguments) },
              })),
            }
          : {}),
      };
    case "tool":
      return { role: "tool", tool_call_id: message.toolCallId, content: message.content };
  }
}

function parseToolCalls(payload: OpenAiToolCallPayload[] | undefined): AiToolCall[] {
  if (!payload) return [];
  return payload
    .filter((call) => call.type === "function" && call.function?.name)
    .map((call) => {
      let args: Record<string, unknown> = {};
      try {
        const parsed: unknown = JSON.parse(call.function.arguments || "{}");
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          args = parsed as Record<string, unknown>;
        }
      } catch {
        // JSON quebrado: a ferramenta recebe `{}` e recusa por argumento
        // ausente, com mensagem que o modelo consegue corrigir na próxima volta.
      }
      return { id: call.id, name: call.function.name, arguments: args };
    });
}

export class OpenAiProvider implements AiProvider {
  readonly kind = "openai" as const;

  constructor(
    private readonly options: { baseUrl?: string; logger: Logger },
  ) {}

  private get baseUrl(): string {
    return (this.options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "");
  }

  private async request(
    apiKey: string,
    path: string,
    init: { method: "GET" | "POST"; body?: unknown; timeoutMs: number },
  ): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), init.timeoutMs);
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}${path}`, {
        method: init.method,
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
        signal: controller.signal,
      });
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        throw new AiProviderError("timeout", "O provedor de IA demorou demais para responder.");
      }
      throw new AiProviderError("provider_error", "Não foi possível falar com o provedor de IA.");
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      // O corpo NÃO vai para o erro: pode ecoar o cabeçalho enviado.
      const text = await response.text().catch(() => "");
      const code = extractErrorCode(text);
      this.options.logger.warn({
        event: "ai_provider_http_error",
        provider: "openai",
        path,
        status: response.status,
        providerCode: code,
      });
      throw classifyHttpError(response.status, code);
    }
    try {
      return await response.json();
    } catch {
      throw new AiProviderError("invalid_response", "O provedor de IA devolveu uma resposta inesperada.");
    }
  }

  async testConnection(apiKey: string, timeoutMs: number): Promise<void> {
    // Listar modelos é a chamada mais barata que valida a chave e o acesso.
    await this.request(apiKey, "/models", { method: "GET", timeoutMs });
  }

  async listModels(apiKey: string, timeoutMs: number): Promise<AiProviderModel[]> {
    const data = (await this.request(apiKey, "/models", { method: "GET", timeoutMs })) as {
      data?: Array<{ id?: string; created?: number }>;
    };
    const models = (data.data ?? [])
      .filter((model): model is { id: string; created?: number } => typeof model.id === "string")
      .filter((model) => isChatModel(model.id))
      .map((model) => ({
        id: model.id,
        createdAt: typeof model.created === "number" ? new Date(model.created * 1000) : null,
      }));
    models.sort((a, b) => a.id.localeCompare(b.id));
    return models;
  }

  async chat(request: AiChatRequest): Promise<AiChatResult> {
    const body: Record<string, unknown> = {
      model: request.model,
      messages: request.messages.map(toOpenAiMessage),
      max_completion_tokens: request.maxOutputTokens,
    };
    if (request.tools.length > 0) {
      body.tools = request.tools.map((tool) => ({
        type: "function",
        function: { name: tool.name, description: tool.description, parameters: tool.parameters },
      }));
      body.tool_choice = "auto";
    }
    if (request.temperature != null && supportsTemperature(request.model)) {
      body.temperature = request.temperature;
    }
    const data = (await this.request(request.apiKey, "/chat/completions", {
      method: "POST",
      body,
      timeoutMs: request.timeoutMs,
    })) as OpenAiChatResponse;
    const choice = data.choices?.[0];
    if (!choice?.message) {
      throw new AiProviderError("invalid_response", "O provedor de IA devolveu uma resposta sem conteúdo.");
    }
    return {
      content: choice.message.content ?? null,
      toolCalls: parseToolCalls(choice.message.tool_calls),
      usage: {
        inputTokens: data.usage?.prompt_tokens ?? 0,
        outputTokens: data.usage?.completion_tokens ?? 0,
      },
      finishReason: choice.finish_reason ?? null,
    };
  }

  /**
   * A OpenAI só expõe custo pela API de organização (`/organization/costs`),
   * que exige uma ADMIN KEY — a chave de projeto comum recebe 401/403. Não
   * existe endpoint público de "saldo" para chave de API. Então: tenta com a
   * chave que temos; se ela não alcança, diz isso, sem inventar número.
   */
  async fetchBilling(apiKey: string, monthStart: Date, timeoutMs: number): Promise<AiProviderBilling> {
    const startTime = Math.floor(monthStart.getTime() / 1000);
    try {
      const data = (await this.request(
        apiKey,
        `/organization/costs?start_time=${startTime}&bucket_width=1d&limit=31`,
        { method: "GET", timeoutMs },
      )) as {
        data?: Array<{ results?: Array<{ amount?: { value?: number; currency?: string } }> }>;
      };
      let usd = 0;
      for (const bucket of data.data ?? []) {
        for (const result of bucket.results ?? []) {
          if (typeof result.amount?.value === "number") usd += result.amount.value;
        }
      }
      return { available: true, reason: null, monthCostMicros: Math.round(usd * 1_000_000) };
    } catch (err) {
      if (err instanceof AiProviderError && (err.status === 401 || err.status === 403)) {
        return {
          available: false,
          reason:
            "Saldo não disponibilizado pelo provedor para esta chave. A OpenAI só informa custo faturado por uma chave de administrador (Admin key); o consumo abaixo é o registrado pelo AZVCHAT.",
          monthCostMicros: null,
        };
      }
      return {
        available: false,
        reason: "O provedor não respondeu à consulta de custo agora. O consumo abaixo é o registrado pelo AZVCHAT.",
        monthCostMicros: null,
      };
    }
  }
}

function extractErrorCode(text: string): string | null {
  try {
    const parsed = JSON.parse(text) as { error?: { code?: string; type?: string } };
    return parsed.error?.code ?? parsed.error?.type ?? null;
  } catch {
    return null;
  }
}

function classifyHttpError(status: number, providerCode: string | null): AiProviderError {
  if (status === 401) {
    return new AiProviderError("invalid_api_key", "Chave de API inválida ou revogada.", status);
  }
  if (status === 403) {
    return new AiProviderError("invalid_api_key", "A chave de API não tem acesso a este recurso.", status);
  }
  if (status === 404 || providerCode === "model_not_found") {
    return new AiProviderError("model_unavailable", "O modelo escolhido não está disponível para esta chave.", status);
  }
  if (status === 429) {
    if (providerCode === "insufficient_quota") {
      return new AiProviderError("insufficient_quota", "A conta do provedor está sem crédito ou cota.", status);
    }
    return new AiProviderError("rate_limited", "O provedor limitou a quantidade de chamadas. Tente de novo em instantes.", status);
  }
  if (status >= 500) {
    return new AiProviderError("provider_error", "O provedor de IA está com instabilidade.", status);
  }
  return new AiProviderError("provider_error", "O provedor de IA recusou a chamada.", status);
}

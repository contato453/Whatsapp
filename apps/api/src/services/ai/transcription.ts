import type { Conversation, Prisma, PrismaClient } from "@azvchat/database";
import {
  AI_DEFAULT_TRANSCRIPTION_MODEL,
  AI_TRANSCRIPTION_LANGUAGE,
  AI_TRANSCRIPTION_LIMITS,
  RealtimeEvents,
  audioTranscriptCanRetry,
  estimateTranscriptionCostMicros,
  readAudioTranscript,
  withAudioTranscript,
  type AudioTranscriptMetadata,
  type AudioTranscriptStatus,
} from "@azvchat/shared";
import type { Server } from "socket.io";
import type { Logger } from "pino";
import type { MediaStorage } from "../../lib/media-storage.js";
import { serializeMessage } from "../../lib/serialize.js";
import { conversationAudience } from "../../realtime/socket.js";
import { AiProviderError } from "./provider.js";
import type { ResolvedCredentials } from "./credentials.js";

/**
 * A IA OUVINDO O CLIENTE: áudio recebido → texto, antes do turno.
 *
 * Por que isto existe: no WhatsApp do escritório, o cliente que tem pressa
 * GRAVA em vez de escrever. Até aqui o áudio chegava ao modelo como o rótulo
 * "[áudio]", então a IA respondia sem saber o que havia sido dito — e o caso
 * mais comum do canal era justamente o que o atendimento por IA não atendia.
 *
 * Decisões que não são opcionais para quem mexer aqui:
 *
 * 1. **A transcrição é GRAVADA no `metadata` da mensagem** (chave
 *    `audioTranscript`, em `@azvchat/shared`), e não recalculada por turno. O
 *    mesmo áudio entra no contexto de vários turnos seguidos, e cada
 *    transcrição é chamada PAGA por minuto: refazê-la a cada volta
 *    multiplicaria a conta pelo tamanho do histórico. De graça vem a
 *    sobrevivência a reinício e a bolha da equipe vendo o que a IA ouviu.
 * 2. **O insucesso também é gravado.** Sem a marca, áudio que não dá para
 *    transcrever (arquivo que não baixou, áudio de meia hora, provedor fora do
 *    ar) seria tentado a cada turno, e o modelo seguiria respondendo como se o
 *    cliente não tivesse falado nada. Com ela, o motor avisa ao modelo que
 *    aquele áudio ele não ouviu — e o modelo pede ao cliente para escrever.
 *    Falha do PROVEDOR (e só ela) vale uma segunda tentativa num turno
 *    seguinte: o mesmo motivo da retentativa do download de mídia — um tropeço
 *    de rede não pode deixar o áudio mudo para sempre.
 * 3. **Falhar aqui NUNCA derruba o turno.** A função não lança: devolve as
 *    mensagens com o que conseguiu. Deixar de entender um áudio é ruim;
 *    deixar de responder o cliente é pior.
 * 4. **O arquivo sai do storage, em bytes, e vai no corpo da chamada** — nunca
 *    um link: mídia do AZVCHAT só existe atrás de rota autenticada.
 * 5. **Nada de conteúdo em log.** O log leva id, status, duração e modelo; o
 *    que o cliente disse fica na conversa, como em todo o resto da casa.
 */

export interface AudioTranscriptionDeps {
  prisma: PrismaClient;
  io: Server;
  logger: Logger;
  media: MediaStorage;
}

/** O que a transcrição precisa de uma mensagem — o select do motor. */
export interface TranscribableMessage {
  id: string;
  type: string;
  content: string | null;
  mediaUrl: string | null;
  mimeType: string | null;
  metadata: unknown;
}

export interface TranscriptionContext {
  organizationId: string;
  conversation: Conversation;
  credentials: ResolvedCredentials;
  /** Modelo de transcrição (ver `resolveTranscriptionModel`). */
  model: string;
  timeoutMs: number;
  /**
   * Desligado = capacidade "Ouvir áudios do cliente" fora no agente OU
   * interruptor do escritório fechado. Nem lê o arquivo, nem marca metadata:
   * religar a chave depois deve voltar a transcrever os próximos áudios sem
   * ter deixado registro de "tentei e não pude".
   */
  enabled: boolean;
  /** Sessão à qual cobrar o consumo; nulo no testador. */
  sessionId: string | null;
  agent: { id: string; name: string } | null;
}

/** Modelo de transcrição em vigor: o do escritório, senão o padrão do sistema. */
export function resolveTranscriptionModel(configured: string | null | undefined): string {
  const trimmed = configured?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : AI_DEFAULT_TRANSCRIPTION_MODEL;
}

/**
 * Garante a transcrição das mensagens de ÁUDIO da lista e devolve a lista com
 * o `metadata` atualizado — as outras mensagens voltam intactas. A ordem é
 * preservada, porque é a ordem da conversa.
 */
export async function ensureAudioTranscripts(
  deps: AudioTranscriptionDeps,
  ctx: TranscriptionContext,
  messages: TranscribableMessage[],
): Promise<TranscribableMessage[]> {
  if (!ctx.enabled) return messages;
  const result: TranscribableMessage[] = [];
  for (const message of messages) {
    if (message.type !== "audio") {
      result.push(message);
      continue;
    }
    const existing = readAudioTranscript(message.metadata);
    if (existing && !audioTranscriptCanRetry(existing)) {
      result.push(message);
      continue;
    }
    // Sequencial de propósito: um cliente manda dois ou três áudios seguidos,
    // e transcrever em paralelo só abriria mais conexões ao provedor para
    // ganhar segundos num turno que já tem o debounce de 2,5s na frente.
    const metadata = await transcribeOne(deps, ctx, message, existing?.attempts ?? 0);
    result.push({ ...message, metadata });
  }
  return result;
}

async function transcribeOne(
  deps: AudioTranscriptionDeps,
  ctx: TranscriptionContext,
  message: TranscribableMessage,
  previousAttempts: number,
): Promise<unknown> {
  const durationSeconds = readDurationSeconds(message.metadata);

  if (!message.mediaUrl) {
    return persist(deps, ctx, message, record("no_file", null, ctx.model, previousAttempts));
  }
  if (durationSeconds != null && durationSeconds > AI_TRANSCRIPTION_LIMITS.maxSeconds) {
    deps.logger.info({
      event: "ai_transcription_skipped",
      reason: "too_long",
      messageId: message.id,
      conversationId: ctx.conversation.id,
      durationSeconds,
    });
    return persist(deps, ctx, message, record("too_long", null, ctx.model, previousAttempts));
  }

  let audio: Buffer;
  try {
    audio = await deps.media.read(message.mediaUrl);
  } catch (err) {
    // Arquivo que sumiu do storage não volta por tentar de novo: é `no_file`,
    // e não `failed`, justamente para não gastar uma segunda tentativa paga.
    deps.logger.warn({
      event: "ai_transcription_media_unreadable",
      messageId: message.id,
      conversationId: ctx.conversation.id,
      error: String(err),
    });
    return persist(deps, ctx, message, record("no_file", null, ctx.model, previousAttempts));
  }
  if (audio.length > AI_TRANSCRIPTION_LIMITS.maxBytes) {
    return persist(deps, ctx, message, record("too_long", null, ctx.model, previousAttempts));
  }

  const startedAt = Date.now();
  try {
    const transcription = await ctx.credentials.provider.transcribeAudio({
      apiKey: ctx.credentials.apiKey,
      model: ctx.model,
      audio,
      filename: filenameFor(message.mimeType),
      mimeType: message.mimeType,
      language: AI_TRANSCRIPTION_LANGUAGE,
      timeoutMs: ctx.timeoutMs,
    });
    // A duração do WhatsApp vence a do provedor: ela é do áudio como o
    // cliente o gravou, e é a que o teto de duração já usou.
    const seconds = durationSeconds ?? transcription.seconds;
    const text = transcription.text.trim();
    await chargeUsage(deps, ctx, {
      seconds,
      inputTokens: transcription.usage.inputTokens,
      outputTokens: transcription.usage.outputTokens,
      durationMs: Date.now() - startedAt,
      outcome: "ok",
      errorCode: null,
    });
    deps.logger.info({
      event: "ai_transcription_done",
      messageId: message.id,
      conversationId: ctx.conversation.id,
      model: ctx.model,
      durationSeconds: seconds,
      // Só o TAMANHO do texto — nunca o texto.
      chars: text.length,
    });
    return persist(
      deps,
      ctx,
      message,
      record(text ? "ok" : "empty", text || null, ctx.model, previousAttempts),
    );
  } catch (err) {
    const providerError = err instanceof AiProviderError ? err : null;
    await chargeUsage(deps, ctx, {
      seconds: durationSeconds,
      inputTokens: 0,
      outputTokens: 0,
      durationMs: Date.now() - startedAt,
      outcome: providerError?.code === "timeout" ? "timeout" : "error",
      errorCode: providerError?.code ?? "unexpected",
    });
    deps.logger.warn({
      event: "ai_transcription_failed",
      messageId: message.id,
      conversationId: ctx.conversation.id,
      model: ctx.model,
      code: providerError?.code ?? "unexpected",
    });
    return persist(deps, ctx, message, record("failed", null, ctx.model, previousAttempts));
  }
}

function record(
  status: AudioTranscriptStatus,
  text: string | null,
  model: string,
  previousAttempts: number,
): AudioTranscriptMetadata {
  return { status, text, model, at: new Date().toISOString(), attempts: previousAttempts + 1 };
}

/**
 * Grava no `metadata` e publica `message:updated` para a audiência da
 * conversa: a equipe precisa ver na bolha o mesmo texto que a IA leu, senão
 * o resumo da transferência citaria conteúdo que ninguém consegue conferir.
 * Evento que já existia e já carrega o `metadata` inteiro — nenhum contrato
 * de tempo real mudou por causa disto.
 */
async function persist(
  deps: AudioTranscriptionDeps,
  ctx: TranscriptionContext,
  message: TranscribableMessage,
  value: AudioTranscriptMetadata,
): Promise<unknown> {
  const metadata = withAudioTranscript(message.metadata, value);
  try {
    const saved = await deps.prisma.message.update({
      where: { id: message.id },
      data: { metadata: metadata as unknown as Prisma.InputJsonValue },
    });
    deps.io
      .to(conversationAudience(ctx.organizationId, ctx.conversation))
      .emit(RealtimeEvents.MessageUpdated, serializeMessage(saved));
  } catch (err) {
    // Não gravou? O turno segue com a transcrição em mãos (ela está no objeto
    // devolvido); o custo é transcrever de novo no próximo turno.
    deps.logger.warn({
      event: "ai_transcription_persist_failed",
      messageId: message.id,
      error: String(err),
    });
  }
  return metadata;
}

/**
 * Consumo da transcrição: linha própria em `AiUsageLog` com `kind`
 * `transcription` — nunca somada ao `chat`, senão o custo por turno de
 * atendimento deixaria de fechar e ninguém saberia quanto o áudio custou. O
 * total da SESSÃO, sim, inclui os dois: ele responde "quanto custou este
 * atendimento".
 */
async function chargeUsage(
  deps: AudioTranscriptionDeps,
  ctx: TranscriptionContext,
  input: {
    seconds: number | null;
    inputTokens: number;
    outputTokens: number;
    durationMs: number;
    outcome: "ok" | "error" | "timeout";
    errorCode: string | null;
  },
): Promise<void> {
  const costMicros = input.outcome === "ok" ? estimateTranscriptionCostMicros(ctx.model, input.seconds) : null;
  try {
    await deps.prisma.aiUsageLog.create({
      data: {
        organizationId: ctx.organizationId,
        sessionId: ctx.sessionId,
        agentId: ctx.agent?.id ?? null,
        agentName: ctx.agent?.name ?? null,
        conversationId: ctx.conversation.id,
        departmentId: ctx.conversation.departmentId,
        provider: ctx.credentials.kind,
        model: ctx.model,
        kind: "transcription",
        outcome: input.outcome,
        inputTokens: input.inputTokens,
        outputTokens: input.outputTokens,
        costMicros,
        durationMs: input.durationMs,
        errorCode: input.errorCode,
        toolsRequested: [],
        toolsExecuted: [],
        toolsBlocked: [],
      },
    });
    if (ctx.sessionId) {
      await deps.prisma.aiSession.update({
        where: { id: ctx.sessionId },
        data: {
          inputTokens: { increment: input.inputTokens },
          outputTokens: { increment: input.outputTokens },
          costMicros: { increment: costMicros ?? 0 },
        },
      });
    }
  } catch (err) {
    deps.logger.warn({ event: "ai_transcription_usage_log_failed", error: String(err) });
  }
}

/** Duração que o WhatsApp mandou, gravada pela ingestão. */
function readDurationSeconds(metadata: unknown): number | null {
  if (!metadata || typeof metadata !== "object") return null;
  const value = (metadata as Record<string, unknown>).durationSeconds;
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

/**
 * O provedor decide o decodificador pela EXTENSÃO do nome do arquivo, não pelo
 * mime type do multipart: nota de voz do WhatsApp mandada como "audio" sem
 * extensão volta como formato não suportado.
 */
function filenameFor(mimeType: string | null): string {
  const clean = (mimeType ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
  const map: Record<string, string> = {
    "audio/ogg": "ogg",
    "audio/opus": "ogg",
    "audio/mpeg": "mp3",
    "audio/mp3": "mp3",
    "audio/mp4": "m4a",
    "audio/m4a": "m4a",
    "audio/aac": "m4a",
    "audio/x-m4a": "m4a",
    "audio/wav": "wav",
    "audio/x-wav": "wav",
    "audio/webm": "webm",
    "audio/amr": "amr",
    "audio/flac": "flac",
  };
  return `audio.${map[clean] ?? "ogg"}`;
}

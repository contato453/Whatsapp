import type { Conversation, Prisma, PrismaClient } from "@azvchat/database";
import {
  AI_DEFAULT_TRANSCRIPTION_MODEL,
  AI_DOCUMENT_LIMITS,
  AI_TRANSCRIPTION_LANGUAGE,
  AI_TRANSCRIPTION_LIMITS,
  AI_VISION_LIMITS,
  RealtimeEvents,
  aiAttachmentCanRetry,
  estimateCostMicros,
  estimateTranscriptionCostMicros,
  readAiAttachmentInsightOf,
  withAiAttachmentInsight,
  type AiAttachmentInsight,
  type AiAttachmentKind,
  type AiAttachmentStatus,
  type AiPricingOverrides,
  type AiUsageKind,
} from "@azvchat/shared";
import type { Server } from "socket.io";
import type { Logger } from "pino";
import { AppError } from "../../lib/errors.js";
import type { MediaStorage } from "../../lib/media-storage.js";
import { serializeMessage } from "../../lib/serialize.js";
import { conversationAudience } from "../../realtime/socket.js";
import { extractDocumentText } from "./knowledge-extract.js";
import { AiProviderError } from "./provider.js";
import type { ResolvedCredentials } from "./credentials.js";

/**
 * A IA ENTENDENDO O ANEXO DO CLIENTE: áudio, imagem e documento → texto, antes
 * do turno.
 *
 * Por que isto existe: no WhatsApp do escritório, o cliente que tem pressa
 * GRAVA um áudio, FOTOGRAFA o comprovante ou MANDA o PDF do contrato. Até aqui
 * os três chegavam ao modelo como rótulo ("[áudio]", "[imagem]",
 * "[documento]"), então a IA respondia sem saber o que havia recebido — o caso
 * mais comum do canal era justamente o que o atendimento por IA não atendia.
 *
 * Três caminhos, um desenho só:
 *   - **áudio** → transcrição (`provider.transcribeAudio`), paga por minuto;
 *   - **imagem** → descrição por visão (`provider.describeImage`), paga por
 *     token, com o MESMO modelo de chat do agente — ele já enxerga imagem, e um
 *     modelo à parte seria mais configuração para o escritório manter;
 *   - **documento** → texto extraído AQUI (`extractDocumentText`, o mesmo
 *     extrator da base de conhecimento), sem chamada e sem custo.
 *
 * Decisões que não são opcionais para quem mexer aqui:
 *
 * 1. **O resultado é GRAVADO no `metadata` da mensagem** (chaves em
 *    `@azvchat/shared`), e não recalculado por turno. O mesmo anexo entra no
 *    contexto de vários turnos seguidos, e ler é chamada PAGA: refazer a leitura
 *    a cada volta multiplicaria a conta pelo tamanho do histórico. De graça vêm
 *    a sobrevivência a reinício e a bolha da equipe vendo o que a IA entendeu.
 * 2. **O insucesso também é gravado.** Sem a marca, anexo que não dá para ler
 *    (arquivo que não baixou, áudio de meia hora, PDF digitalizado, provedor
 *    fora do ar) seria tentado a cada turno, e o modelo seguiria respondendo
 *    como se o cliente não tivesse mandado nada. Com ela, o motor avisa ao
 *    modelo que aquele anexo ele não conseguiu ler — e o modelo pede ao cliente
 *    para escrever. Falha do PROVEDOR (e só ela) vale uma segunda tentativa num
 *    turno seguinte: o mesmo motivo da retentativa do download de mídia.
 * 3. **Falhar aqui NUNCA derruba o turno.** A função não lança: devolve as
 *    mensagens com o que conseguiu. Deixar de entender um anexo é ruim; deixar
 *    de responder o cliente é pior.
 * 4. **O arquivo sai do storage, em bytes, e vai no corpo da chamada** — nunca
 *    um link: mídia do AZVCHAT só existe atrás de rota autenticada.
 * 5. **Nada de conteúdo em log.** O log leva id, tipo, status e modelo; o que o
 *    cliente mandou fica na conversa, como em todo o resto da casa.
 */

export interface AttachmentReadingDeps {
  prisma: PrismaClient;
  io: Server;
  logger: Logger;
  media: MediaStorage;
}

/** O que a leitura precisa de uma mensagem — o select do motor. */
export interface ReadableMessage {
  id: string;
  type: string;
  content: string | null;
  mediaUrl: string | null;
  mimeType: string | null;
  filename: string | null;
  metadata: unknown;
}

export interface AttachmentContext {
  organizationId: string;
  conversation: Conversation;
  credentials: ResolvedCredentials;
  timeoutMs: number;
  /** Sessão à qual cobrar o consumo; nulo no testador. */
  sessionId: string | null;
  agent: { id: string; name: string } | null;
  /** Tabela de preço do escritório, para o custo da leitura de imagem. */
  pricingOverrides: AiPricingOverrides;
  /**
   * Cada tipo liga e desliga sozinho: a capacidade do agente E (no áudio e na
   * imagem, que custam) o interruptor do escritório. Desligado, nem lê o
   * arquivo nem marca metadata — religar a chave depois volta a ler os
   * próximos anexos sem ter deixado registro de "tentei e não pude".
   */
  audio: { enabled: boolean; model: string };
  image: { enabled: boolean; model: string };
  document: { enabled: boolean };
}

/**
 * O que se pede ao modelo de visão. Curto e objetivo de propósito: a descrição
 * vira CONTEXTO do turno, não resposta ao cliente. A ordem "transcreva o texto
 * visível" vem primeiro porque, num escritório contábil, a foto quase sempre é
 * de um papel — comprovante, boleto, nota, print de erro — e o que importa está
 * escrito nele.
 */
const IMAGE_INSTRUCTION = [
  "Descreva esta imagem para um atendente de escritório contábil, em português do Brasil.",
  "Se houver texto visível (comprovante, boleto, nota, documento, print de tela), TRANSCREVA o texto fielmente, incluindo valores, datas, nomes e números.",
  "Depois, em uma frase, diga o que a imagem é.",
  "Não invente nada que não esteja visível: o que não der para ler, escreva \"ilegível\".",
].join(" ");

/** Modelo de transcrição em vigor: o do escritório, senão o padrão do sistema. */
export function resolveTranscriptionModel(configured: string | null | undefined): string {
  const trimmed = configured?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : AI_DEFAULT_TRANSCRIPTION_MODEL;
}

/** O tipo de anexo que sabemos ler, ou `null` para o resto (texto, enquete...). */
function attachmentKind(type: string): AiAttachmentKind | null {
  if (type === "audio") return "audio";
  if (type === "image") return "image";
  if (type === "document") return "document";
  return null;
}

/**
 * Garante a leitura dos ANEXOS da lista e devolve a lista com o `metadata`
 * atualizado — as outras mensagens voltam intactas. A ordem é preservada,
 * porque é a ordem da conversa.
 */
export async function ensureAttachmentInsights(
  deps: AttachmentReadingDeps,
  ctx: AttachmentContext,
  messages: ReadableMessage[],
): Promise<ReadableMessage[]> {
  const result: ReadableMessage[] = [];
  for (const message of messages) {
    const kind = attachmentKind(message.type);
    if (!kind || !ctx[kind].enabled) {
      result.push(message);
      continue;
    }
    const existing = readAiAttachmentInsightOf(kind, message.metadata);
    if (existing && !aiAttachmentCanRetry(existing)) {
      result.push(message);
      continue;
    }
    // Sequencial de propósito: um cliente manda dois ou três anexos seguidos, e
    // ler em paralelo só abriria mais conexões ao provedor para ganhar segundos
    // num turno que já tem o debounce de 2,5s na frente.
    const metadata = await readOne(deps, ctx, kind, message, existing?.attempts ?? 0);
    result.push({ ...message, metadata });
  }
  return result;
}

async function readOne(
  deps: AttachmentReadingDeps,
  ctx: AttachmentContext,
  kind: AiAttachmentKind,
  message: ReadableMessage,
  previousAttempts: number,
): Promise<unknown> {
  const finish = (status: AiAttachmentStatus, text: string | null, model: string | null) =>
    persist(deps, ctx, message, {
      kind,
      status,
      text,
      model,
      at: new Date().toISOString(),
      attempts: previousAttempts + 1,
    });

  if (!message.mediaUrl) return finish("no_file", null, null);

  const duration = readDurationSeconds(message.metadata);
  if (kind === "audio" && duration != null && duration > AI_TRANSCRIPTION_LIMITS.maxSeconds) {
    deps.logger.info({
      event: "ai_attachment_skipped",
      kind,
      reason: "too_long",
      messageId: message.id,
      conversationId: ctx.conversation.id,
      durationSeconds: duration,
    });
    return finish("too_long", null, null);
  }
  if (kind === "document" && !documentExtension(message)) {
    // Planilha, zip, apresentação: o extrator não abre, e tentar de novo daria
    // o mesmo resultado — por isso `unsupported`, que nunca é retentado.
    return finish("unsupported", null, null);
  }

  let bytes: Buffer;
  try {
    bytes = await deps.media.read(message.mediaUrl);
  } catch (err) {
    // Arquivo que sumiu do storage não volta por tentar de novo: é `no_file`,
    // e não `failed`, justamente para não gastar uma segunda tentativa paga.
    deps.logger.warn({
      event: "ai_attachment_media_unreadable",
      kind,
      messageId: message.id,
      conversationId: ctx.conversation.id,
      error: String(err),
    });
    return finish("no_file", null, null);
  }
  const maxBytes =
    kind === "audio"
      ? AI_TRANSCRIPTION_LIMITS.maxBytes
      : kind === "image"
        ? AI_VISION_LIMITS.maxBytes
        : AI_DOCUMENT_LIMITS.maxBytes;
  if (bytes.length > maxBytes) return finish("too_long", null, null);

  // Documento é lido AQUI: sem provedor, sem custo e sem linha de consumo.
  if (kind === "document") return readDocument(deps, ctx, message, bytes, finish);

  const model = kind === "audio" ? ctx.audio.model : ctx.image.model;
  const startedAt = Date.now();
  try {
    const { text, usage, costMicros } =
      kind === "audio"
        ? await runTranscription(ctx, message, bytes, duration)
        : await runVision(ctx, bytes, message.mimeType);
    await chargeUsage(deps, ctx, {
      usageKind: kind === "audio" ? "transcription" : "vision",
      model,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      costMicros,
      durationMs: Date.now() - startedAt,
      outcome: "ok",
      errorCode: null,
    });
    deps.logger.info({
      event: "ai_attachment_read",
      kind,
      messageId: message.id,
      conversationId: ctx.conversation.id,
      model,
      // Só o TAMANHO do texto — nunca o texto.
      chars: text.length,
    });
    return finish(text ? "ok" : "empty", text || null, model);
  } catch (err) {
    const providerError = err instanceof AiProviderError ? err : null;
    await chargeUsage(deps, ctx, {
      usageKind: kind === "audio" ? "transcription" : "vision",
      model,
      inputTokens: 0,
      outputTokens: 0,
      costMicros: null,
      durationMs: Date.now() - startedAt,
      outcome: providerError?.code === "timeout" ? "timeout" : "error",
      errorCode: providerError?.code ?? "unexpected",
    });
    deps.logger.warn({
      event: "ai_attachment_failed",
      kind,
      messageId: message.id,
      conversationId: ctx.conversation.id,
      model,
      code: providerError?.code ?? "unexpected",
    });
    return finish("failed", null, model);
  }
}

async function runTranscription(
  ctx: AttachmentContext,
  message: ReadableMessage,
  bytes: Buffer,
  durationSeconds: number | null,
): Promise<{ text: string; usage: { inputTokens: number; outputTokens: number }; costMicros: number | null }> {
  const transcription = await ctx.credentials.provider.transcribeAudio({
    apiKey: ctx.credentials.apiKey,
    model: ctx.audio.model,
    audio: bytes,
    filename: audioFilename(message.mimeType),
    mimeType: message.mimeType,
    language: AI_TRANSCRIPTION_LANGUAGE,
    timeoutMs: ctx.timeoutMs,
  });
  // A duração do WhatsApp vence a do provedor: ela é do áudio como o cliente o
  // gravou, e é a que o teto de duração já usou.
  const seconds = durationSeconds ?? transcription.seconds;
  return {
    text: transcription.text.trim(),
    usage: transcription.usage,
    costMicros: estimateTranscriptionCostMicros(ctx.audio.model, seconds),
  };
}

async function runVision(
  ctx: AttachmentContext,
  bytes: Buffer,
  mimeType: string | null,
): Promise<{ text: string; usage: { inputTokens: number; outputTokens: number }; costMicros: number | null }> {
  const description = await ctx.credentials.provider.describeImage({
    apiKey: ctx.credentials.apiKey,
    model: ctx.image.model,
    image: bytes,
    mimeType,
    instruction: IMAGE_INSTRUCTION,
    maxOutputTokens: AI_VISION_LIMITS.maxOutputTokens,
    timeoutMs: ctx.timeoutMs,
  });
  return {
    text: description.text.trim(),
    usage: description.usage,
    // Imagem é cobrada em TOKEN, pelo mesmo modelo de chat: a conta é a mesma
    // do turno, com a tabela de preço do escritório por cima do catálogo.
    costMicros: estimateCostMicros(
      ctx.image.model,
      description.usage.inputTokens,
      description.usage.outputTokens,
      ctx.pricingOverrides,
    ),
  };
}

/**
 * DOCUMENTO: o texto sai do MESMO extrator da base de conhecimento
 * (`extractDocumentText`), que já sabe abrir PDF, DOCX e TXT e já foi endurecido
 * lá. Duplicar essa leitura seria manter dois caminhos discordando sobre o que
 * é "documento vazio". Sem chamada ao provedor, então sem linha de consumo: o
 * que custa é só CPU da VPS, como a conversão de áudio do download.
 */
async function readDocument(
  deps: AttachmentReadingDeps,
  ctx: AttachmentContext,
  message: ReadableMessage,
  bytes: Buffer,
  finish: (status: AiAttachmentStatus, text: string | null, model: string | null) => Promise<unknown>,
): Promise<unknown> {
  try {
    const extracted = await extractDocumentText(bytes, documentFilename(message));
    const text = extracted.content.trim();
    deps.logger.info({
      event: "ai_attachment_read",
      kind: "document",
      messageId: message.id,
      conversationId: ctx.conversation.id,
      chars: text.length,
      truncated: extracted.truncated,
    });
    return finish(text ? "ok" : "empty", text || null, null);
  } catch (err) {
    // PDF digitalizado (imagem de página, sem texto real) é `empty`, e não
    // falha: tentar de novo daria o mesmo, e a IA precisa saber que o arquivo
    // chegou mas não tinha texto — é o que a faz pedir o dado por escrito.
    const code = err instanceof AppError ? err.code : null;
    const status: AiAttachmentStatus =
      code === "document_empty" ? "empty" : code === "document_unsupported_type" ? "unsupported" : "failed";
    deps.logger.warn({
      event: "ai_attachment_failed",
      kind: "document",
      messageId: message.id,
      conversationId: ctx.conversation.id,
      code: code ?? "unexpected",
    });
    return finish(status, null, null);
  }
}

/**
 * Grava no `metadata` e publica `message:updated` para a audiência da
 * conversa: a equipe precisa ver na bolha o mesmo texto que a IA leu, senão o
 * resumo da transferência citaria conteúdo que ninguém consegue conferir.
 * Evento que já existia e já carrega o `metadata` inteiro — nenhum contrato de
 * tempo real mudou por causa disto.
 */
async function persist(
  deps: AttachmentReadingDeps,
  ctx: AttachmentContext,
  message: ReadableMessage,
  insight: AiAttachmentInsight,
): Promise<unknown> {
  const metadata = withAiAttachmentInsight(message.metadata, insight);
  try {
    const saved = await deps.prisma.message.update({
      where: { id: message.id },
      data: { metadata: metadata as unknown as Prisma.InputJsonValue },
    });
    deps.io
      .to(conversationAudience(ctx.organizationId, ctx.conversation))
      .emit(RealtimeEvents.MessageUpdated, serializeMessage(saved));
  } catch (err) {
    // Não gravou? O turno segue com a leitura em mãos (ela está no objeto
    // devolvido); o custo é ler de novo no próximo turno.
    deps.logger.warn({
      event: "ai_attachment_persist_failed",
      messageId: message.id,
      error: String(err),
    });
  }
  return metadata;
}

/**
 * Consumo da leitura: linha própria em `AiUsageLog` (`transcription` para o
 * áudio, `vision` para a imagem) — nunca somada ao `chat`, senão o custo por
 * turno de atendimento deixaria de fechar e ninguém saberia quanto o anexo
 * custou. O total da SESSÃO, sim, inclui tudo: ele responde "quanto custou este
 * atendimento".
 */
async function chargeUsage(
  deps: AttachmentReadingDeps,
  ctx: AttachmentContext,
  input: {
    usageKind: Extract<AiUsageKind, "transcription" | "vision">;
    model: string;
    inputTokens: number;
    outputTokens: number;
    costMicros: number | null;
    durationMs: number;
    outcome: "ok" | "error" | "timeout";
    errorCode: string | null;
  },
): Promise<void> {
  // Chamada que falhou não custa: nulo, nunca zero silencioso.
  const costMicros = input.outcome === "ok" ? input.costMicros : null;
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
        model: input.model,
        kind: input.usageKind,
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
    deps.logger.warn({ event: "ai_attachment_usage_log_failed", error: String(err) });
  }
}

/** Duração que o WhatsApp mandou, gravada pela ingestão. */
function readDurationSeconds(metadata: unknown): number | null {
  if (!metadata || typeof metadata !== "object") return null;
  const value = (metadata as Record<string, unknown>).durationSeconds;
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

/**
 * O provedor decide o decodificador do áudio pela EXTENSÃO do nome do arquivo,
 * não pelo mime type do multipart: nota de voz do WhatsApp mandada como "audio"
 * sem extensão volta como formato não suportado.
 */
function audioFilename(mimeType: string | null): string {
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

/**
 * O extrator decide o formato pela EXTENSÃO, e o WhatsApp manda o nome do
 * arquivo — quando não manda, o mime type completa. Sem nenhum dos dois, o
 * documento é `unsupported`: chutar "pdf" faria o extrator falhar com uma
 * mensagem que não explica nada.
 */
function documentExtension(message: ReadableMessage): string | null {
  const fromName = (message.filename ?? "").toLowerCase().split(".").pop() ?? "";
  if (AI_DOCUMENT_LIMITS.extensions.includes(fromName as never)) return fromName;
  const mime = (message.mimeType ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
  const byMime: Record<string, string> = {
    "application/pdf": "pdf",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
    "text/plain": "txt",
  };
  return byMime[mime] ?? null;
}

function documentFilename(message: ReadableMessage): string {
  const extension = documentExtension(message) ?? "pdf";
  const name = (message.filename ?? "").trim();
  return name.toLowerCase().endsWith(`.${extension}`) ? name : `documento.${extension}`;
}

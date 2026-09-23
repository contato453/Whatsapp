import type { Prisma, PrismaClient } from "@azvchat/database";
import {
  AI_DEFAULT_TRANSCRIPTION_MODEL,
  RealtimeEvents,
  estimateCostMicros,
  readAiAttachmentInsightOf,
  type AiPricingOverrides,
  type AttendanceSettings,
  type QualityFailureReason,
  type QualityMetricsDto,
  type QualitySkipReason,
} from "@azvchat/shared";
import type { Logger } from "pino";
import type { Server } from "socket.io";
import type { SecretCipher } from "../../lib/ai-secrets.js";
import { loadAttendanceSettings } from "../../lib/attendance-settings.js";
import type { MediaStorage } from "../../lib/media-storage.js";
import { buildQualityMaterial, type QualityMaterialMessage } from "../../lib/quality/material.js";
import { computeQualityMetrics, resolveQualityOutcome } from "../../lib/quality/metrics.js";
import {
  buildQualitySystemPrompt,
  buildQualityUserMessage,
  formatQualityMetricsForPrompt,
} from "../../lib/quality/prompt.js";
import { parseQualityAiResponse } from "../../lib/quality/response.js";
import { loadQualitySettings, type QualitySettingsView } from "../../lib/quality/settings.js";
import { serializeQualityRun } from "../../lib/serialize.js";
import { orgRoom } from "../../realtime/socket.js";
import { ensureAttachmentInsights } from "../ai/attachments.js";
import { loadBudgetState, loadAiSettings, type AiSettingsView } from "../ai/budget.js";
import { resolveCredentials, type ResolvedCredentials } from "../ai/credentials.js";
import { AiProviderError } from "../ai/provider.js";

/**
 * MOTOR DO QUALITY — transcrever e avaliar, nesta ordem, em DOIS passos.
 *
 * POR QUE DOIS PASSOS, e não uma chamada só mandando o áudio para avaliar: o
 * mascaramento de dados (`lib/quality/masking.ts`) age sobre TEXTO, e é
 * justamente no áudio que o cliente dita CPF, CNPJ, telefone e chave Pix. Áudio
 * entregue direto à etapa de avaliação pularia a proteção exatamente onde ela
 * mais importa. Como efeito de segunda ordem, separar também torna a
 * transcrição REAPROVEITÁVEL: ela fica gravada na mensagem, e a mesma conversa
 * analisada de novo não paga transcrição outra vez.
 *
 * ONDE A TRANSCRIÇÃO MORA: em `Message.metadata.audioTranscript`, o MESMO lugar
 * que o atendimento por IA já usa (`services/ai/attachments.ts`). Não há tabela
 * nova, e o Quality reaproveita a função de leitura de anexo em vez de ter um
 * segundo caminho — dois lugares para a mesma coisa acabariam discordando sobre
 * qual transcrição é a verdadeira, e o segundo pagaria de novo o que o primeiro
 * já comprou.
 *
 * REUSO DA IA EXISTENTE: o módulo fala com `AiProvider` (`services/ai/
 * provider.ts`) e com a credencial já cifrada da organização — nenhum provedor
 * novo, nenhuma chave nova, nenhum `NEXT_PUBLIC_`. O contrato já tinha `chat` e
 * `transcribeAudio`; nada precisou ser acrescentado a ele.
 *
 * O LOG NUNCA LEVA CONTEÚDO: nem mensagem, nem transcrição, nem o material
 * enviado. Sai id, tamanho, duração e resultado.
 */

export interface QualityAnalyzerDeps {
  prisma: PrismaClient;
  logger: Logger;
  /**
   * O SOCKET VEM POR FUNÇÃO, E NÃO PRONTO, PORQUE ELE AINDA NÃO EXISTE QUANDO
   * AS ROTAS SÃO REGISTRADAS.
   *
   * `deps.io` só é preenchido em `index.ts` DEPOIS de `buildApp()`, porque o
   * Socket.IO precisa do servidor HTTP que o Fastify só cria ali (é o late
   * binding que o comentário de `app.ts` descreve). As outras rotas convivem
   * com isso sem perceber, porque leem `deps.io` dentro do handler, já em
   * tempo de requisição; esta era a única que o copiava no REGISTRO, e por
   * isso o analisador nascia com `undefined` e todo disparo morria no primeiro
   * aviso de tela com "Cannot read properties of undefined (reading 'to')" —
   * motivo genérico "Erro inesperado" para quem administra, e nenhuma pista do
   * que era. Guardar a FUNÇÃO adia a leitura para a hora de emitir, que é
   * sempre depois do boot. Teste em `quality-routes.test.ts` prende a ordem.
   */
  io: () => Server;
  storage: MediaStorage;
  aiCipher: SecretCipher;
}

/** Uma retentativa por chamada, e só ela. Falha permanente não se repete. */
const CHAT_MAX_ATTEMPTS = 2;
const CHAT_RETRY_DELAY_MS = 1_500;
/** Teto da saída: a resposta é um JSON de avaliação, não uma redação. */
const CHAT_MAX_OUTPUT_TOKENS = 2_000;

interface PeriodMessage extends QualityMaterialMessage {
  mediaUrl: string | null;
  mimeType: string | null;
  filename: string | null;
}

/**
 * LIGAÇÃO NÃO É MENSAGEM, e aqui isso importa duas vezes.
 *
 * `Message.type = "call"` é o registro de uma chamada, não uma resposta escrita
 * ao cliente (é a mesma régua que o Dashboard já aplica, onde ligação tem card
 * próprio e sai da conta de mensagens). Contá-la como envio do atendente faria
 * duas coisas erradas de uma vez: criaria avaliação para quem só ligou e não
 * escreveu nada, e zeraria o tempo de resposta de uma pergunta que ninguém
 * respondeu por escrito.
 *
 * Ela CONTINUA no material, como marcador: "houve uma ligação aqui" explica um
 * silêncio no chat, e esconder isso faria a IA cobrar uma resposta que existiu
 * por outro canal.
 */
function isCall(message: { type: string }): boolean {
  return message.type === "call";
}

export class QualityAnalyzer {
  constructor(private readonly deps: QualityAnalyzerDeps) {}

  /**
   * Roda um disparo inteiro. NUNCA lança: a rota já respondeu ao administrador
   * quando isto começa, e uma exceção aqui derrubaria a promessa sem deixar
   * rastro na tela. Falha vira estado `failed` com motivo, que é o que a tela
   * mostra.
   */
  async run(runId: string): Promise<void> {
    try {
      await this.execute(runId);
    } catch (err) {
      this.deps.logger.error({ event: "quality_run_failed", runId, error: String(err) });
      await this.finishRun(runId, "failed", "unexpected");
    }
  }

  private async execute(runId: string): Promise<void> {
    const run = await this.deps.prisma.qualityRun.findUnique({ where: { id: runId } });
    if (!run) return;

    const settings = await loadQualitySettings(this.deps.prisma, run.organizationId);
    const credentials = await resolveCredentials(
      this.deps.prisma,
      this.deps.aiCipher,
      this.deps.logger,
      run.organizationId,
    );
    if (!credentials) {
      await this.finishRun(runId, "failed", "ai_not_configured");
      return;
    }

    // O orçamento do escritório vale aqui como vale no atendimento: bloqueado,
    // a análise não começa. Recusar ANTES é melhor que gastar metade do disparo
    // e parar no meio, deixando conversas analisadas e conversas não.
    const aiSettings = await loadAiSettings(this.deps.prisma, run.organizationId);
    const budget = await loadBudgetState(this.deps.prisma, run.organizationId, aiSettings);
    if (budget.blocked) {
      await this.finishRun(runId, "failed", "budget_blocked");
      return;
    }

    await this.patchRun(runId, { status: "transcribing", startedAt: new Date() });

    const items = await this.deps.prisma.qualityRunItem.findMany({
      where: { runId },
      orderBy: { createdAt: "asc" },
    });

    const attendance = await loadAttendanceSettings(this.deps.prisma, run.organizationId);
    const model = run.model;
    let analyzingAnnounced = false;

    for (const item of items) {
      try {
        const messages = await this.loadPeriodMessages(item.conversationId, run.periodFrom, run.periodTo);
        if (messages.length === 0) {
          await this.skipItem(item.id, "no_messages", { messageCount: 0 });
          continue;
        }

        // PASSO 1 — TRANSCRIÇÃO. Só o que ainda não tem transcrição guardada.
        await this.patchItem(item.id, { status: "transcribing" });
        const withTranscripts = await this.ensureTranscripts(
          run.organizationId,
          item.conversationId,
          messages,
          settings,
          credentials,
          aiSettings,
        );

        // PASSO 2 — AVALIAÇÃO, sobre TEXTO já mascarado.
        if (!analyzingAnnounced) {
          await this.patchRun(runId, { status: "analyzing" });
          analyzingAnnounced = true;
        }
        await this.patchItem(item.id, { status: "analyzing" });

        const stats = buildQualityMaterial(withTranscripts, "");
        const agentIds = [
          ...new Set(
            withTranscripts
              .filter((message) => message.direction === "outbound" && message.sentByUserId && !isCall(message))
              .map((message) => message.sentByUserId as string),
          ),
        ];

        const partial = stats.coveragePercent < settings.minCoveragePercent;
        const baseStats = {
          coveragePercent: stats.coveragePercent,
          partial,
          truncated: stats.truncated,
          messageCount: stats.messageCount,
          audioCount: stats.audioCount,
          audioTranscribedCount: stats.audioTranscribedCount,
          promptChars: stats.text.length,
          model,
        };

        if (agentIds.length === 0) {
          await this.skipItem(item.id, "no_agent_messages", baseStats);
          continue;
        }
        if (stats.readableCount === 0) {
          // Conversa só com áudio e nenhuma transcrição possível: recusa em vez
          // de avaliar o silêncio. Nota dada sobre nada é pior que nota nenhuma.
          await this.skipItem(item.id, "no_readable_content", baseStats);
          continue;
        }

        await this.evaluateAgents({
          run,
          item,
          agentIds,
          messages: withTranscripts,
          attendance,
          settings,
          credentials,
          pricing: aiSettings.pricingOverrides,
          timeoutMs: aiSettings.timeoutMs,
          baseStats,
        });
      } catch (err) {
        this.deps.logger.error({
          event: "quality_item_failed",
          runId,
          itemId: item.id,
          conversationId: item.conversationId,
          error: String(err),
        });
        await this.patchItem(item.id, { status: "failed", failureReason: "unexpected" });
      }
    }

    await this.finishRun(runId, "completed", null);
  }

  /**
   * As mensagens do período. Apagada NÃO entra (a avaliação julgaria texto que
   * o cliente já não vê), e nota interna nem é `Message` — ela é conversa da
   * equipe consigo mesma, não atendimento ao cliente.
   */
  private async loadPeriodMessages(
    conversationId: string,
    from: Date,
    to: Date,
  ): Promise<PeriodMessage[]> {
    const rows = await this.deps.prisma.message.findMany({
      where: {
        conversationId,
        deletedAt: null,
        timestamp: { gte: from, lte: to },
      },
      orderBy: { timestamp: "asc" },
      select: {
        id: true,
        direction: true,
        type: true,
        content: true,
        sentByUserId: true,
        timestamp: true,
        metadata: true,
        mediaUrl: true,
        mimeType: true,
        filename: true,
      },
    });
    return rows.map((row) => ({
      id: row.id,
      direction: row.direction as "inbound" | "outbound",
      type: row.type,
      content: row.content,
      sentByUserId: row.sentByUserId,
      timestamp: row.timestamp,
      metadata: row.metadata,
      mediaUrl: row.mediaUrl,
      mimeType: row.mimeType,
      filename: row.filename,
    }));
  }

  /**
   * Garante a transcrição dos áudios do período, REAPROVEITANDO a que já
   * existir. Quem faz o trabalho é `ensureAttachmentInsights`, a mesma função do
   * atendimento por IA: ela já pula o que está pronto, grava o resultado (o
   * sucesso E o insucesso) na própria mensagem e cobra a linha de consumo.
   *
   * O teto de duração é o do Quality, e não a constante do atendimento: áudio
   * mais longo que o configurado é filtrado AQUI e nem chega à função, então
   * fica como marcador sem gastar chamada e sem deixar marca de "tentei" —
   * subir o teto depois volta a transcrevê-lo.
   */
  private async ensureTranscripts(
    organizationId: string,
    conversationId: string,
    messages: PeriodMessage[],
    settings: QualitySettingsView,
    credentials: ResolvedCredentials,
    aiSettings: AiSettingsView,
  ): Promise<PeriodMessage[]> {
    const conversation = await this.deps.prisma.conversation.findUnique({ where: { id: conversationId } });
    if (!conversation) return messages;

    const candidates = messages.filter((message) => {
      if (message.type !== "audio") return false;
      const insight = readAiAttachmentInsightOf("audio", message.metadata);
      if (insight?.status === "ok") return false;
      const seconds = readDurationSeconds(message.metadata);
      return seconds == null || seconds <= settings.maxAudioSeconds;
    });
    if (candidates.length === 0) return messages;

    const updated = await ensureAttachmentInsights(
      { prisma: this.deps.prisma, io: this.deps.io(), logger: this.deps.logger, media: this.deps.storage },
      {
        organizationId,
        conversation,
        credentials,
        timeoutMs: aiSettings.timeoutMs,
        // Sem sessão e sem agente: a transcrição do Quality não pertence a
        // atendimento nenhum, e o consumo entra na organização.
        sessionId: null,
        agent: null,
        pricingOverrides: aiSettings.pricingOverrides,
        audio: {
          enabled: true,
          model: aiSettings.transcriptionModel ?? AI_DEFAULT_TRANSCRIPTION_MODEL,
        },
        // A avaliação não recebe mídia, então descrever imagem e abrir documento
        // seria chamada paga sem destino.
        image: { enabled: false, model: credentials.defaultModel },
        document: { enabled: false },
      },
      candidates.map((message) => ({
        id: message.id,
        type: message.type,
        content: message.content,
        mediaUrl: message.mediaUrl,
        mimeType: message.mimeType,
        filename: message.filename,
        metadata: message.metadata,
      })),
    );

    const metadataById = new Map(updated.map((message) => [message.id, message.metadata]));
    return messages.map((message) =>
      metadataById.has(message.id) ? { ...message, metadata: metadataById.get(message.id) } : message,
    );
  }

  /**
   * Uma avaliação POR ATENDENTE que enviou mensagem no período, cada uma com o
   * contexto da conversa inteira. Duas pessoas na mesma conversa geram duas
   * linhas: a atuação é individual, o contexto não é.
   */
  private async evaluateAgents(input: {
    run: { id: string; organizationId: string; periodFrom: Date; periodTo: Date; model: string };
    item: { id: string; conversationId: string };
    agentIds: string[];
    messages: PeriodMessage[];
    attendance: AttendanceSettings;
    settings: QualitySettingsView;
    credentials: ResolvedCredentials;
    pricing: AiPricingOverrides;
    timeoutMs: number;
    baseStats: Record<string, unknown>;
  }): Promise<void> {
    const conversation = await this.deps.prisma.conversation.findUnique({
      where: { id: input.item.conversationId },
      select: { type: true, status: true, departmentId: true },
    });
    const history = await this.deps.prisma.conversationAssignmentHistory.findMany({
      where: {
        conversationId: input.item.conversationId,
        createdAt: { gte: input.run.periodFrom, lte: input.run.periodTo },
      },
      orderBy: { createdAt: "asc" },
      select: { action: true },
    });
    const users = await this.deps.prisma.user.findMany({
      where: { id: { in: input.agentIds } },
      select: { id: true, name: true },
    });
    const nameById = new Map(users.map((user) => [user.id, user.name]));

    const lastMessage = input.messages.filter((message) => !isCall(message)).slice(-1)[0];
    const outcome = resolveQualityOutcome({
      historyActions: history.map((row) => row.action),
      lastMessageInbound: lastMessage?.direction === "inbound",
      currentStatus: conversation?.status ?? "open",
    });

    let inputTokens = 0;
    let outputTokens = 0;
    let costMicros = 0;
    let anyEvaluation = false;
    let invalid = false;
    let providerFailed = false;
    let promptChars = 0;

    // As métricas ignoram ligação (ver `isCall`); o material, não.
    const messagesForMetrics = input.messages.filter((message) => !isCall(message));

    for (const userId of input.agentIds) {
      const measured = computeQualityMetrics(messagesForMetrics, userId, input.attendance);
      const metrics: QualityMetricsDto = { ...measured, outcome };
      const material = buildQualityMaterial(input.messages, userId);
      promptChars = Math.max(promptChars, material.text.length);

      const userMessage = buildQualityUserMessage({
        metricsText: formatQualityMetricsForPrompt(
          metrics,
          input.attendance.responseLimitMinutes,
          material.coveragePercent,
        ),
        material: material.text,
        conversationType: conversation?.type === "group" ? "group" : "individual",
      });

      const started = Date.now();
      let reply: string | null = null;
      let usage = { inputTokens: 0, outputTokens: 0 };
      let errorCode: string | null = null;

      try {
        const result = await this.chatWithRetry(input.credentials, {
          model: input.run.model,
          system: buildQualitySystemPrompt(),
          user: userMessage,
          timeoutMs: input.timeoutMs,
        });
        reply = result.content;
        usage = result.usage;
      } catch (err) {
        providerFailed = true;
        errorCode = err instanceof AiProviderError ? err.code : "unexpected";
      }

      inputTokens += usage.inputTokens;
      outputTokens += usage.outputTokens;
      const callCost = estimateCostMicros(input.run.model, usage.inputTokens, usage.outputTokens, input.pricing);
      if (callCost != null) costMicros += callCost;

      const parsed = errorCode ? null : parseQualityAiResponse(reply, material.references);
      if (!errorCode && !parsed) invalid = true;

      await this.logUsage({
        organizationId: input.run.organizationId,
        conversationId: input.item.conversationId,
        departmentId: conversation?.departmentId ?? null,
        provider: input.credentials.kind,
        model: input.run.model,
        usage,
        costMicros: errorCode ? null : callCost,
        durationMs: Date.now() - started,
        outcome: errorCode === "timeout" ? "timeout" : errorCode ? "error" : parsed ? "ok" : "error",
        errorCode: errorCode ?? (parsed ? null : "invalid_response"),
      });

      this.deps.logger.info({
        event: "quality_evaluation_done",
        runId: input.run.id,
        itemId: input.item.id,
        conversationId: input.item.conversationId,
        // Só identificadores, tamanho e resultado — nunca o material.
        promptChars: material.text.length,
        coveragePercent: material.coveragePercent,
        audioCount: material.audioCount,
        audioTranscribedCount: material.audioTranscribedCount,
        masked: material.maskCounts,
        model: input.run.model,
        result: parsed ? "ok" : errorCode ? "provider_error" : "invalid_response",
      });

      if (!parsed) continue;

      await this.deps.prisma.qualityEvaluation.create({
        data: {
          organizationId: input.run.organizationId,
          runId: input.run.id,
          itemId: input.item.id,
          conversationId: input.item.conversationId,
          userId,
          userName: nameById.get(userId) ?? "Atendente removido",
          overallScore: parsed.overallScore,
          criteria: parsed.criteria as unknown as Prisma.InputJsonValue,
          subject: parsed.subject,
          actionPlan: parsed.actionPlan as unknown as Prisma.InputJsonValue,
          confidence: parsed.confidence,
          coveragePercent: material.coveragePercent,
          partial: material.coveragePercent < input.settings.minCoveragePercent,
          firstResponseMinutes: metrics.firstResponseMinutes,
          avgResponseMinutes: metrics.avgResponseMinutes,
          responsesMeasured: metrics.responsesMeasured,
          limitBreaches: metrics.limitBreaches,
          messagesSent: metrics.messagesSent,
          conversationOutcome: outcome,
        },
      });
      anyEvaluation = true;
    }

    const failureReason: QualityFailureReason | null = anyEvaluation
      ? null
      : providerFailed
        ? "ai_unavailable"
        : invalid
          ? "invalid_response"
          : "unexpected";

    await this.patchItem(input.item.id, {
      ...input.baseStats,
      promptChars,
      status: anyEvaluation ? "completed" : "failed",
      failureReason,
      inputTokens,
      outputTokens,
      costMicros: costMicros > 0 ? costMicros : null,
    });
  }

  /**
   * Uma retentativa, e só uma. Erro permanente (chave inválida, modelo
   * inexistente, cota estourada) não se repete: repetir gastaria a chamada de
   * novo para receber a mesma recusa.
   */
  private async chatWithRetry(
    credentials: ResolvedCredentials,
    input: { model: string; system: string; user: string; timeoutMs: number },
  ): Promise<{ content: string | null; usage: { inputTokens: number; outputTokens: number } }> {
    let lastError: unknown = null;
    for (let attempt = 1; attempt <= CHAT_MAX_ATTEMPTS; attempt += 1) {
      try {
        const result = await credentials.provider.chat({
          apiKey: credentials.apiKey,
          model: input.model,
          messages: [
            { role: "system", content: input.system },
            { role: "user", content: input.user },
          ],
          // A avaliação não usa ferramenta nenhuma: ela não age na conversa,
          // só julga. Sem ferramenta não há como o material pedir uma ação.
          tools: [],
          temperature: 0,
          maxOutputTokens: CHAT_MAX_OUTPUT_TOKENS,
          timeoutMs: input.timeoutMs,
        });
        return { content: result.content, usage: result.usage };
      } catch (err) {
        lastError = err;
        if (err instanceof AiProviderError && err.permanent) throw err;
        if (attempt < CHAT_MAX_ATTEMPTS) {
          await new Promise((resolve) => setTimeout(resolve, CHAT_RETRY_DELAY_MS));
        }
      }
    }
    throw lastError instanceof Error ? lastError : new Error("falha ao chamar o provedor de IA");
  }

  private async logUsage(input: {
    organizationId: string;
    conversationId: string;
    departmentId: string | null;
    provider: string;
    model: string;
    usage: { inputTokens: number; outputTokens: number };
    costMicros: number | null;
    durationMs: number;
    outcome: "ok" | "error" | "timeout";
    errorCode: string | null;
  }): Promise<void> {
    try {
      await this.deps.prisma.aiUsageLog.create({
        data: {
          organizationId: input.organizationId,
          conversationId: input.conversationId,
          departmentId: input.departmentId,
          provider: input.provider,
          model: input.model,
          // Tipo próprio: o custo da avaliação nunca se mistura ao do atendimento.
          kind: "quality",
          outcome: input.outcome,
          inputTokens: input.usage.inputTokens,
          outputTokens: input.usage.outputTokens,
          costMicros: input.outcome === "ok" ? input.costMicros : null,
          durationMs: input.durationMs,
          errorCode: input.errorCode,
          toolsRequested: [],
          toolsExecuted: [],
          toolsBlocked: [],
        },
      });
    } catch (err) {
      this.deps.logger.warn({ event: "quality_usage_log_failed", error: String(err) });
    }
  }

  private async skipItem(
    itemId: string,
    reason: QualitySkipReason,
    stats: Record<string, unknown>,
  ): Promise<void> {
    await this.patchItem(itemId, { ...stats, status: "skipped", skipReason: reason });
  }

  private async patchItem(itemId: string, data: Record<string, unknown>): Promise<void> {
    await this.deps.prisma.qualityRunItem.update({
      where: { id: itemId },
      data: data as Prisma.QualityRunItemUpdateInput,
    });
  }

  /**
   * Grava o estado do disparo e AVISA a tela. O evento vai só para a sala da
   * organização, que é a sala de administrador: nenhum atendente pode saber que
   * a avaliação existe, e mandá-lo para a audiência da conversa entregaria
   * justamente isso.
   */
  private async patchRun(runId: string, data: Record<string, unknown>): Promise<void> {
    const updated = await this.deps.prisma.qualityRun.update({
      where: { id: runId },
      data: data as Prisma.QualityRunUpdateInput,
    });
    // O AVISO DE TELA NÃO DERRUBA A ANÁLISE. O estado já está gravado na linha
    // acima, e o que vem aqui é só o tempo real. Falhando a emissão, o pior
    // caso é a tela demorar um "Atualizar" para acompanhar; deixar a exceção
    // subir mataria um disparo inteiro (com transcrição e avaliação já PAGAS
    // ao provedor) por causa do aviso, que foi a forma que este defeito tomou
    // em produção.
    try {
      this.deps.io().to(orgRoom(updated.organizationId)).emit(RealtimeEvents.QualityRun, {
        run: serializeQualityRun(updated),
      });
    } catch (err) {
      this.deps.logger.error({
        event: "quality_run_emit_failed",
        runId,
        error: String(err),
      });
    }
  }

  private async finishRun(
    runId: string,
    status: "completed" | "failed",
    failureReason: QualityFailureReason | null,
  ): Promise<void> {
    try {
      await this.patchRun(runId, { status, failureReason, finishedAt: new Date() });
    } catch (err) {
      this.deps.logger.error({ event: "quality_run_finish_failed", runId, error: String(err) });
    }
  }
}

/** Duração que o WhatsApp mandou, gravada pela ingestão. */
function readDurationSeconds(metadata: unknown): number | null {
  if (!metadata || typeof metadata !== "object") return null;
  const value = (metadata as Record<string, unknown>).durationSeconds;
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

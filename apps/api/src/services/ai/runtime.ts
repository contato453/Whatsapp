import type { AiAgent, AiAgentVersion, AiAutomation, AiSession, Conversation, Prisma, PrismaClient } from "@azvchat/database";
import type { WhatsAppProvider } from "@azvchat/whatsapp";
import {
  AI_MESSAGE_ORIGIN,
  RealtimeEvents,
  automationMatchesType,
  estimateCostMicros,
  type AiAgentConfig,
  type AiChatTurn,
  type AiMessageOriginMetadata,
  type AiProviderKind,
  type AiSessionEndReason,
  type AiTestDebugDto,
  type AiTestResultDto,
  type AiUsageOutcome,
} from "@azvchat/shared";
import type { Server } from "socket.io";
import type { Logger } from "pino";
import type { SecretCipher } from "../../lib/ai-secrets.js";
import { loadAttendanceSettings } from "../../lib/attendance-settings.js";
import { assignToUserData } from "../../lib/conversation-assignment.js";
import { conversationInclude } from "../../lib/conversation-events.js";
import { eligibleAssigneeWhere } from "../../lib/default-assignee.js";
import { resolveConversationPersonName } from "../../lib/person-profile.js";
import { serializeConversation, serializeMessage } from "../../lib/serialize.js";
import { conversationAudience } from "../../realtime/socket.js";
import type { AuditService } from "../../modules/audit/service.js";
import type { AzevedoOsClient } from "../azevedo-os-client.js";
import { buildPreview } from "../message-ingest.js";
import {
  executeTool,
  loadApplicableTags,
  type ActionEnvironment,
  type ActionOutcome,
  type TerminalAction,
} from "./actions.js";
import { checkBudgetAlerts, loadAiSettings, loadBudgetState, type AiSettingsView } from "./budget.js";
import { parseStoredAgentConfig } from "./config-schema.js";
import { resolveCredentials, type ResolvedCredentials } from "./credentials.js";
import { retrieveKnowledge, type KnowledgeHit, type KnowledgeSourceInput } from "./knowledge.js";
import { buildHandoffSummary, buildSystemPrompt, type PromptContext } from "./prompt-builder.js";
import { AiProviderError, type AiChatMessage, type AiToolCall } from "./provider.js";
import {
  emitAiSession,
  endAiSession,
  readSessionState,
  type AiSessionState,
} from "./session.js";
import { buildToolDefinitions } from "./tools.js";

/**
 * O MOTOR do atendimento por IA.
 *
 * Caminho de uma mensagem recebida:
 *   WhatsApp → ingestão (grava a mensagem como sempre) → `onInboundMessage`
 *   → há sessão ativa? senão, alguma AUTOMAÇÃO casa? → turno: contexto
 *   permitido + histórico recente + conhecimento relevante → provedor →
 *   ferramentas (validadas pelo backend) → resposta pelo MESMO envio do
 *   WhatsApp → consumo e log → tempo real.
 *
 * Concorrência, em três camadas, porque cada uma cobre um caso diferente:
 *   1. DEBOUNCE por conversa (2,5s): duas mensagens rápidas do cliente viram
 *      um turno só, com as duas no contexto;
 *   2. FILA por conversa em memória: nunca há dois turnos da mesma conversa
 *      ao mesmo tempo, e mensagem que chega DURANTE um turno agenda o
 *      próximo (não é perdida nem respondida duas vezes);
 *   3. `lastProcessedMessageId` no banco: o turno lê "o que chegou depois
 *      do que já respondi" — sobrevive a reinício, e a varredura periódica
 *      (`sweep`) retoma o que ficou pendente quando o processo caiu no meio.
 * O índice parcial de "uma sessão ativa por conversa" fecha a última porta.
 *
 * Humano assumiu: as rotas chamam `interruptAiSessionForHuman`; e o turno
 * RELÊ a sessão antes de enviar — resposta gerada para uma sessão que
 * acabou de ser interrompida é descartada, nunca enviada.
 */

const DEBOUNCE_MS = 2_500;
const MAX_TOOL_ROUNDS = 4;
const MAX_OUTPUT_TOKENS = 700;
const SWEEP_MS = 60_000;
/** Turno pendente há mais que isto sem trava em memória = ficou do reinício. */
const STALE_PENDING_MS = 45_000;

export interface AiRuntimeDeps {
  prisma: PrismaClient;
  io: Server;
  logger: Logger;
  provider: WhatsAppProvider;
  audit: AuditService;
  azevedoOs: AzevedoOsClient;
  cipher: SecretCipher;
}

type SessionRow = AiSession & {
  agent: AiAgent;
  agentVersion: AiAgentVersion | null;
};

interface TurnUsage {
  inputTokens: number;
  outputTokens: number;
  costMicros: number | null;
  requests: number;
}

export class AiRuntime {
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly chains = new Map<string, Promise<void>>();
  private sweepTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly deps: AiRuntimeDeps) {}

  start(): void {
    if (this.sweepTimer) return;
    this.sweepTimer = setInterval(() => void this.sweep(), SWEEP_MS);
    this.deps.logger.info({ event: "ai_runtime_started" });
  }

  stop(): void {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.sweepTimer = null;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }

  // -------------------------------------------------------------------------
  // Entrada
  // -------------------------------------------------------------------------

  /**
   * Chamado pelo instance-manager depois que a ingestão gravou uma mensagem
   * RECEBIDA nova. Nunca lança: falha aqui não pode encostar no caminho da
   * mensagem, que já está no banco.
   */
  onInboundMessage(input: { organizationId: string; conversationId: string; messageId: string }): void {
    const existing = this.timers.get(input.conversationId);
    if (existing) clearTimeout(existing);
    this.timers.set(
      input.conversationId,
      setTimeout(() => {
        this.timers.delete(input.conversationId);
        this.enqueue(input.conversationId, () => this.handleInbound(input.organizationId, input.conversationId));
      }, DEBOUNCE_MS),
    );
  }

  /** Fila por conversa: um turno de cada vez, sempre. */
  private enqueue(conversationId: string, work: () => Promise<void>): Promise<void> {
    const previous = this.chains.get(conversationId) ?? Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(work)
      .catch((err) => {
        this.deps.logger.error({ event: "ai_turn_failed", conversationId, error: String(err) });
      })
      .finally(() => {
        if (this.chains.get(conversationId) === next) this.chains.delete(conversationId);
      });
    this.chains.set(conversationId, next);
    return next;
  }

  private async handleInbound(organizationId: string, conversationId: string): Promise<void> {
    const conversation = await this.deps.prisma.conversation.findUnique({ where: { id: conversationId } });
    if (!conversation || conversation.archivedAt) return;

    let session = await this.loadActive(conversationId);
    if (!session) {
      session = await this.tryStartSession(conversation);
      if (!session) return;
    }
    await this.runTurn(session, conversation);
    // Chegou mensagem enquanto o turno rodava? O próximo turno já vê o que
    // ficou depois de `lastProcessedMessageId`.
    const pending = await this.hasUnprocessedInbound(session);
    if (pending) this.enqueue(conversationId, () => this.handleInbound(organizationId, conversationId));
  }

  private loadActive(conversationId: string): Promise<SessionRow | null> {
    return this.deps.prisma.aiSession.findFirst({
      where: { conversationId, status: "active" },
      include: { agent: true, agentVersion: true },
    });
  }

  private async hasUnprocessedInbound(session: SessionRow): Promise<boolean> {
    const fresh = await this.deps.prisma.aiSession.findUnique({
      where: { id: session.id },
      select: { status: true, lastProcessedMessageId: true },
    });
    if (!fresh || fresh.status !== "active") return false;
    const last = fresh.lastProcessedMessageId
      ? await this.deps.prisma.message.findUnique({ where: { id: fresh.lastProcessedMessageId }, select: { timestamp: true } })
      : null;
    const count = await this.deps.prisma.message.count({
      where: {
        conversationId: session.conversationId,
        direction: "inbound",
        deletedAt: null,
        ...(last ? { timestamp: { gt: last.timestamp } } : {}),
      },
    });
    return count > 0;
  }

  // -------------------------------------------------------------------------
  // Automação → sessão
  // -------------------------------------------------------------------------

  /**
   * Alguma automação casa com esta conversa? A primeira por prioridade vence.
   * Regras que o cliente não vê mas a equipe sente:
   *   - a IA não toma conversa de gente (`onlyUnassigned`);
   *   - conversa cujo último atendimento por IA terminou em transferência,
   *     interrupção, limite ou erro NÃO volta para a IA sozinha — só depois
   *     de a conversa ser concluída (novo ciclo) ou por "Devolver para IA";
   *   - orçamento estourado com política de bloqueio: não começa, e a
   *     política de "encaminhar" aplica o destino de transferência do agente.
   */
  private async tryStartSession(conversation: Conversation): Promise<SessionRow | null> {
    const { prisma } = this.deps;
    const automations = await prisma.aiAutomation.findMany({
      where: { organizationId: conversation.organizationId, active: true, agent: { status: "active" } },
      orderBy: [{ priority: "asc" }, { createdAt: "asc" }],
      include: { agent: true },
    });
    if (automations.length === 0) return null;

    const inboundCount = await prisma.message.count({
      where: { conversationId: conversation.id, direction: "inbound", deletedAt: null },
    });
    const match = automations.find((automation) =>
      automationMatches(automation, conversation, { isFirstInbound: inboundCount <= 1 }),
    );
    if (!match) return null;

    if (!(await this.canRestart(conversation))) {
      this.deps.logger.info({ event: "ai_session_not_restarted", conversationId: conversation.id, automationId: match.id });
      return null;
    }

    const settings = await loadAiSettings(prisma, conversation.organizationId);
    const budget = await loadBudgetState(prisma, conversation.organizationId, settings);
    if (budget.blocked) {
      await this.recordUsage({
        organizationId: conversation.organizationId,
        agent: match.agent,
        conversationId: conversation.id,
        departmentId: conversation.departmentId,
        provider: "openai",
        model: match.agent.model ?? "-",
        kind: "chat",
        outcome: "blocked",
        errorCode: "budget_exceeded",
        usage: { inputTokens: 0, outputTokens: 0, costMicros: 0, requests: 0 },
        durationMs: 0,
      });
      if (budget.policy === "transfer_human") {
        const config = parseStoredAgentConfig(match.agent.config);
        await this.routeConversationForHandoff(conversation, match.agent, config, null);
      }
      return null;
    }

    const credentials = await resolveCredentials(prisma, this.deps.cipher, this.deps.logger, conversation.organizationId);
    if (!credentials) {
      this.deps.logger.warn({ event: "ai_provider_not_connected", organizationId: conversation.organizationId });
      return null;
    }

    const version = await prisma.aiAgentVersion.findUnique({
      where: { agentId_version: { agentId: match.agent.id, version: match.agent.currentVersion } },
    });
    try {
      const session = await prisma.aiSession.create({
        data: {
          organizationId: conversation.organizationId,
          conversationId: conversation.id,
          agentId: match.agent.id,
          agentVersionId: version?.id ?? null,
          automationId: match.id,
          state: { collected: {}, summary: null, subject: null, intent: null, actions: [] },
        },
        include: { agent: true, agentVersion: true },
      });
      await prisma.conversationAssignmentHistory.create({
        data: {
          organizationId: conversation.organizationId,
          conversationId: conversation.id,
          action: "assigned",
          note: `Atendimento por IA iniciado (${match.agent.name}, v${session.agentVersion?.version ?? match.agent.currentVersion}) pela automação "${match.name}".`,
        },
      });
      this.deps.audit.record({
        organizationId: conversation.organizationId,
        userId: null,
        action: "ai.session_started",
        entityType: "Conversation",
        entityId: conversation.id,
        metadata: { sessionId: session.id, agentId: match.agent.id, automationId: match.id },
      });
      this.deps.logger.info({ event: "ai_session_started", sessionId: session.id, conversationId: conversation.id, agentId: match.agent.id });
      await emitAiSession(this.deps, conversation.organizationId, conversation.id);

      // Apresentação: sai antes da primeira resposta, sem passar pelo modelo
      // (é determinística e a equipe a escreveu palavra por palavra).
      const config = parseStoredAgentConfig(session.agentVersion?.config ?? session.agent.config);
      if (config.identity.sendGreeting && config.identity.greeting.trim()) {
        await this.sendAiText(session, conversation, config.identity.greeting.trim(), credentials);
      }
      return session;
    } catch (err) {
      // Perdeu a corrida do índice "uma ativa por conversa": a outra
      // mensagem do mesmo lote já abriu a sessão. Usa a dela.
      if (isUniqueViolation(err)) return this.loadActive(conversation.id);
      throw err;
    }
  }

  /**
   * Pode a IA (re)começar nesta conversa? Sem sessão anterior, sim. Com
   * sessão anterior encerrada por transferência/interrupção/limite/erro, só
   * se a conversa foi CONCLUÍDA depois disso — é o sinal de que aquele ciclo
   * fechou e o cliente que voltou abre outro.
   */
  private async canRestart(conversation: Conversation): Promise<boolean> {
    const last = await this.deps.prisma.aiSession.findFirst({
      where: { conversationId: conversation.id },
      orderBy: { startedAt: "desc" },
      select: { status: true, endedAt: true },
    });
    if (!last) return true;
    if (last.status === "resolved") return true;
    if (!last.endedAt) return false;
    const resolvedAfter = await this.deps.prisma.conversationAssignmentHistory.findFirst({
      where: { conversationId: conversation.id, action: "resolved", createdAt: { gt: last.endedAt } },
      select: { id: true },
    });
    return resolvedAfter != null;
  }

  // -------------------------------------------------------------------------
  // O turno
  // -------------------------------------------------------------------------

  private async runTurn(session: SessionRow, conversation: Conversation): Promise<void> {
    const { prisma, logger } = this.deps;
    const organizationId = conversation.organizationId;
    const config = parseStoredAgentConfig(session.agentVersion?.config ?? session.agent.config);

    // Agente desligado no meio do atendimento: encerra com aviso, sem deixar
    // o cliente falando com ninguém.
    if (session.agent.status !== "active") {
      await this.finishWithFallback(session, conversation, config, "agent_disabled", null);
      return;
    }

    const settings = await loadAiSettings(prisma, organizationId);
    const budget = await loadBudgetState(prisma, organizationId, settings);
    if (budget.blocked) {
      await this.finishWithFallback(session, conversation, config, "budget_exceeded", null);
      return;
    }

    if (session.aiMessageCount >= config.limits.maxAiMessages) {
      await this.finishWithFallback(session, conversation, config, "message_limit", null);
      return;
    }
    if (config.limits.maxDurationMinutes != null) {
      const elapsedMinutes = (Date.now() - session.startedAt.getTime()) / 60_000;
      if (elapsedMinutes > config.limits.maxDurationMinutes) {
        await this.finishWithFallback(session, conversation, config, "duration_limit", null);
        return;
      }
    }

    const credentials = await resolveCredentials(prisma, this.deps.cipher, logger, organizationId);
    if (!credentials) {
      await this.finishWithFallback(session, conversation, config, "provider_error", null);
      return;
    }
    const model = config.advanced.model ?? session.agent.model ?? credentials.defaultModel;

    // Mensagens recebidas ainda não respondidas (idempotência entre turnos).
    const lastProcessed = session.lastProcessedMessageId
      ? await prisma.message.findUnique({ where: { id: session.lastProcessedMessageId }, select: { timestamp: true } })
      : null;
    const newInbound = await prisma.message.findMany({
      where: {
        conversationId: conversation.id,
        direction: "inbound",
        deletedAt: null,
        ...(lastProcessed ? { timestamp: { gt: lastProcessed.timestamp } } : {}),
      },
      orderBy: { timestamp: "asc" },
      select: { id: true, content: true, type: true, timestamp: true },
    });
    if (newInbound.length === 0) return;
    const newestInbound = newInbound[newInbound.length - 1] as (typeof newInbound)[number];
    const queryText = newInbound.map((message) => messageText(message)).join("\n");

    const env = await this.buildEnvironment(session, conversation, config, settings);
    // Histórico recente SEM as mensagens novas, que entram por último: o
    // modelo precisa terminar lendo o que o cliente acabou de dizer — a
    // apresentação enviada entre a mensagem e o turno não pode ficar como
    // "última fala".
    const history = await this.loadHistory(
      conversation.id,
      config.advanced.contextMessageLimit || settings.contextMessageLimit,
      new Set(newInbound.map((message) => message.id)),
    );
    const newTurns: AiChatMessage[] = newInbound.map((message) => ({ role: "user", content: messageText(message) }));
    const knowledge = retrieveKnowledge(
      [...env.knowledgeSources, ...(config.knowledge.includeQuickReplies ? env.quickReplies : [])],
      queryText,
    );
    const promptContext = await this.promptContext(session, conversation, config, env, knowledge);
    const system = buildSystemPrompt(config, promptContext);
    const tools = buildToolDefinitions(config, {
      hasKnowledge: env.knowledgeSources.length > 0 || (config.knowledge.includeQuickReplies && env.quickReplies.length > 0),
      canLookupCompany: env.azevedoOsEnabled && conversation.externalSource === "azevedo-os" && !!conversation.externalReference,
      tagNames: env.tags.map((tag) => tag.name),
      collectFieldKeys: config.dataCollection.fields.map((field) => field.key),
    });
    const messages: AiChatMessage[] = [{ role: "system", content: system }, ...history, ...newTurns];

    const startedAt = Date.now();
    const usage: TurnUsage = { inputTokens: 0, outputTokens: 0, costMicros: 0, requests: 0 };
    const requested: string[] = [];
    const executed: string[] = [];
    const blocked: string[] = [];
    let terminal: TerminalAction | null = null;
    let reply: string | null = null;
    let outcome: AiUsageOutcome = "ok";
    let errorCode: string | null = null;

    try {
      const loop = await this.chatLoop({
        credentials,
        model,
        temperature: config.advanced.temperature,
        timeoutMs: settings.timeoutMs,
        messages,
        tools,
        env,
        mode: "live",
        usage,
        pricing: settings.pricingOverrides,
        onToolOutcome: (result) => {
          requested.push(result.name);
          if (result.executed) executed.push(result.name);
          else blocked.push(result.name);
        },
      });
      reply = loop.reply;
      terminal = loop.terminal;
    } catch (err) {
      const providerError = err instanceof AiProviderError ? err : null;
      outcome = providerError?.code === "timeout" ? "timeout" : "error";
      errorCode = providerError?.code ?? "unexpected";
      logger.warn({ event: "ai_turn_provider_error", sessionId: session.id, code: errorCode });
    }

    await this.recordUsage({
      organizationId,
      agent: session.agent,
      sessionId: session.id,
      conversationId: conversation.id,
      departmentId: conversation.departmentId,
      provider: credentials.kind,
      model,
      kind: "chat",
      outcome,
      errorCode,
      usage,
      durationMs: Date.now() - startedAt,
      toolsRequested: requested,
      toolsExecuted: executed,
      toolsBlocked: blocked,
      handoffReason: terminal?.kind === "transfer" ? terminal.reason : null,
    });

    // Assumido por humano enquanto o modelo pensava? Nada do que foi gerado
    // sai — nem a resposta, nem a transferência.
    const fresh = await prisma.aiSession.findUnique({ where: { id: session.id } });
    if (!fresh || fresh.status !== "active") {
      logger.info({ event: "ai_turn_discarded", sessionId: session.id, reason: "session_not_active" });
      return;
    }

    if (outcome !== "ok") {
      const attempts = fresh.failedAttempts + 1;
      const permanent = errorCode === "invalid_api_key" || errorCode === "model_unavailable" || errorCode === "insufficient_quota";
      await prisma.aiSession.update({
        where: { id: session.id },
        data: { failedAttempts: attempts, inputTokens: { increment: usage.inputTokens }, outputTokens: { increment: usage.outputTokens } },
      });
      if (permanent || attempts >= config.limits.maxFailedAttempts) {
        await this.finishWithFallback({ ...session, ...fresh, agent: session.agent, agentVersion: session.agentVersion }, conversation, config, "provider_error", null);
      } else {
        // Falha transitória: fica pendente e a varredura tenta de novo,
        // sem marcar a mensagem como processada (senão ela nunca teria
        // resposta) e sem responder duas vezes (a trava é a fila).
        logger.info({ event: "ai_turn_retry_later", sessionId: session.id, attempts });
      }
      return;
    }

    // Estado + contadores. `lastProcessedMessageId` avança AQUI, depois do
    // provedor responder: falha antes disto reprocessa as mesmas mensagens.
    const state = env.state;
    await prisma.aiSession.update({
      where: { id: session.id },
      data: {
        state: state as unknown as Prisma.InputJsonValue,
        lastProcessedMessageId: newestInbound.id,
        customerMessageCount: { increment: newInbound.length },
        inputTokens: { increment: usage.inputTokens },
        outputTokens: { increment: usage.outputTokens },
        costMicros: { increment: usage.costMicros ?? 0 },
        failedAttempts: 0,
        lastActivityAt: new Date(),
      },
    });

    if (terminal?.kind === "transfer") {
      const message = reply?.trim() || config.handoff.transferMessage.trim();
      if (message) await this.sendAiText(session, conversation, message, credentials, model);
      await this.transferToHuman(session, conversation, config, terminal, state);
      return;
    }
    if (terminal?.kind === "finish") {
      if (reply?.trim()) await this.sendAiText(session, conversation, reply.trim(), credentials, model);
      await this.resolveByAi(session, conversation, terminal.summary, state);
      return;
    }
    if (terminal?.kind === "followup") {
      if (reply?.trim()) await this.sendAiText(session, conversation, reply.trim(), credentials, model);
      await endAiSession(this.deps, {
        sessionId: session.id,
        organizationId,
        conversationId: conversation.id,
        reason: "resolved_by_ai",
        summary: `Follow-up agendado para daqui a ${terminal.hours}h. ${state.summary ?? ""}`.trim(),
        historyNote: `Atendimento por IA (${session.agent.name}) encerrado: follow-up agendado para daqui a ${terminal.hours}h.`,
      });
      return;
    }

    if (reply?.trim()) {
      await this.sendAiText(session, conversation, reply.trim(), credentials, model);
    } else {
      logger.info({ event: "ai_turn_empty_reply", sessionId: session.id });
    }
    await emitAiSession(this.deps, organizationId, conversation.id);

    const after = await prisma.aiSession.findUnique({ where: { id: session.id }, select: { aiMessageCount: true, status: true } });
    if (after?.status === "active" && after.aiMessageCount >= config.limits.maxAiMessages) {
      await this.finishWithFallback(session, conversation, config, "message_limit", null);
    }
  }

  /**
   * Chamada ao provedor com as voltas de ferramenta. Compartilhado entre o
   * atendimento real e o testador — o que muda é `mode`.
   */
  private async chatLoop(input: {
    credentials: ResolvedCredentials;
    model: string;
    temperature: number | null;
    timeoutMs: number;
    messages: AiChatMessage[];
    tools: ReturnType<typeof buildToolDefinitions>;
    env: ActionEnvironment;
    mode: "live" | "dryRun";
    usage: TurnUsage;
    pricing: AiSettingsView["pricingOverrides"];
    onToolOutcome: (outcome: ActionOutcome) => void;
  }): Promise<{ reply: string | null; terminal: TerminalAction | null }> {
    const messages = [...input.messages];
    let terminal: TerminalAction | null = null;
    let reply: string | null = null;

    for (let round = 0; round <= MAX_TOOL_ROUNDS; round += 1) {
      const result = await input.credentials.provider.chat({
        apiKey: input.credentials.apiKey,
        model: input.model,
        messages,
        // Última volta sem ferramentas: obriga a resposta em texto.
        tools: round === MAX_TOOL_ROUNDS ? [] : input.tools,
        temperature: input.temperature,
        maxOutputTokens: MAX_OUTPUT_TOKENS,
        timeoutMs: input.timeoutMs,
      });
      input.usage.requests += 1;
      input.usage.inputTokens += result.usage.inputTokens;
      input.usage.outputTokens += result.usage.outputTokens;
      const cost = estimateCostMicros(input.model, result.usage.inputTokens, result.usage.outputTokens, input.pricing);
      input.usage.costMicros = cost == null ? null : (input.usage.costMicros ?? 0) + cost;

      if (result.content?.trim()) reply = result.content.trim();
      if (result.toolCalls.length === 0) break;

      messages.push({ role: "assistant", content: result.content, toolCalls: result.toolCalls });
      for (const call of result.toolCalls) {
        const outcome = await this.runTool(input.env, call, input.mode);
        input.onToolOutcome(outcome);
        messages.push({ role: "tool", toolCallId: call.id, content: outcome.result });
        if (outcome.terminal && !terminal) terminal = outcome.terminal;
      }
      // Ferramenta terminal encerra o laço: o modelo já não responde mais.
      if (terminal) break;
    }
    return { reply, terminal };
  }

  private async runTool(env: ActionEnvironment, call: AiToolCall, mode: "live" | "dryRun"): Promise<ActionOutcome> {
    try {
      return await executeTool(this.deps, env, call, mode);
    } catch (err) {
      this.deps.logger.warn({ event: "ai_tool_failed", tool: call.name, error: String(err) });
      return { name: call.name, result: "Ação falhou por erro interno.", executed: false, blockedReason: "erro interno", terminal: null };
    }
  }

  // -------------------------------------------------------------------------
  // Contexto
  // -------------------------------------------------------------------------

  private async buildEnvironment(
    session: SessionRow,
    conversation: Conversation,
    config: AiAgentConfig,
    _settings: AiSettingsView,
  ): Promise<ActionEnvironment> {
    const { prisma } = this.deps;
    const [tags, sources, quickReplies] = await Promise.all([
      loadApplicableTags(prisma, conversation.organizationId, conversation.departmentId),
      prisma.aiKnowledgeSource.findMany({
        where: { active: true, agents: { some: { agentId: session.agentId } } },
        select: { id: true, title: true, kind: true, content: true },
      }),
      config.knowledge.includeQuickReplies
        ? prisma.quickReply.findMany({
            where: {
              organizationId: conversation.organizationId,
              OR: [
                { isGeneral: true },
                ...(conversation.departmentId
                  ? [{ departments: { some: { departmentId: conversation.departmentId } } }]
                  : [{ isGeneral: false }]),
              ],
            },
            select: { id: true, shortcut: true, title: true, content: true },
          })
        : Promise.resolve([]),
    ]);
    return {
      agent: { id: session.agentId, name: session.agent.name },
      config,
      conversation: {
        id: conversation.id,
        organizationId: conversation.organizationId,
        type: conversation.type,
        title: conversation.title,
        customTitle: conversation.customTitle,
        departmentId: conversation.departmentId,
        externalReference: conversation.externalReference,
        externalSource: conversation.externalSource,
      },
      state: readSessionState(session.state),
      tags,
      knowledgeSources: sources,
      quickReplies: quickReplies.map(
        (reply): KnowledgeSourceInput => ({
          id: reply.id,
          title: reply.title || `/${reply.shortcut}`,
          kind: "text",
          content: reply.content,
        }),
      ),
      azevedoOsEnabled: this.deps.azevedoOs.enabled,
    };
  }

  /** Histórico recente como mensagens do chat: cliente = user, equipe/IA = assistant. */
  private async loadHistory(conversationId: string, limit: number, exclude: Set<string>): Promise<AiChatMessage[]> {
    const rows = await this.deps.prisma.message.findMany({
      where: { conversationId, deletedAt: null, type: { not: "call" } },
      orderBy: { timestamp: "desc" },
      take: limit + exclude.size,
      select: { id: true, direction: true, content: true, type: true, senderName: true, metadata: true },
    });
    return rows.filter((row) => !exclude.has(row.id)).slice(0, limit).reverse().map((row) => {
      const text = messageText(row);
      if (row.direction === "inbound") return { role: "user" as const, content: text };
      // Mensagem da equipe (não da IA) vai marcada: o modelo precisa saber
      // que aquilo foi um atendente humano falando, não ele mesmo.
      const isAi = (row.metadata as { origem?: string } | null)?.origem === AI_MESSAGE_ORIGIN;
      return {
        role: "assistant" as const,
        content: isAi ? text : `[Mensagem de um atendente humano${row.senderName ? ` (${row.senderName})` : ""}] ${text}`,
      };
    });
  }

  private async promptContext(
    session: SessionRow,
    conversation: Conversation,
    config: AiAgentConfig,
    env: ActionEnvironment,
    knowledge: KnowledgeHit[],
  ): Promise<PromptContext> {
    const { prisma } = this.deps;
    const [organization, department, settings, personName] = await Promise.all([
      prisma.organization.findUnique({ where: { id: conversation.organizationId }, select: { name: true } }),
      conversation.departmentId
        ? prisma.department.findUnique({ where: { id: conversation.departmentId }, select: { name: true } })
        : Promise.resolve(null),
      loadAttendanceSettings(prisma, conversation.organizationId),
      resolveConversationPersonName(prisma, conversation.organizationId, conversation),
    ]);
    const title = conversation.customTitle || personName || conversation.title;
    const customerName = env.state.collected.nome ?? (looksLikeName(title) ? title : null);
    return {
      agentName: session.agent.name,
      organizationName: organization?.name ?? "o escritório",
      customerName,
      conversationType: conversation.type,
      departmentName: department?.name ?? null,
      tagNames: (await prisma.conversationTag.findMany({ where: { conversationId: conversation.id }, include: { tag: { select: { name: true } } } })).map((link) => link.tag.name),
      collected: env.state.collected,
      summary: env.state.summary,
      company: null,
      knowledge,
      today: new Intl.DateTimeFormat("pt-BR", { dateStyle: "full", timeZone: settings.timezone }).format(new Date()),
      remainingAiMessages: Math.max(0, config.limits.maxAiMessages - session.aiMessageCount),
    };
  }

  // -------------------------------------------------------------------------
  // Envio pelo WhatsApp
  // -------------------------------------------------------------------------

  /**
   * O MESMO caminho do envio manual (`POST /conversations/:id/messages`):
   * provider.sendText, `Message` outbound com a origem marcada, prévia da
   * conversa, `message:new` + `conversation:updated` na audiência.
   */
  private async sendAiText(
    session: SessionRow,
    conversation: Conversation,
    text: string,
    credentials: ResolvedCredentials,
    model?: string,
  ): Promise<void> {
    const { prisma, provider, io } = this.deps;
    const result = await provider.sendText(conversation.whatsappInstanceId, conversation.externalChatId, text);
    const metadata: AiMessageOriginMetadata = {
      origem: AI_MESSAGE_ORIGIN,
      aiAgentId: session.agentId,
      aiAgentName: session.agent.name,
      aiSessionId: session.id,
      aiProvider: credentials.kind,
      aiModel: model ?? credentials.defaultModel,
    };
    const message = await prisma.message.create({
      data: {
        organizationId: conversation.organizationId,
        conversationId: conversation.id,
        externalMessageId: result.externalMessageId,
        direction: "outbound",
        type: "text",
        content: text,
        senderName: session.agent.name,
        timestamp: result.timestamp,
        status: "sent",
        metadata: metadata as unknown as Prisma.InputJsonValue,
      },
    });
    await prisma.conversation.update({
      where: { id: conversation.id },
      data: { lastMessageAt: result.timestamp, lastMessagePreview: buildPreview({ type: "text", content: text }) },
    });
    await prisma.aiSession.update({
      where: { id: session.id },
      data: { aiMessageCount: { increment: 1 }, lastActivityAt: new Date() },
    });
    const full = await prisma.conversation.findUnique({ where: { id: conversation.id }, include: conversationInclude });
    if (full) {
      const personName = await resolveConversationPersonName(prisma, conversation.organizationId, full);
      const room = conversationAudience(conversation.organizationId, full);
      io.to(room).emit(RealtimeEvents.MessageNew, {
        conversation: serializeConversation(full, personName),
        message: serializeMessage(message),
      });
      io.to(room).emit(RealtimeEvents.ConversationUpdated, serializeConversation(full, personName));
    }
    this.deps.audit.record({
      organizationId: conversation.organizationId,
      userId: null,
      action: "message.sent.ai",
      entityType: "Conversation",
      entityId: conversation.id,
      metadata: { sessionId: session.id, agentId: session.agentId, messageId: message.id },
    });
  }

  // -------------------------------------------------------------------------
  // Saídas
  // -------------------------------------------------------------------------

  /** Encerra por erro/limite/orçamento: avisa o cliente e entrega ao humano. */
  private async finishWithFallback(
    session: SessionRow,
    conversation: Conversation,
    config: AiAgentConfig,
    reason: AiSessionEndReason,
    credentials: ResolvedCredentials | null,
  ): Promise<void> {
    const state = readSessionState(session.state);
    const creds = credentials ?? (await resolveCredentials(this.deps.prisma, this.deps.cipher, this.deps.logger, conversation.organizationId));
    const fallback = config.handoff.fallbackMessage.trim();
    if (fallback && creds) {
      try {
        await this.sendAiText(session, conversation, fallback, creds);
      } catch (err) {
        this.deps.logger.warn({ event: "ai_fallback_send_failed", sessionId: session.id, error: String(err) });
      }
    }
    await this.transferToHuman(
      session,
      conversation,
      config,
      { kind: "transfer", reason: reasonLabel(reason), subject: state.subject ?? "", need: "", summary: state.summary ?? "" },
      state,
      reason,
    );
  }

  /**
   * Transferência: resumo como nota interna, conversa roteada ao destino do
   * agente (departamento e responsável), histórico e sessão encerrada. A
   * ordem importa: a nota entra ANTES da conversa mudar de sala, para quem
   * receber já achá-la no painel.
   */
  private async transferToHuman(
    session: SessionRow,
    conversation: Conversation,
    config: AiAgentConfig,
    terminal: Extract<TerminalAction, { kind: "transfer" }>,
    state: AiSessionState,
    reason: AiSessionEndReason = "ai_transfer",
  ): Promise<void> {
    const { prisma } = this.deps;
    const personName = await resolveConversationPersonName(prisma, conversation.organizationId, conversation);
    const summary = buildHandoffSummary({
      agentName: session.agent.name,
      customerName: state.collected.nome ?? conversation.customTitle ?? personName ?? (looksLikeName(conversation.title) ? conversation.title : null),
      subject: terminal.subject || state.subject,
      need: terminal.need || null,
      summary: terminal.summary || state.summary,
      reason: terminal.reason,
      collected: state.collected,
      fields: config.dataCollection.fields,
      aiMessages: session.aiMessageCount,
      customerMessages: session.customerMessageCount,
    });
    await prisma.internalNote.create({
      data: { organizationId: conversation.organizationId, conversationId: conversation.id, userId: null, content: summary },
    });
    await this.routeConversationForHandoff(conversation, session.agent, config, terminal.reason);
    await endAiSession(this.deps, {
      sessionId: session.id,
      organizationId: conversation.organizationId,
      conversationId: conversation.id,
      reason,
      summary,
      historyNote: `Atendimento por IA (${session.agent.name}) transferido para humano: ${terminal.reason}`,
    });
    this.deps.audit.record({
      organizationId: conversation.organizationId,
      userId: null,
      action: "ai.session_transferred",
      entityType: "Conversation",
      entityId: conversation.id,
      metadata: { sessionId: session.id, agentId: session.agentId, reason },
    });
  }

  /**
   * Destino da transferência: departamento do agente (quando definido) e
   * responsável conforme o modo. "Pela regra" reaproveita o responsável
   * padrão do departamento/número; "específico" só se a pessoa enxerga a
   * conversa (`eligibleAssigneeWhere`) — atribuir a quem não vê some com a
   * conversa da fila.
   */
  private async routeConversationForHandoff(
    conversation: Conversation,
    agent: AiAgent,
    config: AiAgentConfig,
    reasonNote: string | null,
  ): Promise<void> {
    const { prisma } = this.deps;
    const departmentId = agent.handoffDepartmentId ?? conversation.departmentId;
    let assigneeId: string | null = null;
    if (config.handoff.assigneeMode === "specific" && agent.handoffAssigneeId) {
      const eligible = await prisma.user.findFirst({
        where: eligibleAssigneeWhere({
          userId: agent.handoffAssigneeId,
          organizationId: conversation.organizationId,
          whatsappInstanceId: conversation.whatsappInstanceId,
          departmentId,
        }),
        select: { id: true },
      });
      assigneeId = eligible?.id ?? null;
    } else if (config.handoff.assigneeMode === "rules") {
      const [department, instance] = await Promise.all([
        departmentId ? prisma.department.findUnique({ where: { id: departmentId }, select: { defaultAssigneeId: true } }) : null,
        prisma.whatsAppInstance.findUnique({ where: { id: conversation.whatsappInstanceId }, select: { defaultAssigneeId: true } }),
      ]);
      const candidate = department?.defaultAssigneeId ?? instance?.defaultAssigneeId ?? null;
      if (candidate) {
        const eligible = await prisma.user.findFirst({
          where: eligibleAssigneeWhere({ userId: candidate, organizationId: conversation.organizationId, whatsappInstanceId: conversation.whatsappInstanceId, departmentId }),
          select: { id: true },
        });
        assigneeId = eligible?.id ?? null;
      }
    }

    const departmentChanged = departmentId !== conversation.departmentId;
    await prisma.$transaction([
      prisma.conversation.update({
        where: { id: conversation.id },
        data: {
          departmentId,
          status: "open",
          ...(assigneeId ? assignToUserData(assigneeId) : { assignedUserId: null, assignedToAll: false }),
        },
      }),
      ...(departmentChanged
        ? [
            prisma.conversationAssignmentHistory.create({
              data: {
                organizationId: conversation.organizationId,
                conversationId: conversation.id,
                action: "transferred_department",
                fromDepartmentId: conversation.departmentId,
                toDepartmentId: departmentId,
                note: `Transferido pela IA (${agent.name})${reasonNote ? `: ${reasonNote}` : ""}`,
              },
            }),
          ]
        : []),
      ...(assigneeId
        ? [
            prisma.conversationAssignmentHistory.create({
              data: {
                organizationId: conversation.organizationId,
                conversationId: conversation.id,
                action: "assigned",
                toUserId: assigneeId,
                toDepartmentId: departmentId,
                note: `Responsável definido na transferência pela IA (${agent.name})`,
              },
            }),
          ]
        : []),
    ]);
    // Mudou de sala (departamento/responsável): publica para a audiência NOVA.
    const full = await prisma.conversation.findUnique({ where: { id: conversation.id }, include: conversationInclude });
    if (full) {
      const personName = await resolveConversationPersonName(prisma, conversation.organizationId, full);
      this.deps.io.to(conversationAudience(conversation.organizationId, full)).emit(RealtimeEvents.ConversationUpdated, serializeConversation(full, personName));
    }
  }

  private async resolveByAi(session: SessionRow, conversation: Conversation, summary: string, state: AiSessionState): Promise<void> {
    const { prisma } = this.deps;
    const automation = session.automationId
      ? await prisma.aiAutomation.findUnique({ where: { id: session.automationId }, select: { resolvedTagId: true } })
      : null;
    await prisma.$transaction([
      prisma.conversation.update({ where: { id: conversation.id }, data: { status: "resolved" } }),
      prisma.conversationAssignmentHistory.create({
        data: {
          organizationId: conversation.organizationId,
          conversationId: conversation.id,
          action: "resolved",
          note: `Concluído pela IA (${session.agent.name})`,
        },
      }),
      ...(automation?.resolvedTagId
        ? [
            prisma.conversationTag.upsert({
              where: { conversationId_tagId: { conversationId: conversation.id, tagId: automation.resolvedTagId } },
              update: {},
              create: { conversationId: conversation.id, tagId: automation.resolvedTagId },
            }),
          ]
        : []),
    ]);
    if (summary || state.summary) {
      await prisma.internalNote.create({
        data: {
          organizationId: conversation.organizationId,
          conversationId: conversation.id,
          userId: null,
          content: `[${session.agent.name}] Atendimento concluído pela IA.\n${summary || state.summary}`,
        },
      });
    }
    await endAiSession(this.deps, {
      sessionId: session.id,
      organizationId: conversation.organizationId,
      conversationId: conversation.id,
      reason: "resolved_by_ai",
      summary: summary || state.summary,
      historyNote: `Atendimento por IA (${session.agent.name}) concluído.`,
    });
    const full = await prisma.conversation.findUnique({ where: { id: conversation.id }, include: conversationInclude });
    if (full) {
      const personName = await resolveConversationPersonName(prisma, conversation.organizationId, full);
      this.deps.io.to(conversationAudience(conversation.organizationId, full)).emit(RealtimeEvents.ConversationUpdated, serializeConversation(full, personName));
    }
  }

  // -------------------------------------------------------------------------
  // Ações da equipe
  // -------------------------------------------------------------------------

  /** "Devolver para IA": abre nova sessão com o mesmo agente, por decisão explícita. */
  async resumeSession(input: { organizationId: string; conversationId: string; userId: string; userName: string }): Promise<{ ok: true } | { ok: false; reason: string }> {
    const { prisma } = this.deps;
    const conversation = await prisma.conversation.findFirst({ where: { id: input.conversationId, organizationId: input.organizationId } });
    if (!conversation) return { ok: false, reason: "Conversa não encontrada." };
    if (conversation.archivedAt) return { ok: false, reason: "Conversa arquivada não volta para a IA." };
    const active = await prisma.aiSession.findFirst({ where: { conversationId: conversation.id, status: "active" }, select: { id: true } });
    if (active) return { ok: false, reason: "A IA já está atendendo esta conversa." };
    const last = await prisma.aiSession.findFirst({
      where: { conversationId: conversation.id },
      orderBy: { startedAt: "desc" },
      include: { agent: true },
    });
    if (!last) return { ok: false, reason: "Esta conversa nunca passou pela IA." };
    if (last.agent.status !== "active") return { ok: false, reason: "O agente deste atendimento não está ativo." };
    const credentials = await resolveCredentials(prisma, this.deps.cipher, this.deps.logger, input.organizationId);
    if (!credentials) return { ok: false, reason: "O provedor de IA não está conectado." };
    const version = await prisma.aiAgentVersion.findUnique({
      where: { agentId_version: { agentId: last.agentId, version: last.agent.currentVersion } },
    });
    const session = await prisma.aiSession.create({
      data: {
        organizationId: input.organizationId,
        conversationId: conversation.id,
        agentId: last.agentId,
        agentVersionId: version?.id ?? null,
        automationId: last.automationId,
        // Memória preservada: o que já foi coletado não é perguntado de novo.
        state: (last.state ?? { collected: {}, summary: null, subject: null, intent: null, actions: [] }) as Prisma.InputJsonValue,
        // A partir daqui: só responde ao que chegar depois de agora.
        lastProcessedMessageId: (await prisma.message.findFirst({ where: { conversationId: conversation.id, direction: "inbound" }, orderBy: { timestamp: "desc" }, select: { id: true } }))?.id ?? null,
      },
    });
    await prisma.$transaction([
      prisma.conversation.update({ where: { id: conversation.id }, data: { assignedUserId: null, assignedToAll: false } }),
      prisma.conversationAssignmentHistory.create({
        data: {
          organizationId: input.organizationId,
          conversationId: conversation.id,
          action: "unassigned",
          performedByUserId: input.userId,
          note: `Conversa devolvida para a IA (${last.agent.name}) por ${input.userName}.`,
        },
      }),
    ]);
    this.deps.audit.record({
      organizationId: input.organizationId,
      userId: input.userId,
      action: "ai.session_resumed",
      entityType: "Conversation",
      entityId: conversation.id,
      metadata: { sessionId: session.id, agentId: last.agentId },
    });
    await emitAiSession(this.deps, input.organizationId, conversation.id);
    const full = await prisma.conversation.findUnique({ where: { id: conversation.id }, include: conversationInclude });
    if (full) {
      const personName = await resolveConversationPersonName(prisma, conversation.organizationId, full);
      this.deps.io.to(conversationAudience(conversation.organizationId, full)).emit(RealtimeEvents.ConversationUpdated, serializeConversation(full, personName));
    }
    return { ok: true };
  }

  // -------------------------------------------------------------------------
  // Testador
  // -------------------------------------------------------------------------

  /**
   * Simulação: mesmo prompt, mesmas ferramentas e mesmas recusas do
   * atendimento real — mas nada é gravado e nada sai pelo WhatsApp. O
   * consumo entra no log como `kind = test`, porque custa de verdade.
   */
  async runTest(input: {
    organizationId: string;
    agent: AiAgent;
    transcript: AiChatTurn[];
    state: Record<string, unknown> | null;
    debug: boolean;
  }): Promise<AiTestResultDto> {
    const { prisma } = this.deps;
    const config = parseStoredAgentConfig(input.agent.config);
    const settings = await loadAiSettings(prisma, input.organizationId);
    const credentials = await resolveCredentials(prisma, this.deps.cipher, this.deps.logger, input.organizationId);
    if (!credentials) throw new AiProviderError("invalid_api_key", "O provedor de IA não está conectado.");
    const model = config.advanced.model ?? input.agent.model ?? credentials.defaultModel;

    const [tags, sources, organization, attendance] = await Promise.all([
      loadApplicableTags(prisma, input.organizationId, null),
      prisma.aiKnowledgeSource.findMany({
        where: { active: true, agents: { some: { agentId: input.agent.id } } },
        select: { id: true, title: true, kind: true, content: true },
      }),
      prisma.organization.findUnique({ where: { id: input.organizationId }, select: { name: true } }),
      loadAttendanceSettings(prisma, input.organizationId),
    ]);
    const state = readSessionState(input.state);
    const env: ActionEnvironment = {
      agent: { id: input.agent.id, name: input.agent.name },
      config,
      conversation: {
        id: "teste",
        organizationId: input.organizationId,
        type: "individual",
        title: "Cliente simulado",
        customTitle: null,
        departmentId: null,
        externalReference: null,
        externalSource: null,
      },
      state,
      tags,
      knowledgeSources: sources,
      quickReplies: [],
      azevedoOsEnabled: false,
    };
    const lastCustomer = [...input.transcript].reverse().find((turn) => turn.role === "customer");
    const knowledge = retrieveKnowledge(sources, lastCustomer?.content ?? "");
    const aiMessages = input.transcript.filter((turn) => turn.role === "assistant").length;
    const system = buildSystemPrompt(config, {
      agentName: input.agent.name,
      organizationName: organization?.name ?? "o escritório",
      customerName: state.collected.nome ?? null,
      conversationType: "individual",
      departmentName: null,
      tagNames: [],
      collected: state.collected,
      summary: state.summary,
      company: null,
      knowledge,
      today: new Intl.DateTimeFormat("pt-BR", { dateStyle: "full", timeZone: attendance.timezone }).format(new Date()),
      remainingAiMessages: Math.max(0, config.limits.maxAiMessages - aiMessages),
    });
    const tools = buildToolDefinitions(config, {
      hasKnowledge: sources.length > 0,
      canLookupCompany: false,
      tagNames: tags.map((tag) => tag.name),
      collectFieldKeys: config.dataCollection.fields.map((field) => field.key),
    });
    const messages: AiChatMessage[] = [
      { role: "system", content: system },
      ...input.transcript.map((turn): AiChatMessage =>
        turn.role === "customer" ? { role: "user", content: turn.content } : { role: "assistant", content: turn.content },
      ),
    ];

    const usage: TurnUsage = { inputTokens: 0, outputTokens: 0, costMicros: 0, requests: 0 };
    const debug: AiTestDebugDto = {
      agentId: input.agent.id,
      agentVersion: input.agent.currentVersion,
      model,
      knowledgeUsed: knowledge.map((hit) => ({ sourceTitle: hit.sourceTitle, excerpt: hit.text.slice(0, 200) })),
      toolsRequested: [],
      toolsBlocked: [],
      toolsExecuted: [],
      inputTokens: 0,
      outputTokens: 0,
      costMicros: 0,
      handoff: null,
      finished: false,
    };
    const startedAt = Date.now();
    let outcome: AiUsageOutcome = "ok";
    let errorCode: string | null = null;
    let reply: string | null = null;
    let terminal: TerminalAction | null = null;
    try {
      const loop = await this.chatLoop({
        credentials,
        model,
        temperature: config.advanced.temperature,
        timeoutMs: settings.timeoutMs,
        messages,
        tools,
        env,
        mode: "dryRun",
        usage,
        pricing: settings.pricingOverrides,
        onToolOutcome: (result) => {
          debug.toolsRequested.push({ name: result.name, arguments: {} });
          if (result.executed) debug.toolsExecuted.push({ name: result.name, result: result.result.slice(0, 300) });
          else debug.toolsBlocked.push({ name: result.name, reason: result.blockedReason ?? "" });
          if (result.knowledgeUsed) debug.knowledgeUsed.push(...result.knowledgeUsed);
        },
      });
      reply = loop.reply;
      terminal = loop.terminal;
    } catch (err) {
      outcome = err instanceof AiProviderError && err.code === "timeout" ? "timeout" : "error";
      errorCode = err instanceof AiProviderError ? err.code : "unexpected";
      await this.recordUsage({
        organizationId: input.organizationId,
        agent: input.agent,
        provider: credentials.kind,
        model,
        kind: "test",
        outcome,
        errorCode,
        usage,
        durationMs: Date.now() - startedAt,
      });
      throw err;
    }
    await this.recordUsage({
      organizationId: input.organizationId,
      agent: input.agent,
      provider: credentials.kind,
      model,
      kind: "test",
      outcome,
      errorCode,
      usage,
      durationMs: Date.now() - startedAt,
      toolsRequested: debug.toolsRequested.map((tool) => tool.name),
      toolsExecuted: debug.toolsExecuted.map((tool) => tool.name),
      toolsBlocked: debug.toolsBlocked.map((tool) => tool.name),
      handoffReason: terminal?.kind === "transfer" ? terminal.reason : null,
    });
    debug.inputTokens = usage.inputTokens;
    debug.outputTokens = usage.outputTokens;
    debug.costMicros = usage.costMicros;
    if (terminal?.kind === "transfer") {
      debug.handoff = { reason: terminal.reason, summary: terminal.summary };
      reply = reply?.trim() || config.handoff.transferMessage;
    }
    debug.finished = terminal?.kind === "finish";
    return {
      reply,
      state: state as unknown as Record<string, unknown>,
      ended: terminal?.kind === "transfer" ? "transferred" : terminal ? "resolved" : null,
      debug: input.debug ? debug : null,
    };
  }

  // -------------------------------------------------------------------------
  // Varredura
  // -------------------------------------------------------------------------

  /**
   * A cada minuto: (a) sessão além do tempo máximo é encerrada com fallback;
   * (b) sessão com mensagem recebida sem resposta há mais de 45s e sem turno
   * em memória (reinício no meio do caminho, ou falha transitória) ganha um
   * turno de novo.
   */
  async sweep(): Promise<void> {
    const { prisma, logger } = this.deps;
    try {
      const active = await prisma.aiSession.findMany({
        where: { status: "active" },
        include: { agent: true, agentVersion: true },
      });
      for (const session of active) {
        if (this.chains.has(session.conversationId) || this.timers.has(session.conversationId)) continue;
        const conversation = await prisma.conversation.findUnique({ where: { id: session.conversationId } });
        if (!conversation) continue;
        const config = parseStoredAgentConfig(session.agentVersion?.config ?? session.agent.config);
        if (conversation.archivedAt) {
          await endAiSession(this.deps, {
            sessionId: session.id,
            organizationId: conversation.organizationId,
            conversationId: conversation.id,
            reason: "conversation_archived",
            historyNote: `Atendimento por IA (${session.agent.name}) encerrado: conversa arquivada.`,
          });
          continue;
        }
        if (config.limits.maxDurationMinutes != null) {
          const elapsedMinutes = (Date.now() - session.startedAt.getTime()) / 60_000;
          if (elapsedMinutes > config.limits.maxDurationMinutes) {
            await this.enqueue(conversation.id, () => this.finishWithFallback(session, conversation, config, "duration_limit", null));
            continue;
          }
        }
        // Mensagem recebida sem resposta há mais que o prazo?
        const last = session.lastProcessedMessageId
          ? await prisma.message.findUnique({ where: { id: session.lastProcessedMessageId }, select: { timestamp: true } })
          : null;
        const pending = await prisma.message.findFirst({
          where: {
            conversationId: conversation.id,
            direction: "inbound",
            deletedAt: null,
            ...(last ? { timestamp: { gt: last.timestamp } } : {}),
            createdAt: { lt: new Date(Date.now() - STALE_PENDING_MS) },
          },
          select: { id: true },
        });
        if (pending) {
          logger.info({ event: "ai_sweep_resume_turn", sessionId: session.id });
          this.enqueue(conversation.id, () => this.handleInbound(conversation.organizationId, conversation.id));
        }
      }
    } catch (err) {
      logger.error({ event: "ai_sweep_failed", error: String(err) });
    }
  }

  // -------------------------------------------------------------------------
  // Consumo
  // -------------------------------------------------------------------------

  private async recordUsage(input: {
    organizationId: string;
    agent: Pick<AiAgent, "id" | "name"> | null;
    sessionId?: string;
    conversationId?: string;
    departmentId?: string | null;
    provider: AiProviderKind;
    model: string;
    kind: "chat" | "test";
    outcome: AiUsageOutcome;
    errorCode: string | null;
    usage: TurnUsage;
    durationMs: number;
    toolsRequested?: string[];
    toolsExecuted?: string[];
    toolsBlocked?: string[];
    handoffReason?: string | null;
  }): Promise<void> {
    try {
      await this.deps.prisma.aiUsageLog.create({
        data: {
          organizationId: input.organizationId,
          sessionId: input.sessionId ?? null,
          agentId: input.agent?.id ?? null,
          agentName: input.agent?.name ?? null,
          conversationId: input.conversationId ?? null,
          departmentId: input.departmentId ?? null,
          provider: input.provider,
          model: input.model,
          kind: input.kind,
          outcome: input.outcome,
          inputTokens: input.usage.inputTokens,
          outputTokens: input.usage.outputTokens,
          costMicros: input.usage.costMicros,
          durationMs: input.durationMs,
          errorCode: input.errorCode,
          toolsRequested: input.toolsRequested ?? [],
          toolsExecuted: input.toolsExecuted ?? [],
          toolsBlocked: input.toolsBlocked ?? [],
          handoffReason: input.handoffReason ?? null,
        },
      });
      if ((input.usage.costMicros ?? 0) > 0) {
        await checkBudgetAlerts(this.deps, input.organizationId);
      }
    } catch (err) {
      // Consumo é registro, não caminho crítico: falha aqui não derruba o turno.
      this.deps.logger.warn({ event: "ai_usage_log_failed", error: String(err) });
    }
  }
}

// ---------------------------------------------------------------------------
// Puras
// ---------------------------------------------------------------------------

/** A automação casa com a conversa? Fonte única, testável sem banco. */
export function automationMatches(
  automation: Pick<
    AiAutomation,
    "whatsappInstanceId" | "departmentId" | "onlyWithoutDepartment" | "conversationType" | "onlyUnassigned" | "onlyNewConversations"
  >,
  conversation: Pick<Conversation, "whatsappInstanceId" | "departmentId" | "type" | "assignedUserId" | "assignedToAll" | "archivedAt">,
  context: { isFirstInbound: boolean },
): boolean {
  if (conversation.archivedAt) return false;
  if (automation.whatsappInstanceId && automation.whatsappInstanceId !== conversation.whatsappInstanceId) return false;
  if (automation.onlyWithoutDepartment) {
    if (conversation.departmentId !== null) return false;
  } else if (automation.departmentId && automation.departmentId !== conversation.departmentId) {
    return false;
  }
  if (!automationMatchesType(automation.conversationType as "any" | "individual" | "group", conversation.type)) return false;
  if (automation.onlyUnassigned && (conversation.assignedUserId || conversation.assignedToAll)) return false;
  if (automation.onlyNewConversations && !context.isFirstInbound) return false;
  return true;
}

function messageText(message: { content: string | null; type: string }): string {
  if (message.type === "text") return message.content ?? "";
  const labels: Record<string, string> = {
    image: "[imagem]",
    audio: "[áudio]",
    video: "[vídeo]",
    document: "[documento]",
    sticker: "[figurinha]",
    location: "[localização]",
    contact: "[contato]",
    poll: "[enquete]",
  };
  const label = labels[message.type] ?? "[mensagem]";
  return message.content ? `${label} ${message.content}` : label;
}

/** Título que é telefone/JID não é nome. */
function looksLikeName(title: string): boolean {
  return !/^[\d+\s()-]+$/.test(title) && !title.includes("@");
}

function reasonLabel(reason: AiSessionEndReason): string {
  switch (reason) {
    case "message_limit":
      return "Limite de mensagens da IA atingido";
    case "duration_limit":
      return "Tempo máximo sob atendimento da IA atingido";
    case "provider_error":
      return "Falha do provedor de IA";
    case "budget_exceeded":
      return "Orçamento mensal de IA atingido";
    case "agent_disabled":
      return "Agente desativado durante o atendimento";
    case "attempt_limit":
      return "Limite de tentativas sem resolver";
    default:
      return reason;
  }
}

function isUniqueViolation(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: unknown }).code === "P2002";
}

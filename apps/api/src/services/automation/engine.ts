import type { Conversation, Prisma, PrismaClient } from "@azvchat/database";
import {
  RealtimeEvents,
  resolveAutomationTemplate,
  type AskQuestionNodeData,
  type AssignUserNodeData,
  type AutomationConditionClause,
  type AutomationExecutionStatus,
  type AutomationGraph,
  type AutomationNode,
  type AutomationTriggerType,
  type ChangeStatusNodeData,
  type ConditionNodeData,
  type FinishNodeData,
  type ForwardDepartmentNodeData,
  type MenuNodeData,
  type MenuOption,
  type SendMessageNodeData,
  type TagNodeData,
  type WaitNodeData,
  type WebhookNodeData,
} from "@azvchat/shared";
import type { WhatsAppProvider } from "@azvchat/whatsapp";
import type { Server } from "socket.io";
import type { Logger } from "pino";
import { conversationAssigneeWhere } from "../../lib/access.js";
import { assignToUserData, clearAssignmentData } from "../../lib/conversation-assignment.js";
import { conversationInclude, emitConversationUpdated } from "../../lib/conversation-events.js";
import { serializeConversation, serializeMessage } from "../../lib/serialize.js";
import { resolveConversationPersonName } from "../../lib/person-profile.js";
import { loadAttendanceSettings } from "../../lib/attendance-settings.js";
import { isWithinBusinessHours, nextBusinessWindowStart } from "../../lib/automation/business-hours.js";
import { conversationAudience } from "../../realtime/socket.js";
import { buildPreview, isUniqueViolation } from "../message-ingest.js";
import { buildAutomationVariableContext, type AutomationExecutionContextData } from "./context.js";

/**
 * O MOTOR de execução das automações — a peça que a especificação chama de
 * "não quero só um editor visual". Ele roda inteiramente no backend: nada
 * aqui depende de aba de navegador aberta (seção 33/34).
 *
 * Cada chamada pública (`handleIncomingMessage`, `handleHumanTakeover`,
 * `handleTagAdded`, `handleConversationResolved`, `tick`) NUNCA lança — mesma
 * regra do `MessageIngestService.ingest()`: uma falha aqui não pode derrubar
 * o recebimento da mensagem, só ficar registrada em log.
 */

const MAX_STEPS_PER_ADVANCE = 60;

interface ConversationRuntime {
  id: string;
  organizationId: string;
  whatsappInstanceId: string;
  externalChatId: string;
  type: string;
  title: string;
  customTitle: string | null;
  status: string;
  departmentId: string | null;
  assignedUserId: string | null;
  assignedToAll: boolean;
}

interface RuntimeExtra {
  latestMessageContent?: string | null;
}

type NodeStepResult =
  | { type: "continue"; handle?: string }
  | { type: "wait"; reason: "reply" | "timer"; until: Date | null }
  | { type: "finish"; summary: string | null }
  | { type: "failed"; error: string };

function pickNextEdge(graph: AutomationGraph, nodeId: string, handle?: string) {
  if (handle) return graph.edges.find((edge) => edge.source === nodeId && edge.sourceHandle === handle);
  return (
    graph.edges.find((edge) => edge.source === nodeId && !edge.sourceHandle) ??
    graph.edges.find((edge) => edge.source === nodeId)
  );
}

function readKeywords(config: unknown): string[] {
  if (!config || typeof config !== "object") return [];
  const value = (config as { keywords?: unknown }).keywords;
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function readMinutes(config: unknown): number | null {
  if (!config || typeof config !== "object") return null;
  const value = (config as { minutes?: unknown }).minutes;
  return typeof value === "number" && value > 0 ? value : null;
}

function readTagId(config: unknown): string | null {
  if (!config || typeof config !== "object") return null;
  const value = (config as { tagId?: unknown }).tagId;
  return typeof value === "string" && value ? value : null;
}

function generateProtocol(): string {
  const stamp = Date.now().toString(36).toUpperCase();
  const rand = Math.random().toString(36).slice(2, 6).toUpperCase();
  return `AZV-${stamp}-${rand}`;
}

function matchMenuOption(options: MenuOption[], raw: string): MenuOption | null {
  const text = raw.trim();
  if (!text) return null;
  if (/^\d+$/.test(text)) {
    const option = options[Number(text) - 1];
    if (option) return option;
  }
  const lower = text.toLowerCase();
  return (
    options.find((option) => option.label.trim().toLowerCase() === lower) ??
    options.find((option) => option.label.trim().toLowerCase().includes(lower)) ??
    null
  );
}

/** Resultado bruto e o valor NORMALIZADO a gravar (dígitos puros em CPF/CNPJ, etc.). */
function validateAnswer(
  answerType: AskQuestionNodeData["answerType"],
  options: string[] | undefined,
  raw: string,
): { ok: true; value: string } | { ok: false } {
  const text = raw.trim();
  if (!text) return { ok: false };
  switch (answerType) {
    case "text":
      return { ok: true, value: text };
    case "number":
      return /^\d+([.,]\d+)?$/.test(text) ? { ok: true, value: text } : { ok: false };
    case "cpf": {
      const digits = text.replace(/\D/g, "");
      return digits.length === 11 ? { ok: true, value: digits } : { ok: false };
    }
    case "cnpj": {
      const digits = text.replace(/\D/g, "");
      return digits.length === 14 ? { ok: true, value: digits } : { ok: false };
    }
    case "email":
      return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text) ? { ok: true, value: text } : { ok: false };
    case "date":
      return /^\d{2}\/\d{2}\/\d{4}$/.test(text) || /^\d{4}-\d{2}-\d{2}$/.test(text)
        ? { ok: true, value: text }
        : { ok: false };
    case "option": {
      const list = options ?? [];
      const byIndex = /^\d+$/.test(text) ? list[Number(text) - 1] : undefined;
      const lower = text.toLowerCase();
      const byLabel = list.find((item) => item.trim().toLowerCase() === lower);
      const chosen = byIndex ?? byLabel;
      return chosen ? { ok: true, value: chosen } : { ok: false };
    }
    default:
      return { ok: true, value: text };
  }
}

function invalidAnswerMessage(answerType: AskQuestionNodeData["answerType"]): string {
  const labels: Record<string, string> = {
    number: "Isso não parece um número válido.",
    cpf: "Isso não parece um CPF válido (11 dígitos).",
    cnpj: "Isso não parece um CNPJ válido (14 dígitos).",
    email: "Isso não parece um e-mail válido.",
    date: "Isso não parece uma data válida (DD/MM/AAAA).",
    option: "Não reconheci essa opção.",
  };
  return labels[answerType] ?? "Não entendi sua resposta.";
}

export class AutomationEngine {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly provider: WhatsAppProvider,
    private readonly io: Server,
    private readonly logger: Logger,
  ) {}

  /* ------------------------------------------------------------------ *
   * Pontos de entrada públicos — nunca lançam.
   * ------------------------------------------------------------------ */

  /** Chamado logo depois que uma mensagem RECEBIDA nova é gravada (ver `instance-manager.ts`). */
  async handleIncomingMessage(input: {
    organizationId: string;
    conversationId: string;
    content: string | null;
  }): Promise<void> {
    try {
      await this.handleIncomingMessageUnsafe(input);
    } catch (err) {
      this.logger.error({
        event: "automation_handle_message_failed",
        conversationId: input.conversationId,
        error: String(err),
      });
    }
  }

  /** Um HUMANO assumiu a conversa (POST /conversations/:id/assign) — para a automação ativa, se houver. */
  async handleHumanTakeover(conversationId: string): Promise<void> {
    try {
      const active = await this.prisma.automationExecution.findFirst({
        where: { conversationId, status: { in: ["running", "waiting"] } },
      });
      if (!active) return;
      await this.prisma.automationExecution.update({
        where: { id: active.id },
        data: {
          status: "handed_off",
          waitingReason: null,
          waitingUntil: null,
          finishedAt: new Date(),
          resultSummary: "Assumido por um atendente.",
        },
      });
      await this.log(active.id, "info", "automation_handed_off", {});
    } catch (err) {
      this.logger.error({ event: "automation_handover_failed", conversationId, error: String(err) });
    }
  }

  /** Uma etiqueta foi aplicada à conversa — avalia fluxos do gatilho `tag_added`. */
  async handleTagAdded(organizationId: string, conversationId: string, tagId: string): Promise<void> {
    try {
      const conversation = await this.prisma.conversation.findUnique({ where: { id: conversationId } });
      if (!conversation || conversation.archivedAt) return;
      if (await this.hasActiveExecution(conversationId)) return;
      const candidates = await this.loadCandidateFlows(organizationId, conversation.whatsappInstanceId, [
        "tag_added",
      ]);
      for (const flow of candidates) {
        if (readTagId(flow.triggerConfig) !== tagId) continue;
        if (await this.isOnCooldown(flow, conversation.id)) continue;
        await this.startExecution(flow, conversation, "tag_added", {});
        return;
      }
    } catch (err) {
      this.logger.error({ event: "automation_tag_trigger_failed", conversationId, error: String(err) });
    }
  }

  /** O atendimento foi concluído — avalia fluxos do gatilho `conversation_resolved`. */
  async handleConversationResolved(organizationId: string, conversationId: string): Promise<void> {
    try {
      const conversation = await this.prisma.conversation.findUnique({ where: { id: conversationId } });
      if (!conversation) return;
      if (await this.hasActiveExecution(conversationId)) return;
      const candidates = await this.loadCandidateFlows(organizationId, conversation.whatsappInstanceId, [
        "conversation_resolved",
      ]);
      for (const flow of candidates) {
        if (await this.isOnCooldown(flow, conversation.id)) continue;
        await this.startExecution(flow, conversation, "conversation_resolved", {});
        return;
      }
    } catch (err) {
      this.logger.error({ event: "automation_resolved_trigger_failed", conversationId, error: String(err) });
    }
  }

  /** Chamado periodicamente pelo worker (ver `worker.ts`): retomadas de timer + "sem resposta". */
  async tick(): Promise<void> {
    try {
      await this.resumeDueWaits();
    } catch (err) {
      this.logger.error({ event: "automation_resume_waits_failed", error: String(err) });
    }
    try {
      await this.scanNoReplyTimeouts();
    } catch (err) {
      this.logger.error({ event: "automation_no_reply_scan_failed", error: String(err) });
    }
  }

  /* ------------------------------------------------------------------ *
   * Seleção de gatilho
   * ------------------------------------------------------------------ */

  private async handleIncomingMessageUnsafe(input: {
    organizationId: string;
    conversationId: string;
    content: string | null;
  }): Promise<void> {
    const conversation = await this.prisma.conversation.findUnique({ where: { id: input.conversationId } });
    if (!conversation || conversation.archivedAt) return;

    const active = await this.prisma.automationExecution.findFirst({
      where: { conversationId: conversation.id, status: { in: ["running", "waiting"] } },
    });
    if (active) {
      await this.handleMessageForActiveExecution(active, conversation, input.content);
      return;
    }

    const messageCount = await this.prisma.message.count({
      where: { conversationId: conversation.id, deletedAt: null },
    });
    const isFirstMessage = messageCount <= 1;

    const candidates = await this.loadCandidateFlows(input.organizationId, conversation.whatsappInstanceId, [
      "first_message",
      "keyword",
      "new_message",
    ]);
    for (const flow of candidates) {
      if (flow.triggerType === "first_message" && !isFirstMessage) continue;
      if (flow.triggerType === "keyword") {
        const keywords = readKeywords(flow.triggerConfig);
        if (keywords.length === 0) continue;
        const text = (input.content ?? "").toLowerCase();
        if (!keywords.some((keyword) => text.includes(keyword.toLowerCase()))) continue;
      }
      if (await this.isOnCooldown(flow, conversation.id)) continue;
      // Só UM fluxo começa por mensagem (seção 27) — a ordenação por
      // `priority` já veio da consulta, então o primeiro que passar vence.
      await this.startExecution(flow, conversation, flow.triggerType, { latestMessageContent: input.content });
      return;
    }

    // Nenhum FLUXO do construtor visual assumiu esta mensagem — sobra a
    // saudação/fora-do-expediente dos Parâmetros de atendimento (seções 4 e
    // 5), o caminho de zero-configuração para quem não quer montar um fluxo.
    // Um escritório com um fluxo de verdade (que já inclui a própria
    // saudação, como o template "Atendimento Geral") nunca chega aqui para a
    // mesma conversa, porque o fluxo já a capturou acima.
    await this.maybeSendAttendanceAutoMessages(input.organizationId, conversation, isFirstMessage);
  }

  /**
   * Saudação e fora-do-expediente configurados em Parâmetros de atendimento.
   * Nunca os dois na mesma mensagem: fora do expediente tem prioridade,
   * porque é a informação mais importante para quem escreve àquela hora.
   */
  private async maybeSendAttendanceAutoMessages(
    organizationId: string,
    conversation: ConversationRuntime,
    isFirstMessage: boolean,
  ): Promise<void> {
    const settings = await loadAttendanceSettings(this.prisma, organizationId);
    const withinHours = isWithinBusinessHours(settings, new Date());
    const instanceMatches = (target: string | null) => !target || target === conversation.whatsappInstanceId;

    if (!withinHours && settings.outOfHours.enabled && instanceMatches(settings.outOfHours.whatsappInstanceId)) {
      const recent = await this.wasAutoMessageSentRecently(
        conversation.id,
        "automation-out-of-hours",
        settings.outOfHours.cooldownMinutes,
      );
      if (!recent) {
        const text = await this.resolveText(conversation, {}, settings.outOfHours.message);
        await this.sendAutomationMessage(conversation, text, "automation-out-of-hours");
      }
      return;
    }

    if (withinHours && settings.greeting.enabled && instanceMatches(settings.greeting.whatsappInstanceId)) {
      // `firstContactOnly` decide SE dispara; o cooldown (mínimo 5 minutos)
      // sempre se aplica por cima, como trava contra reentrega/corrida —
      // mandar a mesma saudação duas vezes é pior que não mandar.
      const shouldConsider = settings.greeting.firstContactOnly ? isFirstMessage : true;
      if (shouldConsider) {
        const cooldown = Math.max(settings.greeting.cooldownMinutes, 5);
        const recent = await this.wasAutoMessageSentRecently(conversation.id, "automation-greeting", cooldown);
        if (!recent) {
          const text = await this.resolveText(conversation, {}, settings.greeting.message);
          await this.sendAutomationMessage(conversation, text, "automation-greeting");
        }
      }
    }
  }

  /** A última mensagem NOSSA deste tipo, para as travas de saudação/fora-do-expediente. */
  private async wasAutoMessageSentRecently(
    conversationId: string,
    origem: "automation-greeting" | "automation-out-of-hours",
    cooldownMinutes: number,
  ): Promise<boolean> {
    const recent = await this.prisma.message.findFirst({
      where: { conversationId, direction: "outbound", metadata: { path: ["origem"], equals: origem } },
      orderBy: { timestamp: "desc" },
      select: { timestamp: true },
    });
    if (!recent) return false;
    return recent.timestamp.getTime() > Date.now() - cooldownMinutes * 60_000;
  }

  private async handleMessageForActiveExecution(
    execution: { id: string; flowVersionId: string; currentNodeId: string | null; status: string; waitingReason: string | null; context: Prisma.JsonValue },
    conversation: Conversation,
    content: string | null,
  ): Promise<void> {
    if (execution.status !== "waiting") return;
    if (execution.waitingReason === "reply") {
      await this.resumeFromReply(execution, conversation, content);
      return;
    }
    if (execution.waitingReason === "timer") {
      const flowVersion = await this.prisma.automationFlowVersion.findUnique({
        where: { id: execution.flowVersionId },
      });
      const graph = flowVersion?.graph as unknown as AutomationGraph | undefined;
      const node = graph?.nodes.find((item) => item.id === execution.currentNodeId);
      if (node?.type === "wait" && (node.data as unknown as WaitNodeData).resumeOnReply) {
        await this.resumeFromReply(execution, conversation, content);
      }
      // Senão, a mensagem só chega normalmente à Inbox — o timer segue no comando.
    }
  }

  private async hasActiveExecution(conversationId: string): Promise<boolean> {
    const active = await this.prisma.automationExecution.findFirst({
      where: { conversationId, status: { in: ["running", "waiting"] } },
      select: { id: true },
    });
    return active != null;
  }

  private async loadCandidateFlows(
    organizationId: string,
    whatsappInstanceId: string,
    triggerTypes: AutomationTriggerType[],
  ) {
    return this.prisma.automationFlow.findMany({
      where: {
        organizationId,
        status: "active",
        triggerType: { in: triggerTypes },
        OR: [{ whatsappInstanceId: null }, { whatsappInstanceId }],
      },
      orderBy: { priority: "asc" },
      include: { publishedVersion: true },
    });
  }

  private async isOnCooldown(flow: { id: string; cooldownMinutes: number }, conversationId: string): Promise<boolean> {
    if (flow.cooldownMinutes <= 0) return false;
    const last = await this.prisma.automationExecution.findFirst({
      where: { flowId: flow.id, conversationId },
      orderBy: { startedAt: "desc" },
      select: { startedAt: true },
    });
    if (!last) return false;
    return last.startedAt.getTime() > Date.now() - flow.cooldownMinutes * 60_000;
  }

  /* ------------------------------------------------------------------ *
   * Início e retomada de execução
   * ------------------------------------------------------------------ */

  private async startExecution(
    flow: {
      id: string;
      organizationId: string;
      publishedVersionId: string | null;
      publishedVersion: { id: string; graph: Prisma.JsonValue } | null;
    },
    conversation: ConversationRuntime,
    triggerType: AutomationTriggerType,
    seed: RuntimeExtra,
  ): Promise<void> {
    if (!flow.publishedVersionId || !flow.publishedVersion) return;
    let execution;
    try {
      execution = await this.prisma.automationExecution.create({
        data: {
          organizationId: flow.organizationId,
          flowId: flow.id,
          flowVersionId: flow.publishedVersionId,
          conversationId: conversation.id,
          whatsappInstanceId: conversation.whatsappInstanceId,
          status: "running",
          triggerType,
          context: {},
        },
      });
    } catch (err) {
      // Índice único parcial (só uma execução ativa por conversa): outra
      // chamada venceu a corrida entre duas mensagens quase simultâneas.
      // Não é erro — só não inicia um segundo fluxo por cima do primeiro.
      if (isUniqueViolation(err)) return;
      throw err;
    }
    await this.log(execution.id, "info", "automation_execution_started", {
      data: { flowId: flow.id, triggerType },
    });
    const graph = flow.publishedVersion.graph as unknown as AutomationGraph;
    const trigger = graph.nodes.find((node) => node.type === "trigger");
    await this.advanceFrom(execution, conversation, graph, trigger?.id ?? null, {}, seed);
  }

  private async resumeFromReply(
    execution: { id: string; flowVersionId: string; currentNodeId: string | null; context: Prisma.JsonValue },
    conversation: ConversationRuntime,
    content: string | null,
  ): Promise<void> {
    const flowVersion = await this.prisma.automationFlowVersion.findUnique({
      where: { id: execution.flowVersionId },
    });
    if (!flowVersion) {
      await this.failExecution(execution.id, "A versão publicada deste fluxo não existe mais.");
      return;
    }
    const graph = flowVersion.graph as unknown as AutomationGraph;
    const node = graph.nodes.find((item) => item.id === execution.currentNodeId);
    if (!node) {
      await this.failExecution(execution.id, "O bloco onde a execução estava parada não existe mais.");
      return;
    }
    const contextData = ((execution.context as AutomationExecutionContextData) ?? {}) as AutomationExecutionContextData;
    const text = (content ?? "").trim();

    if (node.type === "menu") {
      const data = node.data as unknown as MenuNodeData;
      const option = matchMenuOption(data.options ?? [], text);
      if (!option) {
        await this.log(execution.id, "info", "automation_menu_no_match", { nodeId: node.id });
        await this.sendAutomationMessage(conversation, `Não entendi. ${data.question}`);
        return;
      }
      const edge = pickNextEdge(graph, node.id, option.id);
      if (!edge) {
        await this.failExecution(execution.id, `A opção "${option.label}" do menu não está conectada a nada.`);
        return;
      }
      await this.advanceFrom(execution, conversation, graph, edge.target, contextData, {
        latestMessageContent: content,
      });
      return;
    }

    if (node.type === "ask_question") {
      const data = node.data as unknown as AskQuestionNodeData;
      const validated = validateAnswer(data.answerType, data.options, text);
      if (!validated.ok) {
        await this.log(execution.id, "info", "automation_answer_invalid", { nodeId: node.id });
        await this.sendAutomationMessage(conversation, `${invalidAnswerMessage(data.answerType)}\n\n${data.question}`);
        return;
      }
      contextData.answers = { ...(contextData.answers ?? {}), [data.saveKey]: validated.value };
      const edge = pickNextEdge(graph, node.id);
      if (!edge) {
        await this.completeExecution(execution.id, contextData, null);
        return;
      }
      await this.advanceFrom(execution, conversation, graph, edge.target, contextData, {
        latestMessageContent: content,
      });
      return;
    }

    if (node.type === "wait") {
      // "Aguardar" configurado para ser interrompido por resposta do cliente.
      const edge = pickNextEdge(graph, node.id, "reply");
      if (!edge) {
        await this.failExecution(execution.id, 'A saída "Cliente respondeu" do bloco Aguardar não está conectada.');
        return;
      }
      await this.advanceFrom(execution, conversation, graph, edge.target, contextData, {
        latestMessageContent: content,
      });
      return;
    }

    await this.failExecution(execution.id, `Bloco em espera de tipo inesperado: ${node.type}`);
  }

  /* ------------------------------------------------------------------ *
   * O laço de execução
   * ------------------------------------------------------------------ */

  private async advanceFrom(
    execution: { id: string; organizationId?: string },
    conversation: ConversationRuntime,
    graph: AutomationGraph,
    startNodeId: string | null,
    contextData: AutomationExecutionContextData,
    runtimeExtra: RuntimeExtra,
  ): Promise<void> {
    let currentId = startNodeId;
    let steps = 0;
    while (currentId) {
      steps += 1;
      if (steps > MAX_STEPS_PER_ADVANCE) {
        await this.failExecution(
          execution.id,
          "O fluxo excedeu o limite de passos numa única mensagem (possível laço entre blocos).",
          contextData,
        );
        return;
      }
      const node = graph.nodes.find((item) => item.id === currentId);
      if (!node) {
        await this.failExecution(execution.id, `O bloco "${currentId}" não existe mais no fluxo.`, contextData);
        return;
      }

      let result: NodeStepResult;
      try {
        result = await this.runNode(node, { execution, conversation, graph, contextData, runtimeExtra });
      } catch (err) {
        await this.failExecution(execution.id, `Falha ao executar "${node.type}": ${String(err)}`, contextData);
        return;
      }

      if (result.type === "wait") {
        await this.persistWaiting(execution.id, node.id, result.reason, result.until, contextData);
        return;
      }
      if (result.type === "finish") {
        await this.completeExecution(execution.id, contextData, result.summary);
        return;
      }
      if (result.type === "failed") {
        await this.failExecution(execution.id, result.error, contextData);
        return;
      }

      const edge = pickNextEdge(graph, node.id, result.handle);
      if (!edge) {
        // Nó não terminal sem saída conectada: a validação na publicação já
        // deveria ter barrado isso, mas o motor não confia cegamente nela —
        // termina como concluído em vez de travar a execução para sempre.
        await this.completeExecution(execution.id, contextData, null);
        return;
      }
      currentId = edge.target;
    }
  }

  private async runNode(
    node: AutomationNode,
    ctx: {
      execution: { id: string };
      conversation: ConversationRuntime;
      graph: AutomationGraph;
      contextData: AutomationExecutionContextData;
      runtimeExtra: RuntimeExtra;
    },
  ): Promise<NodeStepResult> {
    const { conversation, contextData, runtimeExtra, execution } = ctx;

    switch (node.type) {
      case "trigger":
        return { type: "continue" };

      case "send_message": {
        const data = node.data as unknown as SendMessageNodeData;
        if (data.messageType !== "text") {
          await this.log(execution.id, "warn", "automation_media_not_supported", {
            nodeId: node.id,
            data: { messageType: data.messageType },
          });
          return { type: "continue" };
        }
        const text = await this.resolveText(conversation, contextData, data.text ?? "");
        if (text.trim()) await this.sendAutomationMessage(conversation, text);
        return { type: "continue" };
      }

      case "ask_question": {
        const data = node.data as unknown as AskQuestionNodeData;
        const text = await this.resolveText(conversation, contextData, data.question);
        await this.sendAutomationMessage(conversation, text);
        const until = data.timeoutMinutes ? new Date(Date.now() + data.timeoutMinutes * 60_000) : null;
        return { type: "wait", reason: "reply", until };
      }

      case "menu": {
        const data = node.data as unknown as MenuNodeData;
        const text = await this.resolveText(conversation, contextData, data.question);
        await this.sendAutomationMessage(conversation, text);
        return { type: "wait", reason: "reply", until: null };
      }

      case "condition": {
        const data = node.data as unknown as ConditionNodeData;
        const clauses = data.clauses ?? [];
        if (clauses.length === 0) return { type: "continue", handle: "true" };
        const results = await Promise.all(
          clauses.map((clause) => this.evaluateClause(clause, conversation, contextData, runtimeExtra)),
        );
        const value = data.combinator === "or" ? results.some(Boolean) : results.every(Boolean);
        return { type: "continue", handle: value ? "true" : "false" };
      }

      case "wait": {
        const data = node.data as unknown as WaitNodeData;
        if (data.mode === "until_next_business_hours") {
          const settings = await loadAttendanceSettings(this.prisma, conversation.organizationId);
          const start = nextBusinessWindowStart(settings, new Date());
          if (!start) {
            await this.log(execution.id, "warn", "automation_wait_no_business_window", { nodeId: node.id });
            return { type: "continue", handle: "timeout" };
          }
          return { type: "wait", reason: "timer", until: start };
        }
        const amount = data.amount ?? 0;
        const unitMs = data.unit === "days" ? 86_400_000 : data.unit === "hours" ? 3_600_000 : 60_000;
        const until = new Date(Date.now() + Math.max(amount * unitMs, 1000));
        return { type: "wait", reason: "timer", until };
      }

      case "tag_add": {
        const data = node.data as unknown as TagNodeData;
        if (data.tagId) {
          await this.prisma.conversationTag.upsert({
            where: { conversationId_tagId: { conversationId: conversation.id, tagId: data.tagId } },
            update: {},
            create: { conversationId: conversation.id, tagId: data.tagId },
          });
          await emitConversationUpdated(this.prisma, this.io, conversation.id, conversation.organizationId);
        }
        return { type: "continue" };
      }

      case "tag_remove": {
        const data = node.data as unknown as TagNodeData;
        if (data.tagId) {
          await this.prisma.conversationTag.deleteMany({
            where: { conversationId: conversation.id, tagId: data.tagId },
          });
          await emitConversationUpdated(this.prisma, this.io, conversation.id, conversation.organizationId);
        }
        return { type: "continue" };
      }

      case "change_status": {
        const data = node.data as unknown as ChangeStatusNodeData;
        if (data.status && data.status !== conversation.status) {
          const historyAction =
            data.status === "resolved" ? ("resolved" as const) : conversation.status === "resolved" ? ("reopened" as const) : null;
          await this.prisma.$transaction([
            this.prisma.conversation.update({ where: { id: conversation.id }, data: { status: data.status } }),
            ...(historyAction
              ? [
                  this.prisma.conversationAssignmentHistory.create({
                    data: { organizationId: conversation.organizationId, conversationId: conversation.id, action: historyAction },
                  }),
                ]
              : []),
          ]);
          conversation.status = data.status;
          await emitConversationUpdated(this.prisma, this.io, conversation.id, conversation.organizationId);
        }
        return { type: "continue" };
      }

      case "forward_department": {
        const data = node.data as unknown as ForwardDepartmentNodeData;
        if (data.departmentId) {
          const department = await this.prisma.department.findFirst({
            where: { id: data.departmentId, organizationId: conversation.organizationId },
          });
          if (department) {
            await this.prisma.$transaction([
              this.prisma.conversation.update({
                where: { id: conversation.id },
                data: { departmentId: data.departmentId, assignedUserId: null },
              }),
              this.prisma.conversationAssignmentHistory.create({
                data: {
                  organizationId: conversation.organizationId,
                  conversationId: conversation.id,
                  action: "transferred_department",
                  fromDepartmentId: conversation.departmentId,
                  toDepartmentId: data.departmentId,
                  fromUserId: conversation.assignedUserId,
                },
              }),
            ]);
            conversation.departmentId = data.departmentId;
            conversation.assignedUserId = null;
            await emitConversationUpdated(this.prisma, this.io, conversation.id, conversation.organizationId);
          } else {
            await this.log(execution.id, "warn", "automation_department_missing", { nodeId: node.id });
          }
        }
        return { type: "continue" };
      }

      case "assign_user": {
        const data = node.data as unknown as AssignUserNodeData;
        if (data.userId) {
          const eligible = await this.prisma.user.findFirst({
            where: { id: data.userId, ...conversationAssigneeWhere(conversation.organizationId, conversation) },
          });
          if (eligible) {
            const isTransfer = conversation.assignedUserId != null && conversation.assignedUserId !== data.userId;
            await this.prisma.$transaction([
              this.prisma.conversation.update({ where: { id: conversation.id }, data: assignToUserData(data.userId) }),
              this.prisma.conversationAssignmentHistory.create({
                data: {
                  organizationId: conversation.organizationId,
                  conversationId: conversation.id,
                  action: isTransfer ? "transferred_user" : "assigned",
                  fromUserId: conversation.assignedUserId,
                  toUserId: data.userId,
                },
              }),
            ]);
            conversation.assignedUserId = data.userId;
            conversation.assignedToAll = false;
            await emitConversationUpdated(this.prisma, this.io, conversation.id, conversation.organizationId);
          } else {
            await this.log(execution.id, "warn", "automation_assignee_ineligible", { nodeId: node.id });
          }
        }
        return { type: "continue" };
      }

      case "unassign": {
        if (conversation.assignedUserId || conversation.assignedToAll) {
          await this.prisma.$transaction([
            this.prisma.conversation.update({ where: { id: conversation.id }, data: clearAssignmentData() }),
            this.prisma.conversationAssignmentHistory.create({
              data: {
                organizationId: conversation.organizationId,
                conversationId: conversation.id,
                action: conversation.assignedToAll ? "unassigned_from_all" : "unassigned",
                fromUserId: conversation.assignedUserId,
              },
            }),
          ]);
          conversation.assignedUserId = null;
          conversation.assignedToAll = false;
          await emitConversationUpdated(this.prisma, this.io, conversation.id, conversation.organizationId);
        }
        return { type: "continue" };
      }

      case "webhook": {
        const data = node.data as unknown as WebhookNodeData;
        if (data.url) {
          try {
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 5000);
            await fetch(data.url, {
              method: "POST",
              headers: { "content-type": "application/json", ...(data.headers ?? {}) },
              body: JSON.stringify({
                executionId: execution.id,
                conversationId: conversation.id,
                answers: contextData.answers ?? {},
              }),
              signal: controller.signal,
            }).finally(() => clearTimeout(timeout));
          } catch (err) {
            await this.log(execution.id, "warn", "automation_webhook_failed", {
              nodeId: node.id,
              message: String(err),
            });
          }
        }
        return { type: "continue" };
      }

      case "finish": {
        const data = node.data as unknown as FinishNodeData;
        let protocol: string | null = null;
        if (data.generateProtocol) {
          protocol = generateProtocol();
          contextData.protocol = protocol;
        }
        if (data.message) {
          const text = await this.resolveText(conversation, contextData, data.message);
          await this.sendAutomationMessage(conversation, text);
        }
        if (data.addTagId) {
          await this.prisma.conversationTag.upsert({
            where: { conversationId_tagId: { conversationId: conversation.id, tagId: data.addTagId } },
            update: {},
            create: { conversationId: conversation.id, tagId: data.addTagId },
          });
        }
        if (data.resolveConversation && conversation.status !== "resolved") {
          await this.prisma.$transaction([
            this.prisma.conversation.update({ where: { id: conversation.id }, data: { status: "resolved" } }),
            this.prisma.conversationAssignmentHistory.create({
              data: { organizationId: conversation.organizationId, conversationId: conversation.id, action: "resolved" },
            }),
          ]);
          conversation.status = "resolved";
        }
        await emitConversationUpdated(this.prisma, this.io, conversation.id, conversation.organizationId);
        return { type: "finish", summary: protocol ? `Concluído — protocolo ${protocol}` : "Concluído" };
      }

      default:
        return { type: "failed", error: `Tipo de bloco desconhecido: ${node.type}` };
    }
  }

  private async resolveText(
    conversation: ConversationRuntime,
    contextData: AutomationExecutionContextData,
    template: string,
  ): Promise<string> {
    const variableContext = await buildAutomationVariableContext(
      this.prisma,
      conversation.organizationId,
      conversation,
      contextData,
    );
    return resolveAutomationTemplate(template, variableContext).text;
  }

  private async evaluateClause(
    clause: AutomationConditionClause,
    conversation: ConversationRuntime,
    contextData: AutomationExecutionContextData,
    runtimeExtra: RuntimeExtra,
  ): Promise<boolean> {
    switch (clause.field) {
      case "business_hours": {
        const settings = await loadAttendanceSettings(this.prisma, conversation.organizationId);
        return String(isWithinBusinessHours(settings, new Date())) === clause.value;
      }
      case "weekday": {
        const settings = await loadAttendanceSettings(this.prisma, conversation.organizationId);
        const weekday = new Intl.DateTimeFormat("en-US", { timeZone: settings.timezone, weekday: "short" }).format(
          new Date(),
        );
        const WEEKDAY_INDEX: Record<string, string> = { Sun: "0", Mon: "1", Tue: "2", Wed: "3", Thu: "4", Fri: "5", Sat: "6" };
        return WEEKDAY_INDEX[weekday] === clause.value;
      }
      case "conversation_status":
        return conversation.status === clause.value;
      case "has_tag": {
        const exists = await this.prisma.conversationTag.findFirst({
          where: { conversationId: conversation.id, tagId: clause.value },
          select: { tagId: true },
        });
        return exists != null;
      }
      case "not_has_tag": {
        const exists = await this.prisma.conversationTag.findFirst({
          where: { conversationId: conversation.id, tagId: clause.value },
          select: { tagId: true },
        });
        return exists == null;
      }
      case "department":
        return conversation.departmentId === clause.value;
      case "has_assignee":
        return String(conversation.assignedUserId != null) === clause.value;
      case "message_contains":
        return (runtimeExtra.latestMessageContent ?? "").toLowerCase().includes(clause.value.toLowerCase());
      case "message_equals":
        return (runtimeExtra.latestMessageContent ?? "").trim().toLowerCase() === clause.value.trim().toLowerCase();
      case "field_equals": {
        const key = clause.key ?? "";
        return (contextData.answers?.[key] ?? "").toLowerCase() === clause.value.toLowerCase();
      }
      default:
        return false;
    }
  }

  /* ------------------------------------------------------------------ *
   * Envio de mensagem, persistência de estado e tempo real
   * ------------------------------------------------------------------ */

  private async sendAutomationMessage(
    conversation: ConversationRuntime,
    text: string,
    origem: string = "automation",
  ): Promise<void> {
    const result = await this.provider.sendText(conversation.whatsappInstanceId, conversation.externalChatId, text);
    const preview = buildPreview({ type: "text", content: text });
    const message = await this.prisma.message.create({
      data: {
        organizationId: conversation.organizationId,
        conversationId: conversation.id,
        externalMessageId: result.externalMessageId,
        direction: "outbound",
        type: "text",
        content: text,
        senderName: "Automação",
        timestamp: result.timestamp,
        status: "sent",
        metadata: { origem },
      },
    });
    await this.prisma.conversation.update({
      where: { id: conversation.id },
      data: { lastMessageAt: result.timestamp, lastMessagePreview: preview },
    });
    await this.emitOutboundMessage(conversation.id, conversation.organizationId, message.id);
  }

  /** Mesmo par de eventos do envio manual (`afterOutboundPersist`), reaproveitado — sem evento novo. */
  private async emitOutboundMessage(conversationId: string, organizationId: string, messageId: string): Promise<void> {
    const [conversation, message] = await Promise.all([
      this.prisma.conversation.findUnique({ where: { id: conversationId }, include: conversationInclude }),
      this.prisma.message.findUnique({ where: { id: messageId } }),
    ]);
    if (!conversation || !message) return;
    const personName = await resolveConversationPersonName(this.prisma, organizationId, conversation);
    const room = conversationAudience(organizationId, conversation);
    this.io.to(room).emit(RealtimeEvents.MessageNew, {
      conversation: serializeConversation(conversation, personName),
      message: serializeMessage(message),
    });
    this.io.to(room).emit(RealtimeEvents.ConversationUpdated, serializeConversation(conversation, personName));
  }

  private async persistWaiting(
    executionId: string,
    nodeId: string,
    reason: "reply" | "timer",
    until: Date | null,
    contextData: AutomationExecutionContextData,
  ): Promise<void> {
    await this.prisma.automationExecution.update({
      where: { id: executionId },
      data: {
        status: "waiting",
        currentNodeId: nodeId,
        waitingReason: reason,
        waitingUntil: until,
        context: contextData as unknown as Prisma.InputJsonValue,
      },
    });
  }

  private async completeExecution(
    executionId: string,
    contextData: AutomationExecutionContextData,
    summary: string | null,
  ): Promise<void> {
    await this.prisma.automationExecution.update({
      where: { id: executionId },
      data: {
        status: "completed",
        context: contextData as unknown as Prisma.InputJsonValue,
        resultSummary: summary,
        finishedAt: new Date(),
        waitingReason: null,
        waitingUntil: null,
      },
    });
    await this.log(executionId, "info", "automation_execution_completed", summary ? { message: summary } : undefined);
  }

  private async failExecution(
    executionId: string,
    error: string,
    contextData?: AutomationExecutionContextData,
  ): Promise<void> {
    await this.prisma.automationExecution.update({
      where: { id: executionId },
      data: {
        status: "failed",
        error,
        finishedAt: new Date(),
        waitingReason: null,
        waitingUntil: null,
        ...(contextData ? { context: contextData as unknown as Prisma.InputJsonValue } : {}),
      },
    });
    await this.log(executionId, "error", "automation_execution_failed", { message: error });
  }

  private async log(
    executionId: string,
    level: "info" | "warn" | "error",
    event: string,
    opts?: { nodeId?: string; nodeType?: string; message?: string; data?: Record<string, unknown> },
  ): Promise<void> {
    try {
      await this.prisma.automationExecutionLog.create({
        data: {
          executionId,
          level,
          event,
          nodeId: opts?.nodeId ?? null,
          nodeType: opts?.nodeType ?? null,
          message: opts?.message ?? null,
          ...(opts?.data ? { data: opts.data as Prisma.InputJsonValue } : {}),
        },
      });
    } catch (err) {
      this.logger.warn({ event: "automation_log_write_failed", error: String(err) });
    }
  }

  /* ------------------------------------------------------------------ *
   * Worker: retomadas de timer e o gatilho "sem resposta"
   * ------------------------------------------------------------------ */

  private async resumeDueWaits(): Promise<void> {
    const due = await this.prisma.automationExecution.findMany({
      where: { status: "waiting", waitingReason: "timer", waitingUntil: { lte: new Date() } },
      take: 50,
    });
    for (const execution of due) {
      await this.resumeTimerExecution(execution);
    }
  }

  private async resumeTimerExecution(execution: {
    id: string;
    conversationId: string;
    flowVersionId: string;
    currentNodeId: string | null;
    context: Prisma.JsonValue;
  }): Promise<void> {
    try {
      const conversation = await this.prisma.conversation.findUnique({ where: { id: execution.conversationId } });
      if (!conversation) {
        await this.failExecution(execution.id, "A conversa não existe mais.");
        return;
      }
      const flowVersion = await this.prisma.automationFlowVersion.findUnique({
        where: { id: execution.flowVersionId },
      });
      if (!flowVersion) {
        await this.failExecution(execution.id, "A versão publicada deste fluxo não existe mais.");
        return;
      }
      const graph = flowVersion.graph as unknown as AutomationGraph;
      const contextData = ((execution.context as AutomationExecutionContextData) ?? {}) as AutomationExecutionContextData;
      const edge = pickNextEdge(graph, execution.currentNodeId ?? "", "timeout") ?? pickNextEdge(graph, execution.currentNodeId ?? "");
      if (!edge) {
        await this.completeExecution(execution.id, contextData, null);
        return;
      }
      await this.advanceFrom(execution, conversation, graph, edge.target, contextData, {});
    } catch (err) {
      await this.failExecution(execution.id, `Falha ao retomar espera: ${String(err)}`);
    }
  }

  private async scanNoReplyTimeouts(): Promise<void> {
    const flows = await this.prisma.automationFlow.findMany({
      where: { status: "active", triggerType: "no_reply_timeout" },
      include: { publishedVersion: true },
    });
    for (const flow of flows) {
      const minutes = readMinutes(flow.triggerConfig);
      if (!minutes || !flow.publishedVersionId || !flow.publishedVersion) continue;
      const threshold = new Date(Date.now() - minutes * 60_000);
      const conversations = await this.prisma.conversation.findMany({
        where: {
          organizationId: flow.organizationId,
          archivedAt: null,
          status: { not: "resolved" },
          ...(flow.whatsappInstanceId ? { whatsappInstanceId: flow.whatsappInstanceId } : {}),
          lastMessageAt: { lte: threshold },
          automationExecutions: { none: { status: { in: ["running", "waiting"] } } },
        },
        take: 100,
      });
      for (const conversation of conversations) {
        // A última mensagem precisa ser NOSSA — se foi o cliente quem
        // escreveu por último, ele já respondeu e o gatilho não se aplica.
        const last = await this.prisma.message.findFirst({
          where: { conversationId: conversation.id, deletedAt: null },
          orderBy: { timestamp: "desc" },
          select: { direction: true },
        });
        if (!last || last.direction !== "outbound") continue;
        if (await this.isOnCooldown(flow, conversation.id)) continue;
        await this.startExecution(flow, conversation, "no_reply_timeout", {});
      }
    }
  }
}

export type { AutomationExecutionStatus };

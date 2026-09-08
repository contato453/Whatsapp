import type {
  Conversation,
  FollowUpExecution,
  FollowUpLogEventType,
  FollowUpRule,
  FollowUpRuleDepartment,
  FollowUpRuleStep,
  Prisma,
  PrismaClient,
} from "@azvchat/database";
import {
  RealtimeEvents,
  followUpWaitMs,
  resolveQuickReplyTemplate,
  type FollowUpUpdatedPayload,
} from "@azvchat/shared";
import type { Server } from "socket.io";
import type { Logger } from "pino";
import type { WhatsAppProvider } from "@azvchat/whatsapp";
import type { AzevedoOsClient } from "../services/azevedo-os-client.js";
import { canApplyToConversation } from "./department-resource.js";
import { loadAttendanceSettings } from "./attendance-settings.js";
import { nextBusinessMoment } from "./business-schedule.js";
import { buildPreview } from "../services/message-ingest.js";
import { conversationAudience } from "../realtime/socket.js";
import { serializeConversation, serializeMessage } from "./serialize.js";

/**
 * O motor do Follow-up Automático: decide QUAL regra vale para uma
 * conversa, mantém no máximo UMA execução (o "timer" do pedido) rodando
 * por conversa e revalida tudo antes de agir — nunca dispara às cegas.
 *
 * É chamado de dois lugares bem diferentes, de propósito:
 *  - pelas ROTAS http (status, resolver, reabrir, transferir departamento,
 *    arquivar, mandar mensagem) via `reconcileConversation` /
 *    `handleInboundMessage` / `handleOutboundMessage`;
 *  - pelo WORKER (`services/follow-up-scheduler.ts`), que só chama
 *    `processDueExecutions`.
 *
 * As duas pontas share a MESMA leitura de "a regra ainda vale aqui?" —
 * `ruleAppliesToConversation` —, senão a régua que inicia numa rota e a
 * que revalida no worker divergiriam na primeira mudança de departamento.
 */

/**
 * O que basta para decidir e mexer no ESTADO da execução (iniciar,
 * cancelar, pausar, retomar, adiar, reavaliar). Nenhuma destas ações manda
 * mensagem nem fala com o WhatsApp — por isso não pedem `provider` nem
 * `azevedoOs`, e podem ser chamadas de lugares que não têm as duas coisas
 * à mão (o worker de mensagem agendada, por exemplo).
 */
export type FollowUpCoreDeps = {
  prisma: PrismaClient;
  io: Server;
  logger: Logger;
};

/** O que RODAR uma etapa pede a mais: falar com o WhatsApp e resolver variáveis de empresa. */
export type FollowUpDeps = FollowUpCoreDeps & {
  provider: WhatsAppProvider;
  azevedoOs: AzevedoOsClient;
};

type RuleWithRelations = FollowUpRule & {
  departments: FollowUpRuleDepartment[];
  steps: FollowUpRuleStep[];
};

const RULE_WITH_RELATIONS_INCLUDE = {
  departments: true,
  steps: { orderBy: { order: "asc" as const } },
} satisfies Prisma.FollowUpRuleInclude;

type ConversationForEngine = Pick<
  Conversation,
  | "id"
  | "organizationId"
  | "whatsappInstanceId"
  | "externalChatId"
  | "departmentId"
  | "status"
  | "archivedAt"
  | "externalReference"
  | "externalSource"
  | "customTitle"
  | "title"
>;

/**
 * A regra ainda serve para esta conversa? As mesmas duas condições de
 * `department-resource.ts` (geral, ou departamento em comum — conversa sem
 * departamento aceita qualquer regra visível, mesma regra da etiqueta e da
 * resposta rápida) MAIS o filtro de número, que é exclusivo do follow-up.
 */
export function ruleAppliesToConversation(
  rule: Pick<FollowUpRule, "isGeneral" | "whatsappInstanceId" | "status">,
  departments: Array<{ departmentId: string }>,
  conversation: Pick<ConversationForEngine, "departmentId" | "whatsappInstanceId">,
): boolean {
  if (rule.status !== "active") return false;
  if (rule.whatsappInstanceId && rule.whatsappInstanceId !== conversation.whatsappInstanceId) {
    return false;
  }
  return canApplyToConversation({ isGeneral: rule.isGeneral, departments }, conversation.departmentId);
}

/**
 * Qual regra vale para esta conversa AGORA, entre as ativas da organização.
 *
 * Prioridade (seção 18 do pedido, adaptada à arquitetura real do AZVCHAT —
 * "fila" não existe como entidade aqui, então esse degrau não existe):
 *   1) regra restrita a departamento(s) que inclui o da conversa;
 *   2) regra geral (`isGeneral`).
 * Empate dentro do mesmo degrau: regra com filtro de NÚMERO explícito
 * (mais específica) vence a sem filtro; sobrando empate, a mais
 * recentemente atualizada.
 */
export async function pickApplicableRule(
  prisma: PrismaClient,
  organizationId: string,
  conversation: Pick<ConversationForEngine, "departmentId" | "whatsappInstanceId">,
): Promise<RuleWithRelations | null> {
  const candidates = await prisma.followUpRule.findMany({
    where: { organizationId, status: "active" },
    include: RULE_WITH_RELATIONS_INCLUDE,
  });
  const applicable = candidates.filter((rule) =>
    ruleAppliesToConversation(rule, rule.departments, conversation),
  );
  if (applicable.length === 0) return null;
  applicable.sort((a, b) => {
    if (a.isGeneral !== b.isGeneral) return a.isGeneral ? 1 : -1;
    const aSpecific = a.whatsappInstanceId ? 1 : 0;
    const bSpecific = b.whatsappInstanceId ? 1 : 0;
    if (aSpecific !== bSpecific) return bSpecific - aSpecific;
    return b.updatedAt.getTime() - a.updatedAt.getTime();
  });
  return applicable[0] ?? null;
}

/** Etapa 1 vale como "1 de N" na tela; devolve `null` para regra sem etapa nenhuma. */
function firstStep(rule: RuleWithRelations): FollowUpRuleStep | null {
  return rule.steps[0] ?? null;
}

function stepAt(rule: RuleWithRelations, order: number): FollowUpRuleStep | null {
  return rule.steps.find((step) => step.order === order) ?? null;
}

/** Quando a etapa deve rodar, respeitando o expediente se a regra pedir. */
async function computeNextRunAt(
  prisma: PrismaClient,
  organizationId: string,
  rule: Pick<FollowUpRule, "respectBusinessHours">,
  step: Pick<FollowUpRuleStep, "waitAmount" | "waitUnit">,
  from: Date,
): Promise<Date> {
  const raw = new Date(from.getTime() + followUpWaitMs(step.waitAmount, step.waitUnit));
  if (!rule.respectBusinessHours) return raw;
  const settings = await loadAttendanceSettings(prisma, organizationId);
  const adjusted = nextBusinessMoment(raw, settings);
  // Semana inteira desligada (nenhum dia útil): não há como respeitar
  // expediente algum — a etapa segue no horário cru em vez de nunca sair.
  return adjusted ?? raw;
}

async function log(
  prisma: PrismaClient,
  executionId: string,
  eventType: FollowUpLogEventType,
  extra?: { stepOrder?: number; actorUserId?: string | null; messageId?: string; detail?: string },
): Promise<void> {
  await prisma.followUpExecutionLog.create({
    data: {
      executionId,
      eventType,
      stepOrder: extra?.stepOrder,
      actorUserId: extra?.actorUserId ?? null,
      messageId: extra?.messageId,
      detail: extra?.detail,
    },
  });
}

/** Estado publicado na conversa (faixa discreta do chat — seção 26 do pedido). */
async function emitFollowUpUpdated(
  deps: Pick<FollowUpDeps, "prisma" | "io">,
  conversationId: string,
): Promise<void> {
  const conversation = await deps.prisma.conversation.findUnique({
    where: { id: conversationId },
    select: { id: true, organizationId: true, whatsappInstanceId: true, departmentId: true, assignedUserId: true },
  });
  if (!conversation) return;
  const execution = await deps.prisma.followUpExecution.findFirst({
    where: { conversationId, status: { in: ["active", "paused"] } },
    include: { rule: true, conversation: { include: { department: true } } },
  });
  const payload: FollowUpUpdatedPayload = {
    conversationId,
    execution: execution
      ? {
          id: execution.id,
          ruleId: execution.ruleId,
          ruleName: execution.rule.name,
          status: execution.status as "active" | "paused",
          currentStepOrder: execution.currentStepOrder,
          totalSteps: await deps.prisma.followUpRuleStep.count({ where: { ruleId: execution.ruleId } }),
          nextRunAt: execution.nextRunAt ? execution.nextRunAt.toISOString() : null,
          departmentId: execution.conversation.departmentId,
          departmentName: execution.conversation.department?.name ?? null,
        }
      : null,
  };
  const room = conversationAudience(conversation.organizationId, conversation);
  deps.io.to(room).emit(RealtimeEvents.FollowUpUpdated, payload);
}

/** A execução ATIVA ou PAUSADA da conversa, se houver — para a tela e para as ações do atendente. */
export async function getActiveExecution(
  prisma: PrismaClient,
  conversationId: string,
): Promise<(FollowUpExecution & { rule: FollowUpRule }) | null> {
  return prisma.followUpExecution.findFirst({
    where: { conversationId, status: { in: ["active", "paused"] } },
    include: { rule: true },
  });
}

/**
 * Inicia uma execução nova para a conversa, na primeira etapa da regra.
 * Regra sem etapa nenhuma não inicia (não há o que rodar) — a tela impede
 * salvar uma regra vazia, mas o worker não confia nisso e revalida aqui.
 *
 * Idempotente por construção: o índice parcial do banco
 * (`follow_up_executions_one_active_per_conversation`) garante que só uma
 * ativa/pausada exista por conversa; uma corrida que perder a criação (dois
 * gatilhos quase juntos) recebe `P2002` e só reaproveita o que já existe —
 * mesmo padrão de corrida que `message-ingest.ts` já trata.
 */
export async function startExecution(
  deps: FollowUpCoreDeps,
  conversation: ConversationForEngine,
  rule: RuleWithRelations,
): Promise<void> {
  const step = firstStep(rule);
  if (!step) return;
  const nextRunAt = await computeNextRunAt(deps.prisma, conversation.organizationId, rule, step, new Date());
  try {
    const execution = await deps.prisma.followUpExecution.create({
      data: {
        organizationId: conversation.organizationId,
        ruleId: rule.id,
        conversationId: conversation.id,
        status: "active",
        currentStepOrder: step.order,
        nextRunAt,
      },
    });
    await log(deps.prisma, execution.id, "started", { stepOrder: step.order });
  } catch (err) {
    // P2002 = já existe ativa/pausada (corrida entre dois gatilhos quase
    // simultâneos, ex.: sync de status + mensagem chegando juntos).
    if (!(err instanceof Object && "code" in err && (err as { code?: string }).code === "P2002")) {
      throw err;
    }
    deps.logger.warn({
      event: "follow_up_start_race",
      conversationId: conversation.id,
      ruleId: rule.id,
    });
  }
  await emitFollowUpUpdated(deps, conversation.id);
}

/** Cancela a execução ativa/pausada da conversa, se houver. Idempotente. */
export async function cancelExecution(
  deps: FollowUpCoreDeps,
  conversationId: string,
  options: { reason: string; actorUserId?: string | null },
): Promise<void> {
  const execution = await getActiveExecution(deps.prisma, conversationId);
  if (!execution) return;
  await deps.prisma.followUpExecution.update({
    where: { id: execution.id },
    data: { status: "canceled", finishedAt: new Date(), finishReason: options.reason, nextRunAt: null },
  });
  await log(deps.prisma, execution.id, "canceled", {
    actorUserId: options.actorUserId ?? null,
    detail: options.reason,
  });
  await emitFollowUpUpdated(deps, conversationId);
}

/**
 * Reavalia a conversa contra a régua: entra, sai, ou continua como está.
 * É o ÚNICO ponto que as rotas HTTP chamam depois de qualquer mudança que
 * possa afetar um follow-up — status, resolver, reabrir, arquivar,
 * transferir departamento. Nunca duplica execução: se já existe uma ativa
 * para a MESMA regra que continua valendo, não mexe nela.
 */
export async function reconcileConversation(
  deps: FollowUpCoreDeps,
  conversationId: string,
): Promise<void> {
  const conversation = await deps.prisma.conversation.findUnique({ where: { id: conversationId } });
  if (!conversation) return;

  const existing = await getActiveExecution(deps.prisma, conversationId);

  if (conversation.archivedAt) {
    if (existing) await cancelExecution(deps, conversationId, { reason: "conversation_archived" });
    return;
  }
  if (conversation.status === "resolved") {
    if (existing) await cancelExecution(deps, conversationId, { reason: "conversation_resolved" });
    return;
  }
  if (conversation.status !== "waiting_client") {
    if (existing) await cancelExecution(deps, conversationId, { reason: "canceled_status_change" });
    return;
  }

  const rule = await pickApplicableRule(deps.prisma, conversation.organizationId, conversation);
  if (!rule) {
    if (existing) await cancelExecution(deps, conversationId, { reason: "canceled_department_change" });
    return;
  }
  if (existing) {
    // Já rodando — só reinicia do zero se a regra aplicável MUDOU (ex.:
    // conversa foi transferida e a regra do departamento novo é outra).
    if (existing.ruleId === rule.id) return;
    await cancelExecution(deps, conversationId, { reason: "canceled_department_change" });
  }
  await startExecution(deps, conversation, rule);
}

/**
 * Cliente respondeu — cancela qualquer follow-up em andamento na conversa.
 * Chamado a partir da ingestão de mensagem RECEBIDA (seção 14 do pedido).
 */
export async function handleInboundMessage(deps: FollowUpCoreDeps, conversationId: string): Promise<void> {
  await cancelExecution(deps, conversationId, { reason: "client_replied" });
}

/**
 * Atendente mandou mensagem enquanto a conversa aguarda o cliente — reinicia
 * a contagem da etapa atual a partir de agora (seção 16 do pedido). Não
 * cria execução nova: só a existente pode ser reiniciada, porque só existe
 * timer para reiniciar quando já havia um rodando.
 */
export async function handleOutboundMessage(deps: FollowUpCoreDeps, conversationId: string): Promise<void> {
  const execution = await getActiveExecution(deps.prisma, conversationId);
  if (!execution || execution.status !== "active") return;
  const rule = await deps.prisma.followUpRule.findUnique({ where: { id: execution.ruleId } });
  const currentStep = await deps.prisma.followUpRuleStep.findFirst({
    where: { ruleId: execution.ruleId, order: execution.currentStepOrder },
  });
  if (!rule || !currentStep) return;
  const nextRunAt = await computeNextRunAt(deps.prisma, execution.organizationId, rule, currentStep, new Date());
  await deps.prisma.followUpExecution.update({ where: { id: execution.id }, data: { nextRunAt } });
  await log(deps.prisma, execution.id, "restarted", { stepOrder: execution.currentStepOrder });
  await emitFollowUpUpdated(deps, conversationId);
}

/** Pausa (com ou sem prazo — seção 29 do pedido). Nenhuma etapa roda enquanto pausada. */
export async function pauseExecution(
  deps: FollowUpCoreDeps,
  conversationId: string,
  options: { untilAt?: Date | null; actorUserId: string },
): Promise<void> {
  const execution = await getActiveExecution(deps.prisma, conversationId);
  if (!execution) return;
  await deps.prisma.followUpExecution.update({
    where: { id: execution.id },
    data: { status: "paused", pauseUntil: options.untilAt ?? null },
  });
  await log(deps.prisma, execution.id, "paused", {
    actorUserId: options.actorUserId,
    detail: options.untilAt ? `até ${options.untilAt.toISOString()}` : "sem prazo",
  });
  await emitFollowUpUpdated(deps, conversationId);
}

/** Retoma manualmente. A hora da próxima etapa não muda: se já venceu, roda no próximo tick. */
export async function resumeExecution(
  deps: FollowUpCoreDeps,
  conversationId: string,
  options: { actorUserId: string | null },
): Promise<void> {
  const execution = await deps.prisma.followUpExecution.findFirst({
    where: { conversationId, status: "paused" },
  });
  if (!execution) return;
  await deps.prisma.followUpExecution.update({
    where: { id: execution.id },
    data: { status: "active", pauseUntil: null },
  });
  await log(deps.prisma, execution.id, "resumed", { actorUserId: options.actorUserId });
  await emitFollowUpUpdated(deps, conversationId);
}

/** Adia a próxima ação para um instante específico (seção 28 do pedido). */
export async function postponeExecution(
  deps: FollowUpCoreDeps,
  conversationId: string,
  options: { until: Date; actorUserId: string },
): Promise<void> {
  const execution = await deps.prisma.followUpExecution.findFirst({
    where: { conversationId, status: "active" },
  });
  if (!execution) return;
  await deps.prisma.followUpExecution.update({
    where: { id: execution.id },
    data: { nextRunAt: options.until },
  });
  await log(deps.prisma, execution.id, "postponed", {
    actorUserId: options.actorUserId,
    detail: options.until.toISOString(),
  });
  await emitFollowUpUpdated(deps, conversationId);
}

/* ------------------------------------------------------------------ *
 * Execução das etapas — chamado só pelo worker (services/follow-up-scheduler.ts)
 * ------------------------------------------------------------------ */

interface StepOutcome {
  ok: boolean;
  messageId?: string;
  detail?: string;
}

async function resolveMessageTemplate(
  deps: FollowUpDeps,
  conversation: ConversationForEngine & { department?: { name: string } | null },
): Promise<(text: string) => Promise<string>> {
  let company: Awaited<ReturnType<AzevedoOsClient["getCompany"]>> | null = null;
  if (conversation.externalSource === "azevedo-os" && conversation.externalReference) {
    try {
      company = await deps.azevedoOs.getCompany(conversation.externalReference);
    } catch {
      // Integração fora do ar: variáveis de empresa ficam por preencher —
      // mesma degradação graciosa da resposta rápida, nunca derruba o envio.
      company = null;
    }
  }
  return async (text: string) => {
    const resolved = resolveQuickReplyTemplate(text, {
      company,
      conversation: {
        displayName: conversation.customTitle?.trim() || conversation.title.trim() || null,
        phone: null,
        departmentName: conversation.department?.name ?? null,
        assigneeName: null,
      },
      agent: null,
      now: new Date(),
    });
    return resolved.text;
  };
}

async function runStepAction(
  deps: FollowUpDeps,
  execution: FollowUpExecution,
  rule: RuleWithRelations,
  conversation: ConversationForEngine,
  step: FollowUpRuleStep,
): Promise<StepOutcome> {
  if (step.action === "send_message") {
    if (!step.messageContent) return { ok: false, detail: "Etapa sem texto de mensagem" };
    const conversationWithDept = await deps.prisma.conversation.findUnique({
      where: { id: conversation.id },
      include: { department: true },
    });
    if (!conversationWithDept) return { ok: false, detail: "Conversa não encontrada" };
    const resolveTemplate = await resolveMessageTemplate(deps, conversationWithDept);
    const text = await resolveTemplate(step.messageContent);
    const result = await deps.provider.sendText(
      conversation.whatsappInstanceId,
      conversation.externalChatId,
      text,
    );
    const message = await deps.prisma.message.create({
      data: {
        organizationId: conversation.organizationId,
        conversationId: conversation.id,
        externalMessageId: result.externalMessageId,
        direction: "outbound",
        type: "text",
        content: text,
        senderName: `Follow-up automático (${rule.name})`,
        timestamp: result.timestamp,
        status: "sent",
        metadata: { origem: "follow-up", ruleId: rule.id, executionId: execution.id, stepOrder: step.order },
      },
    });
    await deps.prisma.conversation.update({
      where: { id: conversation.id },
      data: { lastMessageAt: result.timestamp, lastMessagePreview: buildPreview({ type: "text", content: text }) },
    });
    const updated = await deps.prisma.conversation.findUnique({
      where: { id: conversation.id },
      include: { assignedUser: true, department: true, instance: true, tags: { include: { tag: true } } },
    });
    if (updated) {
      const room = conversationAudience(conversation.organizationId, updated);
      deps.io.to(room).emit(RealtimeEvents.MessageNew, {
        conversation: serializeConversation(updated, null),
        message: serializeMessage(message),
      });
      deps.io.to(room).emit(RealtimeEvents.ConversationUpdated, serializeConversation(updated, null));
    }
    return { ok: true, messageId: message.id };
  }

  if (step.action === "add_tag" || step.action === "remove_tag") {
    if (!step.tagId) return { ok: false, detail: "Etapa sem etiqueta definida" };
    const tag = await deps.prisma.tag.findFirst({
      where: { id: step.tagId, organizationId: conversation.organizationId },
    });
    if (!tag) return { ok: false, detail: "Etiqueta não existe mais" };
    if (step.action === "add_tag") {
      await deps.prisma.conversationTag.upsert({
        where: { conversationId_tagId: { conversationId: conversation.id, tagId: tag.id } },
        create: { conversationId: conversation.id, tagId: tag.id },
        update: {},
      });
    } else {
      await deps.prisma.conversationTag
        .delete({ where: { conversationId_tagId: { conversationId: conversation.id, tagId: tag.id } } })
        .catch(() => undefined);
    }
    await emitConversationUpdatedFor(deps, conversation.id);
    return { ok: true };
  }

  if (step.action === "change_status") {
    if (!step.newStatus) return { ok: false, detail: "Etapa sem status definido" };
    await deps.prisma.conversation.update({ where: { id: conversation.id }, data: { status: step.newStatus } });
    await emitConversationUpdatedFor(deps, conversation.id);
    return { ok: true };
  }

  return { ok: false, detail: `Ação desconhecida: ${step.action}` };
}

async function emitConversationUpdatedFor(deps: FollowUpCoreDeps, conversationId: string): Promise<void> {
  const conversation = await deps.prisma.conversation.findUnique({
    where: { id: conversationId },
    include: { assignedUser: true, department: true, instance: true, tags: { include: { tag: true } } },
  });
  if (!conversation) return;
  const room = conversationAudience(conversation.organizationId, conversation);
  deps.io.to(room).emit(RealtimeEvents.ConversationUpdated, serializeConversation(conversation, null));
}

/** Encerra o atendimento por inatividade (seções 13/31/41 do pedido). */
async function finalizeConversation(
  deps: FollowUpCoreDeps,
  execution: FollowUpExecution,
  rule: FollowUpRule,
  conversation: ConversationForEngine,
): Promise<void> {
  await deps.prisma.$transaction([
    deps.prisma.conversation.update({ where: { id: conversation.id }, data: { status: "resolved" } }),
    deps.prisma.conversationAssignmentHistory.create({
      data: {
        organizationId: conversation.organizationId,
        conversationId: conversation.id,
        action: "resolved",
        performedByUserId: null,
        note: `Encerrado automaticamente pelo follow-up "${rule.name}": ${rule.finalizeReason}`,
      },
    }),
    ...(rule.finalizeTagId
      ? [
          deps.prisma.conversationTag.upsert({
            where: { conversationId_tagId: { conversationId: conversation.id, tagId: rule.finalizeTagId } },
            create: { conversationId: conversation.id, tagId: rule.finalizeTagId },
            update: {},
          }),
        ]
      : []),
  ]);
  await emitConversationUpdatedFor(deps, conversation.id);
}

/**
 * Roda até `limit` execuções vencidas. Chamado pelo worker a cada volta —
 * TODA a revalidação da seção 15 do pedido acontece aqui, na frente de
 * cada etapa, e não só no início da régua.
 */
export async function processDueExecutions(deps: FollowUpDeps, limit: number): Promise<number> {
  const now = new Date();

  // Pausa COM PRAZO que já venceu volta a rodar sozinha (seção 29).
  const expiredPauses = await deps.prisma.followUpExecution.findMany({
    where: { status: "paused", pauseUntil: { lte: now } },
    select: { id: true, conversationId: true },
  });
  for (const paused of expiredPauses) {
    await deps.prisma.followUpExecution.update({
      where: { id: paused.id },
      data: { status: "active", pauseUntil: null },
    });
    await log(deps.prisma, paused.id, "resumed", { detail: "prazo da pausa venceu" });
    await emitFollowUpUpdated(deps, paused.conversationId);
  }

  const due = await deps.prisma.followUpExecution.findMany({
    where: { status: "active", nextRunAt: { lte: now } },
    orderBy: { nextRunAt: "asc" },
    take: limit,
  });

  for (const execution of due) {
    await processOne(deps, execution);
  }
  return due.length;
}

async function processOne(deps: FollowUpDeps, execution: FollowUpExecution): Promise<void> {
  const conversation = await deps.prisma.conversation.findUnique({ where: { id: execution.conversationId } });
  const rule = await deps.prisma.followUpRule.findUnique({
    where: { id: execution.ruleId },
    include: RULE_WITH_RELATIONS_INCLUDE,
  });

  // --- Revalidação (seção 15 do pedido): nada roda sem confirmar de novo. ---
  if (!conversation || conversation.archivedAt) {
    await cancelExecution(deps, execution.conversationId, { reason: "conversation_archived" });
    return;
  }
  if (conversation.status === "resolved") {
    await cancelExecution(deps, execution.conversationId, { reason: "conversation_resolved" });
    return;
  }
  if (conversation.status !== "waiting_client") {
    await cancelExecution(deps, execution.conversationId, { reason: "canceled_status_change" });
    return;
  }
  if (!rule || !ruleAppliesToConversation(rule, rule.departments, conversation)) {
    await cancelExecution(deps, execution.conversationId, {
      reason: rule ? "canceled_department_change" : "rule_deactivated",
    });
    return;
  }

  const step = stepAt(rule, execution.currentStepOrder);
  if (!step) {
    if (rule.finalizeOnComplete) {
      await finalizeConversation(deps, execution, rule, conversation);
    }
    await deps.prisma.followUpExecution.update({
      where: { id: execution.id },
      data: { status: "completed", finishedAt: new Date(), finishReason: "completed_no_reply", nextRunAt: null },
    });
    await log(deps.prisma, execution.id, "completed");
    await emitFollowUpUpdated(deps, execution.conversationId);
    return;
  }

  let outcome: StepOutcome;
  try {
    outcome = await runStepAction(deps, execution, rule, conversation, step);
  } catch (err) {
    outcome = { ok: false, detail: err instanceof Error ? err.message : String(err) };
  }

  if (!outcome.ok) {
    deps.logger.warn({
      event: "follow_up_step_failed",
      executionId: execution.id,
      ruleId: rule.id,
      stepOrder: step.order,
      detail: outcome.detail,
    });
  }
  await log(deps.prisma, execution.id, outcome.ok ? "step_executed" : "step_failed", {
    stepOrder: step.order,
    messageId: outcome.messageId,
    detail: outcome.detail,
  });

  const nextStep = stepAt(rule, step.order + 1);
  const messagesSentCount = execution.messagesSentCount + (outcome.ok && step.action === "send_message" ? 1 : 0);
  if (!nextStep) {
    if (rule.finalizeOnComplete) {
      await finalizeConversation(deps, execution, rule, conversation);
    }
    await deps.prisma.followUpExecution.update({
      where: { id: execution.id },
      data: {
        status: "completed",
        finishedAt: new Date(),
        finishReason: "completed_no_reply",
        nextRunAt: null,
        messagesSentCount,
      },
    });
    await log(deps.prisma, execution.id, "completed");
  } else {
    const nextRunAt = await computeNextRunAt(deps.prisma, execution.organizationId, rule, nextStep, new Date());
    await deps.prisma.followUpExecution.update({
      where: { id: execution.id },
      data: { currentStepOrder: nextStep.order, nextRunAt, messagesSentCount },
    });
  }
  await emitFollowUpUpdated(deps, execution.conversationId);
}

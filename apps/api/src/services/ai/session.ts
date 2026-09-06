import type { AiSession, PrismaClient, Prisma } from "@azvchat/database";
import {
  RealtimeEvents,
  type AiSessionDto,
  type AiSessionEndReason,
  type AiSessionPayload,
  type AiSessionStatus,
} from "@azvchat/shared";
import type { Server } from "socket.io";
import type { Logger } from "pino";
import { conversationAudience } from "../../realtime/socket.js";

/**
 * Ciclo de vida da SESSÃO de atendimento por IA — o que a Inbox mostra e o
 * que as rotas de assumir/encerrar/devolver tocam. O motor (`runtime.ts`)
 * usa as mesmas funções, para a sessão só terminar por UM caminho.
 */

/** Memória do atendimento, guardada em `AiSession.state`. */
export interface AiSessionState {
  collected: Record<string, string>;
  summary: string | null;
  subject: string | null;
  intent: string | null;
  /** Ações executadas (nome + instante), para o resumo e a auditoria. */
  actions: Array<{ tool: string; at: string }>;
  /** Estado de "aguardando o cliente" após follow-up agendado. */
  followupScheduledAt?: string | null;
}

export function readSessionState(raw: unknown): AiSessionState {
  const base: AiSessionState = { collected: {}, summary: null, subject: null, intent: null, actions: [] };
  if (!raw || typeof raw !== "object") return base;
  const input = raw as Partial<AiSessionState>;
  return {
    collected:
      input.collected && typeof input.collected === "object"
        ? Object.fromEntries(
            Object.entries(input.collected).filter(([, value]) => typeof value === "string") as Array<[string, string]>,
          )
        : {},
    summary: typeof input.summary === "string" ? input.summary : null,
    subject: typeof input.subject === "string" ? input.subject : null,
    intent: typeof input.intent === "string" ? input.intent : null,
    actions: Array.isArray(input.actions) ? input.actions.slice(-50) : [],
    followupScheduledAt: typeof input.followupScheduledAt === "string" ? input.followupScheduledAt : null,
  };
}

type SessionWithRefs = AiSession & {
  agent: { name: string; currentVersion: number };
  agentVersion?: { version: number } | null;
  endedBy?: { id: string; name: string } | null;
};

export const sessionInclude = {
  agent: { select: { name: true, currentVersion: true } },
  agentVersion: { select: { version: true } },
  endedBy: { select: { id: true, name: true } },
} satisfies Prisma.AiSessionInclude;

export function serializeAiSession(session: SessionWithRefs): AiSessionDto {
  const state = readSessionState(session.state);
  return {
    id: session.id,
    conversationId: session.conversationId,
    agentId: session.agentId,
    agentName: session.agent.name,
    agentVersion: session.agentVersion?.version ?? session.agent.currentVersion,
    status: session.status as AiSessionStatus,
    aiMessageCount: session.aiMessageCount,
    customerMessageCount: session.customerMessageCount,
    startedAt: session.startedAt.toISOString(),
    lastActivityAt: session.lastActivityAt.toISOString(),
    endedAt: session.endedAt?.toISOString() ?? null,
    endReason: (session.endReason as AiSessionEndReason | null) ?? null,
    endedBy: session.endedBy ?? null,
    collectedData: state.collected,
    summary: session.summary,
    inputTokens: session.inputTokens,
    outputTokens: session.outputTokens,
    costMicros: session.costMicros,
  };
}

/** A sessão mais recente da conversa (ativa ou não), para a faixa da Inbox. */
export async function loadLatestSession(prisma: PrismaClient, conversationId: string) {
  return prisma.aiSession.findFirst({
    where: { conversationId },
    orderBy: { startedAt: "desc" },
    include: sessionInclude,
  });
}

export async function loadActiveSession(prisma: PrismaClient, conversationId: string) {
  return prisma.aiSession.findFirst({
    where: { conversationId, status: "active" },
    include: sessionInclude,
  });
}

/** Publica o estado da sessão para quem enxerga a conversa. */
export async function emitAiSession(
  deps: { prisma: PrismaClient; io: Server },
  organizationId: string,
  conversationId: string,
): Promise<void> {
  const [conversation, session] = await Promise.all([
    deps.prisma.conversation.findFirst({
      where: { id: conversationId, organizationId },
      select: { whatsappInstanceId: true, departmentId: true, assignedUserId: true },
    }),
    loadLatestSession(deps.prisma, conversationId),
  ]);
  if (!conversation) return;
  const payload: AiSessionPayload = {
    conversationId,
    session: session ? serializeAiSession(session) : null,
  };
  deps.io.to(conversationAudience(organizationId, conversation)).emit(RealtimeEvents.AiSession, payload);
}

const STATUS_BY_REASON: Record<AiSessionEndReason, AiSessionStatus> = {
  resolved_by_ai: "resolved",
  customer_requested_human: "transferred",
  ai_transfer: "transferred",
  human_takeover: "stopped",
  stopped_by_user: "stopped",
  message_limit: "limit_reached",
  attempt_limit: "limit_reached",
  duration_limit: "expired",
  provider_error: "error",
  budget_exceeded: "error",
  agent_disabled: "stopped",
  conversation_archived: "stopped",
};

/**
 * Encerra a sessão — o ÚNICO caminho de saída de `active`. Idempotente: a
 * segunda chamada (transferência e "assumir" cruzando no mesmo segundo) não
 * faz nada, e devolve `false`. A checagem de status vai no `where` do
 * update, então é atômica no banco.
 */
export async function endAiSession(
  deps: { prisma: PrismaClient; io: Server; logger: Logger },
  input: {
    sessionId: string;
    organizationId: string;
    conversationId: string;
    reason: AiSessionEndReason;
    endedByUserId?: string | null;
    summary?: string | null;
    /** Texto do histórico da conversa (painel de contexto). */
    historyNote?: string;
  },
): Promise<boolean> {
  const status = STATUS_BY_REASON[input.reason];
  const result = await deps.prisma.aiSession.updateMany({
    where: { id: input.sessionId, status: "active" },
    data: {
      status,
      endReason: input.reason,
      endedAt: new Date(),
      endedByUserId: input.endedByUserId ?? null,
      ...(input.summary !== undefined ? { summary: input.summary } : {}),
    },
  });
  if (result.count === 0) return false;

  if (input.historyNote) {
    // O painel de contexto lista o histórico de atribuição: a saída da IA
    // entra ali como "sem responsável" com a nota, o mesmo lugar em que a
    // equipe já olha quem fez o quê.
    await deps.prisma.conversationAssignmentHistory
      .create({
        data: {
          organizationId: input.organizationId,
          conversationId: input.conversationId,
          action: "unassigned",
          performedByUserId: input.endedByUserId ?? null,
          note: input.historyNote,
        },
      })
      .catch((err) => {
        deps.logger.warn({ event: "ai_session_history_failed", sessionId: input.sessionId, error: String(err) });
      });
  }

  deps.logger.info({
    event: "ai_session_ended",
    sessionId: input.sessionId,
    conversationId: input.conversationId,
    reason: input.reason,
    status,
  });
  await emitAiSession(deps, input.organizationId, input.conversationId);
  return true;
}

/**
 * Um atendente assumiu (ou mandou mensagem, ou transferiu): a IA para NA
 * HORA. Chamado pelas rotas de atribuição, transferência e envio — barato
 * quando não há sessão (uma consulta indexada), que é o caso quase sempre.
 */
export async function interruptAiSessionForHuman(
  deps: { prisma: PrismaClient; io: Server; logger: Logger },
  input: { organizationId: string; conversationId: string; userId: string; userName: string; reason?: AiSessionEndReason },
): Promise<boolean> {
  try {
    const session = await deps.prisma.aiSession.findFirst({
      where: { conversationId: input.conversationId, status: "active" },
      select: { id: true, agent: { select: { name: true } } },
    });
    if (!session) return false;
    return await endAiSession(deps, {
      sessionId: session.id,
      organizationId: input.organizationId,
      conversationId: input.conversationId,
      reason: input.reason ?? "human_takeover",
      endedByUserId: input.userId,
      historyNote: `Atendimento por IA (${session.agent.name}) interrompido — assumido por ${input.userName}.`,
    });
  } catch (err) {
    // A interrupção é acessória à ação da pessoa (assumir, transferir,
    // responder): falhar aqui não pode derrubar a ação. Fica o log, e a
    // varredura do motor confere o estado da sessão no próximo turno.
    deps.logger.error({ event: "ai_session_interrupt_failed", conversationId: input.conversationId, error: String(err) });
    return false;
  }
}

import type { PrismaClient } from "@azvchat/database";
import {
  EMPTY_CONVERSATION_AUTOMATION,
  RealtimeEvents,
  type ConversationAutomationDto,
  type ConversationAutomationPayload,
} from "@azvchat/shared";
import type { Server } from "socket.io";
import { conversationAudience } from "../realtime/socket.js";

/**
 * "Quem está atendendo esta conversa é uma máquina?" — fonte única da
 * resposta, para o chip do card da lista (ver `conversation-automation.ts`
 * no shared para o porquê de existir).
 *
 * Duas fontes, uma pergunta: a `AiSession` ativa (seção 20) e a
 * `AutomationExecution` em andamento (seção 18). Nada aqui decide acesso: o
 * estado só é lido para conversas que quem chamou já enxerga — a lista sai
 * de `conversationScope`, e o evento vai para a `conversationAudience()` da
 * conversa, a mesma de qualquer evento de conversa.
 */

/** Uma execução nestes dois status ainda está no controle da conversa. */
const ACTIVE_FLOW_STATUSES = ["running", "waiting"] as const;

/** O que a audiência do evento precisa saber da conversa. */
interface AudienceTarget {
  whatsappInstanceId: string;
  departmentId: string | null;
  assignedUserId: string | null;
}

/**
 * Estado de automação de um conjunto de conversas (a página da lista).
 *
 * DUAS consultas para a página inteira, nunca duas por linha — é o mesmo
 * compromisso de `loadUnreadCounts`. Conversa sem nada automático **não
 * ganha entrada** no mapa: ausência já significa "ninguém automático aqui",
 * e o payload da lista fica com o tamanho do que está acontecendo, não com o
 * da página.
 */
export async function loadConversationAutomations(
  prisma: PrismaClient,
  conversationIds: string[],
): Promise<Map<string, ConversationAutomationDto>> {
  const states = new Map<string, ConversationAutomationDto>();
  if (conversationIds.length === 0) return states;

  const [sessions, executions] = await Promise.all([
    prisma.aiSession.findMany({
      where: { conversationId: { in: conversationIds }, status: "active" },
      select: { id: true, conversationId: true, agentId: true, agent: { select: { name: true } } },
      orderBy: { startedAt: "desc" },
    }),
    prisma.automationExecution.findMany({
      where: { conversationId: { in: conversationIds }, status: { in: [...ACTIVE_FLOW_STATUSES] } },
      select: { id: true, conversationId: true, flowId: true, flow: { select: { name: true } } },
      orderBy: { startedAt: "desc" },
    }),
  ]);

  /** Índice parcial no banco garante uma de cada por conversa; a mais nova vence se um dia houver duas. */
  const entryFor = (conversationId: string): ConversationAutomationDto => {
    const current = states.get(conversationId);
    if (current) return current;
    const created: ConversationAutomationDto = { ai: null, flow: null };
    states.set(conversationId, created);
    return created;
  };

  for (const session of sessions) {
    const entry = entryFor(session.conversationId);
    entry.ai ??= {
      sessionId: session.id,
      agentId: session.agentId,
      agentName: session.agent.name,
    };
  }
  for (const execution of executions) {
    const entry = entryFor(execution.conversationId);
    entry.flow ??= {
      executionId: execution.id,
      flowId: execution.flowId,
      flowName: execution.flow.name,
    };
  }
  return states;
}

/** O mesmo estado para UMA conversa; sem nada rodando devolve as duas pontas nulas. */
export async function loadConversationAutomation(
  prisma: PrismaClient,
  conversationId: string,
): Promise<ConversationAutomationDto> {
  const states = await loadConversationAutomations(prisma, [conversationId]);
  return states.get(conversationId) ?? { ...EMPTY_CONVERSATION_AUTOMATION };
}

/**
 * Recalcula e publica o estado para quem enxerga a conversa.
 *
 * `audience` é opcional só para quem JÁ leu a conversa e pode emprestá-la
 * (o caso de `emitAiSession`): sem ela a função busca sozinha. Sempre
 * reenvia o estado inteiro — chip que some é `ai` e `flow` nulos, nunca um
 * evento de "removido".
 */
export async function emitConversationAutomation(
  deps: { prisma: PrismaClient; io: Server },
  organizationId: string,
  conversationId: string,
  audience?: AudienceTarget | null,
): Promise<void> {
  const target =
    audience ??
    (await deps.prisma.conversation.findFirst({
      where: { id: conversationId, organizationId },
      select: { whatsappInstanceId: true, departmentId: true, assignedUserId: true },
    }));
  if (!target) return;

  const automation = await loadConversationAutomation(deps.prisma, conversationId);
  const payload: ConversationAutomationPayload = { conversationId, automation };
  deps.io
    .to(conversationAudience(organizationId, target))
    .emit(RealtimeEvents.ConversationAutomation, payload);
}

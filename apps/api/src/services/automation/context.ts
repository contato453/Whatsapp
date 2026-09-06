import type { PrismaClient } from "@azvchat/database";
import { phoneFromChatId, type AutomationVariableContext } from "@azvchat/shared";
import { resolveConversationPersonName } from "../../lib/person-profile.js";

export interface AutomationConversationRef {
  id: string;
  type: string;
  customTitle: string | null;
  title: string;
  externalChatId: string;
  departmentId: string | null;
  assignedUserId: string | null;
}

export interface AutomationExecutionContextData {
  answers?: Record<string, string>;
  protocol?: string;
  [key: string]: unknown;
}

/**
 * Monta o contexto de resolução de `{{variáveis}}` de uma execução, a partir
 * da conversa e do que já foi coletado. Mesma precedência de nome que o
 * resto do sistema usa para conversa individual (`customTitle` > nome da
 * pessoa > `title` do WhatsApp — ver `serializeConversation`), para a
 * mensagem do fluxo nunca chamar alguém de um jeito que a Inbox já corrigiu.
 */
export async function buildAutomationVariableContext(
  prisma: PrismaClient,
  organizationId: string,
  conversation: AutomationConversationRef,
  executionContext: AutomationExecutionContextData,
): Promise<AutomationVariableContext> {
  const personName =
    conversation.type === "individual"
      ? await resolveConversationPersonName(prisma, organizationId, conversation)
      : null;
  const contactName = conversation.customTitle || personName || conversation.title || null;
  const contactPhone = conversation.type === "individual" ? phoneFromChatId(conversation.externalChatId) : null;

  const [department, assignee] = await Promise.all([
    conversation.departmentId
      ? prisma.department.findUnique({ where: { id: conversation.departmentId }, select: { name: true } })
      : Promise.resolve(null),
    conversation.assignedUserId
      ? prisma.user.findUnique({ where: { id: conversation.assignedUserId }, select: { name: true } })
      : Promise.resolve(null),
  ]);

  return {
    contactName,
    contactPhone,
    agentName: assignee?.name ?? null,
    departmentName: department?.name ?? null,
    protocol: executionContext.protocol ?? null,
    answers: executionContext.answers ?? {},
    now: new Date(),
  };
}

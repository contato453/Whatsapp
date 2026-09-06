import type { CrmEventType, Prisma, PrismaClient } from "@azvchat/database";

/**
 * A linha do tempo da oportunidade.
 *
 * Ela existe porque a pergunta que o escritório faz sobre uma negociação
 * perdida é sempre "o que aconteceu aqui?" — e a resposta não está no estado
 * atual do card, que só mostra onde a oportunidade parou. Sem o histórico, o
 * card diz "Perdido, R$ 8.000" e ninguém sabe se a proposta chegou a ser
 * enviada, quem largou o atendimento nem quando o cliente parou de responder.
 *
 * Um TIPO por fato, e não frase livre: é assim que o relatório agrupa (quantas
 * viraram ganho no mês, quanto tempo em média entre criação e fechamento) e
 * texto livre não se agrupa. A frase vem junto, no `description`, para a tela
 * não precisar de um dicionário próprio.
 *
 * Registrar histórico NUNCA derruba a operação: `recordCrmEvent` engole a
 * falha. Perder uma linha de timeline é ruim; perder a movimentação do card
 * porque o log falhou é pior — o mesmo raciocínio de `deps.audit.record`,
 * que também é disparado sem `await`.
 */

/** Aceita o client e também o `tx` de dentro de uma transação. */
type PrismaLike = PrismaClient | Prisma.TransactionClient;

export interface CrmEventInput {
  organizationId: string;
  opportunityId: string;
  type: CrmEventType;
  /** Nulo = ação do sistema (automação de etapa, resposta do cliente). */
  performedByUserId?: string | null;
  fromStageId?: string | null;
  toStageId?: string | null;
  fromUserId?: string | null;
  toUserId?: string | null;
  description?: string | null;
  metadata?: Prisma.InputJsonValue;
}

export async function recordCrmEvent(prisma: PrismaLike, input: CrmEventInput): Promise<void> {
  try {
    await prisma.crmOpportunityEvent.create({
      data: {
        organizationId: input.organizationId,
        opportunityId: input.opportunityId,
        type: input.type,
        performedByUserId: input.performedByUserId ?? null,
        fromStageId: input.fromStageId ?? null,
        toStageId: input.toStageId ?? null,
        fromUserId: input.fromUserId ?? null,
        toUserId: input.toUserId ?? null,
        description: input.description ?? null,
        ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
      },
    });
  } catch {
    // Ver o cabeçalho: timeline é registro, não é o trabalho.
  }
}

/** Vários eventos de uma vez (a criação registra o que já veio preenchido). */
export async function recordCrmEvents(
  prisma: PrismaLike,
  events: CrmEventInput[],
): Promise<void> {
  for (const event of events) {
    await recordCrmEvent(prisma, event);
  }
}

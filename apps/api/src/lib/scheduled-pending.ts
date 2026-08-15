import type { PrismaClient } from "@azvchat/database";
import { RealtimeEvents, type ScheduledPendingPayload } from "@azvchat/shared";
import type { Server } from "socket.io";
import type { Logger } from "pino";
import { conversationAudience } from "../realtime/socket.js";

/**
 * Contagem de mensagens agendadas que ainda vão sair nesta conversa.
 *
 * Só `pending` entra na conta: `sent`, `failed` e `canceled` já saíram da
 * fila e não representam mais "coisa marcada para sair". Retentativa do
 * scheduler não altera este número — nela sobe `attempts` e o status
 * permanece `pending` até enviar de vez ou desistir.
 *
 * A consulta é sempre escopada pelo `conversationId` de uma conversa que a
 * chamadora já autorizou por `lib/access.ts`; não existe regra de acesso
 * própria aqui.
 */
export async function countPendingScheduled(
  prisma: PrismaClient,
  conversationId: string,
): Promise<number> {
  return prisma.scheduledMessage.count({ where: { conversationId, status: "pending" } });
}

/**
 * Recalcula o contador e avisa em tempo real quem enxerga a conversa.
 *
 * A audiência é a mesma de qualquer evento de conversa
 * (`conversationAudience`), então o contador nunca chega a quem não teria
 * acesso à conversa pelo HTTP.
 */
export async function emitScheduledPending(
  deps: { prisma: PrismaClient; io: Server; logger: Logger },
  organizationId: string,
  conversationId: string,
): Promise<void> {
  const conversation = await deps.prisma.conversation.findFirst({
    where: { id: conversationId, organizationId },
    select: { whatsappInstanceId: true, departmentId: true, assignedUserId: true },
  });
  if (!conversation) return;

  const pending = await countPendingScheduled(deps.prisma, conversationId);
  const payload: ScheduledPendingPayload = { conversationId, pending };
  deps.io.to(conversationAudience(organizationId, conversation)).emit(
    RealtimeEvents.ScheduledPending,
    payload,
  );
  // Log sem conteúdo da mensagem: só o que a conversa tem em fila.
  deps.logger.info({ event: "scheduled_pending_count", conversationId, pending });
}

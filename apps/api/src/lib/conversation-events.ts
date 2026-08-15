import type { Prisma, PrismaClient } from "@azvchat/database";
import type { Server } from "socket.io";
import { RealtimeEvents } from "@azvchat/shared";
import { conversationAudience } from "../realtime/socket.js";
import { serializeConversation } from "./serialize.js";

/**
 * Relações que `serializeConversation` espera encontrar carregadas. Fica
 * aqui, e não em cada módulo, porque conversa alterada é publicada de mais
 * de um lugar — e um include a menos vira DTO sem responsável ou sem
 * etiqueta no meio da lista de quem está com a tela aberta.
 */
export const conversationInclude = {
  assignedUser: true,
  department: true,
  instance: true,
  tags: { include: { tag: true } },
  // A visão de arquivadas mostra quem arquivou; sem o include o DTO sairia
  // sempre com archivedBy nulo.
  archivedBy: true,
} satisfies Prisma.ConversationInclude;

/**
 * Publica a conversa para a audiência atual dela. A audiência é calculada
 * DEPOIS da alteração: quem muda de responsável muda de sala, e o evento
 * precisa chegar em quem passou a enxergá-la.
 */
export async function emitConversationUpdated(
  prisma: PrismaClient,
  io: Server,
  conversationId: string,
  organizationId: string,
): Promise<void> {
  const conversation = await prisma.conversation.findUnique({
    where: { id: conversationId },
    include: conversationInclude,
  });
  if (!conversation) return;
  io.to(conversationAudience(organizationId, conversation)).emit(
    RealtimeEvents.ConversationUpdated,
    serializeConversation(conversation),
  );
}

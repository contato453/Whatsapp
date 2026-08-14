import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { authenticate } from "../../lib/auth.js";
import { serializeConversation, serializeMessage } from "../../lib/serialize.js";
import type { AppDeps } from "../../types.js";

const searchSchema = z.object({
  q: z.string().min(2).max(120),
  limit: z.coerce.number().min(1).max(50).default(20),
});

export async function searchRoutes(app: FastifyInstance, deps: AppDeps): Promise<void> {
  /**
   * Busca global: conversas (título), mensagens (conteúdo/arquivo),
   * participantes de grupo e contatos (nome/telefone).
   */
  app.get("/search", { preHandler: authenticate }, async (request) => {
    const { q, limit } = searchSchema.parse(request.query);
    const organizationId = request.user.organizationId;

    const [conversations, messages, participants] = await Promise.all([
      deps.prisma.conversation.findMany({
        where: {
          organizationId,
          OR: [
            { title: { contains: q, mode: "insensitive" } },
            { externalChatId: { contains: q } },
          ],
        },
        include: {
          assignedUser: true,
          department: true,
          instance: true,
          tags: { include: { tag: true } },
        },
        orderBy: { lastMessageAt: { sort: "desc", nulls: "last" } },
        take: limit,
      }),
      deps.prisma.message.findMany({
        where: {
          organizationId,
          OR: [
            { content: { contains: q, mode: "insensitive" } },
            { filename: { contains: q, mode: "insensitive" } },
            { senderName: { contains: q, mode: "insensitive" } },
            { senderPhone: { contains: q.replace(/\D/g, "") || q } },
          ],
        },
        orderBy: { timestamp: "desc" },
        take: limit,
        include: { conversation: { select: { id: true, title: true, type: true } } },
      }),
      deps.prisma.groupParticipant.findMany({
        where: {
          group: { organizationId },
          OR: [
            { name: { contains: q, mode: "insensitive" } },
            { phoneNumber: { contains: q.replace(/\D/g, "") || q } },
          ],
        },
        take: limit,
        include: { group: { select: { id: true, name: true, conversationId: true } } },
      }),
    ]);

    return {
      conversations: conversations.map(serializeConversation),
      messages: messages.map((message) => ({
        ...serializeMessage(message),
        conversationTitle: message.conversation.title,
        conversationType: message.conversation.type,
      })),
      participants: participants.map((participant) => ({
        id: participant.id,
        name: participant.name,
        phoneNumber: participant.phoneNumber,
        groupName: participant.group.name,
        conversationId: participant.group.conversationId,
      })),
    };
  });
}

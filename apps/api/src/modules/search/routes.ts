import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { conversationScope, groupScope, loadConversationAccess } from "../../lib/access.js";
import { authenticate } from "../../lib/auth.js";
import {
  resolveConversationPersonNames,
  resolvePersonProfiles,
} from "../../lib/person-profile.js";
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
    // A busca global respeita as conexões liberadas para o usuário.
    const access = await loadConversationAccess(deps.prisma, request.user);
    const scope = conversationScope(access);

    // O nome dado pela equipe mora no registro da PESSOA — sem esta lista,
    // buscar pelo nome corrigido não acharia ninguém nos grupos.
    const matchingProfiles = await deps.prisma.personProfile.findMany({
      where: { organizationId, customName: { contains: q, mode: "insensitive" } },
      select: { externalId: true },
      take: limit,
    });

    const [conversations, messages, participants] = await Promise.all([
      deps.prisma.conversation.findMany({
        where: {
          organizationId,
          ...scope,
          OR: [
            { title: { contains: q, mode: "insensitive" } },
            { externalChatId: { contains: q } },
            // Código do cadastro no escritório ("EMPRESA 001")
            { externalReference: { contains: q, mode: "insensitive" } },
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
          conversation: scope,
          OR: [
            { content: { contains: q, mode: "insensitive" } },
            { filename: { contains: q, mode: "insensitive" } },
            { senderName: { contains: q, mode: "insensitive" } },
            { senderPhone: { contains: q.replace(/\D/g, "") || q } },
          ],
        },
        orderBy: { timestamp: "desc" },
        take: limit,
        include: { conversation: { select: { id: true, title: true, customTitle: true, type: true } } },
      }),
      deps.prisma.groupParticipant.findMany({
        where: {
          group: { organizationId, ...groupScope(access) },
          OR: [
            { name: { contains: q, mode: "insensitive" } },
            { phoneNumber: { contains: q.replace(/\D/g, "") || q } },
            {
              externalContactId: { in: matchingProfiles.map((profile) => profile.externalId) },
            },
          ],
        },
        take: limit,
        include: { group: { select: { id: true, name: true, conversationId: true } } },
      }),
    ]);

    // Nomes decididos no nível da pessoa, em lote, para os resultados
    // exibirem o valor corrigido — nunca uma consulta por linha.
    const [personNames, participantProfiles] = await Promise.all([
      resolveConversationPersonNames(deps.prisma, organizationId, conversations),
      resolvePersonProfiles(
        deps.prisma,
        organizationId,
        participants.map((participant) => participant.externalContactId),
      ),
    ]);

    return {
      conversations: conversations.map((conversation) =>
        serializeConversation(conversation, personNames.get(conversation.id) ?? null),
      ),
      messages: messages.map((message) => ({
        ...serializeMessage(message),
        conversationTitle: message.conversation.customTitle || message.conversation.title,
        conversationType: message.conversation.type,
      })),
      participants: participants.map((participant) => {
        const profile = participantProfiles.get(participant.externalContactId);
        return {
          id: participant.id,
          // Registro da pessoa presente vale inteiro; sem ele, o legado do
          // grupo e por fim o nome do WhatsApp.
          name: (profile ? profile.customName : participant.customName) ?? participant.name,
          phoneNumber: participant.phoneNumber,
          groupName: participant.group.name,
          conversationId: participant.group.conversationId,
        };
      }),
    };
  });
}

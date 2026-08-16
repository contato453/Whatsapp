import type { Conversation, Prisma, PrismaClient } from "@azvchat/database";
import { conversationScope, loadConversationAccess } from "./access.js";
import type { AuthTokenPayload } from "./auth.js";
import { NotFoundError } from "./errors.js";

/**
 * Uma conversa, pelo id, dentro do que a pessoa enxerga.
 *
 * Existe para que todo módulo que parte de uma conversa (inclusive os que
 * ainda vão nascer, como a integração com o Azevedo-OS) use exatamente o
 * mesmo recorte de `access.ts` — em vez de cada um montar o seu `where`,
 * que é como um deles acaba esquecendo o filtro de número.
 */
export async function accessibleConversationWhere(
  prisma: PrismaClient,
  user: AuthTokenPayload,
  id: string,
): Promise<Prisma.ConversationWhereInput> {
  const access = await loadConversationAccess(prisma, user);
  return { id, organizationId: user.organizationId, ...conversationScope(access) };
}

/**
 * Conversa de número ou departamento fora do recorte responde 404, e não
 * 403: o padrão da casa é "como se não existisse" — 403 confirmaria à
 * pessoa que aquele id existe em algum lugar do sistema.
 */
export async function findAccessibleConversation(
  prisma: PrismaClient,
  user: AuthTokenPayload,
  id: string,
): Promise<Conversation> {
  const conversation = await prisma.conversation.findFirst({
    where: await accessibleConversationWhere(prisma, user, id),
  });
  if (!conversation) throw new NotFoundError("Conversa");
  return conversation;
}

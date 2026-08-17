import type { Conversation, Prisma, PrismaClient } from "@azvchat/database";
import {
  CONVERSATION_DEPARTMENT_MIN_ROLE,
  hasRole,
  type UserRole,
} from "@azvchat/shared";
import { conversationScope, loadConversationAccess } from "./access.js";
import type { AuthTokenPayload } from "./auth.js";
import { NotFoundError } from "./errors.js";

/**
 * Pode gravar o departamento da conversa?
 *
 * Regra de ESCRITA, não de visibilidade: quem enxerga o quê continua saindo
 * inteiro de `access.ts`. O que esta função responde é quem pode mexer no
 * campo que move a conversa de um time para outro — supervisor para cima.
 *
 * O papel mínimo vem de `@azvchat/shared` porque o painel de contexto usa o
 * mesmo valor para decidir se desenha o campo: o `requireRole` da API e o
 * que a tela mostra andam sempre juntos.
 *
 * Função pura de propósito — a regra é testável sem subir rota, e os dois
 * caminhos que gravam o campo (transferência e atribuição com departamento)
 * consultam esta mesma linha, em vez de repetir a comparação de papel.
 */
export function canWriteConversationDepartment(role: UserRole): boolean {
  return hasRole(role, CONVERSATION_DEPARTMENT_MIN_ROLE);
}

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

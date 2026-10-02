import type { Prisma, PrismaClient } from "@azvchat/database";
import { MAX_PINNED_CONVERSATIONS, type ConversationPinMap } from "@azvchat/shared";
import { AppError } from "./errors.js";

/**
 * Conversa fixada no topo da lista, POR USUÁRIO.
 *
 * Fonte única de leitura e escrita da fixação de conversa. Três regras moram
 * aqui e em nenhum outro lugar:
 *
 * 1. **Fixar é preferência pessoal.** Cada pessoa tem as suas, e nada daqui
 *    entra no DTO da conversa (que é publicado para a audiência inteira).
 * 2. **Fixar não é ver.** Toda leitura passa pelo `where` de acesso que quem
 *    chama monta com `conversationScope` — conversa que saiu do alcance da
 *    pessoa (trocou de departamento, perdeu o número) simplesmente deixa de
 *    aparecer, e a linha dela não ocupa vaga do teto.
 * 3. **Arquivada não fica fixada.** Arquivar desafixa para todo mundo, como
 *    no WhatsApp: a fixada é "o que estou acompanhando agora", e a arquivada
 *    é o contrário disso.
 */

/**
 * As fixadas que a pessoa ENXERGA agora, mais recente primeiro. `visibleWhere`
 * é o recorte de acesso dela (organização + `conversationScope`); a função só
 * estreita, nunca devolve conversa fora dele.
 */
export async function loadVisiblePins(
  prisma: PrismaClient,
  userId: string,
  visibleWhere: Prisma.ConversationWhereInput,
): Promise<ConversationPinMap> {
  const pins = await prisma.conversationPin.findMany({
    where: { userId, conversation: { is: { ...visibleWhere, archivedAt: null } } },
    orderBy: { pinnedAt: "desc" },
    select: { conversationId: true, pinnedAt: true },
    take: MAX_PINNED_CONVERSATIONS,
  });
  return Object.fromEntries(pins.map((pin) => [pin.conversationId, pin.pinnedAt.toISOString()]));
}

/**
 * Fixa a conversa para esta pessoa. Já fixada é no-op (não regrava a data,
 * senão um clique repetido mudaria a ordem do topo).
 *
 * Antes de contar o teto, poda as linhas que não valem mais (conversa fora do
 * alcance ou arquivada): sem isso uma fixação invisível ocuparia vaga para
 * sempre, e a pessoa veria "limite de 3" com duas na tela.
 */
export async function pinConversation(
  prisma: PrismaClient,
  input: {
    organizationId: string;
    userId: string;
    conversationId: string;
    visibleWhere: Prisma.ConversationWhereInput;
  },
): Promise<ConversationPinMap> {
  const { organizationId, userId, conversationId, visibleWhere } = input;
  const existing = await prisma.conversationPin.findUnique({
    where: { userId_conversationId: { userId, conversationId } },
    select: { id: true },
  });
  if (!existing) {
    await prisma.conversationPin.deleteMany({
      where: {
        userId,
        NOT: { conversation: { is: { ...visibleWhere, archivedAt: null } } },
      },
    });
    const active = await prisma.conversationPin.count({ where: { userId } });
    if (active >= MAX_PINNED_CONVERSATIONS) {
      throw new AppError(
        `Você já fixou ${MAX_PINNED_CONVERSATIONS} conversas. Desafixe uma para fixar esta.`,
        409,
        "conversation_pin_limit_reached",
      );
    }
    try {
      await prisma.conversationPin.create({ data: { organizationId, userId, conversationId } });
    } catch (err) {
      // Duplo clique: a outra chamada já gravou a mesma fixação. O resultado
      // é o mesmo que a pessoa pediu, então não é erro.
      if (!isUniqueViolation(err)) throw err;
    }
  }
  return loadVisiblePins(prisma, userId, visibleWhere);
}

/** Desafixa só para esta pessoa. Não fixada é no-op. */
export async function unpinConversation(
  prisma: PrismaClient,
  input: { userId: string; conversationId: string; visibleWhere: Prisma.ConversationWhereInput },
): Promise<ConversationPinMap> {
  await prisma.conversationPin.deleteMany({
    where: { userId: input.userId, conversationId: input.conversationId },
  });
  return loadVisiblePins(prisma, input.userId, input.visibleWhere);
}

/**
 * Arquivar desafixa para TODO MUNDO. As abas abertas não precisam de aviso
 * próprio: o `conversation:updated` do arquivamento já tira a conversa da
 * lista, e a tela descarta a fixação de quem chega arquivado.
 */
export async function unpinConversationForEveryone(
  prisma: PrismaClient,
  conversationId: string,
): Promise<void> {
  await prisma.conversationPin.deleteMany({ where: { conversationId } });
}

function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { code?: unknown }).code === "P2002"
  );
}

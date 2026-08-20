import type { PrismaClient } from "@azvchat/database";
import { AppError, NotFoundError } from "./errors.js";

/**
 * Teto de fixadas por conversa. Três cabem o caso de uso real (link do
 * formulário, da pasta, do agendamento) sem a faixa deixar de ser "topo" e
 * virar uma segunda lista de mensagens dentro da conversa.
 */
export const MAX_PINNED_ITEMS = 3;

/** O alvo é polimórfico: mensagem OU nota interna, nunca as duas (ver a
 * constraint `pinned_items_one_target` na migration). */
export type PinTarget = { kind: "message"; id: string } | { kind: "note"; id: string };

const PIN_INCLUDE = {
  message: true,
  note: { include: { user: true } },
  pinnedBy: true,
} as const;

export type PinnedItemRecord = Awaited<ReturnType<typeof loadPinnedItems>>[number];

function targetWhere(target: PinTarget) {
  return target.kind === "message" ? { messageId: target.id } : { noteId: target.id };
}

/** Lista as fixações da conversa, da mais antiga para a mais nova — é essa
 * ordem que vira "1 de 3" na faixa. */
export async function loadPinnedItems(prisma: PrismaClient, conversationId: string) {
  return prisma.pinnedItem.findMany({
    where: { conversationId },
    orderBy: { pinnedAt: "asc" },
    include: PIN_INCLUDE,
  });
}

/**
 * Fixa uma mensagem ou nota interna.
 *
 * Idempotente: fixar o que já está fixado não duplica linha nem falha —
 * devolve a lista atual como está. O botão da tela já vira "Desafixar"
 * antes disso acontecer, mas duplo clique (ou duas abas na mesma conversa)
 * não pode virar duas fixações do mesmo alvo.
 *
 * Limite de `MAX_PINNED_ITEMS` por conversa: acima disso recusa com
 * `pin_limit_reached` (409) — A MENOS que `replaceItemId` diga qual
 * fixação liberar, aí troca as duas em uma transação só e devolve a
 * substituída, para quem chama auditar a saída dela também.
 */
export async function pinItem(
  prisma: PrismaClient,
  input: {
    organizationId: string;
    conversationId: string;
    target: PinTarget;
    userId: string;
    replaceItemId?: string;
  },
): Promise<{
  items: PinnedItemRecord[];
  replaced: PinnedItemRecord | null;
  alreadyPinned: boolean;
}> {
  const existing = await prisma.pinnedItem.findFirst({
    where: { conversationId: input.conversationId, ...targetWhere(input.target) },
  });
  if (existing) {
    return {
      items: await loadPinnedItems(prisma, input.conversationId),
      replaced: null,
      alreadyPinned: true,
    };
  }

  const count = await prisma.pinnedItem.count({ where: { conversationId: input.conversationId } });
  let replaced: PinnedItemRecord | null = null;

  if (count >= MAX_PINNED_ITEMS) {
    if (!input.replaceItemId) {
      throw new AppError(
        `Limite de ${MAX_PINNED_ITEMS} mensagens fixadas nesta conversa. Desafixe uma para continuar.`,
        409,
        "pin_limit_reached",
      );
    }
    const toReplace = await prisma.pinnedItem.findFirst({
      where: { id: input.replaceItemId, conversationId: input.conversationId },
      include: PIN_INCLUDE,
    });
    if (!toReplace) throw new NotFoundError("Fixação");
    replaced = toReplace;
    await prisma.$transaction([
      prisma.pinnedItem.delete({ where: { id: toReplace.id } }),
      prisma.pinnedItem.create({
        data: {
          organizationId: input.organizationId,
          conversationId: input.conversationId,
          pinnedByUserId: input.userId,
          ...targetWhere(input.target),
        },
      }),
    ]);
  } else {
    await prisma.pinnedItem.create({
      data: {
        organizationId: input.organizationId,
        conversationId: input.conversationId,
        pinnedByUserId: input.userId,
        ...targetWhere(input.target),
      },
    });
  }

  return { items: await loadPinnedItems(prisma, input.conversationId), replaced, alreadyPinned: false };
}

/** Desafixa; `removed` diz se havia o que desafixar (idempotente também). */
export async function unpinItem(
  prisma: PrismaClient,
  input: { conversationId: string; target: PinTarget },
): Promise<{ items: PinnedItemRecord[]; removed: boolean }> {
  const existing = await prisma.pinnedItem.findFirst({
    where: { conversationId: input.conversationId, ...targetWhere(input.target) },
  });
  if (!existing) {
    return { items: await loadPinnedItems(prisma, input.conversationId), removed: false };
  }
  await prisma.pinnedItem.delete({ where: { id: existing.id } });
  return { items: await loadPinnedItems(prisma, input.conversationId), removed: true };
}

/**
 * Desafixa sozinho quando a mensagem é apagada — pelo agente
 * (`DELETE /messages/:id`) ou pelo CLIENTE, pelo celular (evento
 * `message-deleted` do provider). Sem isso a faixa continuaria mostrando
 * uma mensagem que a conversa não tem mais, ou pior: "Mídia indisponível"
 * fixada no topo. Devolve `null` quando a mensagem não estava fixada — é
 * assim que quem chama sabe que não precisa emitir o evento de fixação.
 */
export async function unpinMessageIfPinned(
  prisma: PrismaClient,
  conversationId: string,
  messageId: string,
): Promise<PinnedItemRecord[] | null> {
  const result = await unpinItem(prisma, { conversationId, target: { kind: "message", id: messageId } });
  return result.removed ? result.items : null;
}

/**
 * Mensagem fixada foi editada (por nós ou pelo cliente): a linha da
 * fixação não muda, só o CONTEÚDO que ela aponta — a faixa precisa
 * acompanhar o texto novo. Devolve a lista fresca só quando a mensagem
 * estava mesmo fixada, para a API não pagar esta consulta em toda edição
 * de mensagem da conversa (a grande maioria não está fixada).
 */
export async function pinnedItemsIfMessagePinned(
  prisma: PrismaClient,
  conversationId: string,
  messageId: string,
): Promise<PinnedItemRecord[] | null> {
  const pinned = await prisma.pinnedItem.findFirst({ where: { conversationId, messageId } });
  if (!pinned) return null;
  return loadPinnedItems(prisma, conversationId);
}

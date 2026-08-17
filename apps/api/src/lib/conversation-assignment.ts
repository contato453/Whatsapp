import type { Prisma } from "@azvchat/database";

/**
 * Atribuição de conversa: pessoa, coletivo ("@todos") ou ninguém.
 *
 * **Por que o coletivo convive com `assignedUserId` nulo, em vez de virar um
 * usuário fictício "@todos" no banco?** Porque a visibilidade que ele precisa
 * já existe: `lib/access.ts` faz o atendente enxergar as conversas atribuídas
 * a ele MAIS as que estão sem responsável, dentro dos números e departamentos
 * marcados. Marcar a conversa é, então, uma decisão registrada — não uma
 * regra de acesso nova. Um usuário fictício, além de exigir um cadastro que
 * ninguém pode editar, apareceria em relatório, em ranking e em todo seletor
 * de responsável como se fosse gente.
 *
 * O preço disso é que "sem responsável" deixou de ser `assignedUserId IS
 * NULL`: passou a ser `assignedUserId IS NULL AND assignedToAll = false`.
 * Este arquivo é a fonte única dos dois lados dessa conta — quem grava e quem
 * conta —, para nenhuma contagem nova precisar lembrar da regra sozinha.
 *
 * A exclusão mútua entre marcação e responsável é garantida também no banco
 * (constraint `conversations_assigned_to_all_without_user`): código é o
 * primeiro guarda, não o único.
 */

/** Passa o atendimento para uma pessoa — sair do coletivo é consequência. */
export function assignToUserData(userId: string): Prisma.ConversationUncheckedUpdateInput {
  return { assignedUserId: userId, assignedToAll: false };
}

/** Marca como coletivo: tira o responsável atual no mesmo movimento. */
export function assignToAllData(): Prisma.ConversationUncheckedUpdateInput {
  return { assignedUserId: null, assignedToAll: true };
}

/** Volta para a fila de verdade: sem dono e sem marcação. */
export function clearAssignmentData(): Prisma.ConversationUncheckedUpdateInput {
  return { assignedUserId: null, assignedToAll: false };
}

/**
 * Filtro das conversas realmente órfãs — as que precisam de alguém.
 *
 * Vale para toda contagem, listagem e atribuição automática: a marcada como
 * @todos não é órfã, é coletiva por decisão, e somá-la de volta faria o
 * número de "sem responsável" mentir exatamente onde a marcação veio ajudar.
 */
export function unassignedConversationWhere(): Prisma.ConversationWhereInput {
  return { assignedUserId: null, assignedToAll: false };
}

/** Filtro das conversas em atendimento coletivo. */
export function assignedToAllWhere(): Prisma.ConversationWhereInput {
  return { assignedToAll: true };
}

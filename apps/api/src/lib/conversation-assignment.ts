import type { Prisma } from "@azvchat/database";
import type { ParsedAssignment } from "@azvchat/shared";

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

/**
 * O filtro unificado de departamento e responsável, montado a partir dos
 * tokens marcados na tela.
 *
 * **Tudo que está marcado SOMA (OU), atravessando os três blocos da lista.**
 * Marcar o Contábil junto com uma pessoa de outro departamento devolve as
 * conversas do Contábil MAIS as dela, e não a interseção (que seria vazia na
 * maioria das vezes, e foi exatamente o motivo de os dois filtros virarem um
 * só). O cruzamento por E acontece entre filtros DIFERENTES, um nível acima,
 * onde este `where` entra como mais um item do `AND`.
 *
 * `OR` sobre a mesma tabela não repete linha: a conversa que casa com dois
 * ramos marcados (o departamento dela e o responsável dela) aparece uma vez
 * só, sem precisar de `distinct`.
 *
 * Devolve `null` quando nada está marcado — filtro vazio é "todos", nunca
 * "nenhum".
 */
export function assignmentFilterWhere(parsed: ParsedAssignment): Prisma.ConversationWhereInput | null {
  const ramos: Prisma.ConversationWhereInput[] = [];
  if (parsed.unassigned) ramos.push(unassignedConversationWhere());
  if (parsed.allUsers) ramos.push(assignedToAllWhere());
  // Conversa sem departamento existe quando o número não tem departamento
  // padrão, e é a única que some de um recorte por departamento — por isso
  // ela tem um item próprio em vez de depender de "desmarcar tudo".
  if (parsed.noDepartment) ramos.push({ departmentId: null });
  if (parsed.departmentIds.length > 0) ramos.push({ departmentId: { in: parsed.departmentIds } });
  if (parsed.userIds.length > 0) ramos.push({ assignedUserId: { in: parsed.userIds } });
  if (ramos.length === 0) return null;
  return ramos.length === 1 ? (ramos[0] as Prisma.ConversationWhereInput) : { OR: ramos };
}

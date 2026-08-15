import type { Prisma, PrismaClient } from "@azvchat/database";

/**
 * Responsável padrão: quem recebe automaticamente a conversa que chega sem
 * ninguém atribuído.
 *
 * Existem dois níveis, do mais específico para o mais geral:
 *
 * 1. o do departamento (`Department.defaultAssigneeId`), que vale para a
 *    conversa já classificada;
 * 2. o do número (`WhatsAppInstance.defaultAssigneeId`), que cobre o número
 *    dedicado a uma pessoa — aquele que não passa por departamento e cuja
 *    conversa nasce com `departmentId` nulo.
 *
 * O arquivo existe para os dois caminhos que atribuem (a ingestão de
 * mensagem e a aplicação em lote pela tela) usarem a MESMA definição de
 * quem pode receber. Regra de acesso duplicada é a forma mais fácil de a
 * conversa acabar atribuída a quem não consegue abri-la.
 */

/**
 * Filtro de usuário elegível a receber uma conversa deste número.
 *
 * Não basta estar ativo: quem recebe precisa **enxergar** a conversa, senão
 * a atribuição existe só no banco. Pelas regras de `lib/access.ts` isso
 * significa ter o número vinculado e, quando a conversa tem departamento,
 * atuar nele. Admin enxerga a organização inteira e não depende de vínculo.
 */
export function eligibleAssigneeWhere(input: {
  userId: string;
  organizationId: string;
  whatsappInstanceId: string;
  /** `undefined` quando o departamento não importa (ex.: validar o cadastro). */
  departmentId?: string | null;
}): Prisma.UserWhereInput {
  return {
    id: input.userId,
    organizationId: input.organizationId,
    status: "active",
    OR: [
      { role: "admin" },
      {
        whatsappAccess: { some: { whatsappInstanceId: input.whatsappInstanceId } },
        ...(input.departmentId
          ? { departmentAccess: { some: { departmentId: input.departmentId } } }
          : {}),
      },
    ],
  };
}

/** O alcance de quem vai receber as conversas em lote. */
export interface AssigneeReach {
  /** Admin enxerga tudo: não filtra por departamento. */
  isAdmin: boolean;
  departmentIds: string[];
}

/**
 * Carrega o alcance do responsável padrão de um número, ou `null` quando a
 * pessoa não pode receber conversa alguma dele (inativa, de outra
 * organização ou sem o número vinculado).
 */
export async function loadAssigneeReach(
  prisma: PrismaClient,
  input: { userId: string; organizationId: string; whatsappInstanceId: string },
): Promise<AssigneeReach | null> {
  const user = await prisma.user.findFirst({
    where: eligibleAssigneeWhere(input),
    select: {
      role: true,
      departmentAccess: { select: { departmentId: true } },
    },
  });
  if (!user) return null;
  return {
    isAdmin: user.role === "admin",
    departmentIds: user.departmentAccess.map((link) => link.departmentId),
  };
}

/**
 * As conversas de um número que essa pessoa enxerga. Espelha
 * `conversationScope` de `lib/access.ts` na parte de departamento: conversa
 * sem departamento é de quem tem o número.
 */
export function reachableConversationFilter(
  reach: AssigneeReach,
): Prisma.ConversationWhereInput {
  if (reach.isAdmin) return {};
  return {
    OR: [{ departmentId: null }, { departmentId: { in: reach.departmentIds } }],
  };
}

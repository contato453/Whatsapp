import type { Prisma, PrismaClient } from "@azvchat/database";
import {
  conversationScope,
  departmentResourceScope,
  loadConversationAccess,
  type ConversationAccess,
} from "./access.js";
import type { AuthTokenPayload } from "./auth.js";
import { NotFoundError } from "./errors.js";

/**
 * Quem enxerga qual OPORTUNIDADE.
 *
 * Nada aqui é regra nova: é a regra de `lib/access.ts` aplicada a outra
 * tabela. Isso não é preciosismo — o CRM guarda quanto o cliente vai pagar e
 * por qual serviço, que é informação mais sensível do que a conversa em si.
 * Uma segunda régua de visibilidade nasceria parecida e envelheceria
 * diferente, e o dia em que as duas divergissem ninguém veria: a oportunidade
 * apareceria para quem não pode ver o cliente, sem erro nenhum na tela.
 *
 * O recorte tem TRÊS condições, e as três vêm de `access.ts`:
 *
 *   a. **departamento** — o mesmo `OR [null, in(...)]` de `conversationScope`.
 *      Oportunidade sem departamento fica visível para quem alcança a
 *      conversa, igual à conversa sem departamento;
 *   b. **responsável**, para quem é `agent`: a dele mais as que estão sem
 *      dono. Idêntico ao `ownOnly` da conversa;
 *   c. **a conversa vinculada precisa estar no alcance** — e é esta que não
 *      pode faltar. Sem ela, bastaria a oportunidade estar num departamento
 *      que a pessoa acessa para o card de um cliente de OUTRO NÚMERO aparecer
 *      na tela dela, com valor e telefone. O número vinculado é condição
 *      absoluta no atendimento (ver CLAUDE.md §5) e continua sendo aqui.
 *
 * Oportunidade AVULSA (sem conversa) passa pela condição (c) porque não há
 * número a conferir: ela nasceu de um lead que ainda não escreveu, e o que a
 * recorta são departamento e responsável.
 */
export function opportunityScope(
  access: ConversationAccess,
): Prisma.CrmOpportunityWhereInput {
  const filters: Prisma.CrmOpportunityWhereInput[] = [];

  if (access.departmentIds) {
    filters.push({
      OR: [{ departmentId: null }, { departmentId: { in: access.departmentIds } }],
    });
  }
  if (access.ownOnly) {
    filters.push({ OR: [{ assignedUserId: access.userId }, { assignedUserId: null }] });
  }
  if (access.instanceIds || access.departmentIds || access.ownOnly) {
    // `is:` obrigatório em relação opcional — sem ele o Prisma trata o
    // escopo vazio do admin como filtro que não casa nada (ver `groupScope`).
    filters.push({
      OR: [{ conversationId: null }, { conversation: { is: conversationScope(access) } }],
    });
  }

  return filters.length > 0 ? { AND: filters } : {};
}

/** Atalho: carrega o acesso e devolve o `where` já com a organização. */
export async function accessibleOpportunityWhere(
  prisma: PrismaClient,
  user: AuthTokenPayload,
): Promise<Prisma.CrmOpportunityWhereInput> {
  const access = await loadConversationAccess(prisma, user);
  return { organizationId: user.organizationId, ...opportunityScope(access) };
}

/**
 * Recorte de FUNIL: o mesmo de etiqueta e resposta rápida.
 *
 * Funil geral aparece para todo mundo; funil restrito, para quem está em pelo
 * menos um dos departamentos dele. `departmentResourceScope` é literalmente a
 * mesma função que a etiqueta usa — o contrato do funil foi desenhado igual
 * (`isGeneral` + N:N) justamente para poder reusá-la.
 */
export function pipelineScope(departmentIds: string[] | null): Prisma.CrmPipelineWhereInput {
  return departmentResourceScope(departmentIds) as Prisma.CrmPipelineWhereInput;
}

/**
 * Uma oportunidade pelo id, dentro do que a pessoa enxerga — com tudo o que
 * o DTO precisa. Fora do recorte responde 404, e não 403: o padrão da casa é
 * "como se não existisse", senão o 403 confirma que aquele id existe.
 */
export const opportunityInclude = {
  pipeline: true,
  // As ações vêm junto porque mover o card roda as de SAÍDA desta etapa —
  // sem elas seria uma consulta a mais em todo arrasto.
  stage: { include: { actions: true } },
  assignedUser: true,
  department: true,
  product: true,
  lossReason: true,
  createdBy: true,
  // A etiqueta sai serializada como em qualquer outra tela (com os
  // departamentos), então o vínculo precisa vir resolvido.
  tags: { include: { tag: { include: { departments: { include: { department: true } } } } } },
  conversation: {
    include: { instance: true },
  },
  activities: {
    where: { status: "pending" as const },
    orderBy: { dueAt: "asc" as const },
    take: 1,
  },
} satisfies Prisma.CrmOpportunityInclude;

export type OpportunityWithRelations = Prisma.CrmOpportunityGetPayload<{
  include: typeof opportunityInclude;
}>;

export async function findAccessibleOpportunity(
  prisma: PrismaClient,
  user: AuthTokenPayload,
  id: string,
): Promise<OpportunityWithRelations> {
  const where = await accessibleOpportunityWhere(prisma, user);
  const opportunity = await prisma.crmOpportunity.findFirst({
    where: { ...where, id },
    include: opportunityInclude,
  });
  if (!opportunity) throw new NotFoundError("Oportunidade");
  return opportunity;
}

/**
 * A mesma busca, mas por id conhecido do SISTEMA (automação, resposta do
 * cliente): sem usuário, portanto sem recorte. Só a organização limita.
 *
 * Existe separada de propósito: quem chama daqui é código que roda sem
 * ninguém logado, e usar a função de cima com um usuário inventado seria a
 * porta para o recorte deixar de valer sem que ninguém notasse.
 */
export async function loadOpportunityForSystem(
  prisma: PrismaClient,
  organizationId: string,
  id: string,
): Promise<OpportunityWithRelations | null> {
  return prisma.crmOpportunity.findFirst({
    where: { id, organizationId },
    include: opportunityInclude,
  });
}

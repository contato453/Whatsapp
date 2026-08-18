import type { Prisma, PrismaClient } from "@azvchat/database";
import { hasRole, type UserRole } from "@azvchat/shared";
import type { AuthTokenPayload } from "./auth.js";

/**
 * Regras de visibilidade de conversa. Valem para toda leitura e escrita —
 * nenhuma rota monta filtro de acesso por conta própria.
 *
 * - admin: enxerga a organização inteira.
 * - supervisor: todas as conversas dos departamentos dele, dentro dos
 *   números vinculados ao login dele.
 * - usuário: dentro do mesmo recorte de número e departamento, só as
 *   conversas atribuídas a ele e as que ainda não têm responsável.
 *
 * O número vinculado é condição absoluta: conversa de número que não está
 * no login não aparece para ninguém além do admin, em nenhuma hipótese.
 *
 * Sem número marcado, ou sem departamento marcado, o usuário não enxerga
 * conversa alguma. Não existe mais o antigo "sem marcação = vê tudo".
 */
export interface ConversationAccess {
  /** `null` = admin, sem restrição. */
  instanceIds: string[] | null;
  /** `null` = admin, sem restrição. */
  departmentIds: string[] | null;
  /** true quando o usuário só pode ver o que é dele ou está sem responsável. */
  ownOnly: boolean;
  userId: string;
}

export async function loadConversationAccess(
  prisma: PrismaClient,
  user: AuthTokenPayload,
): Promise<ConversationAccess> {
  if (user.role === "admin") {
    return { instanceIds: null, departmentIds: null, ownOnly: false, userId: user.sub };
  }
  const [instances, departments] = await Promise.all([
    prisma.userWhatsAppInstance.findMany({
      where: { userId: user.sub, instance: { organizationId: user.organizationId } },
      select: { whatsappInstanceId: true },
    }),
    prisma.userDepartment.findMany({
      where: { userId: user.sub, department: { organizationId: user.organizationId } },
      select: { departmentId: true },
    }),
  ]);
  return {
    instanceIds: instances.map((link) => link.whatsappInstanceId),
    departmentIds: departments.map((link) => link.departmentId),
    ownOnly: user.role === "agent",
    userId: user.sub,
  };
}

/**
 * Filtro Prisma completo para Conversation. Combina número, departamento e,
 * para usuário comum, o recorte de responsável.
 *
 * Conversa sem departamento fica visível para quem tem o número: ela existe
 * quando o número não tem departamento padrão configurado, e sumir com ela
 * significaria mensagem de cliente que ninguém vê.
 */
export function conversationScope(access: ConversationAccess): Prisma.ConversationWhereInput {
  const filters: Prisma.ConversationWhereInput[] = [];
  if (access.instanceIds) {
    filters.push({ whatsappInstanceId: { in: access.instanceIds } });
  }
  if (access.departmentIds) {
    filters.push({
      OR: [{ departmentId: null }, { departmentId: { in: access.departmentIds } }],
    });
  }
  if (access.ownOnly) {
    filters.push({ OR: [{ assignedUserId: access.userId }, { assignedUserId: null }] });
  }
  return filters.length > 0 ? { AND: filters } : {};
}

/** Os números que o usuário enxerga. `null` = todos (admin). */
export async function accessibleInstanceIds(
  prisma: PrismaClient,
  user: AuthTokenPayload,
): Promise<string[] | null> {
  if (user.role === "admin") return null;
  const links = await prisma.userWhatsAppInstance.findMany({
    where: { userId: user.sub, instance: { organizationId: user.organizationId } },
    select: { whatsappInstanceId: true },
  });
  return links.map((link) => link.whatsappInstanceId);
}

/** Filtro Prisma para o campo `whatsappInstanceId` (vazio quando não há restrição). */
export function instanceScope(ids: string[] | null): { whatsappInstanceId?: { in: string[] } } {
  return ids ? { whatsappInstanceId: { in: ids } } : {};
}

/** Filtro Prisma para o campo `id` de WhatsAppInstance. */
export function instanceIdScope(ids: string[] | null): { id?: { in: string[] } } {
  return ids ? { id: { in: ids } } : {};
}

/** Os departamentos em que o usuário atua. `null` = todos (admin). */
export async function accessibleDepartmentIds(
  prisma: PrismaClient,
  user: AuthTokenPayload,
): Promise<string[] | null> {
  if (user.role === "admin") return null;
  const links = await prisma.userDepartment.findMany({
    where: { userId: user.sub, department: { organizationId: user.organizationId } },
    select: { departmentId: true },
  });
  return links.map((link) => link.departmentId);
}

/**
 * Filtro Prisma dos recursos ligados a departamentos em N:N — etiquetas e
 * respostas rápidas. Serve para `Tag` e para `QuickReply`, que têm a mesma
 * forma: a flag `isGeneral` e a coleção `departments`.
 */
export interface DepartmentResourceScope {
  OR?: Array<{ isGeneral: true } | { departments: { some: { departmentId: { in: string[] } } } }>;
}

/**
 * Filtro de leitura para recurso de vários departamentos: o usuário enxerga
 * o que é geral e o que está marcado para pelo menos um departamento dele.
 *
 * "Geral" é a flag `isGeneral`, e não mais a ausência de departamento. Se
 * lista vazia significasse geral, excluir um departamento esvaziaria a lista
 * de um item restrito e ele passaria a valer para a organização inteira sem
 * ninguém perceber. Com a flag, o item fica sem departamento e some para
 * quem não é admin — o lado seguro do erro.
 *
 * Admin recebe `{}`: nenhum filtro, enxerga tudo, inclusive o item que ficou
 * sem departamento e precisa ser arrumado.
 */
export function departmentResourceScope(ids: string[] | null): DepartmentResourceScope {
  if (!ids) return {};
  // Lista vazia não vira "vê tudo": o ramo `in: []` não casa nada e sobra só
  // o geral, que é o que a pessoa sem departamento deve mesmo enxergar.
  return { OR: [{ isGeneral: true }, { departments: { some: { departmentId: { in: ids } } } }] };
}

/**
 * Pode criar ou alterar um recurso geral, que vale para a organização
 * inteira? Continua sendo só o admin: `ids === null` é exatamente o "sem
 * restrição" que apenas ele recebe de `accessibleDepartmentIds`.
 */
export function canWriteGeneralResource(ids: string[] | null): boolean {
  return ids === null;
}

/**
 * Pode gravar um recurso restrito a estes departamentos?
 *
 * Exige acesso a TODOS eles, não a um só: com acesso apenas ao Fiscal, a
 * pessoa poderia pendurar a etiqueta também no Contábil e alterar o que a
 * outra equipe enxerga. Faltando um, a gravação inteira é recusada — nada
 * de salvar metade.
 *
 * Lista vazia é estado inválido para item restrito (o item ficaria invisível
 * para todo mundo menos o admin) e é recusada aqui também.
 */
export function canWriteInAllDepartments(
  ids: string[] | null,
  departmentIds: string[],
): boolean {
  if (departmentIds.length === 0) return false;
  if (!ids) return true;
  return departmentIds.every((departmentId) => ids.includes(departmentId));
}

/**
 * Recorte para consultas que partem do grupo (fotos e dados de
 * participante), e não da conversa.
 *
 * O `is:` é obrigatório: em relação opcional, o Prisma trata
 * `conversation: {}` como filtro que não casa nada — e o admin, cujo
 * escopo é vazio, deixaria de enxergar qualquer participante.
 */
export function groupScope(access: ConversationAccess): Prisma.WhatsAppGroupWhereInput {
  return {
    ...instanceScope(access.instanceIds),
    // Grupo ainda sem conversa continua visível: ele existe entre a
    // sincronização do grupo e a primeira mensagem.
    OR: [{ conversationId: null }, { conversation: { is: conversationScope(access) } }],
  };
}

/**
 * A conversa, na medida em que ela decide quem pode receber o atendimento:
 * o número em que ela vive e o departamento em que ela está classificada.
 */
export interface AssignableConversation {
  whatsappInstanceId: string;
  /** `null` = conversa ainda sem departamento. */
  departmentId: string | null;
}

/**
 * Quem pode RECEBER esta conversa — a lista de candidatos a responsável.
 *
 * É a mesma pergunta de `conversationScope`, virada do avesso: em vez de
 * "quais conversas esta pessoa enxerga", "quais pessoas enxergam esta
 * conversa". Por isso mora aqui, e não na rota: candidato calculado em dois
 * lugares vira duas regras diferentes na primeira manutenção.
 *
 * As duas condições valem JUNTAS, e a do número não é detalhe. Transferir
 * para alguém do departamento certo que não tem aquele chip vinculado grava
 * um responsável que nunca vai abrir a conversa: ela sai da fila de quem
 * estava livre, some da tela de todo mundo e nenhum erro aparece — a falha
 * só é notada quando o cliente cobra a resposta.
 *
 * O departamento que manda é o DA CONVERSA, nunca o de quem transfere: se
 * valesse o de quem move, uma pessoa de vários departamentos empurraria a
 * conversa para outra área sem passar por
 * `POST /conversations/:id/transfer-department`, que é restrita à supervisão
 * justamente porque muda quem enxerga.
 *
 * Conversa SEM departamento não restringe nada além do número: ela já é
 * visível para todos que têm o chip (ver `conversationScope`), então exigir
 * um departamento aqui inventaria uma barreira que a leitura não tem.
 *
 * Inativo nunca é candidato: atribuir a quem não entra mais no sistema é
 * outra forma de conversa órfã.
 *
 * Admin entra sem vínculo nenhum porque ele realmente enxerga a organização
 * inteira — o critério continua sendo "enxerga a conversa", e não "tem
 * linha em UserWhatsAppInstance".
 */
export function conversationAssigneeWhere(
  organizationId: string,
  conversation: AssignableConversation,
): Prisma.UserWhereInput {
  return {
    organizationId,
    status: "active",
    OR: [
      { role: "admin" },
      {
        whatsappAccess: { some: { whatsappInstanceId: conversation.whatsappInstanceId } },
        ...(conversation.departmentId
          ? { departmentAccess: { some: { departmentId: conversation.departmentId } } }
          : {}),
      },
    ],
  };
}

/**
 * Pode transferir para alguém FORA do alcance da conversa?
 *
 * Supervisor e admin podem: existe o caso legítimo de puxar alguém de outra
 * área para um atendimento, e travar a supervisão criaria um problema pior
 * do que o que a regra resolve. A tela avisa antes de gravar, com
 * confirmação explícita — o que não pode é acontecer em silêncio.
 *
 * O atendente não pode, e a recusa é do servidor: lista filtrada na tela é
 * conveniência, não controle de acesso.
 */
export function canAssignBeyondConversationReach(role: UserRole): boolean {
  return hasRole(role, "supervisor");
}

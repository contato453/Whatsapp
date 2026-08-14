import type { Prisma, PrismaClient } from "@azvchat/database";
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
 * Filtro de leitura para recursos que pertencem a um departamento
 * (etiquetas e respostas rápidas).
 *
 * `departmentId: null` significa "geral" e aparece para todo mundo — é o
 * que preserva o que já existia antes de os recursos terem departamento.
 */
export function departmentResourceScope(
  ids: string[] | null,
): { OR?: Array<{ departmentId: null } | { departmentId: { in: string[] } }> } {
  if (!ids) return {};
  return { OR: [{ departmentId: null }, { departmentId: { in: ids } }] };
}

/**
 * Pode criar ou alterar um recurso neste departamento?
 *
 * Admin faz tudo, inclusive o geral. Os demais só dentro dos próprios
 * departamentos — e nunca no geral, que vale para a organização inteira.
 */
export function canWriteInDepartment(
  ids: string[] | null,
  departmentId: string | null,
): boolean {
  if (!ids) return true;
  if (!departmentId) return false;
  return ids.includes(departmentId);
}

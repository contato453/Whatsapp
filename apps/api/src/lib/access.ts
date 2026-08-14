import type { PrismaClient } from "@zapdesk/database";
import type { AuthTokenPayload } from "./auth.js";

/**
 * Escopo de conexões (números de WhatsApp) que um usuário pode enxergar.
 *
 * Regras:
 * - admin sempre vê todas as conexões da organização;
 * - usuário sem nenhuma conexão vinculada também vê todas (padrão de quem
 *   nunca teve acesso restringido);
 * - caso contrário, vê apenas as conexões vinculadas a ele.
 *
 * `null` significa "sem restrição" — é diferente de uma lista vazia.
 */
export async function accessibleInstanceIds(
  prisma: PrismaClient,
  user: AuthTokenPayload,
): Promise<string[] | null> {
  if (user.role === "admin") return null;
  const links = await prisma.userWhatsAppInstance.findMany({
    where: { userId: user.sub, instance: { organizationId: user.organizationId } },
    select: { whatsappInstanceId: true },
  });
  if (links.length === 0) return null;
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

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  CONFIGURABLE_ROLES,
  PERMISSION_ACTION_KEYS,
  defaultPermission,
  type ConfigurableRole,
  type PermissionAction,
} from "@azvchat/shared";
import { requireRole } from "../../lib/auth.js";
import { invalidatePermissionCache } from "../../lib/permissions.js";
import { serializeRolePermission } from "../../lib/serialize.js";
import type { AppDeps } from "../../types.js";

/**
 * Tela de Permissões: o que cada perfil PODE FAZER vira configuração do
 * escritório em vez de linha de código.
 *
 * A tela é de ADMIN, e isso é fixo: `requireRole("admin")`, sem chave no
 * catálogo. Uma chave "editar permissões" permitiria a um supervisor se
 * promover sozinho, e o menu inteiro deixaria de valer alguma coisa.
 *
 * Só o que difere do padrão é gravado. Ligar uma chave de volta ao padrão
 * APAGA a linha, em vez de gravar o mesmo valor: assim o padrão do catálogo
 * continua sendo o padrão de verdade, e mudá-lo no código passa a valer
 * para quem nunca mexeu naquela chave.
 */

/**
 * Nome de ação é validado contra o catálogo, e não aceito como texto livre:
 * chave desconhecida gravada aqui seria permissão órfã, invisível na tela e
 * sem efeito nenhum na API.
 */
const permissionActionSchema = z.enum(
  PERMISSION_ACTION_KEYS as unknown as [PermissionAction, ...PermissionAction[]],
);

const updateSchema = z.object({
  entries: z
    .array(
      z.object({
        role: z.enum(CONFIGURABLE_ROLES),
        action: permissionActionSchema,
        allowed: z.boolean(),
      }),
    )
    .max(CONFIGURABLE_ROLES.length * PERMISSION_ACTION_KEYS.length),
});

export async function permissionRoutes(app: FastifyInstance, deps: AppDeps): Promise<void> {
  /**
   * O que está gravado hoje. O catálogo (rótulos, descrições, áreas e
   * padrões) NÃO vem daqui: a tela o importa de `@azvchat/shared`, que é a
   * fonte única — mandá-lo pela rota criaria a segunda lista que este
   * desenho existe para evitar.
   */
  app.get("/permissions", { preHandler: requireRole("admin") }, async (request) => {
    const rows = await deps.prisma.rolePermission.findMany({
      where: { organizationId: request.user.organizationId },
      include: { updatedBy: true },
    });
    return {
      overrides: rows
        // Linha de ação que saiu do código é ignorada em silêncio: limpeza de
        // catálogo não pode quebrar a tela.
        .filter((row) => (PERMISSION_ACTION_KEYS as readonly string[]).includes(row.action))
        .map((row) =>
          serializeRolePermission({
            role: row.role as ConfigurableRole,
            action: row.action,
            allowed: row.allowed,
            updatedAt: row.updatedAt,
            updatedBy: row.updatedBy,
          }),
        ),
    };
  });

  /**
   * Gravação em bloco: a tela manda o que mudou de uma vez, com confirmação
   * explícita. Salvar a cada clique deixaria a organização passando por
   * estados intermediários que ninguém pediu.
   *
   * É o registro mais sensível do sistema, então cada par (papel, ação) que
   * mudou entra no AuditLog com valor anterior e novo — e o antes é o valor
   * EFETIVO de antes (padrão do catálogo quando não havia linha), não
   * "nulo": quem for reconstituir a mudança quer saber o que valia.
   */
  app.put("/permissions", { preHandler: requireRole("admin") }, async (request) => {
    const { entries } = updateSchema.parse(request.body);
    const organizationId = request.user.organizationId;

    const before = await deps.prisma.rolePermission.findMany({ where: { organizationId } });
    const beforeByKey = new Map(before.map((row) => [`${row.role}:${row.action}`, row.allowed]));

    const changes: Array<{
      role: ConfigurableRole;
      action: PermissionAction;
      from: boolean;
      to: boolean;
    }> = [];

    await deps.prisma.$transaction(async (tx) => {
      for (const entry of entries) {
        const key = `${entry.role}:${entry.action}`;
        const fallback = defaultPermission(entry.action, entry.role);
        const current = beforeByKey.get(key) ?? fallback;
        if (current === entry.allowed) continue;

        if (entry.allowed === fallback) {
          // Voltou ao padrão: a linha some. Guardar o valor igual ao padrão
          // congelaria o padrão de hoje para esta organização.
          await tx.rolePermission.deleteMany({
            where: { organizationId, role: entry.role, action: entry.action },
          });
        } else {
          await tx.rolePermission.upsert({
            where: {
              organizationId_role_action: {
                organizationId,
                role: entry.role,
                action: entry.action,
              },
            },
            create: {
              organizationId,
              role: entry.role,
              action: entry.action,
              allowed: entry.allowed,
              updatedById: request.user.sub,
            },
            update: { allowed: entry.allowed, updatedById: request.user.sub },
          });
        }
        changes.push({
          role: entry.role,
          action: entry.action,
          from: current,
          to: entry.allowed,
        });
      }
    });

    // A mudança vale na ação seguinte, sem esperar o TTL e sem reiniciar o
    // container — que é exatamente o problema que esta tela veio resolver.
    invalidatePermissionCache(organizationId);

    for (const change of changes) {
      deps.audit.record({
        organizationId,
        userId: request.user.sub,
        action: "permissions.updated",
        entityType: "RolePermission",
        entityId: `${change.role}:${change.action}`,
        metadata: {
          role: change.role,
          permission: change.action,
          before: change.from,
          after: change.to,
        },
        ip: request.ip,
      });
    }
    if (changes.length > 0) {
      request.log.info({ event: "permissions_updated", changes: changes.length });
    }

    const rows = await deps.prisma.rolePermission.findMany({
      where: { organizationId },
      include: { updatedBy: true },
    });
    return {
      overrides: rows
        .filter((row) => (PERMISSION_ACTION_KEYS as readonly string[]).includes(row.action))
        .map((row) =>
          serializeRolePermission({
            role: row.role as ConfigurableRole,
            action: row.action,
            allowed: row.allowed,
            updatedAt: row.updatedAt,
            updatedBy: row.updatedBy,
          }),
        ),
    };
  });
}

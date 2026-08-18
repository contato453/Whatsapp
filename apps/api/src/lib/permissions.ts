import type { PrismaClient } from "@azvchat/database";
import {
  allowedPermissions,
  isConfigurableRole,
  isPermissionAction,
  PERMISSION_DENIED_CODE,
  permissionDeniedMessage,
  permissionOverrideKey,
  resolvePermission,
  type PermissionAction,
  type PermissionOverrides,
} from "@azvchat/shared";
import type { FastifyReply, FastifyRequest } from "fastify";
import { authenticate, type AuthTokenPayload } from "./auth.js";
import { AppError } from "./errors.js";

/**
 * O motor de permissão: UMA função decide toda ação do sistema.
 *
 * Por que existe uma função única, e por que é proibido espalhar `if` de
 * papel dentro de handler: com a regra escrita em cada rota, ligar ou
 * desligar uma chave na tela passaria a valer em umas rotas e não em
 * outras, e a diferença só apareceria quando alguém conseguisse fazer o
 * que o dono do escritório achava ter bloqueado. Uma porta só, e ela é
 * esta.
 *
 * PERMISSÃO É AÇÃO, VISIBILIDADE É ALCANCE. Nada aqui filtra conversa:
 * o recorte de quem enxerga o quê continua saindo inteiro de `access.ts`,
 * e a chave entra POR CIMA dele, nunca no lugar. Uma pessoa com o catálogo
 * inteiro ligado continua vendo apenas as conversas dos números e
 * departamentos dela.
 */

/**
 * Cache de vida curta da configuração da organização.
 *
 * A decisão não pode custar uma consulta por checagem (um envio de mensagem
 * consulta várias), e também não pode exigir reinício do container para
 * valer — que é exatamente o problema que a tela veio resolver. Por isso os
 * dois: janela curta e invalidação explícita na gravação. A API roda em
 * instância única (ver CLAUDE.md §8), então a invalidação alcança todo mundo.
 */
const CACHE_TTL_MS = 5_000;

interface CacheEntry {
  expiresAt: number;
  overrides: PermissionOverrides;
}

const cache = new Map<string, CacheEntry>();

/** Chamada pela gravação: a mudança vale na ação seguinte, sem esperar o TTL. */
export function invalidatePermissionCache(organizationId: string): void {
  cache.delete(organizationId);
}

/** Só para os testes — zera o estado entre casos. */
export function clearPermissionCache(): void {
  cache.clear();
}

/**
 * Configuração gravada pela organização, já em mapa `papel:ação`.
 *
 * Linha de ação que saiu do catálogo é descartada aqui, em silêncio: uma
 * limpeza de catálogo não pode quebrar a leitura nem a tela. Linha de
 * `admin` idem — o banco já a proíbe, e ignorá-la aqui fecha o caminho.
 */
export async function loadOrganizationPermissions(
  prisma: PrismaClient,
  organizationId: string,
): Promise<PermissionOverrides> {
  const cached = cache.get(organizationId);
  const now = Date.now();
  if (cached && cached.expiresAt > now) return cached.overrides;

  const rows = await prisma.rolePermission.findMany({
    where: { organizationId },
    select: { role: true, action: true, allowed: true },
  });
  const overrides = new Map<string, boolean>();
  for (const row of rows) {
    if (!isConfigurableRole(row.role)) continue;
    if (!isPermissionAction(row.action)) continue;
    overrides.set(permissionOverrideKey(row.role, row.action), row.allowed);
  }
  cache.set(organizationId, { expiresAt: now + CACHE_TTL_MS, overrides });
  return overrides;
}

/** A decisão já amarrada a uma pessoa — é isto que as rotas consultam. */
export interface UserPermissions {
  can(action: PermissionAction): boolean;
  /** Recusa a ação com mensagem que nomeia a chave desligada. */
  assert(action: PermissionAction): void;
  /** Tudo o que esta pessoa pode fazer — vai para o frontend no login. */
  allowed(): PermissionAction[];
}

export async function loadPermissions(
  prisma: PrismaClient,
  user: AuthTokenPayload,
): Promise<UserPermissions> {
  const overrides = await loadOrganizationPermissions(prisma, user.organizationId);
  return buildPermissions(user, overrides);
}

/** Versão pura, sem banco — usada pelos testes e por quem já tem a configuração. */
export function buildPermissions(
  user: Pick<AuthTokenPayload, "role">,
  overrides: PermissionOverrides,
): UserPermissions {
  const can = (action: PermissionAction): boolean =>
    resolvePermission(user.role, action, overrides);
  return {
    can,
    assert(action) {
      if (!can(action)) {
        throw new AppError(permissionDeniedMessage(action), 403, PERMISSION_DENIED_CODE);
      }
    },
    allowed: () => allowedPermissions(user.role, overrides),
  };
}

/**
 * preHandler que autentica e exige uma chave do catálogo.
 *
 * Substitui `requireRole()` em toda rota que representa uma ação
 * configurável. `requireRole("admin")` continua existindo para o que é
 * fixo no código de propósito: excluir número, excluir departamento,
 * criar e editar usuário, e a própria tela de Permissões.
 */
export function requirePermission(
  deps: { prisma: PrismaClient },
  action: PermissionAction,
) {
  return async (request: FastifyRequest, _reply: FastifyReply): Promise<void> => {
    await authenticate(request);
    const permissions = await loadPermissions(deps.prisma, request.user);
    permissions.assert(action);
  };
}

/**
 * preHandler para rota que atende mais de uma ação e basta uma delas.
 *
 * Hoje serve à busca de empresas do Azevedo-OS: ela existe para vincular e
 * para trocar vínculo, e quem pode qualquer um dos dois precisa pesquisar.
 */
export function requireAnyPermission(
  deps: { prisma: PrismaClient },
  actions: readonly PermissionAction[],
) {
  return async (request: FastifyRequest, _reply: FastifyReply): Promise<void> => {
    await authenticate(request);
    const permissions = await loadPermissions(deps.prisma, request.user);
    if (actions.some((action) => permissions.can(action))) return;
    const [first] = actions;
    throw new AppError(
      permissionDeniedMessage(first ?? ""),
      403,
      PERMISSION_DENIED_CODE,
    );
  };
}

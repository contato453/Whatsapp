import type { PrismaClient } from "@azvchat/database";
import { AppError } from "./errors.js";

/**
 * Os MÓDULOS ligados nesta organização.
 *
 * Isto não é permissão, e a diferença importa: permissão diz o que cada
 * PERFIL pode fazer com um recurso que existe; módulo diz se o recurso existe
 * para o escritório. Uma chave "usar o CRM" no catálogo de permissões
 * deixaria metade da equipe com o menu e a outra metade sem — isso é
 * configuração, não é desligar o módulo. Por isso mora numa coluna do
 * `Organization`, e não em `PERMISSION_ACTIONS`.
 *
 * O cache é o mesmo desenho do de permissões (`lib/permissions.ts`), pelo
 * mesmo motivo: a checagem não pode custar uma consulta por requisição, e
 * também não pode exigir reiniciar o container para valer. Janela curta mais
 * invalidação explícita na gravação; a API roda em instância única, então a
 * invalidação alcança todo mundo.
 */

const CACHE_TTL_MS = 5_000;

export interface OrganizationFeatures {
  /** CRM (Kanban) ligado. Nasce ligado — ver a coluna no schema. */
  crm: boolean;
}

interface CacheEntry {
  expiresAt: number;
  features: OrganizationFeatures;
}

const cache = new Map<string, CacheEntry>();

/** Chamada pela gravação: a mudança vale na ação seguinte, sem esperar o TTL. */
export function invalidateOrganizationFeatures(organizationId: string): void {
  cache.delete(organizationId);
}

/** Só para os testes — zera o estado entre casos. */
export function clearOrganizationFeaturesCache(): void {
  cache.clear();
}

export async function loadOrganizationFeatures(
  prisma: PrismaClient,
  organizationId: string,
): Promise<OrganizationFeatures> {
  const cached = cache.get(organizationId);
  const now = Date.now();
  if (cached && cached.expiresAt > now) return cached.features;

  const organization = await prisma.organization.findUnique({
    where: { id: organizationId },
    select: { crmEnabled: true },
  });
  // Organização que sumiu no meio da requisição: o lado seguro é o módulo
  // DESLIGADO, não ligado — sem organização não há nada legítimo a fazer.
  const features: OrganizationFeatures = { crm: organization?.crmEnabled ?? false };
  cache.set(organizationId, { expiresAt: now + CACHE_TTL_MS, features });
  return features;
}

export const CRM_DISABLED_CODE = "crm_disabled";

/**
 * Recusa quando o módulo está desligado.
 *
 * É conferido ANTES da chave de permissão em toda rota do CRM: com o módulo
 * desligado, nem quem tem todas as chaves deve conseguir criar oportunidade —
 * senão "desligar" seria só esconder o menu, e o sistema continuaria abrindo
 * card e agendando follow-up de um módulo que o escritório desligou.
 */
export function assertCrmEnabled(features: OrganizationFeatures): void {
  if (features.crm) return;
  throw new AppError(
    "O CRM está desativado para este escritório. Um administrador pode religá-lo em Configurações.",
    403,
    CRM_DISABLED_CODE,
  );
}

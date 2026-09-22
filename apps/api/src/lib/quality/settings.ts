import type { PrismaClient } from "@azvchat/database";
import { QUALITY_DEFAULT_SETTINGS, type QualitySettingsDto } from "@azvchat/shared";

/**
 * Os tetos do Quality, lidos do banco A CADA DISPARO — sem cache, pelo mesmo
 * motivo dos parâmetros de atendimento: em cache, baixar o teto de conversas
 * para conter custo só valeria depois de reiniciar o contêiner, que é
 * exatamente o problema que a tela de configuração veio resolver.
 *
 * Linha ausente cai nos padrões do shared em vez de recusar o disparo:
 * organização que nunca abriu a tela precisa poder usar o módulo.
 */
export interface QualitySettingsView {
  maxConversationsPerRun: number;
  maxAudioSeconds: number;
  minCoveragePercent: number;
  model: string | null;
  updatedAt: Date | null;
}

export const DEFAULT_QUALITY_SETTINGS: QualitySettingsView = {
  ...QUALITY_DEFAULT_SETTINGS,
  model: null,
  updatedAt: null,
};

export async function loadQualitySettings(
  prisma: PrismaClient,
  organizationId: string,
): Promise<QualitySettingsView> {
  const row = await prisma.qualitySettings.findUnique({ where: { organizationId } });
  if (!row) return DEFAULT_QUALITY_SETTINGS;
  return {
    maxConversationsPerRun: row.maxConversationsPerRun,
    maxAudioSeconds: row.maxAudioSeconds,
    minCoveragePercent: row.minCoveragePercent,
    model: row.model,
    updatedAt: row.updatedAt,
  };
}

export function serializeQualitySettings(view: QualitySettingsView): QualitySettingsDto {
  return {
    maxConversationsPerRun: view.maxConversationsPerRun,
    maxAudioSeconds: view.maxAudioSeconds,
    minCoveragePercent: view.minCoveragePercent,
    model: view.model,
    updatedAt: view.updatedAt ? view.updatedAt.toISOString() : null,
  };
}

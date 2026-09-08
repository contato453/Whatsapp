import type { PrismaClient } from "@azvchat/database";
import {
  CRM_POSITION_STEP,
  DEFAULT_LOSS_REASONS,
  DEFAULT_PIPELINE_NAME,
  DEFAULT_PIPELINE_STAGES,
} from "@azvchat/shared";

/**
 * O funil que o escritório encontra pronto na primeira vez que abre o CRM.
 *
 * Por que aqui e não no seed: o seed só roda em instalação nova, e a
 * organização que já existe em produção (a única de verdade hoje) nunca
 * passaria por ele — ela abriria o Kanban num quadro sem colunas, sem ter o
 * que arrastar e sem entender se o recurso funciona. Semear na migration
 * também não serve: SQL não conhece o catálogo de `@azvchat/shared`, e o
 * modelo de funil ficaria congelado em duas cópias.
 *
 * É IDEMPOTENTE por construção e checa antes de escrever: existindo QUALQUER
 * funil, não faz nada. Assim, o escritório que apagar o funil padrão de
 * propósito não o vê renascer na próxima carga da tela — o que seria pior do
 * que não ter nada, porque ninguém entenderia de onde ele voltou.
 */
export async function ensureDefaultCrmSetup(
  prisma: PrismaClient,
  organizationId: string,
): Promise<void> {
  const [pipelines, reasons] = await Promise.all([
    prisma.crmPipeline.count({ where: { organizationId } }),
    prisma.crmLossReason.count({ where: { organizationId } }),
  ]);

  if (reasons === 0) {
    // Os motivos de perda alimentam relatório: sem lista de partida, cada um
    // digitaria "preço" de um jeito e o gráfico nasceria inútil.
    await prisma.crmLossReason.createMany({
      data: DEFAULT_LOSS_REASONS.map((name, index) => ({
        organizationId,
        name,
        position: index * 10,
      })),
      skipDuplicates: true,
    });
  }

  if (pipelines > 0) return;

  await prisma.crmPipeline.create({
    data: {
      organizationId,
      name: DEFAULT_PIPELINE_NAME,
      description: "Funil inicial do escritório. Tudo aqui pode ser renomeado e reordenado.",
      // Nasce GERAL (vale para todos os departamentos) porque o contrário —
      // amarrado a um departamento escolhido pelo sistema — esconderia o
      // Kanban de quase todo mundo no primeiro acesso, e o recurso pareceria
      // quebrado em vez de configurável.
      isGeneral: true,
      isDefault: true,
      stages: {
        create: DEFAULT_PIPELINE_STAGES.map((stage, index) => ({
          organizationId,
          name: stage.name,
          position: (index + 1) * CRM_POSITION_STEP,
          color: stage.color,
          probability: stage.probability,
          type: stage.type,
        })),
      },
    },
  });
}

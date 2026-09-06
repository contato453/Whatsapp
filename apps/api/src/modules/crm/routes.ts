import type { Prisma } from "@azvchat/database";
import {
  CRM_ACTIVITY_PRIORITIES,
  CRM_ACTIVITY_TYPES,
  CRM_BOARD_PAGE_SIZE,
  CRM_LIST_PAGE_SIZE,
  CRM_ORIGINS,
  CRM_STAGE_ACTION_TRIGGERS,
  CRM_STAGE_ACTION_TYPES,
  CRM_STAGE_TYPES,
  CRM_POSITION_STEP,
  isCrmActivityOverdue,
} from "@azvchat/shared";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { accessibleDepartmentIds, conversationAssigneeWhere } from "../../lib/access.js";
import { findAccessibleConversation } from "../../lib/conversation-access.js";
import {
  accessibleOpportunityWhere,
  findAccessibleOpportunity,
  opportunityInclude,
  pipelineScope,
} from "../../lib/crm-access.js";
import { ensureDefaultCrmSetup } from "../../lib/crm-bootstrap.js";
import { emitCrmOpportunity, emitCrmOpportunityById } from "../../lib/crm-events.js";
import { recordCrmEvent } from "../../lib/crm-history.js";
import {
  averageDaysInStage,
  breakdown,
  summarizePeriod,
  totalsByStage,
  totalsOverall,
  type ClosedRow,
  type CrmMetricRow,
} from "../../lib/crm-metrics.js";
import { moveCrmOpportunity } from "../../lib/crm-move.js";
import { createCrmOpportunity } from "../../lib/crm-opportunity.js";
import {
  decimalToNumber,
  serializeCrmActivity,
  serializeCrmEvent,
  serializeCrmLossReason,
  serializeCrmOpportunity,
  serializeCrmPipeline,
  serializeCrmProduct,
  serializeCrmStage,
} from "../../lib/crm-serialize.js";
import {
  assertCanManageResource,
  resolveDepartmentTarget,
} from "../../lib/department-resource.js";
import { AppError, NotFoundError } from "../../lib/errors.js";
import { requirePermission } from "../../lib/permissions.js";
import { serializeUserDirectory } from "../../lib/serialize.js";
import type { AppDeps } from "../../types.js";

/**
 * O CRM: funil de oportunidades por cima do atendimento.
 *
 * TRÊS COISAS QUE VALEM PARA TODA ROTA DAQUI:
 *
 * 1. **visibilidade sai de `lib/access.ts`, sempre.** `opportunityScope` é a
 *    regra da conversa aplicada à oportunidade, e nenhuma rota monta `where`
 *    de acesso na mão. Permissão do catálogo entra POR CIMA disso, nunca no
 *    lugar: `crm.view` ligada não faz ninguém enxergar cliente de outro
 *    número (CLAUDE.md §13);
 * 2. **o contato é a conversa.** Não existe rota de cadastro de cliente aqui,
 *    e não pode passar a existir;
 * 3. **o follow-up é `ScheduledMessage`.** Não existe agendador do CRM.
 */

const idParam = z.object({ id: z.string().uuid() });

/** Lista que chega como parâmetro repetido OU separada por vírgula. */
function listParam(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  const bruto = Array.isArray(value) ? value : [value];
  return bruto
    .flatMap((item) => String(item).split(","))
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

const departmentTargetFields = {
  isGeneral: z.boolean().default(false),
  departmentIds: z.array(z.string().uuid()).default([]),
};

const PIPELINE_LABELS = {
  general: "Apenas quem administra funis pode criar funil para todos os departamentos",
  foreign: "Você não tem acesso a todos os departamentos selecionados",
};

const PIPELINE_MANAGE_LABELS = {
  ...PIPELINE_LABELS,
  orphan: "Este funil ficou sem departamento — só o administrador pode ajustá-lo",
};

const stageActionSchema = z.object({
  trigger: z.enum(CRM_STAGE_ACTION_TRIGGERS).default("enter"),
  type: z.enum(CRM_STAGE_ACTION_TYPES),
  tagId: z.string().uuid().nullish(),
  userId: z.string().uuid().nullish(),
  departmentId: z.string().uuid().nullish(),
  delayMinutes: z.number().int().min(0).max(60 * 24 * 90).default(0),
  content: z.string().max(4000).nullish(),
});

const stageFieldsSchema = z.object({
  name: z.string().min(1).max(60),
  color: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .default("#64748b"),
  probability: z.number().int().min(0).max(100).default(0),
  type: z.enum(CRM_STAGE_TYPES).default("in_progress"),
  slaDays: z.number().int().min(0).max(365).nullish(),
  actions: z.array(stageActionSchema).max(20).optional(),
});

const opportunityFieldsSchema = z.object({
  title: z.string().min(1).max(160).optional(),
  conversationId: z.string().uuid().nullish(),
  contactName: z.string().max(160).nullish(),
  contactPhone: z.string().max(30).nullish(),
  assignedUserId: z.string().uuid().nullish(),
  departmentId: z.string().uuid().nullish(),
  productId: z.string().uuid().nullish(),
  value: z.number().min(0).max(999_999_999).nullish(),
  discount: z.number().min(0).max(999_999_999).nullish(),
  probability: z.number().int().min(0).max(100).nullish(),
  expectedCloseDate: z.string().datetime().nullish(),
  origin: z.enum(CRM_ORIGINS).nullish(),
  notes: z.string().max(4000).nullish(),
});

export async function crmRoutes(app: FastifyInstance, deps: AppDeps): Promise<void> {
  // ============================================================
  // Funis e etapas
  // ============================================================

  /**
   * Os funis que esta pessoa enxerga, com as etapas já dentro.
   *
   * É esta rota que semeia o funil inicial da organização (uma vez só, ver
   * `ensureDefaultCrmSetup`): sem isso quem abrisse o CRM pela primeira vez
   * encontraria um quadro sem colunas e concluiria que o recurso não funciona.
   */
  app.get("/crm/pipelines", { preHandler: requirePermission(deps, "crm.view") }, async (request) => {
    await ensureDefaultCrmSetup(deps.prisma, request.user.organizationId);
    const departmentIds = await accessibleDepartmentIds(deps.prisma, request.user);
    const pipelines = await deps.prisma.crmPipeline.findMany({
      where: {
        organizationId: request.user.organizationId,
        ...pipelineScope(departmentIds),
      },
      include: {
        departments: { include: { department: true } },
        stages: { include: { actions: true }, orderBy: { position: "asc" } },
      },
      orderBy: [{ isDefault: "desc" }, { position: "asc" }, { name: "asc" }],
    });
    return { pipelines: pipelines.map(serializeCrmPipeline) };
  });

  app.post(
    "/crm/pipelines",
    { preHandler: requirePermission(deps, "crm.pipeline.manage") },
    async (request, reply) => {
      const body = z
        .object({
          name: z.string().min(1).max(80),
          description: z.string().max(500).nullish(),
          color: z
            .string()
            .regex(/^#[0-9a-fA-F]{6}$/)
            .default("#102a4c"),
          autoCreateTagId: z.string().uuid().nullish(),
          ...departmentTargetFields,
        })
        .parse(request.body);

      const accessible = await accessibleDepartmentIds(deps.prisma, request.user);
      // Mesma régua de etiqueta e resposta rápida: geral OU pelo menos um
      // departamento, e escrita exige acesso a TODOS os escolhidos.
      const target = await resolveDepartmentTarget(
        deps.prisma,
        request.user,
        accessible,
        body,
        PIPELINE_LABELS,
        { canWriteGeneral: true },
      );

      const existente = await deps.prisma.crmPipeline.findFirst({
        where: { organizationId: request.user.organizationId, name: body.name },
        select: { id: true },
      });
      if (existente) {
        throw new AppError("Já existe um funil com este nome", 409, "crm_pipeline_exists");
      }

      const ultimo = await deps.prisma.crmPipeline.findFirst({
        where: { organizationId: request.user.organizationId },
        orderBy: { position: "desc" },
        select: { position: true },
      });

      const pipeline = await deps.prisma.crmPipeline.create({
        data: {
          organizationId: request.user.organizationId,
          name: body.name,
          description: body.description ?? null,
          color: body.color,
          isGeneral: target.isGeneral,
          autoCreateTagId: body.autoCreateTagId ?? null,
          position: (ultimo?.position ?? 0) + 10,
          createdById: request.user.sub,
          departments: { create: target.departmentIds.map((departmentId) => ({ departmentId })) },
        },
        include: {
          departments: { include: { department: true } },
          stages: { include: { actions: true } },
        },
      });
      deps.audit.record({
        organizationId: request.user.organizationId,
        userId: request.user.sub,
        action: "crm.pipeline_created",
        entityType: "CrmPipeline",
        entityId: pipeline.id,
        metadata: { name: pipeline.name },
      });
      return reply.status(201).send({ pipeline: serializeCrmPipeline(pipeline) });
    },
  );

  app.patch(
    "/crm/pipelines/:id",
    { preHandler: requirePermission(deps, "crm.pipeline.manage") },
    async (request) => {
      const { id } = idParam.parse(request.params);
      const body = z
        .object({
          name: z.string().min(1).max(80).optional(),
          description: z.string().max(500).nullish(),
          color: z
            .string()
            .regex(/^#[0-9a-fA-F]{6}$/)
            .optional(),
          isActive: z.boolean().optional(),
          isDefault: z.boolean().optional(),
          autoCreateTagId: z.string().uuid().nullish(),
          isGeneral: z.boolean().optional(),
          departmentIds: z.array(z.string().uuid()).optional(),
        })
        .parse(request.body);

      const accessible = await accessibleDepartmentIds(deps.prisma, request.user);
      const atual = await deps.prisma.crmPipeline.findFirst({
        where: { id, organizationId: request.user.organizationId },
        include: { departments: true },
      });
      if (!atual) throw new NotFoundError("Funil");

      const estadoAtual = {
        isGeneral: atual.isGeneral,
        departmentIds: atual.departments.map((link) => link.departmentId),
      };
      // Precisa poder mexer no funil COMO ELE ESTÁ, e não só no destino:
      // senão bastaria mandar o próprio departamento no corpo para editar o
      // funil de outra área.
      assertCanManageResource(accessible, estadoAtual, PIPELINE_MANAGE_LABELS, {
        canWriteGeneral: true,
      });

      const target =
        body.isGeneral !== undefined || body.departmentIds !== undefined
          ? await resolveDepartmentTarget(
              deps.prisma,
              request.user,
              accessible,
              {
                isGeneral: body.isGeneral ?? estadoAtual.isGeneral,
                departmentIds: body.departmentIds ?? estadoAtual.departmentIds,
              },
              PIPELINE_LABELS,
              { canWriteGeneral: true },
            )
          : null;

      const pipeline = await deps.prisma.$transaction(async (tx) => {
        if (target) {
          await tx.crmPipelineDepartment.deleteMany({ where: { pipelineId: id } });
        }
        if (body.isDefault) {
          // Um funil padrão por organização: marcar um desmarca o anterior,
          // senão dois "padrão" fariam a tela abrir um e a API outro.
          await tx.crmPipeline.updateMany({
            where: { organizationId: request.user.organizationId, isDefault: true },
            data: { isDefault: false },
          });
        }
        return tx.crmPipeline.update({
          where: { id },
          data: {
            ...(body.name ? { name: body.name } : {}),
            ...(body.description !== undefined ? { description: body.description } : {}),
            ...(body.color ? { color: body.color } : {}),
            ...(body.isActive !== undefined ? { isActive: body.isActive } : {}),
            ...(body.isDefault !== undefined ? { isDefault: body.isDefault } : {}),
            ...(body.autoCreateTagId !== undefined
              ? { autoCreateTagId: body.autoCreateTagId }
              : {}),
            ...(target
              ? {
                  isGeneral: target.isGeneral,
                  departments: {
                    create: target.departmentIds.map((departmentId) => ({ departmentId })),
                  },
                }
              : {}),
          },
          include: {
            departments: { include: { department: true } },
            stages: { include: { actions: true }, orderBy: { position: "asc" } },
          },
        });
      });

      deps.audit.record({
        organizationId: request.user.organizationId,
        userId: request.user.sub,
        action: "crm.pipeline_updated",
        entityType: "CrmPipeline",
        entityId: id,
      });
      return { pipeline: serializeCrmPipeline(pipeline) };
    },
  );

  app.delete(
    "/crm/pipelines/:id",
    { preHandler: requirePermission(deps, "crm.pipeline.manage") },
    async (request) => {
      const { id } = idParam.parse(request.params);
      const pipeline = await deps.prisma.crmPipeline.findFirst({
        where: { id, organizationId: request.user.organizationId },
        include: { departments: true },
      });
      if (!pipeline) throw new NotFoundError("Funil");
      const accessible = await accessibleDepartmentIds(deps.prisma, request.user);
      assertCanManageResource(
        accessible,
        {
          isGeneral: pipeline.isGeneral,
          departmentIds: pipeline.departments.map((link) => link.departmentId),
        },
        PIPELINE_MANAGE_LABELS,
        { canWriteGeneral: true },
      );

      const cards = await deps.prisma.crmOpportunity.count({ where: { pipelineId: id } });
      if (cards > 0) {
        // Apagar levaria junto o histórico comercial (valores, motivos de
        // perda) de negociações que aconteceram. Desativar tira o funil dos
        // seletores e preserva o que já foi medido.
        throw new AppError(
          `Este funil tem ${cards} oportunidade(s). Desative-o em vez de excluir.`,
          409,
          "crm_pipeline_in_use",
        );
      }
      await deps.prisma.crmPipeline.delete({ where: { id } });
      deps.audit.record({
        organizationId: request.user.organizationId,
        userId: request.user.sub,
        action: "crm.pipeline_deleted",
        entityType: "CrmPipeline",
        entityId: id,
        metadata: { name: pipeline.name },
      });
      return { ok: true };
    },
  );

  app.post(
    "/crm/pipelines/:id/stages",
    { preHandler: requirePermission(deps, "crm.pipeline.manage") },
    async (request, reply) => {
      const { id } = idParam.parse(request.params);
      const body = stageFieldsSchema.parse(request.body);
      const pipeline = await requireManageablePipeline(deps, request, id);

      const ultima = await deps.prisma.crmStage.findFirst({
        where: { pipelineId: pipeline.id },
        orderBy: { position: "desc" },
        select: { position: true },
      });
      const stage = await deps.prisma.crmStage.create({
        data: {
          organizationId: request.user.organizationId,
          pipelineId: pipeline.id,
          name: body.name,
          color: body.color,
          probability: body.probability,
          type: body.type,
          slaDays: body.slaDays ?? null,
          position: (ultima?.position ?? 0) + CRM_POSITION_STEP,
          ...(body.actions
            ? { actions: { create: body.actions.map(actionCreateData) } }
            : {}),
        },
        include: { actions: true },
      });
      deps.audit.record({
        organizationId: request.user.organizationId,
        userId: request.user.sub,
        action: "crm.stage_created",
        entityType: "CrmStage",
        entityId: stage.id,
        metadata: { pipelineId: pipeline.id, name: stage.name },
      });
      return reply.status(201).send({ stage: serializeCrmStage(stage) });
    },
  );

  app.patch(
    "/crm/stages/:id",
    { preHandler: requirePermission(deps, "crm.pipeline.manage") },
    async (request) => {
      const { id } = idParam.parse(request.params);
      const body = stageFieldsSchema.partial().parse(request.body);
      const stage = await deps.prisma.crmStage.findFirst({
        where: { id, organizationId: request.user.organizationId },
      });
      if (!stage) throw new NotFoundError("Etapa");
      await requireManageablePipeline(deps, request, stage.pipelineId);

      const atualizada = await deps.prisma.$transaction(async (tx) => {
        if (body.actions) {
          // Substitui o conjunto inteiro: somar deixaria automação duplicada
          // a cada gravação da tela, e o cliente receberia a mesma mensagem
          // duas vezes.
          await tx.crmStageAction.deleteMany({ where: { stageId: id } });
        }
        return tx.crmStage.update({
          where: { id },
          data: {
            ...(body.name ? { name: body.name } : {}),
            ...(body.color ? { color: body.color } : {}),
            ...(body.probability !== undefined ? { probability: body.probability } : {}),
            ...(body.type ? { type: body.type } : {}),
            ...(body.slaDays !== undefined ? { slaDays: body.slaDays } : {}),
            ...(body.actions ? { actions: { create: body.actions.map(actionCreateData) } } : {}),
          },
          include: { actions: true },
        });
      });
      deps.audit.record({
        organizationId: request.user.organizationId,
        userId: request.user.sub,
        action: "crm.stage_updated",
        entityType: "CrmStage",
        entityId: id,
      });
      return { stage: serializeCrmStage(atualizada) };
    },
  );

  /** Reordena as colunas do quadro em bloco — a tela manda a ordem inteira. */
  app.post(
    "/crm/pipelines/:id/stages/reorder",
    { preHandler: requirePermission(deps, "crm.pipeline.manage") },
    async (request) => {
      const { id } = idParam.parse(request.params);
      const { stageIds } = z
        .object({ stageIds: z.array(z.string().uuid()).min(1).max(40) })
        .parse(request.body);
      await requireManageablePipeline(deps, request, id);

      const existentes = await deps.prisma.crmStage.findMany({
        where: { pipelineId: id },
        select: { id: true },
      });
      const conhecidos = new Set(existentes.map((stage) => stage.id));
      if (stageIds.some((stageId) => !conhecidos.has(stageId))) {
        throw new AppError("Etapa de outro funil na ordenação", 400, "invalid_stage");
      }
      await deps.prisma.$transaction(
        stageIds.map((stageId, index) =>
          deps.prisma.crmStage.update({
            where: { id: stageId },
            data: { position: (index + 1) * CRM_POSITION_STEP },
          }),
        ),
      );
      return { ok: true };
    },
  );

  app.delete(
    "/crm/stages/:id",
    { preHandler: requirePermission(deps, "crm.pipeline.manage") },
    async (request) => {
      const { id } = idParam.parse(request.params);
      const { moveToStageId } = z
        .object({ moveToStageId: z.string().uuid().nullish() })
        .parse(request.query ?? {});
      const stage = await deps.prisma.crmStage.findFirst({
        where: { id, organizationId: request.user.organizationId },
      });
      if (!stage) throw new NotFoundError("Etapa");
      await requireManageablePipeline(deps, request, stage.pipelineId);

      const cards = await deps.prisma.crmOpportunity.count({ where: { stageId: id } });
      if (cards > 0) {
        // A chave estrangeira é RESTRICT: sem etapa de destino a exclusão
        // deixaria cards órfãos de coluna. Exigir o destino é a única forma
        // de a equipe não perder oportunidade de vista sem perceber.
        if (!moveToStageId) {
          throw new AppError(
            `Esta etapa tem ${cards} oportunidade(s). Escolha para qual etapa movê-las.`,
            409,
            "crm_stage_in_use",
          );
        }
        const destino = await deps.prisma.crmStage.findFirst({
          where: { id: moveToStageId, pipelineId: stage.pipelineId },
          select: { id: true },
        });
        if (!destino) throw new AppError("Etapa de destino inválida", 400, "invalid_stage");
        await deps.prisma.crmOpportunity.updateMany({
          where: { stageId: id },
          data: { stageId: destino.id, stageEnteredAt: new Date() },
        });
      }
      await deps.prisma.crmStage.delete({ where: { id } });
      deps.audit.record({
        organizationId: request.user.organizationId,
        userId: request.user.sub,
        action: "crm.stage_deleted",
        entityType: "CrmStage",
        entityId: id,
        metadata: { movidas: cards, destino: moveToStageId ?? null },
      });
      return { ok: true };
    },
  );

  // ============================================================
  // Kanban e lista
  // ============================================================

  /**
   * O quadro: uma página de cards por coluna, mais os totais da coluna INTEIRA.
   *
   * Os totais não saem da página de cards, e sim de uma leitura enxuta de
   * todas as abertas do funil (cinco colunas por linha). Somar só o que a
   * página trouxe faria o topo da coluna dizer R$ 48.000 com R$ 120.000 de
   * verdade lá embaixo — o defeito clássico de painel que ninguém confere.
   */
  app.get("/crm/board", { preHandler: requirePermission(deps, "crm.view") }, async (request) => {
    const query = boardQuerySchema.parse(request.query ?? {});
    const escopo = await accessibleOpportunityWhere(deps.prisma, request.user);
    const filtros = buildOpportunityFilters(query);

    const pipeline = await loadReadablePipeline(deps, request, query.pipelineId);
    const where: Prisma.CrmOpportunityWhereInput = {
      AND: [escopo, { pipelineId: pipeline.id, status: "open" }, ...filtros],
    };

    const [linhas, cards] = await Promise.all([
      deps.prisma.crmOpportunity.findMany({
        where,
        select: {
          stageId: true,
          value: true,
          discount: true,
          probability: true,
          stageEnteredAt: true,
          stage: { select: { probability: true } },
        },
      }),
      deps.prisma.crmOpportunity.findMany({
        where,
        include: opportunityInclude,
        orderBy: [{ position: "asc" }, { createdAt: "desc" }],
        take: CRM_BOARD_PAGE_SIZE * Math.max(1, pipeline.stages.length),
      }),
    ]);

    const metricRows: CrmMetricRow[] = linhas.map((linha) => ({
      stageId: linha.stageId,
      value: decimalToNumber(linha.value) ?? 0,
      discount: decimalToNumber(linha.discount),
      probability: linha.probability,
      stageProbability: linha.stage.probability,
      stageEnteredAt: linha.stageEnteredAt,
    }));
    const porEtapa = totalsByStage(metricRows);

    return {
      pipeline: serializeCrmPipeline(pipeline),
      columns: pipeline.stages.map((stage) => {
        const doStage = metricRows.filter((linha) => linha.stageId === stage.id);
        return {
          stage: serializeCrmStage(stage),
          totals: porEtapa.get(stage.id) ?? { count: 0, value: 0, weightedValue: 0 },
          averageDaysInStage: averageDaysInStage(doStage),
          opportunities: cards
            .filter((card) => card.stageId === stage.id)
            .slice(0, CRM_BOARD_PAGE_SIZE)
            .map(serializeCrmOpportunity),
        };
      }),
      totals: totalsOverall(metricRows),
    };
  });

  /** A mesma coisa em tabela — para quem prefere ordenar e varrer. */
  app.get(
    "/crm/opportunities",
    { preHandler: requirePermission(deps, "crm.view") },
    async (request) => {
      const query = listQuerySchema.parse(request.query ?? {});
      const escopo = await accessibleOpportunityWhere(deps.prisma, request.user);
      const filtros = buildOpportunityFilters(query);
      const where: Prisma.CrmOpportunityWhereInput = {
        AND: [
          escopo,
          ...(query.pipelineId ? [{ pipelineId: query.pipelineId }] : []),
          ...(query.status.length > 0 ? [{ status: { in: query.status } }] : []),
          ...filtros,
        ],
      };

      const [total, items] = await Promise.all([
        deps.prisma.crmOpportunity.count({ where }),
        deps.prisma.crmOpportunity.findMany({
          where,
          include: opportunityInclude,
          orderBy: { updatedAt: "desc" },
          take: CRM_LIST_PAGE_SIZE,
          skip: query.offset,
        }),
      ]);
      return { total, opportunities: items.map(serializeCrmOpportunity) };
    },
  );

  app.get(
    "/crm/opportunities/:id",
    { preHandler: requirePermission(deps, "crm.view") },
    async (request) => {
      const { id } = idParam.parse(request.params);
      const opportunity = await findAccessibleOpportunity(deps.prisma, request.user, id);
      const [activities, followUps] = await Promise.all([
        deps.prisma.crmActivity.findMany({
          where: { opportunityId: id },
          include: { assignedUser: true, completedBy: true },
          orderBy: [{ status: "asc" }, { dueAt: "asc" }],
          take: 100,
        }),
        deps.prisma.scheduledMessage.findMany({
          where: { crmOpportunityId: id, status: "pending" },
          orderBy: { scheduledFor: "asc" },
          select: { id: true, scheduledFor: true, content: true },
        }),
      ]);
      return {
        opportunity: serializeCrmOpportunity(opportunity),
        activities: activities.map(serializeCrmActivity),
        // Follow-ups a caminho: a equipe precisa ver o que o sistema vai
        // mandar antes de mandar a mesma coisa na mão.
        followUps: followUps.map((item) => ({
          id: item.id,
          scheduledFor: item.scheduledFor.toISOString(),
          content: item.content,
        })),
      };
    },
  );

  app.get(
    "/crm/opportunities/:id/history",
    { preHandler: requirePermission(deps, "crm.view") },
    async (request) => {
      const { id } = idParam.parse(request.params);
      await findAccessibleOpportunity(deps.prisma, request.user, id);
      const events = await deps.prisma.crmOpportunityEvent.findMany({
        where: { opportunityId: id },
        include: { performedBy: true },
        orderBy: { createdAt: "desc" },
        take: 200,
      });
      return { events: events.map(serializeCrmEvent) };
    },
  );

  app.post(
    "/crm/opportunities",
    { preHandler: requirePermission(deps, "crm.opportunity.manage") },
    async (request, reply) => {
      const body = opportunityFieldsSchema
        .extend({
          pipelineId: z.string().uuid(),
          stageId: z.string().uuid().nullish(),
          tagIds: z.array(z.string().uuid()).max(20).default([]),
        })
        .parse(request.body);

      // A conversa passa pelo recorte de acesso ANTES de virar oportunidade:
      // sem isso alguém abriria card para um cliente que não enxerga e o
      // veria pela porta dos fundos.
      if (body.conversationId) {
        await findAccessibleConversation(deps.prisma, request.user, body.conversationId);
      }
      await loadReadablePipeline(deps, request, body.pipelineId);

      const { opportunity, duplicated } = await createCrmOpportunity(deps, {
        organizationId: request.user.organizationId,
        pipelineId: body.pipelineId,
        stageId: body.stageId ?? null,
        title: body.title ?? null,
        conversationId: body.conversationId ?? null,
        contactName: body.contactName ?? null,
        contactPhone: body.contactPhone ?? null,
        assignedUserId: body.assignedUserId ?? null,
        departmentId: body.departmentId ?? null,
        productId: body.productId ?? null,
        value: body.value ?? null,
        discount: body.discount ?? null,
        probability: body.probability ?? null,
        expectedCloseDate: body.expectedCloseDate ? new Date(body.expectedCloseDate) : null,
        origin: body.origin ?? null,
        notes: body.notes ?? null,
        tagIds: body.tagIds,
        performedByUserId: request.user.sub,
      });

      deps.audit.record({
        organizationId: request.user.organizationId,
        userId: request.user.sub,
        action: "crm.opportunity_created",
        entityType: "CrmOpportunity",
        entityId: opportunity.id,
        metadata: { pipelineId: body.pipelineId, duplicada: duplicated },
      });
      // Duplicada devolve 200 com a que já existe: 409 faria a tela mostrar
      // erro para uma situação em que está tudo certo (o card existe).
      return reply
        .status(duplicated ? 200 : 201)
        .send({ opportunity: serializeCrmOpportunity(opportunity), duplicated });
    },
  );

  app.patch(
    "/crm/opportunities/:id",
    { preHandler: requirePermission(deps, "crm.opportunity.manage") },
    async (request) => {
      const { id } = idParam.parse(request.params);
      const body = opportunityFieldsSchema.parse(request.body);
      const atual = await findAccessibleOpportunity(deps.prisma, request.user, id);

      if (body.assignedUserId) {
        await assertAssignable(deps, request.user.organizationId, atual, body.assignedUserId);
      }

      const valorAntes = decimalToNumber(atual.value) ?? 0;
      const atualizada = await deps.prisma.crmOpportunity.update({
        where: { id },
        data: {
          ...(body.title ? { title: body.title } : {}),
          ...(body.contactName !== undefined ? { contactName: body.contactName } : {}),
          ...(body.contactPhone !== undefined ? { contactPhone: body.contactPhone } : {}),
          ...(body.assignedUserId !== undefined ? { assignedUserId: body.assignedUserId } : {}),
          ...(body.departmentId !== undefined ? { departmentId: body.departmentId } : {}),
          ...(body.productId !== undefined ? { productId: body.productId } : {}),
          ...(body.value !== undefined && body.value !== null ? { value: body.value } : {}),
          ...(body.discount !== undefined ? { discount: body.discount } : {}),
          ...(body.probability !== undefined ? { probability: body.probability } : {}),
          ...(body.expectedCloseDate !== undefined
            ? {
                expectedCloseDate: body.expectedCloseDate
                  ? new Date(body.expectedCloseDate)
                  : null,
              }
            : {}),
          ...(body.origin !== undefined ? { origin: body.origin } : {}),
          ...(body.notes !== undefined ? { notes: body.notes } : {}),
        },
        include: opportunityInclude,
      });

      // Histórico por FATO: valor e responsável têm evento próprio porque são
      // as duas perguntas que a supervisão faz depois ("quem baixou o preço?",
      // "quem largou o atendimento?").
      if (body.value !== undefined && body.value !== null && body.value !== valorAntes) {
        await recordCrmEvent(deps.prisma, {
          organizationId: request.user.organizationId,
          opportunityId: id,
          type: "value_changed",
          performedByUserId: request.user.sub,
          description: `Valor alterado de ${valorAntes} para ${body.value}`,
          metadata: { antes: valorAntes, depois: body.value },
        });
      }
      if (body.assignedUserId !== undefined && body.assignedUserId !== atual.assignedUserId) {
        await recordCrmEvent(deps.prisma, {
          organizationId: request.user.organizationId,
          opportunityId: id,
          type: "assignee_changed",
          performedByUserId: request.user.sub,
          fromUserId: atual.assignedUserId,
          toUserId: body.assignedUserId,
          description: body.assignedUserId
            ? `Responsável: ${atualizada.assignedUser?.name ?? "—"}`
            : "Responsável removido",
        });
      }
      if (body.departmentId !== undefined && body.departmentId !== atual.departmentId) {
        await recordCrmEvent(deps.prisma, {
          organizationId: request.user.organizationId,
          opportunityId: id,
          type: "department_changed",
          performedByUserId: request.user.sub,
          description: `Departamento: ${atualizada.department?.name ?? "sem departamento"}`,
        });
      }

      emitCrmOpportunity(deps, request.user.organizationId, atualizada);
      deps.audit.record({
        organizationId: request.user.organizationId,
        userId: request.user.sub,
        action: "crm.opportunity_updated",
        entityType: "CrmOpportunity",
        entityId: id,
      });
      return { opportunity: serializeCrmOpportunity(atualizada) };
    },
  );

  /** Arrastar o card. Ver `lib/crm-move.ts` para a regra de concorrência. */
  app.post(
    "/crm/opportunities/:id/move",
    { preHandler: requirePermission(deps, "crm.opportunity.manage") },
    async (request) => {
      const { id } = idParam.parse(request.params);
      const body = z
        .object({
          stageId: z.string().uuid(),
          fromStageId: z.string().uuid().nullish(),
          beforeId: z.string().uuid().nullish(),
          afterId: z.string().uuid().nullish(),
          lossReasonId: z.string().uuid().nullish(),
          lossNote: z.string().max(1000).nullish(),
          closedValue: z.number().min(0).max(999_999_999).nullish(),
        })
        .parse(request.body);

      // O card precisa estar no alcance de quem move — a mesma régua da
      // leitura, aplicada antes da escrita.
      await findAccessibleOpportunity(deps.prisma, request.user, id);
      const opportunity = await moveCrmOpportunity(deps, {
        organizationId: request.user.organizationId,
        opportunityId: id,
        toStageId: body.stageId,
        fromStageId: body.fromStageId ?? null,
        beforeId: body.beforeId ?? null,
        afterId: body.afterId ?? null,
        lossReasonId: body.lossReasonId ?? null,
        lossNote: body.lossNote ?? null,
        closedValue: body.closedValue ?? null,
        performedByUserId: request.user.sub,
      });
      deps.audit.record({
        organizationId: request.user.organizationId,
        userId: request.user.sub,
        action: "crm.opportunity_moved",
        entityType: "CrmOpportunity",
        entityId: id,
        metadata: { stageId: body.stageId, status: opportunity.status },
      });
      return { opportunity: serializeCrmOpportunity(opportunity) };
    },
  );

  /**
   * Ganho e perda são a MESMA movimentação, com destino já decidido: a
   * primeira etapa do tipo `won`/`lost` do funil. Existem como rota própria
   * porque o botão "Ganhei" não deveria obrigar a tela a descobrir qual é a
   * coluna de fechamento — e porque a perda exige motivo.
   */
  app.post(
    "/crm/opportunities/:id/win",
    { preHandler: requirePermission(deps, "crm.opportunity.manage") },
    async (request) => {
      const { id } = idParam.parse(request.params);
      const body = z
        .object({ closedValue: z.number().min(0).max(999_999_999).nullish() })
        .parse(request.body ?? {});
      const atual = await findAccessibleOpportunity(deps.prisma, request.user, id);
      const destino = await closingStage(deps, atual.pipelineId, "won");
      const opportunity = await moveCrmOpportunity(deps, {
        organizationId: request.user.organizationId,
        opportunityId: id,
        toStageId: destino.id,
        performedByUserId: request.user.sub,
        closedValue: body.closedValue ?? null,
      });
      deps.audit.record({
        organizationId: request.user.organizationId,
        userId: request.user.sub,
        action: "crm.opportunity_won",
        entityType: "CrmOpportunity",
        entityId: id,
        metadata: { closedValue: body.closedValue ?? null },
      });
      return { opportunity: serializeCrmOpportunity(opportunity) };
    },
  );

  app.post(
    "/crm/opportunities/:id/lose",
    { preHandler: requirePermission(deps, "crm.opportunity.manage") },
    async (request) => {
      const { id } = idParam.parse(request.params);
      const body = z
        .object({
          lossReasonId: z.string().uuid(),
          lossNote: z.string().max(1000).nullish(),
        })
        .parse(request.body);
      const atual = await findAccessibleOpportunity(deps.prisma, request.user, id);
      const destino = await closingStage(deps, atual.pipelineId, "lost");
      const opportunity = await moveCrmOpportunity(deps, {
        organizationId: request.user.organizationId,
        opportunityId: id,
        toStageId: destino.id,
        performedByUserId: request.user.sub,
        lossReasonId: body.lossReasonId,
        lossNote: body.lossNote ?? null,
      });
      deps.audit.record({
        organizationId: request.user.organizationId,
        userId: request.user.sub,
        action: "crm.opportunity_lost",
        entityType: "CrmOpportunity",
        entityId: id,
        metadata: { lossReasonId: body.lossReasonId },
      });
      return { opportunity: serializeCrmOpportunity(opportunity) };
    },
  );

  /**
   * Reabrir tem chave própria (`crm.opportunity.reopen`) porque mexe em
   * número já contado: a conversão e a receita do mês passado mudam quando
   * uma ganha volta para o funil.
   */
  app.post(
    "/crm/opportunities/:id/reopen",
    { preHandler: requirePermission(deps, "crm.opportunity.reopen") },
    async (request) => {
      const { id } = idParam.parse(request.params);
      const body = z
        .object({
          stageId: z.string().uuid().nullish(),
          note: z.string().max(1000).nullish(),
        })
        .parse(request.body ?? {});
      const atual = await findAccessibleOpportunity(deps.prisma, request.user, id);
      if (atual.status === "open") {
        throw new AppError("Esta oportunidade já está aberta", 400, "crm_already_open");
      }

      const destino = body.stageId
        ? await deps.prisma.crmStage.findFirst({
            where: { id: body.stageId, pipelineId: atual.pipelineId },
          })
        : await deps.prisma.crmStage.findFirst({
            where: { pipelineId: atual.pipelineId, type: { in: ["open", "in_progress"] } },
            orderBy: { position: "asc" },
          });
      if (!destino) throw new AppError("Etapa de destino inválida", 400, "invalid_stage");

      const atualizada = await deps.prisma.crmOpportunity.update({
        where: { id },
        data: {
          status: "open",
          stageId: destino.id,
          stageEnteredAt: new Date(),
          closedAt: null,
          // O motivo da perda sai junto: mantê-lo faria o card reaberto
          // continuar aparecendo como perdido no relatório de motivos.
          lossReasonId: null,
          lossNote: null,
        },
        include: opportunityInclude,
      });
      await recordCrmEvent(deps.prisma, {
        organizationId: request.user.organizationId,
        opportunityId: id,
        type: "reopened",
        performedByUserId: request.user.sub,
        fromStageId: atual.stageId,
        toStageId: destino.id,
        description: `Reaberta em ${destino.name}`,
        metadata: { statusAnterior: atual.status, nota: body.note ?? null },
      });
      emitCrmOpportunity(deps, request.user.organizationId, atualizada);
      deps.audit.record({
        organizationId: request.user.organizationId,
        userId: request.user.sub,
        action: "crm.opportunity_reopened",
        entityType: "CrmOpportunity",
        entityId: id,
        metadata: { statusAnterior: atual.status },
      });
      return { opportunity: serializeCrmOpportunity(atualizada) };
    },
  );

  app.post(
    "/crm/opportunities/:id/tags/:tagId",
    { preHandler: requirePermission(deps, "crm.opportunity.manage") },
    async (request) => {
      const { id, tagId } = z
        .object({ id: z.string().uuid(), tagId: z.string().uuid() })
        .parse(request.params);
      await findAccessibleOpportunity(deps.prisma, request.user, id);
      const tag = await deps.prisma.tag.findFirst({
        where: { id: tagId, organizationId: request.user.organizationId },
        select: { id: true, name: true },
      });
      if (!tag) throw new NotFoundError("Etiqueta");
      await deps.prisma.crmOpportunityTag.createMany({
        data: [{ opportunityId: id, tagId }],
        skipDuplicates: true,
      });
      await recordCrmEvent(deps.prisma, {
        organizationId: request.user.organizationId,
        opportunityId: id,
        type: "tag_added",
        performedByUserId: request.user.sub,
        description: `Etiqueta ${tag.name}`,
      });
      await emitCrmOpportunityById(deps, request.user.organizationId, id);
      return { ok: true };
    },
  );

  app.delete(
    "/crm/opportunities/:id/tags/:tagId",
    { preHandler: requirePermission(deps, "crm.opportunity.manage") },
    async (request) => {
      const { id, tagId } = z
        .object({ id: z.string().uuid(), tagId: z.string().uuid() })
        .parse(request.params);
      await findAccessibleOpportunity(deps.prisma, request.user, id);
      await deps.prisma.crmOpportunityTag.deleteMany({
        where: { opportunityId: id, tagId },
      });
      await emitCrmOpportunityById(deps, request.user.organizationId, id);
      return { ok: true };
    },
  );

  // ============================================================
  // Atividades
  // ============================================================

  /**
   * A agenda do CRM. `range` é recorte de PRAZO e o atraso é derivado do
   * relógio — não existe status "atrasada" gravado (ver `crm.ts` no shared).
   */
  app.get(
    "/crm/activities",
    { preHandler: requirePermission(deps, "crm.view") },
    async (request) => {
      const query = z
        .object({
          range: z.enum(["overdue", "today", "tomorrow", "week", "done", "all"]).default("all"),
          assignedUserId: z.string().uuid().optional(),
          opportunityId: z.string().uuid().optional(),
          mine: z.coerce.boolean().optional(),
        })
        .parse(request.query ?? {});

      // Atividade herda o alcance da OPORTUNIDADE: quem não enxerga o card
      // não enxerga a tarefa dele. O `is:` é obrigatório aqui pelo mesmo
      // motivo de sempre em relação opcional.
      const escopo = await accessibleOpportunityWhere(deps.prisma, request.user);
      const agora = new Date();
      const where: Prisma.CrmActivityWhereInput = {
        organizationId: request.user.organizationId,
        opportunity: { is: escopo },
        ...(query.opportunityId ? { opportunityId: query.opportunityId } : {}),
        ...(query.mine
          ? { assignedUserId: request.user.sub }
          : query.assignedUserId
            ? { assignedUserId: query.assignedUserId }
            : {}),
        ...activityRangeWhere(query.range, agora),
      };

      const items = await deps.prisma.crmActivity.findMany({
        where,
        include: {
          assignedUser: true,
          completedBy: true,
          opportunity: { select: { id: true, title: true, conversationId: true } },
        },
        orderBy: query.range === "done" ? { completedAt: "desc" } : { dueAt: "asc" },
        take: 200,
      });
      return {
        activities: items.map(serializeCrmActivity),
        overdueCount: items.filter((item) => isCrmActivityOverdue(item, agora)).length,
      };
    },
  );

  app.post(
    "/crm/opportunities/:id/activities",
    { preHandler: requirePermission(deps, "crm.opportunity.manage") },
    async (request, reply) => {
      const { id } = idParam.parse(request.params);
      const body = z
        .object({
          type: z.enum(CRM_ACTIVITY_TYPES).default("task"),
          title: z.string().min(1).max(160),
          description: z.string().max(2000).nullish(),
          assignedUserId: z.string().uuid().nullish(),
          dueAt: z.string().datetime(),
          priority: z.enum(CRM_ACTIVITY_PRIORITIES).default("normal"),
        })
        .parse(request.body);
      await findAccessibleOpportunity(deps.prisma, request.user, id);

      const activity = await deps.prisma.crmActivity.create({
        data: {
          organizationId: request.user.organizationId,
          opportunityId: id,
          type: body.type,
          title: body.title,
          description: body.description ?? null,
          // Sem responsável escolhido, a tarefa é de quem a criou: tarefa sem
          // dono some da agenda de todo mundo e nunca é feita.
          assignedUserId: body.assignedUserId ?? request.user.sub,
          dueAt: new Date(body.dueAt),
          priority: body.priority,
          createdById: request.user.sub,
        },
        include: { assignedUser: true, completedBy: true },
      });
      await recordCrmEvent(deps.prisma, {
        organizationId: request.user.organizationId,
        opportunityId: id,
        type: "activity_created",
        performedByUserId: request.user.sub,
        description: `Atividade: ${activity.title}`,
        metadata: { activityId: activity.id, dueAt: activity.dueAt.toISOString() },
      });
      // O card mostra a PRÓXIMA ação — o quadro precisa disso na hora.
      await emitCrmOpportunityById(deps, request.user.organizationId, id);
      return reply.status(201).send({ activity: serializeCrmActivity(activity) });
    },
  );

  app.patch(
    "/crm/activities/:id",
    { preHandler: requirePermission(deps, "crm.opportunity.manage") },
    async (request) => {
      const { id } = idParam.parse(request.params);
      const body = z
        .object({
          type: z.enum(CRM_ACTIVITY_TYPES).optional(),
          title: z.string().min(1).max(160).optional(),
          description: z.string().max(2000).nullish(),
          assignedUserId: z.string().uuid().nullish(),
          dueAt: z.string().datetime().optional(),
          priority: z.enum(CRM_ACTIVITY_PRIORITIES).optional(),
          status: z.enum(["pending", "done", "canceled"]).optional(),
        })
        .parse(request.body);
      const activity = await loadAccessibleActivity(deps, request, id);

      const concluindo = body.status === "done" && activity.status !== "done";
      const atualizada = await deps.prisma.crmActivity.update({
        where: { id },
        data: {
          ...(body.type ? { type: body.type } : {}),
          ...(body.title ? { title: body.title } : {}),
          ...(body.description !== undefined ? { description: body.description } : {}),
          ...(body.assignedUserId !== undefined ? { assignedUserId: body.assignedUserId } : {}),
          ...(body.dueAt ? { dueAt: new Date(body.dueAt) } : {}),
          ...(body.priority ? { priority: body.priority } : {}),
          ...(body.status ? { status: body.status } : {}),
          ...(concluindo
            ? { completedAt: new Date(), completedById: request.user.sub }
            : body.status === "pending"
              ? { completedAt: null, completedById: null }
              : {}),
        },
        include: { assignedUser: true, completedBy: true },
      });
      if (concluindo) {
        await recordCrmEvent(deps.prisma, {
          organizationId: request.user.organizationId,
          opportunityId: activity.opportunityId,
          type: "activity_done",
          performedByUserId: request.user.sub,
          description: `Atividade concluída: ${atualizada.title}`,
          metadata: { activityId: id },
        });
      }
      await emitCrmOpportunityById(deps, request.user.organizationId, activity.opportunityId);
      return { activity: serializeCrmActivity(atualizada) };
    },
  );

  // ============================================================
  // A conversa e o CRM
  // ============================================================

  /**
   * O que o chat precisa saber: esta conversa tem oportunidade?
   *
   * A Inbox mostra um resumo discreto no painel de contexto, com o botão de
   * abrir e o de criar. É a ponte entre atender e vender — sem ela o CRM
   * viraria uma tela paralela que ninguém abre no meio do atendimento.
   */
  app.get(
    "/conversations/:id/crm",
    { preHandler: requirePermission(deps, "crm.view") },
    async (request) => {
      const { id } = idParam.parse(request.params);
      await findAccessibleConversation(deps.prisma, request.user, id);
      const escopo = await accessibleOpportunityWhere(deps.prisma, request.user);
      const opportunities = await deps.prisma.crmOpportunity.findMany({
        where: { AND: [escopo, { conversationId: id }] },
        include: opportunityInclude,
        orderBy: [{ status: "asc" }, { updatedAt: "desc" }],
        take: 20,
      });
      return { opportunities: opportunities.map(serializeCrmOpportunity) };
    },
  );

  // ============================================================
  // Configurações do CRM (serviços e motivos de perda)
  // ============================================================

  app.get(
    "/crm/settings",
    { preHandler: requirePermission(deps, "crm.view") },
    async (request) => {
      await ensureDefaultCrmSetup(deps.prisma, request.user.organizationId);
      const [products, lossReasons] = await Promise.all([
        deps.prisma.crmProduct.findMany({
          where: { organizationId: request.user.organizationId },
          orderBy: { name: "asc" },
        }),
        deps.prisma.crmLossReason.findMany({
          where: { organizationId: request.user.organizationId },
          orderBy: [{ position: "asc" }, { name: "asc" }],
        }),
      ]);
      return {
        products: products.map(serializeCrmProduct),
        lossReasons: lossReasons.map(serializeCrmLossReason),
      };
    },
  );

  app.post(
    "/crm/products",
    { preHandler: requirePermission(deps, "crm.pipeline.manage") },
    async (request, reply) => {
      const body = z
        .object({
          name: z.string().min(1).max(120),
          defaultValue: z.number().min(0).max(999_999_999).nullish(),
        })
        .parse(request.body);
      const product = await deps.prisma.crmProduct.create({
        data: {
          organizationId: request.user.organizationId,
          name: body.name,
          defaultValue: body.defaultValue ?? null,
        },
      });
      return reply.status(201).send({ product: serializeCrmProduct(product) });
    },
  );

  app.patch(
    "/crm/products/:id",
    { preHandler: requirePermission(deps, "crm.pipeline.manage") },
    async (request) => {
      const { id } = idParam.parse(request.params);
      const body = z
        .object({
          name: z.string().min(1).max(120).optional(),
          defaultValue: z.number().min(0).max(999_999_999).nullish(),
          active: z.boolean().optional(),
        })
        .parse(request.body);
      const existente = await deps.prisma.crmProduct.findFirst({
        where: { id, organizationId: request.user.organizationId },
        select: { id: true },
      });
      if (!existente) throw new NotFoundError("Serviço");
      const product = await deps.prisma.crmProduct.update({
        where: { id },
        data: {
          ...(body.name ? { name: body.name } : {}),
          ...(body.defaultValue !== undefined ? { defaultValue: body.defaultValue } : {}),
          ...(body.active !== undefined ? { active: body.active } : {}),
        },
      });
      return { product: serializeCrmProduct(product) };
    },
  );

  app.post(
    "/crm/loss-reasons",
    { preHandler: requirePermission(deps, "crm.pipeline.manage") },
    async (request, reply) => {
      const body = z.object({ name: z.string().min(1).max(120) }).parse(request.body);
      const ultimo = await deps.prisma.crmLossReason.findFirst({
        where: { organizationId: request.user.organizationId },
        orderBy: { position: "desc" },
        select: { position: true },
      });
      const reason = await deps.prisma.crmLossReason.create({
        data: {
          organizationId: request.user.organizationId,
          name: body.name,
          position: (ultimo?.position ?? 0) + 10,
        },
      });
      return reply.status(201).send({ lossReason: serializeCrmLossReason(reason) });
    },
  );

  app.patch(
    "/crm/loss-reasons/:id",
    { preHandler: requirePermission(deps, "crm.pipeline.manage") },
    async (request) => {
      const { id } = idParam.parse(request.params);
      const body = z
        .object({ name: z.string().min(1).max(120).optional(), active: z.boolean().optional() })
        .parse(request.body);
      const existente = await deps.prisma.crmLossReason.findFirst({
        where: { id, organizationId: request.user.organizationId },
        select: { id: true },
      });
      if (!existente) throw new NotFoundError("Motivo de perda");
      const reason = await deps.prisma.crmLossReason.update({
        where: { id },
        data: {
          ...(body.name ? { name: body.name } : {}),
          ...(body.active !== undefined ? { active: body.active } : {}),
        },
      });
      return { lossReason: serializeCrmLossReason(reason) };
    },
  );

  // ============================================================
  // Relatórios
  // ============================================================

  /**
   * Os números do funil. `crm.reports.view` é chave própria porque aqui a
   * pessoa vê o desempenho dos COLEGAS — mesma decisão do relatório por
   * atendente e do `topUsers` do dashboard.
   *
   * O recorte de acesso continua entrando por baixo de tudo: um supervisor
   * não vê no relatório uma oportunidade que não veria no quadro.
   */
  app.get(
    "/crm/reports",
    { preHandler: requirePermission(deps, "crm.reports.view") },
    async (request) => {
      const query = z
        .object({
          pipelineId: z.string().uuid().optional(),
          from: z.string().datetime().optional(),
          to: z.string().datetime().optional(),
        })
        .parse(request.query ?? {});

      const escopo = await accessibleOpportunityWhere(deps.prisma, request.user);
      const funil = query.pipelineId ? [{ pipelineId: query.pipelineId }] : [];
      const desde = query.from ? new Date(query.from) : trintaDiasAtras();
      const ate = query.to ? new Date(query.to) : new Date();

      const [abertas, fechadas, criadas, usuarios] = await Promise.all([
        deps.prisma.crmOpportunity.findMany({
          where: { AND: [escopo, ...funil, { status: "open" }] },
          select: {
            stageId: true,
            value: true,
            discount: true,
            probability: true,
            assignedUserId: true,
            origin: true,
            stageEnteredAt: true,
            stage: { select: { probability: true } },
          },
        }),
        deps.prisma.crmOpportunity.findMany({
          where: {
            AND: [
              escopo,
              ...funil,
              { status: { in: ["won", "lost"] } },
              { closedAt: { gte: desde, lte: ate } },
            ],
          },
          select: {
            status: true,
            value: true,
            discount: true,
            closedValue: true,
            createdAt: true,
            closedAt: true,
            assignedUserId: true,
            origin: true,
            lossReason: { select: { id: true, name: true } },
          },
        }),
        deps.prisma.crmOpportunity.count({
          where: { AND: [escopo, ...funil, { createdAt: { gte: desde, lte: ate } }] },
        }),
        deps.prisma.user.findMany({
          where: { organizationId: request.user.organizationId },
          select: { id: true, name: true, role: true, status: true, avatarUrl: true },
        }),
      ]);

      const openRows: Array<CrmMetricRow & { groupKey: string }> = abertas.map((linha) => ({
        stageId: linha.stageId,
        value: decimalToNumber(linha.value) ?? 0,
        discount: decimalToNumber(linha.discount),
        probability: linha.probability,
        stageProbability: linha.stage.probability,
        assignedUserId: linha.assignedUserId,
        origin: linha.origin,
        stageEnteredAt: linha.stageEnteredAt,
        groupKey: linha.assignedUserId ?? "sem-responsavel",
      }));
      const closedRows: Array<ClosedRow & { groupKey: string }> = fechadas.map((linha) => ({
        status: linha.status as "won" | "lost",
        value: decimalToNumber(linha.value) ?? 0,
        discount: decimalToNumber(linha.discount),
        closedValue: decimalToNumber(linha.closedValue),
        createdAt: linha.createdAt,
        closedAt: linha.closedAt,
        groupKey: linha.assignedUserId ?? "sem-responsavel",
      }));

      const nomePorId = new Map(usuarios.map((user) => [user.id, user.name]));
      const porOrigem = breakdown(
        openRows.map((linha) => ({ ...linha, groupKey: linha.origin ?? "sem-origem" })),
        fechadas.map((linha) => ({
          status: linha.status as "won" | "lost",
          value: decimalToNumber(linha.value) ?? 0,
          discount: decimalToNumber(linha.discount),
          closedValue: decimalToNumber(linha.closedValue),
          createdAt: linha.createdAt,
          closedAt: linha.closedAt,
          groupKey: linha.origin ?? "sem-origem",
        })),
        (key) => key,
      );

      // Motivos de perda: é o que o escritório olha para saber o que corrigir.
      const motivos = new Map<string, { name: string; count: number }>();
      for (const linha of fechadas) {
        if (linha.status !== "lost") continue;
        const chave = linha.lossReason?.id ?? "sem-motivo";
        const atual = motivos.get(chave) ?? {
          name: linha.lossReason?.name ?? "Sem motivo",
          count: 0,
        };
        atual.count += 1;
        motivos.set(chave, atual);
      }

      return {
        period: { from: desde.toISOString(), to: ate.toISOString() },
        summary: summarizePeriod({ openRows, closedRows, createdCount: criadas }),
        byUser: breakdown(openRows, closedRows, (key) =>
          key === "sem-responsavel" ? "Sem responsável" : (nomePorId.get(key) ?? "—"),
        ).map((linha) => ({
          ...linha,
          user:
            usuarios.find((user) => user.id === linha.key) !== undefined
              ? serializeUserDirectory(
                  usuarios.find((user) => user.id === linha.key) as Parameters<
                    typeof serializeUserDirectory
                  >[0],
                )
              : null,
        })),
        byOrigin: porOrigem,
        lossReasons: [...motivos.entries()]
          .map(([id, valor]) => ({ id, name: valor.name, count: valor.count }))
          .sort((a, b) => b.count - a.count),
      };
    },
  );
}

// ============================================================
// Auxiliares das rotas
// ============================================================

const boardQuerySchema = z.object({
  pipelineId: z.string().uuid().optional(),
  search: z.string().max(120).optional(),
  assignedUserId: z.preprocess(listParam, z.array(z.string()).default([])),
  departmentId: z.preprocess(listParam, z.array(z.string()).default([])),
  tagId: z.preprocess(listParam, z.array(z.string().uuid()).default([])),
  origin: z.preprocess(listParam, z.array(z.string()).default([])),
  productId: z.preprocess(listParam, z.array(z.string().uuid()).default([])),
  overdueActivity: z.coerce.boolean().optional(),
});

const listQuerySchema = boardQuerySchema.extend({
  status: z.preprocess(listParam, z.array(z.enum(["open", "won", "lost"])).default([])),
  offset: z.coerce.number().int().min(0).max(100_000).default(0),
});

type BoardQuery = z.infer<typeof boardQuerySchema>;

/**
 * Os filtros do quadro e da tabela — os mesmos, montados uma vez só.
 *
 * A regra é a da Inbox: **OU dentro do filtro, E entre filtros**. Marcar duas
 * pessoas mostra as duas; marcar uma pessoa e uma etiqueta mostra o que tem as
 * duas coisas. Invertido, quase toda marcação múltipla devolveria vazio e
 * pareceria "o filtro não acha nada" (CLAUDE.md §13).
 *
 * "Sem responsável" e "sem departamento" viajam como o token `none`, igual ao
 * resto do sistema.
 */
function buildOpportunityFilters(query: BoardQuery): Prisma.CrmOpportunityWhereInput[] {
  const filtros: Prisma.CrmOpportunityWhereInput[] = [];

  if (query.search) {
    const termo = query.search.trim();
    filtros.push({
      OR: [
        { title: { contains: termo, mode: "insensitive" } },
        { contactName: { contains: termo, mode: "insensitive" } },
        { contactPhone: { contains: termo } },
        { notes: { contains: termo, mode: "insensitive" } },
        { conversation: { is: { title: { contains: termo, mode: "insensitive" } } } },
        { conversation: { is: { customTitle: { contains: termo, mode: "insensitive" } } } },
      ],
    });
  }
  if (query.assignedUserId.length > 0) {
    const semDono = query.assignedUserId.includes("none");
    const ids = query.assignedUserId.filter((valor) => valor !== "none");
    filtros.push({
      OR: [
        ...(semDono ? [{ assignedUserId: null }] : []),
        ...(ids.length > 0 ? [{ assignedUserId: { in: ids } }] : []),
      ],
    });
  }
  if (query.departmentId.length > 0) {
    const semDepartamento = query.departmentId.includes("none");
    const ids = query.departmentId.filter((valor) => valor !== "none");
    filtros.push({
      OR: [
        ...(semDepartamento ? [{ departmentId: null }] : []),
        ...(ids.length > 0 ? [{ departmentId: { in: ids } }] : []),
      ],
    });
  }
  if (query.tagId.length > 0) {
    filtros.push({ tags: { some: { tagId: { in: query.tagId } } } });
  }
  if (query.origin.length > 0) {
    filtros.push({ origin: { in: query.origin } });
  }
  if (query.productId.length > 0) {
    filtros.push({ productId: { in: query.productId } });
  }
  if (query.overdueActivity) {
    // Atrasada é derivada: pendente com prazo no passado. A mesma definição
    // de `isCrmActivityOverdue`, escrita em Prisma.
    filtros.push({
      activities: { some: { status: "pending", dueAt: { lt: new Date() } } },
    });
  }
  return filtros;
}

function activityRangeWhere(
  range: "overdue" | "today" | "tomorrow" | "week" | "done" | "all",
  now: Date,
): Prisma.CrmActivityWhereInput {
  const inicioDoDia = new Date(now);
  inicioDoDia.setHours(0, 0, 0, 0);
  const fimDoDia = new Date(inicioDoDia);
  fimDoDia.setDate(fimDoDia.getDate() + 1);
  const fimDeAmanha = new Date(fimDoDia);
  fimDeAmanha.setDate(fimDeAmanha.getDate() + 1);
  const fimDaSemana = new Date(inicioDoDia);
  fimDaSemana.setDate(fimDaSemana.getDate() + 7);

  switch (range) {
    case "overdue":
      return { status: "pending", dueAt: { lt: now } };
    case "today":
      return { status: "pending", dueAt: { gte: inicioDoDia, lt: fimDoDia } };
    case "tomorrow":
      return { status: "pending", dueAt: { gte: fimDoDia, lt: fimDeAmanha } };
    case "week":
      return { status: "pending", dueAt: { gte: inicioDoDia, lt: fimDaSemana } };
    case "done":
      return { status: "done" };
    default:
      return {};
  }
}

function actionCreateData(action: z.infer<typeof stageActionSchema>, index: number) {
  return {
    trigger: action.trigger,
    type: action.type,
    tagId: action.tagId ?? null,
    userId: action.userId ?? null,
    departmentId: action.departmentId ?? null,
    delayMinutes: action.delayMinutes,
    content: action.content ?? null,
    position: index * 10,
  };
}

/** Funil que a pessoa ENXERGA (leitura) — o padrão quando ela não escolheu. */
async function loadReadablePipeline(
  deps: AppDeps,
  request: FastifyRequest,
  pipelineId?: string | null,
) {
  await ensureDefaultCrmSetup(deps.prisma, request.user.organizationId);
  const departmentIds = await accessibleDepartmentIds(deps.prisma, request.user);
  const pipeline = await deps.prisma.crmPipeline.findFirst({
    where: {
      organizationId: request.user.organizationId,
      ...(pipelineId ? { id: pipelineId } : { isActive: true }),
      ...pipelineScope(departmentIds),
    },
    include: {
      departments: { include: { department: true } },
      stages: { include: { actions: true }, orderBy: { position: "asc" } },
    },
    orderBy: [{ isDefault: "desc" }, { position: "asc" }],
  });
  if (!pipeline) throw new NotFoundError("Funil");
  return pipeline;
}

/** Funil que a pessoa pode ADMINISTRAR — leitura mais a régua de departamento. */
async function requireManageablePipeline(
  deps: AppDeps,
  request: FastifyRequest,
  pipelineId: string,
) {
  const pipeline = await deps.prisma.crmPipeline.findFirst({
    where: { id: pipelineId, organizationId: request.user.organizationId },
    include: { departments: true },
  });
  if (!pipeline) throw new NotFoundError("Funil");
  const accessible = await accessibleDepartmentIds(deps.prisma, request.user);
  assertCanManageResource(
    accessible,
    {
      isGeneral: pipeline.isGeneral,
      departmentIds: pipeline.departments.map((link) => link.departmentId),
    },
    PIPELINE_MANAGE_LABELS,
    { canWriteGeneral: true },
  );
  return pipeline;
}

/** A primeira etapa de fechamento do funil (ganho ou perda). */
async function closingStage(deps: AppDeps, pipelineId: string, type: "won" | "lost") {
  const stage = await deps.prisma.crmStage.findFirst({
    where: { pipelineId, type },
    orderBy: { position: "asc" },
  });
  if (!stage) {
    throw new AppError(
      type === "won"
        ? "Este funil não tem etapa de fechamento (tipo Ganha)"
        : "Este funil não tem etapa de perda (tipo Perdida)",
      400,
      "crm_missing_closing_stage",
    );
  }
  return stage;
}

async function loadAccessibleActivity(deps: AppDeps, request: FastifyRequest, id: string) {
  const escopo = await accessibleOpportunityWhere(deps.prisma, request.user);
  const activity = await deps.prisma.crmActivity.findFirst({
    where: {
      id,
      organizationId: request.user.organizationId,
      opportunity: { is: escopo },
    },
  });
  if (!activity) throw new NotFoundError("Atividade");
  return activity;
}

/**
 * Quem pode RECEBER a oportunidade.
 *
 * Mesma pergunta da transferência de conversa, e mesma resposta: quem enxerga
 * a conversa vinculada. Atribuir a quem não enxerga faz o card sumir da tela
 * de todo mundo — inclusive de quem atribuiu — sem erro nenhum, que é a falha
 * silenciosa descrita no CLAUDE.md §13.
 */
async function assertAssignable(
  deps: AppDeps,
  organizationId: string,
  opportunity: { conversationId: string | null; departmentId: string | null },
  userId: string,
): Promise<void> {
  const candidato = await deps.prisma.user.findFirst({
    where: { id: userId, organizationId, status: "active" },
    select: { id: true },
  });
  if (!candidato) {
    throw new AppError("Usuário inválido para esta oportunidade", 400, "invalid_assignee");
  }
  if (!opportunity.conversationId) return;
  const conversation = await deps.prisma.conversation.findUnique({
    where: { id: opportunity.conversationId },
    select: { whatsappInstanceId: true, departmentId: true },
  });
  if (!conversation) return;
  const alcanca = await deps.prisma.user.findFirst({
    where: { ...conversationAssigneeWhere(organizationId, conversation), id: userId },
    select: { id: true },
  });
  if (!alcanca) {
    throw new AppError(
      "Esta pessoa não enxerga a conversa vinculada e não veria o card",
      400,
      "assignee_out_of_reach",
    );
  }
}

function trintaDiasAtras(): Date {
  const data = new Date();
  data.setDate(data.getDate() - 30);
  return data;
}

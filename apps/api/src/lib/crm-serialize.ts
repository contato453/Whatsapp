import type {
  CrmActivity,
  CrmLossReason,
  CrmOpportunityEvent,
  CrmProduct,
  CrmStage,
  CrmStageAction,
  Prisma,
  User,
} from "@azvchat/database";
import {
  crmEffectiveProbability,
  crmFinalValue,
  crmWeightedValue,
  isCrmActivityOverdue,
  type CrmStageType,
} from "@azvchat/shared";
import type { OpportunityWithRelations } from "./crm-access.js";
import { serializeDepartment, serializeTag, serializeUserDirectory } from "./serialize.js";

/**
 * Serializadores do CRM. Mesma regra do resto da casa: entidade do Prisma
 * nunca sai crua, e o que a tela precisa calculado sai calculado daqui.
 *
 * Valor ponderado e valor final são resolvidos NO SERVIDOR, com as funções do
 * `@azvchat/shared`, e não em cada componente: o card, a tabela, o topo da
 * coluna e o relatório mostram os mesmos números, e quatro contas separadas
 * discordariam por arredondamento — a diferença apareceria como "o total da
 * coluna não bate com a soma dos cards", que é como um painel perde a
 * confiança da equipe (ver o histórico do Dashboard no CLAUDE.md).
 */

/**
 * Decimal do Prisma vira número simples no DTO.
 *
 * O JSON não tem tipo decimal, e `Decimal` serializado direto vira objeto ou
 * string dependendo da versão do client — a tela receberia `{s,e,d}` e
 * mostraria `NaN`. Aceita número também porque os testes montam registro à
 * mão sem instanciar Decimal.
 */
export function decimalToNumber(value: Prisma.Decimal | number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") return value;
  return Number(value);
}

export function serializeCrmStage(
  stage: CrmStage & { actions?: CrmStageAction[]; _count?: { opportunities: number } },
) {
  return {
    id: stage.id,
    pipelineId: stage.pipelineId,
    name: stage.name,
    position: stage.position,
    color: stage.color,
    probability: stage.probability,
    type: stage.type as CrmStageType,
    slaDays: stage.slaDays,
    actions: stage.actions?.map(serializeCrmStageAction) ?? [],
  };
}

export function serializeCrmStageAction(action: CrmStageAction) {
  return {
    id: action.id,
    stageId: action.stageId,
    trigger: action.trigger,
    type: action.type,
    tagId: action.tagId,
    userId: action.userId,
    departmentId: action.departmentId,
    delayMinutes: action.delayMinutes,
    content: action.content,
    position: action.position,
  };
}

type PipelineWithRelations = Prisma.CrmPipelineGetPayload<{
  include: {
    departments: { include: { department: true } };
    stages: { include: { actions: true } };
  };
}>;

export function serializeCrmPipeline(pipeline: PipelineWithRelations) {
  return {
    id: pipeline.id,
    name: pipeline.name,
    description: pipeline.description,
    color: pipeline.color,
    isActive: pipeline.isActive,
    isDefault: pipeline.isDefault,
    position: pipeline.position,
    // Mesmo contrato de etiqueta e resposta rápida: ou é geral, ou traz os
    // departamentos. A tela desenha o mesmo seletor dos outros dois.
    isGeneral: pipeline.isGeneral,
    departments: pipeline.departments.map((link) => serializeDepartment(link.department)),
    autoCreateTagId: pipeline.autoCreateTagId,
    stages: [...pipeline.stages]
      .sort((a, b) => a.position - b.position)
      .map((stage) => serializeCrmStage(stage)),
  };
}

/**
 * O card do Kanban e a linha da tabela — o MESMO DTO.
 *
 * Um DTO só porque as duas telas respondem a mesma pergunta ("como está esta
 * oportunidade?") e porque é ele que viaja no evento de tempo real: dois
 * formatos obrigariam o socket a escolher um, e a outra tela ficaria
 * desatualizada até alguém recarregar.
 *
 * O que NÃO entra aqui: histórico, atividades concluídas e mensagens. O
 * quadro desenha dezenas de cards por carga e não pode pagar isso por linha —
 * mesmo motivo de `scheduledPendingCount` ficar fora de `serializeConversation`.
 */
export function serializeCrmOpportunity(opportunity: OpportunityWithRelations) {
  const value = decimalToNumber(opportunity.value) ?? 0;
  const discount = decimalToNumber(opportunity.discount);
  const finalValue = crmFinalValue(value, discount);
  const probability = crmEffectiveProbability(
    opportunity.probability,
    opportunity.stage.probability,
  );
  const nextActivity = opportunity.activities?.[0] ?? null;

  return {
    id: opportunity.id,
    title: opportunity.title,
    pipelineId: opportunity.pipelineId,
    stageId: opportunity.stageId,
    stageName: opportunity.stage.name,
    stageType: opportunity.stage.type as CrmStageType,
    stageColor: opportunity.stage.color,
    stageSlaDays: opportunity.stage.slaDays,
    status: opportunity.status,
    // O contato é a CONVERSA — nome, telefone e foto saem dela, nunca de um
    // cadastro próprio do CRM. Os campos avulsos só respondem pelo lead que
    // ainda não escreveu.
    conversationId: opportunity.conversationId,
    conversationTitle: opportunity.conversation
      ? opportunity.conversation.customTitle || opportunity.conversation.title
      : null,
    conversationHasAvatar: opportunity.conversation?.profilePicture != null,
    instanceName: opportunity.conversation?.instance?.name ?? null,
    contactName:
      (opportunity.conversation
        ? opportunity.conversation.customTitle || opportunity.conversation.title
        : null) ?? opportunity.contactName,
    contactPhone: opportunity.contactPhone,
    /** Empresa do Azevedo-OS já vinculada à conversa — sem consulta ao portal. */
    companyReference: opportunity.conversation?.externalReference ?? null,
    companySource: opportunity.conversation?.externalSource ?? null,
    assignedUser: opportunity.assignedUser
      ? serializeUserDirectory(opportunity.assignedUser)
      : null,
    department: opportunity.department ? serializeDepartment(opportunity.department) : null,
    product: opportunity.product
      ? { id: opportunity.product.id, name: opportunity.product.name }
      : null,
    value,
    discount,
    finalValue,
    probability,
    weightedValue: crmWeightedValue(finalValue, probability),
    expectedCloseDate: opportunity.expectedCloseDate?.toISOString() ?? null,
    origin: opportunity.origin,
    tags: opportunity.tags?.map((entry) => serializeTag(entry.tag)) ?? [],
    lossReason: opportunity.lossReason
      ? { id: opportunity.lossReason.id, name: opportunity.lossReason.name }
      : null,
    lossNote: opportunity.lossNote,
    closedValue: decimalToNumber(opportunity.closedValue),
    closedAt: opportunity.closedAt?.toISOString() ?? null,
    notes: opportunity.notes,
    position: opportunity.position,
    stageEnteredAt: opportunity.stageEnteredAt.toISOString(),
    lastInteractionAt: opportunity.lastInteractionAt?.toISOString() ?? null,
    // A próxima ação é o que faz o card virar agenda em vez de post-it. Vem
    // só a PRÓXIMA pendente (a consulta já traz `take: 1`), nunca a lista.
    nextActivity: nextActivity
      ? {
          id: nextActivity.id,
          title: nextActivity.title,
          type: nextActivity.type,
          dueAt: nextActivity.dueAt.toISOString(),
          overdue: isCrmActivityOverdue(nextActivity),
        }
      : null,
    createdBy: opportunity.createdBy ? serializeUserDirectory(opportunity.createdBy) : null,
    createdAt: opportunity.createdAt.toISOString(),
    updatedAt: opportunity.updatedAt.toISOString(),
  };
}

export type CrmOpportunityDto = ReturnType<typeof serializeCrmOpportunity>;

export function serializeCrmActivity(
  activity: CrmActivity & {
    assignedUser?: User | null;
    completedBy?: User | null;
    opportunity?: { id: string; title: string; conversationId: string | null } | null;
  },
) {
  return {
    id: activity.id,
    opportunityId: activity.opportunityId,
    opportunityTitle: activity.opportunity?.title ?? null,
    conversationId: activity.opportunity?.conversationId ?? null,
    type: activity.type,
    title: activity.title,
    description: activity.description,
    assignedUser: activity.assignedUser ? serializeUserDirectory(activity.assignedUser) : null,
    dueAt: activity.dueAt.toISOString(),
    priority: activity.priority,
    status: activity.status,
    // Derivado, nunca gravado: gravar exigiria um processo virando linhas de
    // status na hora certa, e a queda dele faria a tela dizer que não há
    // nada atrasado.
    overdue: isCrmActivityOverdue(activity),
    completedAt: activity.completedAt?.toISOString() ?? null,
    completedBy: activity.completedBy ? serializeUserDirectory(activity.completedBy) : null,
    createdAt: activity.createdAt.toISOString(),
  };
}

export function serializeCrmEvent(
  event: CrmOpportunityEvent & { performedBy?: User | null },
) {
  return {
    id: event.id,
    type: event.type,
    description: event.description,
    // Nulo = ação do sistema (automação de etapa, resposta do cliente). A
    // tela escreve "Sistema" em vez de deixar a linha sem autor.
    performedBy: event.performedBy ? serializeUserDirectory(event.performedBy) : null,
    fromStageId: event.fromStageId,
    toStageId: event.toStageId,
    metadata: (event.metadata ?? null) as Record<string, unknown> | null,
    createdAt: event.createdAt.toISOString(),
  };
}

export function serializeCrmProduct(product: CrmProduct) {
  return {
    id: product.id,
    name: product.name,
    defaultValue: decimalToNumber(product.defaultValue),
    active: product.active,
  };
}

export function serializeCrmLossReason(reason: CrmLossReason) {
  return {
    id: reason.id,
    name: reason.name,
    active: reason.active,
    position: reason.position,
  };
}

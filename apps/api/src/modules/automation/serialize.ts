import type {
  AutomationExecution,
  AutomationExecutionLog,
  AutomationFlow,
  AutomationFlowVersion,
} from "@azvchat/database";
import type {
  AutomationExecutionStatus,
  AutomationFlowStatus,
  AutomationGraph,
  AutomationTriggerType,
  ScheduleMode,
} from "@azvchat/shared";

export interface AutomationFlowSummaryDto {
  id: string;
  name: string;
  description: string | null;
  status: AutomationFlowStatus;
  triggerType: AutomationTriggerType;
  whatsappInstanceId: string | null;
  instanceName: string | null;
  /** `null` = fluxo GERAL (sem classificação de departamento). */
  departmentId: string | null;
  departmentName: string | null;
  departmentColor: string | null;
  /**
   * Quem pede pode gravar neste fluxo? Decidido no servidor pela mesma régua
   * que recusa a gravação (`canWriteAutomationConfig`) — a tela nunca deduz
   * pelo papel, senão mostraria botão que só dá 403.
   */
  canEdit: boolean;
  priority: number;
  cooldownMinutes: number;
  scheduleMode: ScheduleMode;
  hasPublishedVersion: boolean;
  executionsCount: number;
  updatedAt: string;
}

type FlowWithRelations = AutomationFlow & {
  whatsappInstance?: { name: string } | null;
  department?: { name: string; color: string | null } | null;
  _count?: { executions: number };
};

export function serializeAutomationFlowSummary(
  flow: FlowWithRelations,
  viewer: { canEdit: boolean },
): AutomationFlowSummaryDto {
  return {
    id: flow.id,
    name: flow.name,
    description: flow.description,
    status: flow.status,
    triggerType: flow.triggerType,
    whatsappInstanceId: flow.whatsappInstanceId,
    instanceName: flow.whatsappInstance?.name ?? null,
    departmentId: flow.departmentId,
    departmentName: flow.department?.name ?? null,
    departmentColor: flow.department?.color ?? null,
    canEdit: viewer.canEdit,
    priority: flow.priority,
    cooldownMinutes: flow.cooldownMinutes,
    scheduleMode: flow.scheduleMode,
    hasPublishedVersion: flow.publishedVersionId != null,
    executionsCount: flow._count?.executions ?? 0,
    updatedAt: flow.updatedAt.toISOString(),
  };
}

export interface AutomationFlowDetailDto extends AutomationFlowSummaryDto {
  triggerConfig: Record<string, unknown> | null;
  draftGraph: AutomationGraph;
  publishedGraph: AutomationGraph | null;
  publishedVersion: number | null;
}

export function serializeAutomationFlowDetail(
  flow: FlowWithRelations & { publishedVersion?: AutomationFlowVersion | null },
  viewer: { canEdit: boolean },
): AutomationFlowDetailDto {
  return {
    ...serializeAutomationFlowSummary(flow, viewer),
    triggerConfig: (flow.triggerConfig as Record<string, unknown> | null) ?? null,
    draftGraph: flow.draftGraph as unknown as AutomationGraph,
    publishedGraph: flow.publishedVersion ? (flow.publishedVersion.graph as unknown as AutomationGraph) : null,
    publishedVersion: flow.publishedVersion?.version ?? null,
  };
}

export interface AutomationExecutionLogDto {
  id: string;
  at: string;
  nodeId: string | null;
  nodeType: string | null;
  level: string;
  event: string;
  message: string | null;
  data: Record<string, unknown> | null;
}

export function serializeAutomationExecutionLog(log: AutomationExecutionLog): AutomationExecutionLogDto {
  return {
    id: log.id,
    at: log.at.toISOString(),
    nodeId: log.nodeId,
    nodeType: log.nodeType,
    level: log.level,
    event: log.event,
    message: log.message,
    data: (log.data as Record<string, unknown> | null) ?? null,
  };
}

export interface AutomationExecutionSummaryDto {
  id: string;
  /**
   * `null` quando o fluxo é de uma área que quem pede não enxerga
   * (`flowHidden`): a execução aparece, a configuração não.
   */
  flowId: string | null;
  flowName: string;
  /** A conversa passou por automação de outra área — sem o nome nem os passos. */
  flowHidden: boolean;
  conversationId: string;
  conversationTitle: string;
  whatsappInstanceId: string;
  status: AutomationExecutionStatus;
  triggerType: AutomationTriggerType;
  resultSummary: string | null;
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
}

/** Rótulo do fluxo que quem pede não enxerga — diz que houve, não qual foi. */
export const HIDDEN_FLOW_LABEL = "Automação de outra área";

export function serializeAutomationExecutionSummary(
  execution: AutomationExecution & {
    flow: { name: string };
    conversation: { title: string; customTitle: string | null };
  },
  viewer: { flowHidden: boolean },
): AutomationExecutionSummaryDto {
  const hidden = viewer.flowHidden;
  return {
    id: execution.id,
    flowId: hidden ? null : execution.flowId,
    flowName: hidden ? HIDDEN_FLOW_LABEL : execution.flow.name,
    flowHidden: hidden,
    conversationId: execution.conversationId,
    conversationTitle: execution.conversation.customTitle || execution.conversation.title,
    whatsappInstanceId: execution.whatsappInstanceId,
    status: execution.status,
    triggerType: execution.triggerType,
    // O resumo e o erro citam etapa, setor e etiqueta escolhidos no fluxo:
    // são configuração, e somem junto com ela.
    resultSummary: hidden ? null : execution.resultSummary,
    error: hidden ? null : execution.error,
    startedAt: execution.startedAt.toISOString(),
    finishedAt: execution.finishedAt ? execution.finishedAt.toISOString() : null,
  };
}

export interface AutomationExecutionDetailDto extends AutomationExecutionSummaryDto {
  context: Record<string, unknown>;
  currentNodeId: string | null;
  logs: AutomationExecutionLogDto[];
}

export function serializeAutomationExecutionDetail(
  execution: AutomationExecution & {
    flow: { name: string };
    conversation: { title: string; customTitle: string | null };
    logs: AutomationExecutionLog[];
  },
  viewer: { flowHidden: boolean },
): AutomationExecutionDetailDto {
  const hidden = viewer.flowHidden;
  return {
    ...serializeAutomationExecutionSummary(execution, viewer),
    context: hidden ? {} : ((execution.context as Record<string, unknown> | null) ?? {}),
    currentNodeId: hidden ? null : execution.currentNodeId,
    logs: hidden ? [] : execution.logs.map(serializeAutomationExecutionLog),
  };
}

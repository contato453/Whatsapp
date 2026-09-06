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
} from "@azvchat/shared";

export interface AutomationFlowSummaryDto {
  id: string;
  name: string;
  description: string | null;
  status: AutomationFlowStatus;
  triggerType: AutomationTriggerType;
  whatsappInstanceId: string | null;
  instanceName: string | null;
  priority: number;
  cooldownMinutes: number;
  hasPublishedVersion: boolean;
  executionsCount: number;
  updatedAt: string;
}

export function serializeAutomationFlowSummary(
  flow: AutomationFlow & {
    whatsappInstance?: { name: string } | null;
    _count?: { executions: number };
  },
): AutomationFlowSummaryDto {
  return {
    id: flow.id,
    name: flow.name,
    description: flow.description,
    status: flow.status,
    triggerType: flow.triggerType,
    whatsappInstanceId: flow.whatsappInstanceId,
    instanceName: flow.whatsappInstance?.name ?? null,
    priority: flow.priority,
    cooldownMinutes: flow.cooldownMinutes,
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
  flow: AutomationFlow & {
    whatsappInstance?: { name: string } | null;
    publishedVersion?: AutomationFlowVersion | null;
    _count?: { executions: number };
  },
): AutomationFlowDetailDto {
  return {
    ...serializeAutomationFlowSummary(flow),
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
  flowId: string;
  flowName: string;
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

export function serializeAutomationExecutionSummary(
  execution: AutomationExecution & {
    flow: { name: string };
    conversation: { title: string; customTitle: string | null };
  },
): AutomationExecutionSummaryDto {
  return {
    id: execution.id,
    flowId: execution.flowId,
    flowName: execution.flow.name,
    conversationId: execution.conversationId,
    conversationTitle: execution.conversation.customTitle || execution.conversation.title,
    whatsappInstanceId: execution.whatsappInstanceId,
    status: execution.status,
    triggerType: execution.triggerType,
    resultSummary: execution.resultSummary,
    error: execution.error,
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
): AutomationExecutionDetailDto {
  return {
    ...serializeAutomationExecutionSummary(execution),
    context: (execution.context as Record<string, unknown> | null) ?? {},
    currentNodeId: execution.currentNodeId,
    logs: execution.logs.map(serializeAutomationExecutionLog),
  };
}

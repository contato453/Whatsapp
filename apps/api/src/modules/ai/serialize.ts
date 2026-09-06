import type {
  AiAgent,
  AiAgentVersion,
  AiAutomation,
  AiKnowledgeSource,
  AiProviderConfig,
  AiUsageLog,
  Department,
} from "@azvchat/database";
import {
  AI_DEFAULT_MODEL,
  aiModelInfo,
  isAiProviderKind,
  type AiAgentDto,
  type AiAgentStatus,
  type AiAgentSummaryDto,
  type AiAgentVersionDto,
  type AiAutomationConversationType,
  type AiAutomationDto,
  type AiKnowledgeSourceDto,
  type AiModelDto,
  type AiProviderDto,
  type AiProviderKind,
  type AiUsageLogDto,
} from "@azvchat/shared";
import { parseStoredAgentConfig } from "../../services/ai/config-schema.js";

/**
 * Serializadores do módulo de IA. A regra do resto do sistema vale
 * dobrada aqui: a chave do provedor NUNCA sai — nem cifrada. Só o `hint`.
 */

export function serializeAiProvider(
  kind: AiProviderKind,
  config: AiProviderConfig | null,
): AiProviderDto {
  return {
    provider: kind,
    status: config?.apiKeyEncrypted ? config.status : "not_connected",
    apiKeyHint: config?.apiKeyEncrypted ? config.apiKeyHint : null,
    defaultModel: config?.defaultModel ?? null,
    lastTestedAt: config?.lastTestedAt?.toISOString() ?? null,
    lastTestError: config?.lastTestError ?? null,
    modelsFetchedAt: config?.modelsFetchedAt?.toISOString() ?? null,
    updatedAt: config?.updatedAt.toISOString() ?? null,
  };
}

/** Lista do provedor (ids) enriquecida com o catálogo local (rótulo, finalidade, preço). */
export function serializeModels(ids: string[] | null): AiModelDto[] {
  const known = new Map<string, AiModelDto>();
  for (const id of ids ?? []) {
    const info = aiModelInfo(id);
    known.set(id, {
      id,
      label: info?.label ?? id,
      purpose: info?.purpose ?? "Modelo disponível na sua conta (sem descrição no catálogo local)",
      inputPerMillion: info?.inputPerMillion ?? null,
      outputPerMillion: info?.outputPerMillion ?? null,
      recommended: info?.recommended ?? false,
      fromProvider: true,
    });
  }
  return [...known.values()].sort((a, b) => Number(b.recommended) - Number(a.recommended) || a.id.localeCompare(b.id));
}

type AgentWithRelations = AiAgent & {
  departments?: Array<{ department: Department }>;
  knowledgeSources?: Array<{ sourceId: string }>;
  _count?: { sessions: number };
};

export function serializeAiAgentSummary(
  agent: AgentWithRelations,
  extras: { costMicros: number; defaultModel: string | null },
): AiAgentSummaryDto {
  return {
    id: agent.id,
    name: agent.name,
    description: agent.description,
    status: agent.status as AiAgentStatus,
    isGeneral: agent.isGeneral,
    departments: (agent.departments ?? []).map((link) => ({
      id: link.department.id,
      name: link.department.name,
      color: link.department.color,
    })),
    provider: "openai",
    model: agent.model ?? extras.defaultModel ?? AI_DEFAULT_MODEL,
    version: agent.currentVersion,
    sessionsCount: agent._count?.sessions ?? 0,
    costMicros: extras.costMicros,
    knowledgeSourceIds: (agent.knowledgeSources ?? []).map((link) => link.sourceId),
    updatedAt: agent.updatedAt.toISOString(),
    createdAt: agent.createdAt.toISOString(),
  };
}

export function serializeAiAgent(
  agent: AgentWithRelations,
  extras: { costMicros: number; defaultModel: string | null },
): AiAgentDto {
  const config = parseStoredAgentConfig(agent.config);
  // As colunas com FK são a verdade do destino de transferência (o banco as
  // zera quando o alvo some); o JSON só carrega a cópia.
  config.handoff.departmentId = agent.handoffDepartmentId;
  config.handoff.assigneeUserId = agent.handoffAssigneeId;
  return { ...serializeAiAgentSummary(agent, extras), config };
}

export function serializeAiAgentVersion(
  version: AiAgentVersion & { createdBy?: { id: string; name: string } | null },
): AiAgentVersionDto {
  return {
    id: version.id,
    version: version.version,
    model: version.model,
    createdBy: version.createdBy ?? null,
    createdAt: version.createdAt.toISOString(),
  };
}

export function serializeAiKnowledgeSource(
  source: AiKnowledgeSource & { _count?: { agents: number } },
): AiKnowledgeSourceDto {
  return {
    id: source.id,
    title: source.title,
    kind: source.kind,
    content: source.content,
    active: source.active,
    agentsCount: source._count?.agents ?? 0,
    updatedAt: source.updatedAt.toISOString(),
  };
}

export function serializeAiAutomation(
  automation: AiAutomation & { agent: { name: string; status: string }; _count?: { sessions: number } },
): AiAutomationDto {
  return {
    id: automation.id,
    name: automation.name,
    active: automation.active,
    agentId: automation.agentId,
    agentName: automation.agent.name,
    agentStatus: automation.agent.status as AiAgentStatus,
    whatsappInstanceId: automation.whatsappInstanceId,
    departmentId: automation.departmentId,
    onlyWithoutDepartment: automation.onlyWithoutDepartment,
    conversationType: automation.conversationType as AiAutomationConversationType,
    onlyUnassigned: automation.onlyUnassigned,
    onlyNewConversations: automation.onlyNewConversations,
    resolvedTagId: automation.resolvedTagId,
    priority: automation.priority,
    sessionsCount: automation._count?.sessions ?? 0,
    createdAt: automation.createdAt.toISOString(),
  };
}

function stringList(raw: unknown): string[] {
  return Array.isArray(raw) ? raw.filter((item): item is string => typeof item === "string") : [];
}

export function serializeAiUsageLog(
  log: AiUsageLog & { conversation?: { title: string; customTitle: string | null } | null },
): AiUsageLogDto {
  return {
    id: log.id,
    createdAt: log.createdAt.toISOString(),
    kind: log.kind,
    outcome: log.outcome,
    agentId: log.agentId,
    agentName: log.agentName,
    conversationId: log.conversationId,
    conversationTitle: log.conversation ? (log.conversation.customTitle || log.conversation.title) : null,
    sessionId: log.sessionId,
    provider: isAiProviderKind(log.provider) ? log.provider : "openai",
    model: log.model,
    inputTokens: log.inputTokens,
    outputTokens: log.outputTokens,
    costMicros: log.costMicros,
    durationMs: log.durationMs,
    toolsRequested: stringList(log.toolsRequested),
    toolsExecuted: stringList(log.toolsExecuted),
    toolsBlocked: stringList(log.toolsBlocked),
    handoffReason: log.handoffReason,
    errorCode: log.errorCode,
  };
}

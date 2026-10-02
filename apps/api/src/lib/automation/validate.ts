import type { PrismaClient } from "@azvchat/database";
import {
  validateAutomationGraph,
  type AiAgentNodeData,
  type AssignUserNodeData,
  type AutomationFlowProblem,
  type AutomationGraph,
  type CrmOpportunityNodeData,
  type FinishNodeData,
  type ForwardDepartmentNodeData,
  type TagNodeData,
} from "@azvchat/shared";

/**
 * Validação completa do grafo antes de publicar (seção 25): a FORMA (sem
 * banco, `validateAutomationGraph` do shared) mais o que só a API sabe —
 * departamento, usuário e etiqueta referenciados por um nó existem mesmo
 * NESTA organização. Publicar um fluxo apontando para um departamento
 * excluído travaria a primeira conversa que passasse por ali sem aviso
 * nenhum antes disso.
 */
export async function validateAutomationFlowForPublish(
  prisma: PrismaClient,
  organizationId: string,
  graph: AutomationGraph,
): Promise<AutomationFlowProblem[]> {
  const problems = [...validateAutomationGraph(graph)];

  const tagIds = new Set<string>();
  const departmentIds = new Set<string>();
  const userIds = new Set<string>();
  const agentIds = new Set<string>();

  for (const node of graph.nodes) {
    if (node.type === "tag_add" || node.type === "tag_remove") {
      const id = (node.data as unknown as TagNodeData).tagId;
      if (id) tagIds.add(id);
    }
    if (node.type === "forward_department") {
      const id = (node.data as unknown as ForwardDepartmentNodeData).departmentId;
      if (id) departmentIds.add(id);
    }
    if (node.type === "assign_user") {
      const id = (node.data as unknown as AssignUserNodeData).userId;
      if (id) userIds.add(id);
    }
    if (node.type === "ai_agent") {
      const id = (node.data as unknown as AiAgentNodeData).agentId;
      if (id) agentIds.add(id);
    }
    if (node.type === "finish") {
      const id = (node.data as unknown as FinishNodeData).addTagId;
      if (id) tagIds.add(id);
    }
  }

  const [tags, departments, users, agents] = await Promise.all([
    tagIds.size
      ? prisma.tag.findMany({ where: { id: { in: [...tagIds] }, organizationId }, select: { id: true } })
      : Promise.resolve([]),
    departmentIds.size
      ? prisma.department.findMany({
          where: { id: { in: [...departmentIds] }, organizationId },
          select: { id: true },
        })
      : Promise.resolve([]),
    userIds.size
      ? prisma.user.findMany({ where: { id: { in: [...userIds] }, organizationId }, select: { id: true } })
      : Promise.resolve([]),
    agentIds.size
      ? prisma.aiAgent.findMany({ where: { id: { in: [...agentIds] }, organizationId }, select: { id: true } })
      : Promise.resolve([]),
  ]);

  const foundTags = new Set(tags.map((tag) => tag.id));
  const foundDepartments = new Set(departments.map((department) => department.id));
  const foundUsers = new Set(users.map((user) => user.id));
  const foundAgents = new Set(agents.map((agent) => agent.id));

  for (const id of tagIds) {
    if (!foundTags.has(id)) problems.push({ message: "Um dos blocos de etiqueta aponta para uma etiqueta que não existe mais." });
  }
  for (const id of departmentIds) {
    if (!foundDepartments.has(id)) {
      problems.push({ message: "O bloco de encaminhar para setor aponta para um departamento que não existe mais." });
    }
  }
  for (const id of userIds) {
    if (!foundUsers.has(id)) {
      problems.push({ message: "O bloco de atribuir atendente aponta para uma pessoa que não existe mais." });
    }
  }
  for (const id of agentIds) {
    if (!foundAgents.has(id)) {
      problems.push({ message: "O bloco de atendimento por IA aponta para um agente que não existe mais." });
    }
  }

  // Funil e etapa do bloco "Enviar para funil (CRM)". Em runtime o motor
  // ainda se defende (funil apagado vira log, etapa removida cai na
  // primeira), mas publicar já apontando para o que não existe é o erro que
  // dá para pegar antes de o primeiro lead passar por ali sem virar card.
  const crmNodes = graph.nodes
    .filter((node) => node.type === "crm_opportunity")
    .map((node) => ({ nodeId: node.id, data: node.data as unknown as CrmOpportunityNodeData }))
    .filter((item) => item.data.pipelineId);
  if (crmNodes.length > 0) {
    const pipelines = await prisma.crmPipeline.findMany({
      where: { id: { in: [...new Set(crmNodes.map((item) => item.data.pipelineId))] }, organizationId },
      select: { id: true, isActive: true, stages: { select: { id: true } } },
    });
    const byId = new Map(pipelines.map((pipeline) => [pipeline.id, pipeline]));
    for (const { nodeId, data } of crmNodes) {
      const pipeline = byId.get(data.pipelineId);
      if (!pipeline) {
        problems.push({ nodeId, message: "O bloco de funil do CRM aponta para um funil que não existe mais." });
      } else if (!pipeline.isActive) {
        problems.push({ nodeId, message: "O bloco de funil do CRM aponta para um funil desativado." });
      } else if (data.stageId && !pipeline.stages.some((stage) => stage.id === data.stageId)) {
        problems.push({ nodeId, message: "O bloco de funil do CRM aponta para uma etapa que não existe mais neste funil." });
      }
    }
  }

  return problems;
}

import type { FastifyInstance } from "fastify";
import type { Prisma } from "@azvchat/database";
import { z } from "zod";
import {
  AUTOMATION_NODE_TYPES,
  AUTOMATION_TRIGGER_TYPES,
  AUTOMATION_TEMPLATES,
  automationTemplate,
  emptyAutomationGraph,
  type AutomationGraph,
} from "@azvchat/shared";
import { requirePermission } from "../../lib/permissions.js";
import { AppError, NotFoundError } from "../../lib/errors.js";
import { conversationScope, loadConversationAccess } from "../../lib/access.js";
import { validateAutomationFlowForPublish } from "../../lib/automation/validate.js";
import {
  serializeAutomationExecutionDetail,
  serializeAutomationExecutionSummary,
  serializeAutomationFlowDetail,
  serializeAutomationFlowSummary,
} from "./serialize.js";
import type { AppDeps } from "../../types.js";

const graphSchema = z.object({
  nodes: z.array(
    z.object({
      id: z.string().min(1),
      type: z.enum(AUTOMATION_NODE_TYPES),
      position: z.object({ x: z.number(), y: z.number() }),
      data: z.record(z.string(), z.unknown()),
    }),
  ),
  edges: z.array(
    z.object({
      id: z.string().min(1),
      source: z.string().min(1),
      target: z.string().min(1),
      sourceHandle: z.string().nullable().optional(),
    }),
  ),
});

const flowCreateSchema = z.object({
  name: z.string().min(2).max(120),
  description: z.string().max(500).optional(),
  triggerType: z.enum(AUTOMATION_TRIGGER_TYPES).optional(),
  whatsappInstanceId: z.string().uuid().optional(),
  /** Cria já a partir de um template do catálogo (seção 21/22). */
  templateKey: z.string().optional(),
});

const flowUpdateSchema = z.object({
  name: z.string().min(2).max(120).optional(),
  description: z.string().max(500).nullable().optional(),
  triggerType: z.enum(AUTOMATION_TRIGGER_TYPES).optional(),
  triggerConfig: z.record(z.string(), z.unknown()).nullable().optional(),
  whatsappInstanceId: z.string().uuid().nullable().optional(),
  priority: z.coerce.number().int().min(1).max(1000).optional(),
  cooldownMinutes: z.coerce.number().int().min(0).max(10_080).optional(),
  draftGraph: graphSchema.optional(),
});

const executionListQuerySchema = z.object({
  flowId: z.string().uuid().optional(),
  conversationId: z.string().uuid().optional(),
  status: z
    .enum(["running", "waiting", "completed", "failed", "canceled", "handed_off"])
    .optional(),
  limit: z.coerce.number().min(1).max(200).default(50),
});

/**
 * Módulo AUTOMAÇÕES: construtor de fluxos (`automation.manage`) e histórico
 * de execução (`automation.view_history`) — os dois papéis do catálogo que a
 * varredura de `permissions.test.ts` exige encontrar em uso aqui.
 *
 * Visibilidade da conversa NUNCA muda por causa de automação: o histórico
 * de execução é recortado por `conversationScope`, a mesma régua de sempre —
 * ver a conversa de uma execução exige o número/departamento dela.
 */
export async function automationRoutes(app: FastifyInstance, deps: AppDeps): Promise<void> {
  async function assertInstanceInOrg(id: string | null | undefined, organizationId: string): Promise<void> {
    if (!id) return;
    const instance = await deps.prisma.whatsAppInstance.findFirst({ where: { id, organizationId } });
    if (!instance) throw new NotFoundError("Número de WhatsApp");
  }

  async function findFlowOr404(id: string, organizationId: string) {
    const flow = await deps.prisma.automationFlow.findFirst({
      where: { id, organizationId },
      include: { whatsappInstance: true, publishedVersion: true, _count: { select: { executions: true } } },
    });
    if (!flow) throw new NotFoundError("Fluxo de automação");
    return flow;
  }

  app.get("/automation-flows", { preHandler: requirePermission(deps, "automation.manage") }, async (request) => {
    const flows = await deps.prisma.automationFlow.findMany({
      where: { organizationId: request.user.organizationId },
      include: { whatsappInstance: true, _count: { select: { executions: true } } },
      orderBy: { updatedAt: "desc" },
    });
    return { flows: flows.map(serializeAutomationFlowSummary) };
  });

  app.get("/automation-templates", { preHandler: requirePermission(deps, "automation.manage") }, async () => {
    return {
      templates: AUTOMATION_TEMPLATES.map((template) => ({
        key: template.key,
        name: template.name,
        description: template.description,
        category: template.category,
        triggerType: template.triggerType,
      })),
    };
  });

  app.post(
    "/automation-templates/:key/use",
    { preHandler: requirePermission(deps, "automation.manage") },
    async (request, reply) => {
      const { key } = z.object({ key: z.string() }).parse(request.params);
      const template = automationTemplate(key);
      if (!template) throw new NotFoundError("Template de automação");
      const flow = await deps.prisma.automationFlow.create({
        data: {
          organizationId: request.user.organizationId,
          name: template.name,
          description: template.description,
          triggerType: template.triggerType,
          triggerConfig: (template.triggerConfig ?? undefined) as Prisma.InputJsonValue | undefined,
          draftGraph: template.graph as unknown as Prisma.InputJsonValue,
          createdById: request.user.sub,
        },
        include: { whatsappInstance: true, _count: { select: { executions: true } } },
      });
      deps.audit.record({
        organizationId: request.user.organizationId,
        userId: request.user.sub,
        action: "automation_flow.created_from_template",
        entityType: "AutomationFlow",
        entityId: flow.id,
        metadata: { templateKey: key },
      });
      return reply.status(201).send({ flow: serializeAutomationFlowDetail(flow) });
    },
  );

  app.post("/automation-flows", { preHandler: requirePermission(deps, "automation.manage") }, async (request, reply) => {
    const body = flowCreateSchema.parse(request.body);
    await assertInstanceInOrg(body.whatsappInstanceId, request.user.organizationId);
    const template = body.templateKey ? automationTemplate(body.templateKey) : null;
    const flow = await deps.prisma.automationFlow.create({
      data: {
        organizationId: request.user.organizationId,
        name: body.name,
        description: body.description ?? null,
        triggerType: template?.triggerType ?? body.triggerType ?? "new_message",
        whatsappInstanceId: body.whatsappInstanceId ?? null,
        draftGraph: (template?.graph ?? emptyAutomationGraph()) as unknown as object,
        createdById: request.user.sub,
      },
      include: { whatsappInstance: true, _count: { select: { executions: true } } },
    });
    deps.audit.record({
      organizationId: request.user.organizationId,
      userId: request.user.sub,
      action: "automation_flow.created",
      entityType: "AutomationFlow",
      entityId: flow.id,
    });
    return reply.status(201).send({ flow: serializeAutomationFlowDetail(flow) });
  });

  app.get(
    "/automation-flows/:id",
    { preHandler: requirePermission(deps, "automation.manage") },
    async (request) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
      const flow = await findFlowOr404(id, request.user.organizationId);
      return { flow: serializeAutomationFlowDetail(flow) };
    },
  );

  /**
   * Autosave do construtor: grava o RASCUNHO. Nunca toca em
   * `publishedVersionId` — é assim que editar um fluxo ATIVO não afeta
   * execução em andamento (seção 24), que continua presa à versão publicada.
   */
  app.patch(
    "/automation-flows/:id",
    { preHandler: requirePermission(deps, "automation.manage") },
    async (request) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
      const body = flowUpdateSchema.parse(request.body);
      await findFlowOr404(id, request.user.organizationId);
      if (body.whatsappInstanceId) await assertInstanceInOrg(body.whatsappInstanceId, request.user.organizationId);

      const data: Prisma.AutomationFlowUncheckedUpdateInput = {
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.description !== undefined ? { description: body.description } : {}),
        ...(body.triggerType !== undefined ? { triggerType: body.triggerType } : {}),
        ...(body.triggerConfig !== undefined
          ? { triggerConfig: (body.triggerConfig ?? undefined) as Prisma.InputJsonValue | undefined }
          : {}),
        ...(body.whatsappInstanceId !== undefined ? { whatsappInstanceId: body.whatsappInstanceId } : {}),
        ...(body.priority !== undefined ? { priority: body.priority } : {}),
        ...(body.cooldownMinutes !== undefined ? { cooldownMinutes: body.cooldownMinutes } : {}),
        ...(body.draftGraph !== undefined ? { draftGraph: body.draftGraph as unknown as Prisma.InputJsonValue } : {}),
        updatedById: request.user.sub,
      };
      const flow = await deps.prisma.automationFlow.update({
        where: { id },
        data,
        include: { whatsappInstance: true, publishedVersion: true, _count: { select: { executions: true } } },
      });
      return { flow: serializeAutomationFlowDetail(flow) };
    },
  );

  app.get(
    "/automation-flows/:id/validate",
    { preHandler: requirePermission(deps, "automation.manage") },
    async (request) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
      const flow = await findFlowOr404(id, request.user.organizationId);
      const problems = await validateAutomationFlowForPublish(
        deps.prisma,
        request.user.organizationId,
        flow.draftGraph as unknown as AutomationGraph,
      );
      return { problems };
    },
  );

  /**
   * Publica o rascunho: valida, congela numa `AutomationFlowVersion` nova e
   * aponta o fluxo para ela. Primeira publicação já ATIVA o fluxo — é o
   * gesto natural de "terminei de montar, pode rodar"; republicar um fluxo
   * que a supervisão desativou não o reativa sozinho.
   */
  app.post(
    "/automation-flows/:id/publish",
    { preHandler: requirePermission(deps, "automation.manage") },
    async (request) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
      const flow = await findFlowOr404(id, request.user.organizationId);
      const graph = flow.draftGraph as unknown as AutomationGraph;
      const problems = await validateAutomationFlowForPublish(deps.prisma, request.user.organizationId, graph);
      if (problems.length > 0) {
        throw new AppError("O fluxo tem pendências e não pode ser publicado.", 422, "automation_flow_invalid", {
          problems,
        });
      }
      const lastVersion = await deps.prisma.automationFlowVersion.findFirst({
        where: { flowId: id },
        orderBy: { version: "desc" },
        select: { version: true },
      });
      const nextVersion = (lastVersion?.version ?? 0) + 1;
      const version = await deps.prisma.automationFlowVersion.create({
        data: { flowId: id, version: nextVersion, graph: graph as unknown as object, publishedById: request.user.sub },
      });
      const updated = await deps.prisma.automationFlow.update({
        where: { id },
        data: {
          publishedVersionId: version.id,
          status: flow.status === "draft" ? "active" : flow.status,
        },
        include: { whatsappInstance: true, publishedVersion: true, _count: { select: { executions: true } } },
      });
      deps.audit.record({
        organizationId: request.user.organizationId,
        userId: request.user.sub,
        action: "automation_flow.published",
        entityType: "AutomationFlow",
        entityId: id,
        metadata: { version: nextVersion },
      });
      return { flow: serializeAutomationFlowDetail(updated) };
    },
  );

  app.post(
    "/automation-flows/:id/activate",
    { preHandler: requirePermission(deps, "automation.manage") },
    async (request) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
      const flow = await findFlowOr404(id, request.user.organizationId);
      if (!flow.publishedVersionId) {
        throw new AppError("Publique o fluxo antes de ativá-lo.", 422, "automation_flow_not_published");
      }
      const updated = await deps.prisma.automationFlow.update({
        where: { id },
        data: { status: "active" },
        include: { whatsappInstance: true, publishedVersion: true, _count: { select: { executions: true } } },
      });
      deps.audit.record({
        organizationId: request.user.organizationId,
        userId: request.user.sub,
        action: "automation_flow.activated",
        entityType: "AutomationFlow",
        entityId: id,
      });
      return { flow: serializeAutomationFlowDetail(updated) };
    },
  );

  app.post(
    "/automation-flows/:id/deactivate",
    { preHandler: requirePermission(deps, "automation.manage") },
    async (request) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
      await findFlowOr404(id, request.user.organizationId);
      const updated = await deps.prisma.automationFlow.update({
        where: { id },
        data: { status: "inactive" },
        include: { whatsappInstance: true, publishedVersion: true, _count: { select: { executions: true } } },
      });
      deps.audit.record({
        organizationId: request.user.organizationId,
        userId: request.user.sub,
        action: "automation_flow.deactivated",
        entityType: "AutomationFlow",
        entityId: id,
      });
      return { flow: serializeAutomationFlowDetail(updated) };
    },
  );

  app.post(
    "/automation-flows/:id/duplicate",
    { preHandler: requirePermission(deps, "automation.manage") },
    async (request, reply) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
      const flow = await findFlowOr404(id, request.user.organizationId);
      const copy = await deps.prisma.automationFlow.create({
        data: {
          organizationId: request.user.organizationId,
          name: `${flow.name} (cópia)`,
          description: flow.description,
          triggerType: flow.triggerType,
          triggerConfig: flow.triggerConfig ?? undefined,
          whatsappInstanceId: flow.whatsappInstanceId,
          priority: flow.priority,
          cooldownMinutes: flow.cooldownMinutes,
          // A cópia nasce RASCUNHO, sem versão publicada — mexer nela nunca
          // afeta o fluxo original que já pode estar em produção.
          draftGraph: flow.draftGraph as object,
          createdById: request.user.sub,
        },
        include: { whatsappInstance: true, _count: { select: { executions: true } } },
      });
      deps.audit.record({
        organizationId: request.user.organizationId,
        userId: request.user.sub,
        action: "automation_flow.duplicated",
        entityType: "AutomationFlow",
        entityId: copy.id,
        metadata: { fromFlowId: id },
      });
      return reply.status(201).send({ flow: serializeAutomationFlowDetail(copy) });
    },
  );

  app.delete(
    "/automation-flows/:id",
    { preHandler: requirePermission(deps, "automation.manage") },
    async (request) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
      await findFlowOr404(id, request.user.organizationId);
      await deps.prisma.automationFlow.delete({ where: { id } });
      deps.audit.record({
        organizationId: request.user.organizationId,
        userId: request.user.sub,
        action: "automation_flow.deleted",
        entityType: "AutomationFlow",
        entityId: id,
      });
      return { ok: true };
    },
  );

  /* ------------------------------------------------------------------ *
   * Histórico de execução (seção 28)
   * ------------------------------------------------------------------ */

  app.get(
    "/automation-executions",
    { preHandler: requirePermission(deps, "automation.view_history") },
    async (request) => {
      const query = executionListQuerySchema.parse(request.query);
      const access = await loadConversationAccess(deps.prisma, request.user);
      const executions = await deps.prisma.automationExecution.findMany({
        where: {
          organizationId: request.user.organizationId,
          ...(query.flowId ? { flowId: query.flowId } : {}),
          ...(query.conversationId ? { conversationId: query.conversationId } : {}),
          ...(query.status ? { status: query.status } : {}),
          conversation: { is: conversationScope(access) },
        },
        include: { flow: { select: { name: true } }, conversation: { select: { title: true, customTitle: true } } },
        orderBy: { startedAt: "desc" },
        take: query.limit,
      });
      return { executions: executions.map(serializeAutomationExecutionSummary) };
    },
  );

  app.get(
    "/automation-executions/:id",
    { preHandler: requirePermission(deps, "automation.view_history") },
    async (request) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
      const access = await loadConversationAccess(deps.prisma, request.user);
      const execution = await deps.prisma.automationExecution.findFirst({
        where: { id, organizationId: request.user.organizationId, conversation: { is: conversationScope(access) } },
        include: {
          flow: { select: { name: true } },
          conversation: { select: { title: true, customTitle: true } },
          logs: { orderBy: { at: "asc" } },
        },
      });
      if (!execution) throw new NotFoundError("Execução de automação");
      return { execution: serializeAutomationExecutionDetail(execution) };
    },
  );
}

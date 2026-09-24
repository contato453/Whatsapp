import type { FastifyInstance } from "fastify";
import type { Prisma } from "@azvchat/database";
import { z } from "zod";
import {
  AUTOMATION_NODE_TYPES,
  AUTOMATION_TRIGGER_TYPES,
  AUTOMATION_TEMPLATES,
  automationTemplate,
  emptyAutomationGraph,
  SCHEDULE_MODES,
  type AutomationGraph,
} from "@azvchat/shared";
import type { FastifyRequest } from "fastify";
import { loadPermissions, requirePermission } from "../../lib/permissions.js";
import { AppError, ForbiddenError, NotFoundError } from "../../lib/errors.js";
import {
  automationConfigScope,
  canSeeAutomationConfig,
  canWriteAutomationConfig,
  conversationScope,
  isGeneralAutomationConfig,
  loadConversationAccess,
  type AutomationConfigAccess,
  type AutomationConfigTarget,
} from "../../lib/access.js";
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

/**
 * Onde o fluxo mora: departamento (nulo = geral) e número (nulo = todos).
 * O departamento é OBRIGATÓRIO de informar na criação — escolher "geral" é
 * decisão explícita, e não o que sobra quando alguém esquece o campo.
 */
const flowScopeSchema = z.object({
  departmentId: z.string().uuid().nullable(),
  whatsappInstanceId: z.string().uuid().nullable().optional(),
});

const flowCreateSchema = flowScopeSchema.extend({
  name: z.string().min(2).max(120),
  description: z.string().max(500).optional(),
  triggerType: z.enum(AUTOMATION_TRIGGER_TYPES).optional(),
  /** Cria já a partir de um template do catálogo (seção 21/22). */
  templateKey: z.string().optional(),
});

const flowListQuerySchema = z.object({
  /** Um departamento, ou `none` para os gerais (sem classificação). */
  departmentId: z.union([z.string().uuid(), z.literal("none")]).optional(),
});

const flowUpdateSchema = z.object({
  name: z.string().min(2).max(120).optional(),
  description: z.string().max(500).nullable().optional(),
  triggerType: z.enum(AUTOMATION_TRIGGER_TYPES).optional(),
  triggerConfig: z.record(z.string(), z.unknown()).nullable().optional(),
  whatsappInstanceId: z.string().uuid().nullable().optional(),
  departmentId: z.string().uuid().nullable().optional(),
  priority: z.coerce.number().int().min(1).max(1000).optional(),
  cooldownMinutes: z.coerce.number().int().min(0).max(10_080).optional(),
  scheduleMode: z.enum(SCHEDULE_MODES).optional(),
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

const executionInclude = {
  flow: { select: { name: true, departmentId: true, whatsappInstanceId: true } },
  conversation: { select: { title: true, customTitle: true } },
} satisfies Prisma.AutomationExecutionInclude;

/** Campos de cadastro cuja mudança entra no `AuditLog` (o desenho não entra). */
const AUDITED_FLOW_FIELDS = [
  "name",
  "description",
  "triggerType",
  "whatsappInstanceId",
  "departmentId",
  "priority",
  "cooldownMinutes",
  "scheduleMode",
] as const;

/** Onde o fluxo mora, como a auditoria registra: ids, nunca nomes que mudam. */
function flowScopeAudit(flow: AutomationConfigTarget): Record<string, unknown> {
  return {
    departmentId: flow.departmentId,
    whatsappInstanceId: flow.whatsappInstanceId,
    general: isGeneralAutomationConfig(flow),
  };
}

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

  async function assertDepartmentInOrg(id: string | null | undefined, organizationId: string): Promise<void> {
    if (!id) return;
    const department = await deps.prisma.department.findFirst({ where: { id, organizationId }, select: { id: true } });
    if (!department) throw new NotFoundError("Departamento");
  }

  /**
   * O alcance de quem pede, para a CONFIGURAÇÃO de automação: os mesmos
   * vínculos de número e departamento da conversa, mais a chave de alcance
   * geral. Nada disto é usado pelo motor — ver `automationConfigScope`.
   */
  async function loadFlowAccess(user: FastifyRequest["user"]) {
    const [conversationAccess, permissions] = await Promise.all([
      loadConversationAccess(deps.prisma, user),
      loadPermissions(deps.prisma, user),
    ]);
    const access: AutomationConfigAccess = {
      instanceIds: conversationAccess.instanceIds,
      departmentIds: conversationAccess.departmentIds,
    };
    return { access, canManageGeneral: permissions.can("automation.manage_general") };
  }
  type FlowAccess = Awaited<ReturnType<typeof loadFlowAccess>>;

  /**
   * Recusa a gravação de um estado que esta pessoa não pode ter nas mãos.
   * Duas mensagens, porque os dois motivos pedem ações diferentes de quem lê:
   * um é "este fluxo não é da sua área", o outro é "fluxo geral pede a chave".
   */
  function assertCanWriteFlow(flowAccess: FlowAccess, target: AutomationConfigTarget): void {
    if (canWriteAutomationConfig(flowAccess.access, target, flowAccess.canManageGeneral)) return;
    if (!canSeeAutomationConfig(flowAccess.access, target)) {
      throw new ForbiddenError("Você só pode gravar fluxos dos seus departamentos e dos números que atende.");
    }
    throw new ForbiddenError(
      "Fluxo geral (sem departamento ou para todos os números) exige a permissão de automações gerais. Escolha um departamento e um número.",
    );
  }

  const flowInclude = {
    whatsappInstance: true,
    department: { select: { id: true, name: true, color: true } },
    publishedVersion: true,
    _count: { select: { executions: true } },
  } satisfies Prisma.AutomationFlowInclude;

  /**
   * Carrega o fluxo e confere que quem pede o ENXERGA. Fluxo de outra
   * organização não existe (404); fluxo desta organização fora do alcance é
   * recusado (403) — esconder na tela não é controle de acesso, e chamar a
   * rota direto com o id tem que dar na mesma parede.
   */
  async function findVisibleFlow(id: string, user: FastifyRequest["user"]) {
    const flow = await deps.prisma.automationFlow.findFirst({
      where: { id, organizationId: user.organizationId },
      include: flowInclude,
    });
    if (!flow) throw new NotFoundError("Fluxo de automação");
    const flowAccess = await loadFlowAccess(user);
    if (!canSeeAutomationConfig(flowAccess.access, flow)) {
      throw new ForbiddenError("Este fluxo é de um departamento ou de um número que você não atende.");
    }
    return { flow, flowAccess };
  }

  /** O mesmo, exigindo também poder GRAVAR no estado atual do fluxo. */
  async function findWritableFlow(id: string, user: FastifyRequest["user"]) {
    const found = await findVisibleFlow(id, user);
    assertCanWriteFlow(found.flowAccess, found.flow);
    return found;
  }

  function serializeFor(flowAccess: FlowAccess) {
    return <T extends Parameters<typeof serializeAutomationFlowDetail>[0]>(flow: T) =>
      serializeAutomationFlowDetail(flow, {
        canEdit: canWriteAutomationConfig(flowAccess.access, flow, flowAccess.canManageGeneral),
      });
  }

  app.get("/automation-flows", { preHandler: requirePermission(deps, "automation.manage") }, async (request) => {
    const query = flowListQuerySchema.parse(request.query);
    const flowAccess = await loadFlowAccess(request.user);
    const flows = await deps.prisma.automationFlow.findMany({
      where: {
        organizationId: request.user.organizationId,
        // Recorte de VISUALIZAÇÃO. O motor lista os fluxos sem ele, e tem
        // de continuar assim: quando a mensagem chega não há usuário logado.
        ...automationConfigScope(flowAccess.access),
        ...(query.departmentId ? { departmentId: query.departmentId === "none" ? null : query.departmentId } : {}),
      },
      include: flowInclude,
      orderBy: { updatedAt: "desc" },
    });
    return {
      flows: flows.map((flow) =>
        serializeAutomationFlowSummary(flow, {
          canEdit: canWriteAutomationConfig(flowAccess.access, flow, flowAccess.canManageGeneral),
        }),
      ),
    };
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
      const scope = flowScopeSchema.parse(request.body ?? {});
      const template = automationTemplate(key);
      if (!template) throw new NotFoundError("Template de automação");
      // O template é catálogo do sistema, igual para toda a organização, e
      // não carrega departamento. A CÓPIA carrega: ela nasce onde quem a
      // criou escolheu, pela mesma régua de criar do zero.
      await assertDepartmentInOrg(scope.departmentId, request.user.organizationId);
      await assertInstanceInOrg(scope.whatsappInstanceId, request.user.organizationId);
      const target = { departmentId: scope.departmentId, whatsappInstanceId: scope.whatsappInstanceId ?? null };
      const flowAccess = await loadFlowAccess(request.user);
      assertCanWriteFlow(flowAccess, target);
      const flow = await deps.prisma.automationFlow.create({
        data: {
          organizationId: request.user.organizationId,
          departmentId: target.departmentId,
          whatsappInstanceId: target.whatsappInstanceId,
          name: template.name,
          description: template.description,
          triggerType: template.triggerType,
          triggerConfig: (template.triggerConfig ?? undefined) as Prisma.InputJsonValue | undefined,
          draftGraph: template.graph as unknown as Prisma.InputJsonValue,
          createdById: request.user.sub,
        },
        include: flowInclude,
      });
      deps.audit.record({
        organizationId: request.user.organizationId,
        userId: request.user.sub,
        action: "automation_flow.created_from_template",
        entityType: "AutomationFlow",
        entityId: flow.id,
        metadata: { templateKey: key, ...flowScopeAudit(flow) },
      });
      return reply.status(201).send({ flow: serializeFor(flowAccess)(flow) });
    },
  );

  app.post("/automation-flows", { preHandler: requirePermission(deps, "automation.manage") }, async (request, reply) => {
    const body = flowCreateSchema.parse(request.body);
    await assertInstanceInOrg(body.whatsappInstanceId, request.user.organizationId);
    await assertDepartmentInOrg(body.departmentId, request.user.organizationId);
    const target = { departmentId: body.departmentId, whatsappInstanceId: body.whatsappInstanceId ?? null };
    const flowAccess = await loadFlowAccess(request.user);
    assertCanWriteFlow(flowAccess, target);
    const template = body.templateKey ? automationTemplate(body.templateKey) : null;
    const flow = await deps.prisma.automationFlow.create({
      data: {
        organizationId: request.user.organizationId,
        name: body.name,
        description: body.description ?? null,
        triggerType: template?.triggerType ?? body.triggerType ?? "new_message",
        whatsappInstanceId: target.whatsappInstanceId,
        departmentId: target.departmentId,
        draftGraph: (template?.graph ?? emptyAutomationGraph()) as unknown as object,
        createdById: request.user.sub,
      },
      include: flowInclude,
    });
    deps.audit.record({
      organizationId: request.user.organizationId,
      userId: request.user.sub,
      action: "automation_flow.created",
      entityType: "AutomationFlow",
      entityId: flow.id,
      metadata: flowScopeAudit(flow),
    });
    return reply.status(201).send({ flow: serializeFor(flowAccess)(flow) });
  });

  app.get(
    "/automation-flows/:id",
    { preHandler: requirePermission(deps, "automation.manage") },
    async (request) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
      const { flow, flowAccess } = await findVisibleFlow(id, request.user);
      return { flow: serializeFor(flowAccess)(flow) };
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
      const { flow: current, flowAccess } = await findWritableFlow(id, request.user);
      if (body.whatsappInstanceId) await assertInstanceInOrg(body.whatsappInstanceId, request.user.organizationId);
      if (body.departmentId) await assertDepartmentInOrg(body.departmentId, request.user.organizationId);
      // O estado NOVO também precisa caber no alcance de quem grava: sem isto
      // bastaria mover o fluxo para outro departamento (ou para "geral") e
      // entregá-lo, ou tomá-lo, de outra equipe.
      const nextTarget: AutomationConfigTarget = {
        departmentId: body.departmentId !== undefined ? body.departmentId : current.departmentId,
        whatsappInstanceId:
          body.whatsappInstanceId !== undefined ? body.whatsappInstanceId : current.whatsappInstanceId,
      };
      assertCanWriteFlow(flowAccess, nextTarget);

      const data: Prisma.AutomationFlowUncheckedUpdateInput = {
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.description !== undefined ? { description: body.description } : {}),
        ...(body.triggerType !== undefined ? { triggerType: body.triggerType } : {}),
        ...(body.triggerConfig !== undefined
          ? { triggerConfig: (body.triggerConfig ?? undefined) as Prisma.InputJsonValue | undefined }
          : {}),
        ...(body.whatsappInstanceId !== undefined ? { whatsappInstanceId: body.whatsappInstanceId } : {}),
        ...(body.departmentId !== undefined ? { departmentId: body.departmentId } : {}),
        ...(body.priority !== undefined ? { priority: body.priority } : {}),
        ...(body.cooldownMinutes !== undefined ? { cooldownMinutes: body.cooldownMinutes } : {}),
        ...(body.scheduleMode !== undefined ? { scheduleMode: body.scheduleMode } : {}),
        ...(body.draftGraph !== undefined ? { draftGraph: body.draftGraph as unknown as Prisma.InputJsonValue } : {}),
        updatedById: request.user.sub,
      };
      const flow = await deps.prisma.automationFlow.update({ where: { id }, data, include: flowInclude });
      // O autosave grava o desenho a cada pausa de digitação, e auditar cada
      // bloco arrastado afogaria o registro. Entra na auditoria o que muda o
      // fluxo como CADASTRO: nome, gatilho, onde ele mora e como disputa.
      const changedFields = AUDITED_FLOW_FIELDS.filter((field) => {
        if (body[field] === undefined) return false;
        return JSON.stringify(body[field]) !== JSON.stringify(current[field] ?? null);
      });
      if (changedFields.length > 0) {
        deps.audit.record({
          organizationId: request.user.organizationId,
          userId: request.user.sub,
          action: "automation_flow.updated",
          entityType: "AutomationFlow",
          entityId: id,
          metadata: {
            changedFields,
            ...flowScopeAudit(flow),
            ...(changedFields.includes("departmentId") ? { previousDepartmentId: current.departmentId } : {}),
          },
        });
      }
      return { flow: serializeFor(flowAccess)(flow) };
    },
  );

  app.get(
    "/automation-flows/:id/validate",
    { preHandler: requirePermission(deps, "automation.manage") },
    async (request) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
      const { flow } = await findVisibleFlow(id, request.user);
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
      const { flow, flowAccess } = await findWritableFlow(id, request.user);
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
        include: flowInclude,
      });
      deps.audit.record({
        organizationId: request.user.organizationId,
        userId: request.user.sub,
        action: "automation_flow.published",
        entityType: "AutomationFlow",
        entityId: id,
        metadata: { version: nextVersion, ...flowScopeAudit(updated) },
      });
      return { flow: serializeFor(flowAccess)(updated) };
    },
  );

  app.post(
    "/automation-flows/:id/activate",
    { preHandler: requirePermission(deps, "automation.manage") },
    async (request) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
      const { flow, flowAccess } = await findWritableFlow(id, request.user);
      if (!flow.publishedVersionId) {
        throw new AppError("Publique o fluxo antes de ativá-lo.", 422, "automation_flow_not_published");
      }
      const updated = await deps.prisma.automationFlow.update({
        where: { id },
        data: { status: "active" },
        include: flowInclude,
      });
      deps.audit.record({
        organizationId: request.user.organizationId,
        userId: request.user.sub,
        action: "automation_flow.activated",
        entityType: "AutomationFlow",
        entityId: id,
        metadata: flowScopeAudit(updated),
      });
      return { flow: serializeFor(flowAccess)(updated) };
    },
  );

  app.post(
    "/automation-flows/:id/deactivate",
    { preHandler: requirePermission(deps, "automation.manage") },
    async (request) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
      const { flowAccess } = await findWritableFlow(id, request.user);
      const updated = await deps.prisma.automationFlow.update({
        where: { id },
        data: { status: "inactive" },
        include: flowInclude,
      });
      // Desligar para o que o fluxo JÁ está fazendo, e não só a disputa por
      // gatilho: a execução em andamento seguia perguntando e respondendo, e
      // a IA que um bloco dela tivesse aberto seguia atendendo. Quem desliga
      // espera silêncio na hora.
      const stoppedExecutions = await deps.automation.stopExecutionsForFlow({
        organizationId: request.user.organizationId,
        flowId: id,
        note: `Fluxo "${updated.name}" desligado.`,
      });
      deps.audit.record({
        organizationId: request.user.organizationId,
        userId: request.user.sub,
        action: "automation_flow.deactivated",
        entityType: "AutomationFlow",
        entityId: id,
        metadata: { stoppedExecutions, ...flowScopeAudit(updated) },
      });
      return { flow: serializeFor(flowAccess)(updated), stoppedExecutions };
    },
  );

  app.post(
    "/automation-flows/:id/duplicate",
    { preHandler: requirePermission(deps, "automation.manage") },
    async (request, reply) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
      // A cópia nasce no MESMO departamento e número do original, então quem
      // duplica precisa poder gravar ali — duplicar não é atalho para criar
      // fluxo geral sem a chave.
      const { flow, flowAccess } = await findWritableFlow(id, request.user);
      const copy = await deps.prisma.automationFlow.create({
        data: {
          organizationId: request.user.organizationId,
          name: `${flow.name} (cópia)`,
          description: flow.description,
          triggerType: flow.triggerType,
          triggerConfig: flow.triggerConfig ?? undefined,
          whatsappInstanceId: flow.whatsappInstanceId,
          departmentId: flow.departmentId,
          priority: flow.priority,
          cooldownMinutes: flow.cooldownMinutes,
          scheduleMode: flow.scheduleMode,
          // A cópia nasce RASCUNHO, sem versão publicada — mexer nela nunca
          // afeta o fluxo original que já pode estar em produção.
          draftGraph: flow.draftGraph as object,
          createdById: request.user.sub,
        },
        include: flowInclude,
      });
      deps.audit.record({
        organizationId: request.user.organizationId,
        userId: request.user.sub,
        action: "automation_flow.duplicated",
        entityType: "AutomationFlow",
        entityId: copy.id,
        metadata: { fromFlowId: id, ...flowScopeAudit(copy) },
      });
      return reply.status(201).send({ flow: serializeFor(flowAccess)(copy) });
    },
  );

  app.delete(
    "/automation-flows/:id",
    { preHandler: requirePermission(deps, "automation.manage") },
    async (request) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
      const { flow } = await findWritableFlow(id, request.user);
      // ANTES do delete, sempre: as execuções somem junto com o fluxo
      // (`onDelete: Cascade`) e a sessão de IA que uma delas abriu fica com
      // `automationExecutionId` nulo (`SetNull`) — indistinguível de uma
      // sessão de automação, sem ninguém para desligá-la. Depois de apagar
      // não há mais como alcançá-las.
      const stoppedExecutions = await deps.automation.stopExecutionsForFlow({
        organizationId: request.user.organizationId,
        flowId: id,
        note: `Fluxo "${flow.name}" excluído.`,
      });
      await deps.prisma.automationFlow.delete({ where: { id } });
      deps.audit.record({
        organizationId: request.user.organizationId,
        userId: request.user.sub,
        action: "automation_flow.deleted",
        entityType: "AutomationFlow",
        entityId: id,
        metadata: { stoppedExecutions, name: flow.name, ...flowScopeAudit(flow) },
      });
      return { ok: true, stoppedExecutions };
    },
  );

  /* ------------------------------------------------------------------ *
   * Histórico de execução (seção 28)
   * ------------------------------------------------------------------ */

  /**
   * O histórico passa por DOIS recortes. O da conversa (`conversationScope`,
   * como sempre): ninguém vê execução de conversa que não enxerga. E o do
   * FLUXO: a lista geral mostra só as execuções dos fluxos que a pessoa
   * enxergaria, senão o Histórico viraria a porta dos fundos da mesma
   * configuração que a aba Fluxos passou a esconder.
   *
   * A exceção é a pergunta sobre UMA conversa (`conversationId`): ali a
   * pessoa já enxerga a conversa, e esconder que houve automação nela faria
   * a conversa parecer ter respondido sozinha. Então a execução aparece,
   * mas redigida (`flowHidden`): sem o nome do fluxo, sem o registro por
   * bloco e sem o contexto, que são a configuração de outra área.
   */
  app.get(
    "/automation-executions",
    { preHandler: requirePermission(deps, "automation.view_history") },
    async (request) => {
      const query = executionListQuerySchema.parse(request.query);
      const access = await loadConversationAccess(deps.prisma, request.user);
      const flowAccess: AutomationConfigAccess = { instanceIds: access.instanceIds, departmentIds: access.departmentIds };
      const executions = await deps.prisma.automationExecution.findMany({
        where: {
          organizationId: request.user.organizationId,
          ...(query.flowId ? { flowId: query.flowId } : {}),
          ...(query.conversationId ? { conversationId: query.conversationId } : {}),
          ...(query.status ? { status: query.status } : {}),
          conversation: { is: conversationScope(access) },
          ...(query.conversationId ? {} : { flow: { is: automationConfigScope(flowAccess) } }),
        },
        include: executionInclude,
        orderBy: { startedAt: "desc" },
        take: query.limit,
      });
      return {
        executions: executions.map((execution) =>
          serializeAutomationExecutionSummary(execution, {
            flowHidden: !canSeeAutomationConfig(flowAccess, execution.flow),
          }),
        ),
      };
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
        include: { ...executionInclude, logs: { orderBy: { at: "asc" } } },
      });
      if (!execution) throw new NotFoundError("Execução de automação");
      const flowHidden = !canSeeAutomationConfig(
        { instanceIds: access.instanceIds, departmentIds: access.departmentIds },
        execution.flow,
      );
      return { execution: serializeAutomationExecutionDetail(execution, { flowHidden }) };
    },
  );
}

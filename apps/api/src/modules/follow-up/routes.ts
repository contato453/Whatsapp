import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  FOLLOW_UP_STEP_ACTIONS,
  FOLLOW_UP_TIME_UNITS,
  FOLLOW_UP_TRIGGERS,
  CONVERSATION_STATUSES,
} from "@azvchat/shared";
import { accessibleDepartmentIds, departmentResourceScope } from "../../lib/access.js";
import { authenticate } from "../../lib/auth.js";
import { requirePermission } from "../../lib/permissions.js";
import {
  assertCanManageResource,
  auditDepartmentSnapshot,
  resolveDepartmentTarget,
} from "../../lib/department-resource.js";
import { findAccessibleConversation } from "../../lib/conversation-access.js";
import {
  cancelExecution,
  getActiveExecution,
  pauseExecution,
  postponeExecution,
  reconcileConversation,
  resumeExecution,
} from "../../lib/follow-up-engine.js";
import { AppError, NotFoundError } from "../../lib/errors.js";
import {
  serializeFollowUpExecution,
  serializeFollowUpRule,
} from "../../lib/serialize.js";
import type { AppDeps } from "../../types.js";

/**
 * Follow-up automático — CRUD da regra (com o MESMO vínculo N:N de
 * departamento das respostas rápidas, ver `lib/department-resource.ts`) e as
 * ações que o atendente faz de dentro da conversa (cancelar, pausar, retomar,
 * adiar). O motor de verdade — quem inicia, revalida e roda cada etapa —
 * mora em `lib/follow-up-engine.ts` e no worker `follow-up-scheduler.ts`;
 * este módulo só valida entrada, checa permissão e devolve o DTO.
 */

const withRuleRelations = {
  departments: { include: { department: true } },
  steps: { orderBy: { order: "asc" as const } },
  instance: { select: { id: true, name: true } },
  finalizeTag: { select: { id: true, name: true, color: true } },
} as const;

const stepSchema = z
  .object({
    waitAmount: z.number().int().min(1).max(9999),
    waitUnit: z.enum(FOLLOW_UP_TIME_UNITS),
    action: z.enum(FOLLOW_UP_STEP_ACTIONS),
    messageContent: z.string().trim().min(1).max(4000).optional(),
    tagId: z.string().uuid().optional(),
    newStatus: z.enum(CONVERSATION_STATUSES).optional(),
  })
  .superRefine((step, ctx) => {
    if (step.action === "send_message" && !step.messageContent) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Etapa de enviar mensagem precisa de um texto",
        path: ["messageContent"],
      });
    }
    if ((step.action === "add_tag" || step.action === "remove_tag") && !step.tagId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Etapa de etiqueta precisa de uma etiqueta selecionada",
        path: ["tagId"],
      });
    }
    if (step.action === "change_status" && !step.newStatus) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Etapa de alterar status precisa de um status alvo",
        path: ["newStatus"],
      });
    }
  });

const ruleFieldsSchema = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(500).optional(),
  status: z.enum(["active", "inactive"]).default("active"),
  isGeneral: z.boolean().default(false),
  departmentIds: z.array(z.string().uuid()).default([]),
  trigger: z.enum(FOLLOW_UP_TRIGGERS).default("waiting_client"),
  respectBusinessHours: z.boolean().default(true),
  whatsappInstanceId: z.string().uuid().nullable().default(null),
  finalizeOnComplete: z.boolean().default(true),
  finalizeReason: z.string().trim().min(1).max(300).default("Sem retorno do cliente"),
  finalizeTagId: z.string().uuid().nullable().default(null),
  // Ordem vem da posição na lista, não de um campo digitado — reordenar é
  // arrastar na tela, e um `order` mandado à mão só criaria furo ou duplicata.
  steps: z.array(stepSchema).min(1, "A regra precisa de pelo menos uma etapa"),
});

const WRITE_LABELS = {
  general: "Apenas quem tem a chave de regra geral pode criar follow-up para todos os departamentos",
  foreign: "Você não tem acesso a todos os departamentos selecionados",
};

const MANAGE_LABELS = {
  general: "Apenas quem tem a chave de regra geral pode mexer nesta regra",
  foreign: "Esta regra está em departamentos que você não acessa",
  orphan: "Esta regra ficou sem departamento — só o administrador pode ajustá-la",
};

export async function followUpRoutes(app: FastifyInstance, deps: AppDeps): Promise<void> {
  async function validateReferences(body: z.infer<typeof ruleFieldsSchema>, organizationId: string) {
    if (body.whatsappInstanceId) {
      const instance = await deps.prisma.whatsAppInstance.findFirst({
        where: { id: body.whatsappInstanceId, organizationId },
      });
      if (!instance) throw new AppError("Número de WhatsApp inválido", 400, "invalid_instance");
    }
    const tagIds = new Set<string>();
    if (body.finalizeTagId) tagIds.add(body.finalizeTagId);
    for (const step of body.steps) {
      if (step.tagId) tagIds.add(step.tagId);
    }
    if (tagIds.size > 0) {
      const found = await deps.prisma.tag.findMany({
        where: { id: { in: [...tagIds] }, organizationId },
        select: { id: true },
      });
      if (found.length !== tagIds.size) {
        throw new AppError("Etiqueta inválida", 400, "invalid_tag");
      }
    }
  }

  /** Estatísticas de uso (seção 2/34 do pedido), calculadas fora do serializer. */
  async function withStats(ruleIds: string[]) {
    if (ruleIds.length === 0) return new Map<string, { active: number; messagesSent: number }>();
    const [activeGroups, sentGroups] = await Promise.all([
      deps.prisma.followUpExecution.groupBy({
        by: ["ruleId"],
        where: { ruleId: { in: ruleIds }, status: { in: ["active", "paused"] } },
        _count: { _all: true },
      }),
      deps.prisma.followUpExecution.groupBy({
        by: ["ruleId"],
        where: { ruleId: { in: ruleIds } },
        _sum: { messagesSentCount: true },
      }),
    ]);
    const map = new Map<string, { active: number; messagesSent: number }>();
    for (const id of ruleIds) map.set(id, { active: 0, messagesSent: 0 });
    for (const row of activeGroups) map.set(row.ruleId, { ...map.get(row.ruleId)!, active: row._count._all });
    for (const row of sentGroups) {
      map.set(row.ruleId, { ...map.get(row.ruleId)!, messagesSent: row._sum.messagesSentCount ?? 0 });
    }
    return map;
  }

  app.get(
    "/follow-up-rules",
    { preHandler: requirePermission(deps, "follow_up.manage") },
    async (request) => {
      const departmentIds = await accessibleDepartmentIds(deps.prisma, request.user);
      const rules = await deps.prisma.followUpRule.findMany({
        where: {
          organizationId: request.user.organizationId,
          ...departmentResourceScope(departmentIds),
        },
        include: withRuleRelations,
        orderBy: [{ status: "asc" }, { name: "asc" }],
      });
      const stats = await withStats(rules.map((rule) => rule.id));
      return {
        rules: rules.map((rule) => ({
          ...serializeFollowUpRule(rule),
          activeExecutions: stats.get(rule.id)?.active ?? 0,
          messagesSent: stats.get(rule.id)?.messagesSent ?? 0,
        })),
      };
    },
  );

  app.post(
    "/follow-up-rules",
    { preHandler: requirePermission(deps, "follow_up.manage") },
    async (request, reply) => {
      const body = ruleFieldsSchema.parse(request.body);
      await validateReferences(body, request.user.organizationId);
      const accessible = await accessibleDepartmentIds(deps.prisma, request.user);
      const target = await resolveDepartmentTarget(
        deps.prisma,
        request.user,
        accessible,
        body,
        WRITE_LABELS,
      );

      const clash = await deps.prisma.followUpRule.findUnique({
        where: { organizationId_name: { organizationId: request.user.organizationId, name: body.name } },
      });
      if (clash) throw new AppError(`Já existe uma regra chamada "${body.name}"`, 409, "name_taken");

      const created = await deps.prisma.followUpRule.create({
        data: {
          organizationId: request.user.organizationId,
          name: body.name,
          description: body.description ?? null,
          status: body.status,
          isGeneral: target.isGeneral,
          trigger: body.trigger,
          respectBusinessHours: body.respectBusinessHours,
          whatsappInstanceId: body.whatsappInstanceId,
          finalizeOnComplete: body.finalizeOnComplete,
          finalizeReason: body.finalizeReason,
          finalizeTagId: body.finalizeTagId,
          createdById: request.user.sub,
          departments: { create: target.departmentIds.map((departmentId) => ({ departmentId })) },
          steps: {
            create: body.steps.map((step, index) => ({
              order: index + 1,
              waitAmount: step.waitAmount,
              waitUnit: step.waitUnit,
              action: step.action,
              messageContent: step.messageContent ?? null,
              tagId: step.tagId ?? null,
              newStatus: step.newStatus ?? null,
            })),
          },
        },
        include: withRuleRelations,
      });
      deps.audit.record({
        organizationId: request.user.organizationId,
        userId: request.user.sub,
        action: "follow_up_rule.created",
        entityType: "FollowUpRule",
        entityId: created.id,
        metadata: { depois: auditDepartmentSnapshot(created.isGeneral, created.departments) },
      });
      return reply.status(201).send({ rule: serializeFollowUpRule(created) });
    },
  );

  async function findManageableOr404(id: string, user: FastifyRequest["user"]) {
    const accessible = await accessibleDepartmentIds(deps.prisma, user);
    const existing = await deps.prisma.followUpRule.findFirst({
      where: { id, organizationId: user.organizationId },
      include: withRuleRelations,
    });
    if (!existing) throw new NotFoundError("Regra de follow-up");
    assertCanManageResource(
      accessible,
      { isGeneral: existing.isGeneral, departmentIds: existing.departments.map((link) => link.departmentId) },
      MANAGE_LABELS,
    );
    return existing;
  }

  app.patch(
    "/follow-up-rules/:id",
    { preHandler: requirePermission(deps, "follow_up.manage") },
    async (request) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
      const existing = await findManageableOr404(id, request.user);
      const body = ruleFieldsSchema.parse(request.body);
      await validateReferences(body, request.user.organizationId);
      const accessible = await accessibleDepartmentIds(deps.prisma, request.user);
      const target = await resolveDepartmentTarget(deps.prisma, request.user, accessible, body, WRITE_LABELS);

      if (body.name !== existing.name) {
        const clash = await deps.prisma.followUpRule.findUnique({
          where: { organizationId_name: { organizationId: request.user.organizationId, name: body.name } },
        });
        if (clash) throw new AppError(`Já existe uma regra chamada "${body.name}"`, 409, "name_taken");
      }

      // Substitui departamentos E etapas em bloco, como a resposta rápida
      // faz com os departamentos: apagar e recriar evita duplicata e deixa
      // o cadastro sempre igual ao que a tela mandou — inclusive reordenado.
      const updated = await deps.prisma.$transaction(async (tx) => {
        await tx.followUpRuleDepartment.deleteMany({ where: { ruleId: id } });
        await tx.followUpRuleStep.deleteMany({ where: { ruleId: id } });
        return tx.followUpRule.update({
          where: { id },
          data: {
            name: body.name,
            description: body.description ?? null,
            status: body.status,
            isGeneral: target.isGeneral,
            trigger: body.trigger,
            respectBusinessHours: body.respectBusinessHours,
            whatsappInstanceId: body.whatsappInstanceId,
            finalizeOnComplete: body.finalizeOnComplete,
            finalizeReason: body.finalizeReason,
            finalizeTagId: body.finalizeTagId,
            departments: { create: target.departmentIds.map((departmentId) => ({ departmentId })) },
            steps: {
              create: body.steps.map((step, index) => ({
                order: index + 1,
                waitAmount: step.waitAmount,
                waitUnit: step.waitUnit,
                action: step.action,
                messageContent: step.messageContent ?? null,
                tagId: step.tagId ?? null,
                newStatus: step.newStatus ?? null,
              })),
            },
          },
          include: withRuleRelations,
        });
      });

      deps.audit.record({
        organizationId: request.user.organizationId,
        userId: request.user.sub,
        action: "follow_up_rule.updated",
        entityType: "FollowUpRule",
        entityId: id,
        metadata: {
          antes: auditDepartmentSnapshot(existing.isGeneral, existing.departments),
          depois: auditDepartmentSnapshot(updated.isGeneral, updated.departments),
        },
      });

      // A régua desligada, ou que deixou de valer para os departamentos de
      // uma execução em andamento, não pode continuar rodando por trás —
      // revalida toda conversa com execução ativa/pausada desta regra.
      const affected = await deps.prisma.followUpExecution.findMany({
        where: { ruleId: id, status: { in: ["active", "paused"] } },
        select: { conversationId: true },
      });
      for (const { conversationId } of affected) {
        await reconcileConversation(deps, conversationId);
      }

      return { rule: serializeFollowUpRule(updated) };
    },
  );

  app.post(
    "/follow-up-rules/:id/duplicate",
    { preHandler: requirePermission(deps, "follow_up.manage") },
    async (request, reply) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
      const existing = await findManageableOr404(id, request.user);

      let name = `${existing.name} (cópia)`;
      let suffix = 2;
      while (
        await deps.prisma.followUpRule.findUnique({
          where: { organizationId_name: { organizationId: request.user.organizationId, name } },
        })
      ) {
        name = `${existing.name} (cópia ${suffix})`;
        suffix += 1;
      }

      const created = await deps.prisma.followUpRule.create({
        data: {
          organizationId: request.user.organizationId,
          name,
          description: existing.description,
          // A cópia nasce INATIVA de propósito: duplicar não pode colocar
          // uma segunda régua rodando sozinha sobre os mesmos departamentos.
          status: "inactive",
          isGeneral: existing.isGeneral,
          trigger: existing.trigger,
          respectBusinessHours: existing.respectBusinessHours,
          whatsappInstanceId: existing.whatsappInstanceId,
          finalizeOnComplete: existing.finalizeOnComplete,
          finalizeReason: existing.finalizeReason,
          finalizeTagId: existing.finalizeTagId,
          createdById: request.user.sub,
          departments: {
            create: existing.departments.map((link) => ({ departmentId: link.departmentId })),
          },
          steps: {
            create: existing.steps.map((step) => ({
              order: step.order,
              waitAmount: step.waitAmount,
              waitUnit: step.waitUnit,
              action: step.action,
              messageContent: step.messageContent,
              tagId: step.tagId,
              newStatus: step.newStatus,
            })),
          },
        },
        include: withRuleRelations,
      });
      deps.audit.record({
        organizationId: request.user.organizationId,
        userId: request.user.sub,
        action: "follow_up_rule.duplicated",
        entityType: "FollowUpRule",
        entityId: created.id,
        metadata: { origemId: existing.id },
      });
      return reply.status(201).send({ rule: serializeFollowUpRule(created) });
    },
  );

  async function setStatus(id: string, user: FastifyRequest["user"], status: "active" | "inactive") {
    const existing = await findManageableOr404(id, user);
    if (existing.status === status) return existing;
    const updated = await deps.prisma.followUpRule.update({
      where: { id },
      data: { status },
      include: withRuleRelations,
    });
    deps.audit.record({
      organizationId: user.organizationId,
      userId: user.sub,
      action: status === "active" ? "follow_up_rule.activated" : "follow_up_rule.deactivated",
      entityType: "FollowUpRule",
      entityId: id,
    });
    if (status === "inactive") {
      // Desativar não deixa timer solto: toda execução em andamento desta
      // regra é cancelada agora, e não só na próxima revalidação do worker.
      const affected = await deps.prisma.followUpExecution.findMany({
        where: { ruleId: id, status: { in: ["active", "paused"] } },
        select: { conversationId: true },
      });
      for (const { conversationId } of affected) {
        await cancelExecution(deps, conversationId, { reason: "rule_deactivated" });
      }
    }
    return updated;
  }

  app.post(
    "/follow-up-rules/:id/activate",
    { preHandler: requirePermission(deps, "follow_up.manage") },
    async (request) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
      const updated = await setStatus(id, request.user, "active");
      return { rule: serializeFollowUpRule(updated) };
    },
  );

  app.post(
    "/follow-up-rules/:id/deactivate",
    { preHandler: requirePermission(deps, "follow_up.manage") },
    async (request) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
      const updated = await setStatus(id, request.user, "inactive");
      return { rule: serializeFollowUpRule(updated) };
    },
  );

  app.delete(
    "/follow-up-rules/:id",
    { preHandler: requirePermission(deps, "follow_up.manage") },
    async (request) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
      const existing = await findManageableOr404(id, request.user);
      // Cancela quem estiver rodando ANTES de apagar a regra — apagar sem
      // isso deixaria a execução órfã (a chave estrangeira até bloquearia,
      // mas a mensagem de erro para quem clicou seria "não deu" sem dizer
      // por quê).
      const affected = await deps.prisma.followUpExecution.findMany({
        where: { ruleId: id, status: { in: ["active", "paused"] } },
        select: { conversationId: true },
      });
      for (const { conversationId } of affected) {
        await cancelExecution(deps, conversationId, { reason: "rule_deactivated" });
      }
      await deps.prisma.followUpRule.delete({ where: { id } });
      deps.audit.record({
        organizationId: request.user.organizationId,
        userId: request.user.sub,
        action: "follow_up_rule.deleted",
        entityType: "FollowUpRule",
        entityId: id,
        metadata: { antes: auditDepartmentSnapshot(existing.isGeneral, existing.departments) },
      });
      return { ok: true };
    },
  );

  /** Histórico da regra (seção 33/34 do pedido). */
  app.get(
    "/follow-up-rules/:id/history",
    { preHandler: requirePermission(deps, "follow_up.manage") },
    async (request) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
      await findManageableOr404(id, request.user);
      const executions = await deps.prisma.followUpExecution.findMany({
        where: { ruleId: id },
        include: {
          rule: { select: { id: true, name: true } },
          conversation: {
            include: { department: { select: { id: true, name: true } }, instance: { select: { id: true, name: true } } },
          },
          logs: { orderBy: { createdAt: "asc" } },
        },
        orderBy: { startedAt: "desc" },
        take: 200,
      });

      const total = executions.length;
      const clientsReplied = executions.filter((e) => e.finishReason === "client_replied").length;
      const resolvedByRule = executions.filter((e) => e.finishReason === "completed_no_reply").length;
      const canceledCount = executions.filter((e) => e.status === "canceled").length;
      const departmentsUsed = new Set(
        executions.map((e) => e.conversation.department?.id).filter((v): v is string => Boolean(v)),
      );

      return {
        stats: {
          totalExecutions: total,
          departmentsUsed: departmentsUsed.size,
          clientsReplied,
          resolvedByRule,
          canceledCount,
        },
        executions: executions.map((execution) => serializeFollowUpExecution(execution)),
      };
    },
  );

  /** Histórico geral (todas as regras) — a tela "Automações → Follow-up Automático → Histórico". */
  const historyQuerySchema = z.object({
    ruleId: z.string().uuid().optional(),
    departmentId: z.string().uuid().optional(),
    status: z.enum(["active", "paused", "canceled", "completed", "failed"]).optional(),
    from: z.string().optional(),
    to: z.string().optional(),
  });

  app.get(
    "/follow-up-executions",
    { preHandler: requirePermission(deps, "follow_up.manage") },
    async (request) => {
      const query = historyQuerySchema.parse(request.query);
      const departmentIds = await accessibleDepartmentIds(deps.prisma, request.user);
      const executions = await deps.prisma.followUpExecution.findMany({
        where: {
          organizationId: request.user.organizationId,
          ...(query.ruleId ? { ruleId: query.ruleId } : {}),
          ...(query.status ? { status: query.status } : {}),
          ...(query.from || query.to
            ? {
                startedAt: {
                  ...(query.from ? { gte: new Date(query.from) } : {}),
                  ...(query.to ? { lte: new Date(query.to) } : {}),
                },
              }
            : {}),
          ...(query.departmentId
            ? { conversation: { is: { departmentId: query.departmentId } } }
            : departmentIds
              ? { conversation: { is: { departmentId: { in: departmentIds } } } }
              : {}),
        },
        include: {
          rule: { select: { id: true, name: true } },
          conversation: {
            include: { department: { select: { id: true, name: true } }, instance: { select: { id: true, name: true } } },
          },
          logs: { orderBy: { createdAt: "asc" } },
        },
        orderBy: { startedAt: "desc" },
        take: 300,
      });
      return { executions: executions.map((execution) => serializeFollowUpExecution(execution)) };
    },
  );

  /* ------------------------------------------------------------------ *
   * Ações de dentro da conversa (seções 26-29 do pedido)
   * ------------------------------------------------------------------ */

  app.get("/conversations/:id/follow-up", { preHandler: authenticate }, async (request) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    await findAccessibleConversation(deps.prisma, request.user, id);
    const execution = await getActiveExecution(deps.prisma, id);
    if (!execution) return { execution: null };
    const totalSteps = await deps.prisma.followUpRuleStep.count({ where: { ruleId: execution.ruleId } });
    return {
      execution: {
        ...serializeFollowUpExecution({ ...execution, rule: { id: execution.rule.id, name: execution.rule.name } }),
        totalSteps,
      },
    };
  });

  app.post(
    "/conversations/:id/follow-up/cancel",
    { preHandler: requirePermission(deps, "follow_up.control") },
    async (request) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
      await findAccessibleConversation(deps.prisma, request.user, id);
      await cancelExecution(deps, id, { reason: "canceled_manual", actorUserId: request.user.sub });
      deps.audit.record({
        organizationId: request.user.organizationId,
        userId: request.user.sub,
        action: "follow_up.canceled",
        entityType: "Conversation",
        entityId: id,
      });
      return { ok: true };
    },
  );

  app.post(
    "/conversations/:id/follow-up/pause",
    { preHandler: requirePermission(deps, "follow_up.control") },
    async (request) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
      const body = z.object({ untilAt: z.string().datetime().optional() }).parse(request.body ?? {});
      await findAccessibleConversation(deps.prisma, request.user, id);
      await pauseExecution(deps, id, {
        untilAt: body.untilAt ? new Date(body.untilAt) : null,
        actorUserId: request.user.sub,
      });
      deps.audit.record({
        organizationId: request.user.organizationId,
        userId: request.user.sub,
        action: "follow_up.paused",
        entityType: "Conversation",
        entityId: id,
        metadata: { untilAt: body.untilAt ?? null },
      });
      return { ok: true };
    },
  );

  app.post(
    "/conversations/:id/follow-up/resume",
    { preHandler: requirePermission(deps, "follow_up.control") },
    async (request) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
      await findAccessibleConversation(deps.prisma, request.user, id);
      await resumeExecution(deps, id, { actorUserId: request.user.sub });
      deps.audit.record({
        organizationId: request.user.organizationId,
        userId: request.user.sub,
        action: "follow_up.resumed",
        entityType: "Conversation",
        entityId: id,
      });
      return { ok: true };
    },
  );

  app.post(
    "/conversations/:id/follow-up/postpone",
    { preHandler: requirePermission(deps, "follow_up.control") },
    async (request) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
      const body = z.object({ until: z.string().datetime() }).parse(request.body);
      await findAccessibleConversation(deps.prisma, request.user, id);
      const until = new Date(body.until);
      if (until.getTime() <= Date.now()) {
        throw new AppError("O adiamento precisa ser para um horário futuro", 400, "invalid_postpone");
      }
      await postponeExecution(deps, id, { until, actorUserId: request.user.sub });
      deps.audit.record({
        organizationId: request.user.organizationId,
        userId: request.user.sub,
        action: "follow_up.postponed",
        entityType: "Conversation",
        entityId: id,
        metadata: { until: body.until },
      });
      return { ok: true };
    },
  );
}

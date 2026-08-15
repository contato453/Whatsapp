import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { authenticate } from "../../lib/auth.js";
import { AppError, NotFoundError } from "../../lib/errors.js";
import { emitScheduledPending } from "../../lib/scheduled-pending.js";
import { serializeUserDirectory } from "../../lib/serialize.js";
import type { AppDeps } from "../../types.js";
import type { ScheduledMessage, User } from "@azvchat/database";

function serialize(scheduled: ScheduledMessage & { createdBy?: User | null }) {
  return {
    id: scheduled.id,
    conversationId: scheduled.conversationId,
    content: scheduled.content,
    scheduledFor: scheduled.scheduledFor.toISOString(),
    status: scheduled.status,
    error: scheduled.error,
    createdBy: scheduled.createdBy ? serializeUserDirectory(scheduled.createdBy) : null,
    createdAt: scheduled.createdAt.toISOString(),
  };
}

export async function scheduledMessageRoutes(app: FastifyInstance, deps: AppDeps): Promise<void> {
  /** Agenda uma mensagem de texto para envio futuro. */
  app.post(
    "/conversations/:id/scheduled-messages",
    { preHandler: authenticate },
    async (request, reply) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
      const body = z
        .object({
          content: z.string().min(1).max(65_000),
          scheduledFor: z.string().datetime(),
        })
        .parse(request.body);

      const conversation = await deps.prisma.conversation.findFirst({
        where: { id, organizationId: request.user.organizationId },
      });
      if (!conversation) throw new NotFoundError("Conversa");

      const when = new Date(body.scheduledFor);
      if (when.getTime() <= Date.now()) {
        throw new AppError("A data do agendamento deve ser no futuro", 400, "past_date");
      }

      const scheduled = await deps.prisma.scheduledMessage.create({
        data: {
          organizationId: request.user.organizationId,
          conversationId: id,
          content: body.content,
          scheduledFor: when,
          createdById: request.user.sub,
        },
        include: { createdBy: true },
      });
      deps.audit.record({
        organizationId: request.user.organizationId,
        userId: request.user.sub,
        action: "message.scheduled",
        entityType: "Conversation",
        entityId: id,
        metadata: { scheduledFor: when.toISOString() },
      });
      // Badge do composer acompanha na hora, em todas as sessões que
      // enxergam a conversa.
      await emitScheduledPending(deps, request.user.organizationId, id);
      return reply.status(201).send({ scheduledMessage: serialize(scheduled) });
    },
  );

  /** Lista os agendamentos de uma conversa (pendentes primeiro). */
  app.get(
    "/conversations/:id/scheduled-messages",
    { preHandler: authenticate },
    async (request) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
      const conversation = await deps.prisma.conversation.findFirst({
        where: { id, organizationId: request.user.organizationId },
        select: { id: true },
      });
      if (!conversation) throw new NotFoundError("Conversa");
      const items = await deps.prisma.scheduledMessage.findMany({
        where: { conversationId: id },
        orderBy: [{ status: "asc" }, { scheduledFor: "asc" }],
        take: 50,
        include: { createdBy: true },
      });
      return { scheduledMessages: items.map(serialize) };
    },
  );

  /** Cancela um agendamento ainda pendente. */
  app.delete("/scheduled-messages/:id", { preHandler: authenticate }, async (request) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const scheduled = await deps.prisma.scheduledMessage.findFirst({
      where: { id, organizationId: request.user.organizationId },
    });
    if (!scheduled) throw new NotFoundError("Agendamento");
    if (scheduled.status !== "pending") {
      throw new AppError("Este agendamento já foi processado", 400, "not_pending");
    }
    await deps.prisma.scheduledMessage.update({
      where: { id },
      data: { status: "canceled" },
    });
    // Cancelado sai da conta: o badge cai um na hora.
    await emitScheduledPending(deps, request.user.organizationId, scheduled.conversationId);
    return { ok: true };
  });
}

import type { PrismaClient } from "@azvchat/database";
import { RealtimeEvents } from "@azvchat/shared";
import type { WhatsAppProvider } from "@azvchat/whatsapp";
import type { Server } from "socket.io";
import type { Logger } from "pino";
import { conversationAudience } from "../realtime/socket.js";
import { emitScheduledPending } from "../lib/scheduled-pending.js";
import { serializeConversation, serializeMessage } from "../lib/serialize.js";
import { applySignature } from "../lib/signature.js";
import { buildPreview } from "./message-ingest.js";

/** Intervalo de verificação da fila de agendamentos. */
const TICK_MS = 30_000;
/** Quantas mensagens processa por rodada. */
const BATCH = 20;
/** Tentativas antes de marcar como falha (≈5 min cobrindo quedas rápidas). */
const MAX_ATTEMPTS = 10;

/**
 * Dispara mensagens agendadas cuja hora chegou.
 *
 * Implementação simples e suficiente para o volume de um escritório:
 * uma verificação a cada 30s no próprio processo da API. Se um dia houver
 * várias instâncias da API, migrar para uma fila (BullMQ/Redis) — a
 * interface pública desta classe não muda.
 */
export class ScheduledMessageWorker {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(
    private readonly prisma: PrismaClient,
    private readonly provider: WhatsAppProvider,
    private readonly io: Server,
    private readonly logger: Logger,
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), TICK_MS);
    this.logger.info({ event: "scheduler_started", intervalMs: TICK_MS });
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const due = await this.prisma.scheduledMessage.findMany({
        where: { status: "pending", scheduledFor: { lte: new Date() } },
        orderBy: { scheduledFor: "asc" },
        take: BATCH,
        include: { conversation: true },
      });
      for (const scheduled of due) {
        await this.dispatch(scheduled);
      }
    } catch (err) {
      this.logger.error({ event: "scheduler_tick_failed", error: String(err) });
    } finally {
      this.running = false;
    }
  }

  private async dispatch(scheduled: {
    id: string;
    organizationId: string;
    conversationId: string;
    content: string;
    createdById: string | null;
    attempts: number;
    conversation: {
      id: string;
      whatsappInstanceId: string;
      externalChatId: string;
      status: string;
    };
  }): Promise<void> {
    try {
      // Mensagem agendada em conversa que foi arquivada AINDA É ENVIADA:
      // o agendamento é um compromisso assumido com o cliente, e arquivar a
      // conversa não o cancela. A conversa continua arquivada — o envio não
      // a traz de volta para a Inbox (nada aqui toca em archivedAt).
      //
      // A assinatura é lida na hora do envio, e não no agendamento: vale a
      // configuração que estiver valendo quando a mensagem de fato sair.
      const sender = scheduled.createdById
        ? await this.prisma.user.findUnique({
            where: { id: scheduled.createdById },
            select: { name: true, signMessages: true },
          })
        : null;
      const outgoing = applySignature(scheduled.content, sender) ?? scheduled.content;

      const result = await this.provider.sendText(
        scheduled.conversation.whatsappInstanceId,
        scheduled.conversation.externalChatId,
        outgoing,
      );

      const message = await this.prisma.message.create({
        data: {
          organizationId: scheduled.organizationId,
          conversationId: scheduled.conversationId,
          externalMessageId: result.externalMessageId,
          direction: "outbound",
          type: "text",
          content: outgoing,
          senderName: sender?.name ?? null,
          timestamp: result.timestamp,
          status: "sent",
          sentByUserId: scheduled.createdById,
        },
      });
      await this.prisma.scheduledMessage.update({
        where: { id: scheduled.id },
        data: { status: "sent", sentMessageId: message.id },
      });
      await this.prisma.conversation.update({
        where: { id: scheduled.conversationId },
        data: {
          lastMessageAt: result.timestamp,
          lastMessagePreview: buildPreview({ type: "text", content: outgoing }),
        },
      });

      const conversation = await this.prisma.conversation.findUnique({
        where: { id: scheduled.conversationId },
        include: {
          assignedUser: true,
          department: true,
          instance: true,
          tags: { include: { tag: true } },
        },
      });
      if (conversation) {
        // Respeita o mesmo recorte de número, departamento e responsável da API
        const room = conversationAudience(scheduled.organizationId, conversation);
        this.io.to(room).emit(RealtimeEvents.MessageNew, {
          conversation: serializeConversation(conversation),
          message: serializeMessage(message),
        });
        this.io
          .to(room)
          .emit(RealtimeEvents.ConversationUpdated, serializeConversation(conversation));
      }
      // Saiu da fila: o badge do composer cai um (ou some, se era o último).
      await this.emitPending(scheduled.organizationId, scheduled.conversationId);
      this.logger.info({
        event: "scheduled_message_sent",
        scheduledId: scheduled.id,
        conversationId: scheduled.conversationId,
      });
    } catch (err) {
      // Falha comum: instância desconectada na hora exata do disparo.
      // Mantém pendente e tenta de novo nas próximas rodadas antes de desistir.
      const attempts = scheduled.attempts + 1;
      const giveUp = attempts >= MAX_ATTEMPTS;
      await this.prisma.scheduledMessage.update({
        where: { id: scheduled.id },
        data: {
          attempts,
          error: String(err).slice(0, 500),
          ...(giveUp ? { status: "failed" as const } : {}),
        },
      });
      // Só a desistência muda o contador: enquanto o status seguir `pending`
      // a mensagem continua na fila e o badge não deve mexer.
      if (giveUp) {
        await this.emitPending(scheduled.organizationId, scheduled.conversationId);
      }
      this.logger[giveUp ? "error" : "warn"]({
        event: giveUp ? "scheduled_message_failed" : "scheduled_message_retry",
        scheduledId: scheduled.id,
        attempts,
        error: String(err),
      });
    }
  }

  /** Avisa o contador de agendamentos pendentes a quem enxerga a conversa. */
  private async emitPending(organizationId: string, conversationId: string): Promise<void> {
    try {
      await emitScheduledPending(
        { prisma: this.prisma, io: this.io, logger: this.logger },
        organizationId,
        conversationId,
      );
    } catch (err) {
      // O contador é acessório: uma falha aqui não pode derrubar o envio.
      this.logger.warn({
        event: "scheduled_pending_emit_failed",
        conversationId,
        error: String(err),
      });
    }
  }
}

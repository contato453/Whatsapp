import type { PrismaClient } from "@azvchat/database";
import {
  BROADCAST_LIMITS,
  RealtimeEvents,
  formatPhone,
  normalizeBrazilPhone,
  pickIntervalMs,
  resolveBroadcastTemplate,
  type BroadcastPauseReason,
} from "@azvchat/shared";
import type { WhatsAppProvider } from "@azvchat/whatsapp";
import type { Server } from "socket.io";
import type { Logger } from "pino";
import { conversationAudience } from "../realtime/socket.js";
import { serializeConversation, serializeMessage } from "../lib/serialize.js";
import { resolveConversationPersonName } from "../lib/person-profile.js";
import { loadAttendanceSettings } from "../lib/attendance-settings.js";
import { nextBusinessMoment } from "../lib/business-schedule.js";
import { createCrmOpportunity } from "../lib/crm-opportunity.js";
import { readContactFields, readMessageVariants } from "../lib/broadcast.js";
import { buildPreview } from "./message-ingest.js";
import type { MessageIngestService } from "./message-ingest.js";

/**
 * O MOTOR DO DISPARO — uma mensagem por vez, no ritmo configurado.
 *
 * Tudo que define o ritmo mora no BANCO (`nextSendAt`, `sentToday`), nunca
 * em `setTimeout`: uma campanha de 5.000 contatos leva horas, e reiniciar a
 * API no meio não pode recomeçar a lista nem pular quem já recebeu. O worker
 * é burro de propósito — a cada volta ele lê o estado, manda no máximo UMA
 * mensagem por campanha e grava quando pode mandar a próxima.
 *
 * MANDAR UMA POR VOLTA É A TRAVA CENTRAL. Um laço que esvazia a fila
 * "respeitando o intervalo" com `sleep` entre os envios prende o processo e,
 * pior, continua mandando depois de a conexão cair ou de alguém pausar —
 * porque o estado que ele consulta é o que leu no começo. Uma por volta
 * significa que TODA mensagem passa por todas as guardas outra vez.
 */

/** Volta do worker. Precisa ser menor que o intervalo mínimo (5s) do disparo. */
const TICK_MS = 3_000;
/** Quantas campanhas processa por volta — uma mensagem em cada. */
const MAX_CAMPAIGNS_PER_TICK = 10;
/** Tentativas na MESMA entrega antes de marcá-la como falha definitiva. */
const MAX_DELIVERY_ATTEMPTS = 3;

interface CampaignRecord {
  id: string;
  organizationId: string;
  name: string;
  status: string;
  whatsappInstanceId: string;
  message: string;
  messageVariants: unknown;
  minIntervalSeconds: number;
  maxIntervalSeconds: number;
  dailyLimit: number | null;
  respectBusinessHours: boolean;
  consecutiveFailures: number;
  crmMode: string;
  crmPipelineId: string | null;
  crmStageId: string | null;
  tagId: string | null;
  sentToday: number;
  sentTodayDate: string | null;
  createdById: string | null;
}

export class BroadcastWorker {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(
    private readonly prisma: PrismaClient,
    private readonly provider: WhatsAppProvider,
    private readonly ingest: MessageIngestService,
    private readonly io: Server,
    private readonly logger: Logger,
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), TICK_MS);
    this.logger.info({ event: "broadcast_worker_started", intervalMs: TICK_MS });
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Exposto para o teste rodar uma volta sem depender do relógio. */
  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await this.promoteScheduled();
      await this.dispatchRunning();
    } catch (err) {
      this.logger.error({ event: "broadcast_tick_failed", error: String(err) });
    } finally {
      this.running = false;
    }
  }

  /**
   * Campanha agendada cuja hora chegou vira `running`.
   *
   * A checagem de "já tem uma rodando neste número" acontece aqui e no banco
   * (índice parcial `broadcast_campaigns_one_running_per_instance`): duas
   * campanhas no mesmo chip dobram o ritmo real sem ninguém perceber — o
   * operador configurou uma a cada 60s e o WhatsApp vê uma a cada 30s. A
   * segunda simplesmente espera a primeira acabar, em vez de ser recusada.
   */
  private async promoteScheduled(): Promise<void> {
    const agora = new Date();
    const agendadas = await this.prisma.broadcastCampaign.findMany({
      where: { status: "scheduled", scheduledFor: { lte: agora } },
      orderBy: { scheduledFor: "asc" },
      take: MAX_CAMPAIGNS_PER_TICK,
      select: { id: true, whatsappInstanceId: true, name: true, organizationId: true },
    });

    for (const campanha of agendadas) {
      const ocupada = await this.prisma.broadcastCampaign.findFirst({
        where: { whatsappInstanceId: campanha.whatsappInstanceId, status: "running" },
        select: { id: true },
      });
      if (ocupada) continue;

      try {
        await this.prisma.broadcastCampaign.update({
          where: { id: campanha.id },
          data: { status: "running", startedAt: agora, nextSendAt: agora, pausedReason: null },
        });
        this.logger.info({
          event: "broadcast_campaign_started",
          campaignId: campanha.id,
          organizationId: campanha.organizationId,
        });
      } catch (err) {
        // P2002 do índice parcial: outra volta ganhou a corrida. Fica agendada.
        this.logger.debug({
          event: "broadcast_promote_skipped",
          campaignId: campanha.id,
          error: String(err),
        });
      }
    }
  }

  private async dispatchRunning(): Promise<void> {
    const agora = new Date();
    const campanhas = (await this.prisma.broadcastCampaign.findMany({
      where: { status: "running", OR: [{ nextSendAt: null }, { nextSendAt: { lte: agora } }] },
      orderBy: { nextSendAt: "asc" },
      take: MAX_CAMPAIGNS_PER_TICK,
    })) as unknown as CampaignRecord[];

    for (const campanha of campanhas) {
      try {
        await this.sendNext(campanha);
      } catch (err) {
        this.logger.error({
          event: "broadcast_campaign_failed",
          campaignId: campanha.id,
          error: String(err),
        });
      }
    }
  }

  /** Pausa com motivo — nunca pausa muda, a tela precisa dizer o porquê. */
  private async pause(campaignId: string, reason: BroadcastPauseReason): Promise<void> {
    await this.prisma.broadcastCampaign.update({
      where: { id: campaignId },
      data: { status: "paused", pausedReason: reason, nextSendAt: null },
    });
    this.logger.warn({ event: "broadcast_campaign_paused", campaignId, reason });
  }

  /** Dia civil no fuso do escritório, no formato AAAA-MM-DD (chave do teto diário). */
  private civilDay(timeZone: string, moment: Date): string {
    try {
      return new Intl.DateTimeFormat("en-CA", {
        timeZone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }).format(moment);
    } catch {
      return moment.toISOString().slice(0, 10);
    }
  }

  /**
   * O primeiro instante do próximo dia civil do escritório.
   *
   * Avança de hora em hora (no máximo 25 voltas) até o dia mudar no fuso
   * configurado, em vez de somar 24h: o container roda em UTC, e somar um
   * dia inteiro pularia a manhã seguinte quando o disparo bate no teto de
   * madrugada.
   */
  private startOfNextCivilDay(timeZone: string, from: Date): Date {
    const hoje = this.civilDay(timeZone, from);
    let cursor = from;
    for (let volta = 0; volta < 25; volta += 1) {
      cursor = new Date(cursor.getTime() + 60 * 60 * 1000);
      if (this.civilDay(timeZone, cursor) !== hoje) return cursor;
    }
    return new Date(from.getTime() + 24 * 60 * 60 * 1000);
  }

  private async sendNext(campaign: CampaignRecord): Promise<void> {
    const agora = new Date();

    // 1. A conexão precisa estar no ar. Número fora do ar não acumula erro:
    //    a campanha PAUSA e volta quando alguém reconectar — marcar 200
    //    entregas como falha por causa de um QR vencido destruiria a lista.
    const instancia = await this.prisma.whatsAppInstance.findUnique({
      where: { id: campaign.whatsappInstanceId },
      select: { id: true, status: true, organizationId: true },
    });
    if (!instancia || instancia.status !== "connected") {
      await this.pause(campaign.id, "instance_offline");
      return;
    }

    const settings = await loadAttendanceSettings(this.prisma, campaign.organizationId);

    // 2. Expediente. Fora dele o disparo NÃO falha: ele adia para a abertura
    //    do próximo dia útil. Mandar promoção às 3h da manhã é a forma mais
    //    rápida de ser denunciado como spam, e a denúncia derruba o número.
    if (campaign.respectBusinessHours) {
      const permitido = nextBusinessMoment(agora, settings);
      if (!permitido) {
        // Semana inteira desligada: não há quando enviar. Pausa em vez de
        // procurar um horário que não existe (mesma guarda do dashboard).
        await this.pause(campaign.id, "manual");
        return;
      }
      if (permitido.getTime() > agora.getTime()) {
        await this.prisma.broadcastCampaign.update({
          where: { id: campaign.id },
          data: { nextSendAt: permitido },
        });
        return;
      }
    }

    // 3. Teto diário. Também não é falha: reprograma para a abertura do dia
    //    seguinte. O par (contador, dia) evita varrer as entregas por data a
    //    cada mensagem.
    const hoje = this.civilDay(settings.timezone, agora);
    const enviadasHoje = campaign.sentTodayDate === hoje ? campaign.sentToday : 0;
    if (campaign.dailyLimit !== null && enviadasHoje >= campaign.dailyLimit) {
      // A retomada tem de cair no DIA CIVIL seguinte, e não "daqui a algumas
      // horas": um salto fixo às 9h da manhã ainda é hoje, o teto continua
      // estourado e a campanha voltaria a esta guarda a cada volta do worker
      // até a virada — centenas de escritas por hora sem mandar nada.
      const amanha = this.startOfNextCivilDay(settings.timezone, agora);
      const retomada = campaign.respectBusinessHours
        ? (nextBusinessMoment(amanha, settings) ?? amanha)
        : amanha;
      await this.prisma.broadcastCampaign.update({
        where: { id: campaign.id },
        data: { nextSendAt: retomada, pausedReason: "daily_limit" },
      });
      return;
    }

    // 4. A próxima da fila.
    const delivery = await this.prisma.broadcastDelivery.findFirst({
      where: { campaignId: campaign.id, status: "pending" },
      orderBy: { createdAt: "asc" },
    });
    if (!delivery) {
      await this.prisma.broadcastCampaign.update({
        where: { id: campaign.id },
        data: { status: "completed", finishedAt: agora, nextSendAt: null, pausedReason: null },
      });
      this.logger.info({ event: "broadcast_campaign_completed", campaignId: campaign.id });
      return;
    }

    // 5. Descadastro, conferido AGORA e não na geração da fila: a pessoa pode
    //    ter pedido para sair depois que a campanha começou — e é justamente
    //    quem pediu durante o disparo que denuncia se receber a próxima.
    const descadastrado = await this.prisma.broadcastOptOut.findUnique({
      where: { organizationId_phone: { organizationId: campaign.organizationId, phone: delivery.phone } },
      select: { id: true },
    });
    if (descadastrado) {
      await this.prisma.broadcastDelivery.update({
        where: { id: delivery.id },
        data: { status: "skipped", skipReason: "opted_out" },
      });
      // Pular não gasta o intervalo: quem não recebeu mensagem não conta
      // como envio para o WhatsApp. A próxima sai na volta seguinte.
      await this.prisma.broadcastCampaign.update({
        where: { id: campaign.id },
        data: { nextSendAt: agora },
      });
      return;
    }

    const normalizado = normalizeBrazilPhone(delivery.phone);
    if (!normalizado.ok) {
      await this.prisma.broadcastDelivery.update({
        where: { id: delivery.id },
        data: { status: "skipped", skipReason: "invalid_phone" },
      });
      await this.prisma.broadcastCampaign.update({
        where: { id: campaign.id },
        data: { nextSendAt: agora },
      });
      return;
    }

    // 6. O texto. Sorteia entre a principal e as variações — mil mensagens
    //    idênticas é o padrão mais fácil de reconhecer que existe.
    const variantes = [campaign.message, ...readMessageVariants(campaign.messageVariants)];
    const escolhida = variantes[Math.floor(Math.random() * variantes.length)] ?? campaign.message;
    const contato = delivery.contactId
      ? await this.prisma.broadcastContact.findUnique({
          where: { id: delivery.contactId },
          select: { fields: true },
        })
      : null;
    const texto = resolveBroadcastTemplate(
      escolhida,
      {
        name: delivery.contactName,
        company: delivery.contactCompany,
        phone: formatPhone(delivery.phone),
        fields: readContactFields(contato?.fields),
      },
      agora,
    );

    // 7. Envio, pelo MESMO caminho do envio manual e da API de integração:
    //    `ensureConversation` + `provider.sendText` + `Message.create`. Um
    //    caminho paralelo de inserção de mensagem sairia de sincronia com a
    //    Inbox no primeiro detalhe esquecido.
    const conversation = await this.ingest.ensureConversation(
      {
        instanceId: instancia.id,
        externalChatId: normalizado.jid,
        isGroup: false,
        callerName: delivery.contactName,
        callerPhone: normalizado.phone,
      },
      campaign.organizationId,
    );

    try {
      const resultado = await this.provider.sendText(instancia.id, normalizado.jid, texto);

      const message = await this.prisma.message.create({
        data: {
          organizationId: campaign.organizationId,
          conversationId: conversation.id,
          externalMessageId: resultado.externalMessageId,
          direction: "outbound",
          type: "text",
          content: texto,
          senderName: `Disparo (${campaign.name})`,
          timestamp: resultado.timestamp,
          status: "sent",
          // Sem `sentByUserId`: não foi pessoa digitando. `origem` marca a
          // fonte, do mesmo jeito que a API de integração e a IA marcam.
          metadata: { origem: "broadcast", broadcastCampaignId: campaign.id },
        },
      });

      await this.prisma.broadcastDelivery.update({
        where: { id: delivery.id },
        data: {
          status: "sent",
          sentAt: resultado.timestamp,
          content: texto,
          conversationId: conversation.id,
          messageId: message.id,
          attempts: delivery.attempts + 1,
          failureReason: null,
        },
      });

      await this.prisma.conversation.update({
        where: { id: conversation.id },
        data: {
          lastMessageAt: resultado.timestamp,
          lastMessagePreview: buildPreview({ type: "text", content: texto }),
        },
      });

      await this.publicar(campaign.organizationId, conversation.id, message.id);
      await this.aplicarEtiqueta(campaign, conversation.id);
      await this.criarOportunidade(campaign, conversation.id, delivery, "on_send");

      const intervalo = pickIntervalMs(campaign.minIntervalSeconds, campaign.maxIntervalSeconds);
      await this.prisma.broadcastCampaign.update({
        where: { id: campaign.id },
        data: {
          nextSendAt: new Date(agora.getTime() + intervalo),
          consecutiveFailures: 0,
          pausedReason: null,
          sentToday: enviadasHoje + 1,
          sentTodayDate: hoje,
        },
      });
    } catch (err) {
      const tentativas = delivery.attempts + 1;
      const desistiu = tentativas >= MAX_DELIVERY_ATTEMPTS;
      await this.prisma.broadcastDelivery.update({
        where: { id: delivery.id },
        data: {
          attempts: tentativas,
          status: desistiu ? "failed" : "pending",
          failureReason: err instanceof Error ? err.message : "Falha desconhecida no envio",
        },
      });

      const seguidas = campaign.consecutiveFailures + 1;
      this.logger.warn({
        event: "broadcast_delivery_failed",
        campaignId: campaign.id,
        deliveryId: delivery.id,
        attempts: tentativas,
        consecutiveFailures: seguidas,
      });

      // A TRAVA QUE SALVA O NÚMERO: falha em sequência é sintoma de bloqueio
      // em curso. Parar no quinto erro custa uma campanha; insistir até o fim
      // da lista custa o chip, e com ele o histórico de todos os clientes.
      if (seguidas >= BROADCAST_LIMITS.MAX_CONSECUTIVE_FAILURES) {
        await this.prisma.broadcastCampaign.update({
          where: { id: campaign.id },
          data: { consecutiveFailures: seguidas },
        });
        await this.pause(campaign.id, "too_many_failures");
        return;
      }

      const intervalo = pickIntervalMs(campaign.minIntervalSeconds, campaign.maxIntervalSeconds);
      await this.prisma.broadcastCampaign.update({
        where: { id: campaign.id },
        data: {
          consecutiveFailures: seguidas,
          nextSendAt: new Date(agora.getTime() + intervalo),
        },
      });
    }
  }

  /** Os mesmos dois eventos do envio manual, na mesma audiência. */
  private async publicar(
    organizationId: string,
    conversationId: string,
    messageId: string,
  ): Promise<void> {
    const [conversation, message] = await Promise.all([
      this.prisma.conversation.findUnique({
        where: { id: conversationId },
        include: {
          assignedUser: true,
          department: true,
          instance: true,
          tags: { include: { tag: true } },
        },
      }),
      this.prisma.message.findUnique({ where: { id: messageId } }),
    ]);
    if (!conversation || !message) return;

    const personName = await resolveConversationPersonName(this.prisma, organizationId, conversation);
    const room = conversationAudience(organizationId, conversation);
    this.io.to(room).emit(RealtimeEvents.MessageNew, {
      conversation: serializeConversation(conversation, personName),
      message: serializeMessage(message),
    });
    this.io
      .to(room)
      .emit(RealtimeEvents.ConversationUpdated, serializeConversation(conversation, personName));
  }

  /**
   * A etiqueta da campanha na conversa — é o que faz a Inbox distinguir
   * "conversa que nasceu de disparo" das demais, e o que permite filtrar
   * depois. Falhar aqui não desfaz o envio: a mensagem já saiu.
   */
  private async aplicarEtiqueta(campaign: CampaignRecord, conversationId: string): Promise<void> {
    if (!campaign.tagId) return;
    try {
      await this.prisma.conversationTag.createMany({
        data: [{ conversationId, tagId: campaign.tagId }],
        skipDuplicates: true,
      });
    } catch (err) {
      this.logger.warn({
        event: "broadcast_tag_failed",
        campaignId: campaign.id,
        error: String(err),
      });
    }
  }

  /**
   * A oportunidade no CRM, quando o modo da campanha bate com o momento.
   *
   * Reaproveita `createCrmOpportunity` — a MESMA função do "+ Criar
   * oportunidade" da conversa, com a mesma régua de duplicidade, a mesma
   * distribuição automática e as mesmas automações de etapa. Um caminho
   * próprio aqui criaria card que não passa pelas regras do funil.
   *
   * Falha do CRM NUNCA desfaz o envio nem derruba o disparo: a mensagem já
   * está no celular do cliente, e parar a campanha porque um funil foi
   * apagado seria a consequência errada.
   */
  private async criarOportunidade(
    campaign: CampaignRecord,
    conversationId: string,
    delivery: { phone: string; contactName: string | null },
    momento: "on_send" | "on_reply",
  ): Promise<void> {
    if (campaign.crmMode !== momento) return;
    if (!campaign.crmPipelineId) return;
    try {
      await createCrmOpportunity(
        { prisma: this.prisma, io: this.io, logger: this.logger },
        {
          organizationId: campaign.organizationId,
          pipelineId: campaign.crmPipelineId,
          stageId: campaign.crmStageId,
          conversationId,
          contactName: delivery.contactName,
          contactPhone: delivery.phone,
          origin: `Disparo: ${campaign.name}`,
          // Nulo = criada pelo sistema, como a automação de etiqueta.
          performedByUserId: null,
        },
      );
    } catch (err) {
      this.logger.warn({
        event: "broadcast_crm_failed",
        campaignId: campaign.id,
        conversationId,
        error: String(err),
      });
    }
  }

  /**
   * Chamado quando um contato disparado RESPONDE — cria o card do CRM no
   * modo `on_reply`, que é o padrão do módulo.
   *
   * Fica aqui, e não na ingestão, para a ingestão continuar sem saber que
   * disparo existe: ela avisa `handleBroadcastInbound` e segue a vida.
   */
  async handleReply(input: {
    organizationId: string;
    campaignId: string;
    conversationId: string;
    phone: string;
    contactName: string | null;
  }): Promise<void> {
    const campaign = (await this.prisma.broadcastCampaign.findUnique({
      where: { id: input.campaignId },
    })) as unknown as CampaignRecord | null;
    if (!campaign) return;
    await this.criarOportunidade(
      campaign,
      input.conversationId,
      { phone: input.phone, contactName: input.contactName },
      "on_reply",
    );
  }
}

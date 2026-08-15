import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { Prisma } from "@azvchat/database";
import {
  CONNECTION_STATUSES,
  CONVERSATION_STATUSES,
  DASHBOARD_PERIODS,
  type ConnectionStatus,
  type ConversationStatus,
} from "@azvchat/shared";
import { conversationScope, instanceIdScope, loadConversationAccess } from "../../lib/access.js";
import { loadAttendanceSettings } from "../../lib/attendance-settings.js";
import { authenticate } from "../../lib/auth.js";
import { serializeDashboardStats } from "../../lib/serialize.js";
import type { AppDeps } from "../../types.js";
import { computeOverdue, periodStart, type WaitingConversation } from "./metrics.js";

const statsQuerySchema = z.object({
  // Só os quatro períodos da tela: intervalo livre não é oferecido, para o
  // número do dashboard significar sempre a mesma coisa para todo mundo.
  period: z.enum(DASHBOARD_PERIODS).default("today"),
});

/**
 * Mensagem que conta como movimento de atendimento.
 *
 * Apagada para todos não infla volume — a linha fica só para histórico. Saída
 * ainda `pending` também não: agendada que não saiu não foi enviada a
 * ninguém. Vale igual para os cards e para o ranking, senão a soma de uma
 * linha do ranking não bateria com o card de mensagens enviadas.
 */
const COUNTABLE_MESSAGE = {
  deletedAt: null,
  NOT: { direction: "outbound" as const, status: "pending" as const },
};

/** Última mensagem de cada conversa candidata a atraso. */
interface LastMessageRow {
  conversationId: string;
  direction: "inbound" | "outbound";
  timestamp: Date;
}

export async function dashboardRoutes(app: FastifyInstance, deps: AppDeps): Promise<void> {
  app.get("/dashboard/stats", { preHandler: authenticate }, async (request) => {
    const { period } = statsQuerySchema.parse(request.query);
    const organizationId = request.user.organizationId;
    const now = new Date();

    // Os parâmetros são lidos do banco a cada requisição, de propósito: mudar
    // o limite de resposta na tela de Parâmetros tem que valer na próxima
    // carga do dashboard, não depois de reiniciar o container.
    const settings = await loadAttendanceSettings(deps.prisma, organizationId);
    const start = periodStart(period, now, settings.timezone);

    // Todo número desta tela sai do mesmo recorte da Inbox — nada de filtro
    // de acesso montado à mão.
    const access = await loadConversationAccess(deps.prisma, request.user);
    const instanceFilter = instanceIdScope(access.instanceIds);
    const conversationFilter = conversationScope(access);
    const messageFilter = { conversation: conversationFilter };

    const [statusBuckets, instanceBuckets, messagesReceived, messagesSent, topConversations] =
      await Promise.all([
        /**
         * A regra central da tela: o **período filtra por atividade** e o
         * **status agrupa** o resultado. Conta conversa que teve mensagem no
         * período, pelo status atual dela — não por data de criação nem por
         * data de mudança de status, que responderiam outra pergunta.
         *
         * `lastMessageAt` é sempre o timestamp da última mensagem, então
         * "teve mensagem no período" é exatamente `lastMessageAt >= início`.
         * Vindo tudo de um `groupBy` só, a soma dos quatro status fecha com o
         * total de conversas ativas por construção.
         */
        deps.prisma.conversation.groupBy({
          by: ["status"],
          where: { organizationId, ...conversationFilter, lastMessageAt: { gte: start } },
          _count: { _all: true },
        }),
        deps.prisma.whatsAppInstance.groupBy({
          by: ["status"],
          where: { organizationId, ...instanceFilter },
          _count: { _all: true },
        }),
        deps.prisma.message.count({
          where: {
            organizationId,
            ...messageFilter,
            direction: "inbound",
            timestamp: { gte: start },
            ...COUNTABLE_MESSAGE,
          },
        }),
        deps.prisma.message.count({
          where: {
            organizationId,
            ...messageFilter,
            direction: "outbound",
            timestamp: { gte: start },
            ...COUNTABLE_MESSAGE,
          },
        }),
        // Ranking: a contagem é feita no banco. Primeiro as dez conversas com
        // mais mensagens no período, ordenadas pelo próprio banco.
        deps.prisma.message.groupBy({
          by: ["conversationId"],
          where: {
            organizationId,
            ...messageFilter,
            timestamp: { gte: start },
            ...COUNTABLE_MESSAGE,
          },
          _count: { _all: true },
          orderBy: { _count: { conversationId: "desc" } },
          take: 10,
        }),
      ]);

    const rankingIds = topConversations.map((row) => row.conversationId);

    const [rankingSplit, rankingConversations, overdueCandidates] = await Promise.all([
      // Depois a quebra entrada/saída, só das dez — de novo agregado no banco.
      rankingIds.length > 0
        ? deps.prisma.message.groupBy({
            by: ["conversationId", "direction"],
            where: {
              conversationId: { in: rankingIds },
              timestamp: { gte: start },
              ...COUNTABLE_MESSAGE,
            },
            _count: { _all: true },
          })
        : Promise.resolve([]),
      rankingIds.length > 0
        ? deps.prisma.conversation.findMany({
            where: { id: { in: rankingIds } },
            select: {
              id: true,
              title: true,
              customTitle: true,
              type: true,
              instance: { select: { name: true } },
            },
          })
        : Promise.resolve([]),
      /**
       * Candidatas a atraso. O card ignora o filtro de período — ele é sempre
       * o estado agora.
       *
       * O corte por tempo de relógio é só uma peneira: tempo de expediente
       * nunca passa do tempo corrido, então nada que ainda não completou o
       * limite no relógio pode estar atrasado. A conta de verdade, em tempo
       * útil, roda depois, só sobre o que sobrou.
       */
      deps.prisma.conversation.findMany({
        where: {
          organizationId,
          ...conversationFilter,
          status: { not: "resolved" },
          lastMessageAt: {
            not: null,
            lte: new Date(now.getTime() - settings.responseLimitMinutes * 60_000),
          },
        },
        select: { id: true },
      }),
    ]);

    const waiting = await loadWaitingConversations(
      deps,
      overdueCandidates.map((row) => row.id),
    );
    const overdue = computeOverdue(waiting, settings, now);

    const conversationsByStatus = emptyCounts(CONVERSATION_STATUSES);
    for (const bucket of statusBuckets) {
      conversationsByStatus[bucket.status] = bucket._count._all;
    }
    const instancesByStatus = emptyCounts(CONNECTION_STATUSES);
    for (const bucket of instanceBuckets) {
      instancesByStatus[bucket.status] = bucket._count._all;
    }

    const receivedByConversation = new Map<string, number>();
    const sentByConversation = new Map<string, number>();
    for (const row of rankingSplit) {
      const target = row.direction === "inbound" ? receivedByConversation : sentByConversation;
      target.set(row.conversationId, row._count._all);
    }
    const conversationById = new Map(rankingConversations.map((row) => [row.id, row]));

    const ranking = topConversations.flatMap((row) => {
      const conversation = conversationById.get(row.conversationId);
      if (!conversation) return [];
      return [
        {
          conversationId: row.conversationId,
          // Mesma regra de exibição da Inbox: o nome da equipe vence o do
          // WhatsApp, que o sync sobrescreve.
          title: conversation.customTitle ?? conversation.title,
          type: conversation.type,
          instanceName: conversation.instance?.name ?? null,
          received: receivedByConversation.get(row.conversationId) ?? 0,
          sent: sentByConversation.get(row.conversationId) ?? 0,
          total: row._count._all,
        },
      ];
    });

    request.log.debug(
      {
        event: "dashboard_stats",
        period,
        overdueCandidates: overdueCandidates.length,
        durationMs: Date.now() - now.getTime(),
      },
      "dashboard_stats_computed",
    );

    return serializeDashboardStats({
      period,
      periodStart: start,
      generatedAt: now,
      settings,
      conversationsByStatus,
      instancesByStatus,
      messagesReceived,
      messagesSent,
      overdue,
      ranking,
    });
  });

  /**
   * Direção da última mensagem de cada conversa candidata.
   *
   * SQL cru porque o Prisma não faz "a última linha de cada grupo" — e sem
   * isso seria uma consulta por conversa. O escopo de acesso continua valendo:
   * os ids vêm de uma busca que já passou por `conversationScope`, e esta
   * consulta não amplia o conjunto, só olha as mensagens deles.
   *
   * Nota interna não entra: ela vive em `internal_notes` e nunca foi
   * mensagem, então não conta como resposta ao cliente — o que está certo,
   * porque o cliente não recebeu nada. Mensagem apagada também não conta.
   */
  async function loadWaitingConversations(
    { prisma }: AppDeps,
    conversationIds: string[],
  ): Promise<WaitingConversation[]> {
    if (conversationIds.length === 0) return [];
    const rows = await prisma.$queryRaw<LastMessageRow[]>(Prisma.sql`
      SELECT DISTINCT ON ("conversationId")
             "conversationId", "direction"::text AS "direction", "timestamp"
      FROM "messages"
      WHERE "conversationId" IN (${Prisma.join(conversationIds)})
        AND "deletedAt" IS NULL
        AND NOT ("direction" = 'outbound' AND "status" = 'pending')
      ORDER BY "conversationId", "timestamp" DESC
    `);
    return rows
      .filter((row) => row.direction === "inbound")
      .map((row) => ({ conversationId: row.conversationId, lastInboundAt: row.timestamp }));
  }
}

/** Zera todos os status para o card ausente aparecer como 0, e não sumir. */
function emptyCounts<T extends string>(keys: readonly T[]): Record<T, number> {
  return Object.fromEntries(keys.map((key) => [key, 0])) as Record<T, number>;
}

export type ConversationStatusCounts = Record<ConversationStatus, number>;
export type ConnectionStatusCounts = Record<ConnectionStatus, number>;

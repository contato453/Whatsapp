import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { Prisma } from "@azvchat/database";
import {
  CONNECTION_STATUSES,
  CONVERSATION_STATUSES,
  DASHBOARD_PERIODS,
  DATE_ONLY_PATTERN,
  FILTER_NONE,
  hasRole,
  MAX_CUSTOM_RANGE_DAYS,
  type ConnectionStatus,
  type ConversationStatus,
} from "@azvchat/shared";
import { conversationScope, instanceIdScope, loadConversationAccess } from "../../lib/access.js";
import { loadAttendanceSettings } from "../../lib/attendance-settings.js";
import { authenticate } from "../../lib/auth.js";
import { serializeDashboardStats, type DashboardTopUserRow } from "../../lib/serialize.js";
import type { AppDeps } from "../../types.js";
import { computeOverdue, periodRange, type WaitingConversation } from "./metrics.js";

/** Filtro que aceita um id ou a ausência dele ("sem departamento", "sem responsável"). */
const idOrNone = z.union([z.string().uuid(), z.literal(FILTER_NONE)]);

const statsQuerySchema = z
  .object({
    period: z.enum(DASHBOARD_PERIODS).default("today"),
    /** Só valem com `period=custom`; são datas civis no fuso configurado. */
    from: z.string().regex(DATE_ONLY_PATTERN, "Data deve estar no formato AAAA-MM-DD").optional(),
    to: z.string().regex(DATE_ONLY_PATTERN, "Data deve estar no formato AAAA-MM-DD").optional(),
    instanceId: z.string().uuid().optional(),
    departmentId: idOrNone.optional(),
    assignedUserId: idOrNone.optional(),
  })
  .superRefine((query, ctx) => {
    if (query.period !== "custom") return;
    if (!query.from || !query.to) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["from"],
        message: "Informe a data de início e a de fim",
      });
      return;
    }
    // "AAAA-MM-DD" ordena igual como texto e como data, então a comparação
    // direta basta e não depende de fuso nenhum.
    if (query.to < query.from) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["to"],
        message: "A data de fim não pode ser anterior à de início",
      });
      return;
    }
    const days = Math.round(
      (Date.parse(`${query.to}T00:00:00Z`) - Date.parse(`${query.from}T00:00:00Z`)) / 86_400_000,
    ) + 1;
    if (days > MAX_CUSTOM_RANGE_DAYS) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["to"],
        message: `O intervalo não pode passar de ${MAX_CUSTOM_RANGE_DAYS} dias`,
      });
    }
  });

type StatsQuery = z.infer<typeof statsQuerySchema>;

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

/**
 * Teto de conversas lidas para montar o ranking de usuários. Acima disso o
 * número sairia incompleto, então em vez de cortar em silêncio a rota loga o
 * estouro — o mesmo espírito do teto do relatório por atendente.
 */
const MAX_CONVERSATIONS_FOR_TEAM_RANKING = 20_000;

/** Última mensagem de cada conversa candidata a atraso. */
interface LastMessageRow {
  conversationId: string;
  direction: "inbound" | "outbound";
  timestamp: Date;
}

/**
 * Filtros escolhidos na tela, como condições de Prisma.
 *
 * Eles **refinam** o recorte de `access.ts`, nunca o ampliam: entram num AND
 * junto com `conversationScope`, então pedir um número que o usuário não
 * enxerga devolve vazio em vez de vazar. Os seletores da tela já só oferecem
 * o que ele enxerga; isto é a garantia do lado do servidor.
 */
function scopedConversationWhere(
  access: Parameters<typeof conversationScope>[0],
  query: StatsQuery,
): Prisma.ConversationWhereInput {
  const scope = conversationScope(access);
  const conditions = [
    // Admin sem filtro nenhum tem escopo vazio: incluí-lo criaria um `AND`
    // com um objeto vazio dentro, que não filtra nada e só polui a consulta.
    ...(Object.keys(scope).length > 0 ? [scope] : []),
    ...dashboardFilterConditions(query),
  ];
  return conditions.length > 0 ? { AND: conditions } : {};
}

function dashboardFilterConditions(query: StatsQuery): Prisma.ConversationWhereInput[] {
  const conditions: Prisma.ConversationWhereInput[] = [];
  if (query.instanceId) {
    conditions.push({ whatsappInstanceId: query.instanceId });
  }
  if (query.departmentId) {
    conditions.push({
      departmentId: query.departmentId === FILTER_NONE ? null : query.departmentId,
    });
  }
  if (query.assignedUserId) {
    conditions.push({
      assignedUserId: query.assignedUserId === FILTER_NONE ? null : query.assignedUserId,
    });
  }
  return conditions;
}

export async function dashboardRoutes(app: FastifyInstance, deps: AppDeps): Promise<void> {
  app.get("/dashboard/stats", { preHandler: authenticate }, async (request) => {
    const query = statsQuerySchema.parse(request.query);
    const organizationId = request.user.organizationId;
    const now = new Date();

    // Os parâmetros são lidos do banco a cada requisição, de propósito: mudar
    // o limite de resposta na tela de Parâmetros tem que valer na próxima
    // carga do dashboard, não depois de reiniciar o container.
    const settings = await loadAttendanceSettings(deps.prisma, organizationId);
    const { start, end } = periodRange(
      query.period,
      now,
      settings.timezone,
      query.from && query.to ? { from: query.from, to: query.to } : undefined,
    );
    // Um só intervalo para tudo o que olha data: `end` nulo vira "até agora".
    const withinPeriod = end ? { gte: start, lte: end } : { gte: start };

    // Todo número desta tela sai do mesmo recorte da Inbox — nada de filtro
    // de acesso montado à mão —, com os filtros da tela por cima.
    const access = await loadConversationAccess(deps.prisma, request.user);
    const instanceFilter = query.instanceId
      ? { id: query.instanceId, ...instanceIdScope(access.instanceIds) }
      : instanceIdScope(access.instanceIds);
    const conversationFilter = scopedConversationWhere(access, query);
    const messageFilter = { conversation: conversationFilter };

    // Números de desempenho da equipe são de supervisor para cima, igual ao
    // relatório por atendente. Para quem não é, o bloco nem é consultado.
    const canSeeTeam = hasRole(request.user.role, "supervisor");

    const [statusBuckets, instanceBuckets, messagesReceived, messagesSent, topConversations] =
      await Promise.all([
        /**
         * A regra central da tela: o **período filtra por atividade** e o
         * **status agrupa** o resultado. Conta conversa que teve mensagem no
         * período, pelo status atual dela — não por data de criação nem por
         * data de mudança de status, que responderiam outra pergunta.
         *
         * `lastMessageAt` é sempre o timestamp da última mensagem, então
         * "teve mensagem no período" é exatamente `lastMessageAt` dentro do
         * intervalo. Vindo tudo de um `groupBy` só, a soma dos quatro status
         * fecha com o total de conversas ativas por construção.
         */
        deps.prisma.conversation.groupBy({
          by: ["status"],
          where: { organizationId, ...conversationFilter, lastMessageAt: withinPeriod },
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
            timestamp: withinPeriod,
            ...COUNTABLE_MESSAGE,
          },
        }),
        deps.prisma.message.count({
          where: {
            organizationId,
            ...messageFilter,
            direction: "outbound",
            timestamp: withinPeriod,
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
            timestamp: withinPeriod,
            ...COUNTABLE_MESSAGE,
          },
          _count: { _all: true },
          orderBy: { _count: { conversationId: "desc" } },
          take: 10,
        }),
      ]);

    const rankingIds = topConversations.map((row) => row.conversationId);

    const [rankingSplit, rankingConversations, overdueCandidates, assignedConversations, sentByUser] =
      await Promise.all([
        // Depois a quebra entrada/saída, só das dez — de novo agregado no banco.
        rankingIds.length > 0
          ? deps.prisma.message.groupBy({
              by: ["conversationId", "direction"],
              where: {
                conversationId: { in: rankingIds },
                timestamp: withinPeriod,
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
         * o estado agora —, mas respeita os filtros de número, departamento e
         * responsável: a tela inteira responde a eles.
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
        /**
         * Conversas com responsável que tiveram movimento no período. Servem
         * para saber quanto o cliente mandou para cada pessoa: mensagem de
         * entrada não tem autor do nosso lado, quem a "recebeu" é quem estava
         * com a conversa na mão.
         *
         * É em duas etapas porque o Prisma não agrupa por campo de relação —
         * não dá para pedir `groupBy(conversation.assignedUserId)`.
         */
        canSeeTeam
          ? deps.prisma.conversation.findMany({
              where: {
                organizationId,
                ...conversationFilter,
                assignedUserId: { not: null },
                lastMessageAt: withinPeriod,
              },
              select: { id: true, assignedUserId: true },
              take: MAX_CONVERSATIONS_FOR_TEAM_RANKING,
            })
          : Promise.resolve([]),
        canSeeTeam
          ? deps.prisma.message.groupBy({
              by: ["sentByUserId"],
              where: {
                organizationId,
                ...messageFilter,
                direction: "outbound",
                timestamp: withinPeriod,
                ...COUNTABLE_MESSAGE,
                // Envio sem autor é da automação (agendada disparada pelo
                // scheduler), e não trabalho de alguém.
                sentByUserId: { not: null },
              },
              _count: { _all: true },
            })
          : Promise.resolve([]),
      ]);

    const waiting = await loadWaitingConversations(
      deps,
      overdueCandidates.map((row) => row.id),
    );
    const overdue = computeOverdue(waiting, settings, now);

    const topUsers = canSeeTeam
      ? await buildTopUsers(deps, organizationId, assignedConversations, sentByUser, withinPeriod)
      : null;

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

    if (assignedConversations.length >= MAX_CONVERSATIONS_FOR_TEAM_RANKING) {
      // Nada de corte em silêncio: se o teto foi atingido, o número por
      // usuário está incompleto e isso precisa aparecer em algum lugar.
      request.log.warn(
        { event: "dashboard_team_ranking_truncated", limit: MAX_CONVERSATIONS_FOR_TEAM_RANKING },
        "dashboard_team_ranking_truncated",
      );
    }

    request.log.debug(
      {
        event: "dashboard_stats",
        period: query.period,
        filtered: Boolean(query.instanceId || query.departmentId || query.assignedUserId),
        overdueCandidates: overdueCandidates.length,
        durationMs: Date.now() - now.getTime(),
      },
      "dashboard_stats_computed",
    );

    return serializeDashboardStats({
      period: query.period,
      periodStart: start,
      periodEnd: end,
      generatedAt: now,
      settings,
      filters: {
        instanceId: query.instanceId ?? null,
        departmentId: query.departmentId ?? null,
        assignedUserId: query.assignedUserId ?? null,
      },
      conversationsByStatus,
      instancesByStatus,
      messagesReceived,
      messagesSent,
      overdue,
      ranking,
      topUsers,
    });
  });

  /**
   * Top de usuários: quanto cada pessoa enviou e quanto o cliente mandou nas
   * conversas dela, no período e dentro do mesmo recorte de acesso.
   *
   * Ordena pelo total das duas pontas — é a medida de carga de atendimento,
   * não de produtividade. Quem só recebeu e não respondeu aparece igual, o
   * que é justamente o que a supervisão precisa enxergar.
   */
  async function buildTopUsers(
    { prisma }: AppDeps,
    organizationId: string,
    assignedConversations: Array<{ id: string; assignedUserId: string | null }>,
    sentByUser: Array<{ sentByUserId: string | null; _count: { _all: number } }>,
    withinPeriod: { gte: Date; lte?: Date },
  ): Promise<DashboardTopUserRow[]> {
    const totals = new Map<string, { sent: number; received: number }>();
    const bump = (userId: string, field: "sent" | "received", amount: number): void => {
      const current = totals.get(userId) ?? { sent: 0, received: 0 };
      current[field] += amount;
      totals.set(userId, current);
    };

    for (const row of sentByUser) {
      if (row.sentByUserId) bump(row.sentByUserId, "sent", row._count._all);
    }

    const ownerByConversation = new Map<string, string>();
    for (const row of assignedConversations) {
      if (row.assignedUserId) ownerByConversation.set(row.id, row.assignedUserId);
    }
    if (ownerByConversation.size > 0) {
      const inbound = await prisma.message.groupBy({
        by: ["conversationId"],
        where: {
          organizationId,
          conversationId: { in: [...ownerByConversation.keys()] },
          direction: "inbound",
          timestamp: withinPeriod,
          ...COUNTABLE_MESSAGE,
        },
        _count: { _all: true },
      });
      for (const row of inbound) {
        const owner = ownerByConversation.get(row.conversationId);
        if (owner) bump(owner, "received", row._count._all);
      }
    }

    const top = [...totals.entries()]
      .map(([userId, counts]) => ({ userId, ...counts, total: counts.sent + counts.received }))
      .sort((a, b) => b.total - a.total || b.sent - a.sent)
      .slice(0, 10);
    if (top.length === 0) return [];

    const users = await prisma.user.findMany({
      where: { organizationId, id: { in: top.map((row) => row.userId) } },
      select: { id: true, name: true, role: true, avatarUrl: true },
    });
    const userById = new Map(users.map((user) => [user.id, user]));

    return top.flatMap((row) => {
      const user = userById.get(row.userId);
      // Usuário de outra organização não existe aqui; sumido do cadastro é
      // linha sem nome, e nome é o único jeito de a supervisão ler a lista.
      if (!user) return [];
      return [
        {
          userId: row.userId,
          name: user.name,
          role: user.role,
          hasAvatar: user.avatarUrl != null,
          sent: row.sent,
          received: row.received,
          total: row.total,
        },
      ];
    });
  }

  /**
   * Direção da última mensagem de cada conversa candidata.
   *
   * SQL cru porque o Prisma não faz "a última linha de cada grupo" — e sem
   * isso seria uma consulta por conversa. O escopo de acesso continua valendo:
   * os ids vêm de uma busca que já passou por `conversationScope` e pelos
   * filtros da tela, e esta consulta não amplia o conjunto, só olha as
   * mensagens deles.
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

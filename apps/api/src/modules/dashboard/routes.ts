import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { Prisma } from "@azvchat/database";
import {
  CONNECTION_STATUSES,
  CONVERSATION_STATUSES,
  DASHBOARD_PERIODS,
  DATE_ONLY_PATTERN,
  FILTER_ALL_USERS,
  FILTER_NONE,
  MAX_CUSTOM_RANGE_DAYS,
  type ConnectionStatus,
  type ConversationStatus,
} from "@azvchat/shared";
import { conversationScope, instanceIdScope, loadConversationAccess } from "../../lib/access.js";
import { loadAttendanceSettings } from "../../lib/attendance-settings.js";
import {
  assignedToAllWhere,
  unassignedConversationWhere,
} from "../../lib/conversation-assignment.js";
import { authenticate } from "../../lib/auth.js";
import { assertKnownFilterIds, listaDe } from "../../lib/conversation-filters.js";
import { scanOverdueConversations } from "../../lib/overdue.js";
import {
  excludeInternalDepartments,
  loadInternalDepartmentIds,
} from "../../lib/internal-department.js";
import { loadPermissions } from "../../lib/permissions.js";
import { serializeDashboardStats, type DashboardTopUserRow } from "../../lib/serialize.js";
import type { AppDeps } from "../../types.js";
import {
  civilDaysOfRange,
  foldHourly,
  foldTimeline,
  periodRange,
  safeTimeZone,
  type ActivityBucket,
} from "./metrics.js";

/** Filtro que aceita um id ou a ausência dele ("sem departamento", "sem responsável"). */
const idOrNone = z.union([z.string().uuid(), z.literal(FILTER_NONE)]);

/**
 * O de responsável aceita um valor a mais: o atendimento coletivo ("@todos").
 * Ele fica FORA de "sem responsável" de propósito — as duas conversas têm
 * `assignedUserId` nulo, mas só uma delas está esperando alguém pegar.
 */
const assigneeFilter = z.union([idOrNone, z.literal(FILTER_ALL_USERS)]);

/**
 * Filtros da tela, todos em LISTA.
 *
 * **OU dentro do filtro, E entre filtros** (a regra e o porquê completos
 * estão em `@azvchat/shared/dashboard-filters`). Os nomes continuam no
 * singular, como na Inbox: o parâmetro é repetido (`?instanceId=a&instanceId=b`)
 * e o link antigo, de um valor só, continua valendo sem tratamento nenhum.
 *
 * Item inválido é RECUSADO, nunca ignorado: uuid torto, status fora do enum
 * ou id que não existe na organização derrubam a requisição com 400. Ignorar
 * em silêncio devolveria números plausíveis recortados por um critério
 * diferente do que a pessoa marcou — e aqui o resultado é um número só, que
 * ninguém consegue conferir de olho.
 */
const statsQuerySchema = z
  .object({
    /**
     * O período continua ÚNICO, e não vira lista: ele é um intervalo, não um
     * conjunto. "Hoje" mais "30 dias" não significa nada — ou é a união (que
     * é só o intervalo maior) ou é contradição.
     */
    period: z.enum(DASHBOARD_PERIODS).default("today"),
    /** Só valem com `period=custom`; são datas civis no fuso configurado. */
    from: z.string().regex(DATE_ONLY_PATTERN, "Data deve estar no formato AAAA-MM-DD").optional(),
    to: z.string().regex(DATE_ONLY_PATTERN, "Data deve estar no formato AAAA-MM-DD").optional(),
    instanceId: listaDe(z.string().uuid()),
    /**
     * Recorta a tela inteira para os status marcados. Com eles, o fluxo por
     * status mostra só as colunas pedidas — os filtros refinam, nunca somem
     * com número em silêncio.
     */
    status: listaDe(z.enum(CONVERSATION_STATUSES)),
    departmentId: listaDe(idOrNone),
    assignedUserId: listaDe(assigneeFilter),
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
 * Teto de conversas lidas por requisição. Acima disso a série por dia e o
 * total por usuário sairiam incompletos, então em vez de cortar em silêncio a
 * rota loga o estouro — o mesmo espírito do teto do relatório por atendente.
 */
const MAX_CONVERSATIONS_SCANNED = 20_000;

/**
 * Filtros escolhidos na tela, como condições de Prisma.
 *
 * Eles **refinam** o recorte de `access.ts`, nunca o ampliam: entram num AND
 * junto com `conversationScope`, então pedir um número que o usuário não
 * enxerga devolve vazio em vez de vazar. Os seletores da tela já só oferecem
 * o que ele enxerga; isto é a garantia do lado do servidor.
 *
 * O recorte de arquivamento entra aqui, POR CIMA do escopo de acesso e para
 * a tela inteira de uma vez: toda contagem nova que nascer deste filtro já
 * exclui (ou isola) as arquivadas sem depender de ninguém lembrar. `active`
 * é o dashboard normal; `archived` existe só para o card de arquivadas.
 */
function scopedConversationWhere(
  access: Parameters<typeof conversationScope>[0],
  query: StatsQuery,
  archive: "active" | "archived",
  internalDepartmentIds: string[],
): Prisma.ConversationWhereInput {
  const scope = conversationScope(access);
  const conditions = [
    // Admin sem filtro nenhum tem escopo vazio: incluí-lo criaria um `AND`
    // com um objeto vazio dentro, que não filtra nada e só polui a consulta.
    ...(Object.keys(scope).length > 0 ? [scope] : []),
    ...dashboardFilterConditions(query),
    { archivedAt: archive === "active" ? null : { not: null } },
    // Departamento interno não entra em número nenhum — nem no card de
    // arquivadas. Como o recorte é montado UMA vez e usado por todas as
    // consultas da tela, cards, gráficos e mapa de horas contam a mesma
    // coisa por construção.
    ...excludeInternalDepartments(internalDepartmentIds),
  ];
  return { AND: conditions };
}

/**
 * Junta os ramos de um filtro num item só do `AND`.
 *
 * Um ramo vai direto; vários viram `OR`, que é o "somam entre si". Lista
 * vazia não gera item nenhum — o "todos" daquele filtro.
 */
function ouEntre(ramos: Prisma.ConversationWhereInput[]): Prisma.ConversationWhereInput | null {
  if (ramos.length === 0) return null;
  if (ramos.length === 1) return ramos[0] ?? null;
  return { OR: ramos };
}

/**
 * Os filtros da tela como itens de um `AND`.
 *
 * **OU dentro de cada filtro, E entre filtros diferentes.** Cada item desta
 * lista é um filtro inteiro; dentro dele os valores marcados somam (pelo `in`
 * ou por um `OR`), e os itens cruzam entre si porque estão todos no mesmo
 * `AND`. Inverter isso zeraria a tela em quase toda marcação múltipla — uma
 * conversa não está em dois departamentos ao mesmo tempo.
 *
 * **Departamento e responsável são DOIS filtros, e cruzam.** É divergência
 * proposital em relação à Inbox, onde eles viraram um filtro só que soma: lá
 * a pergunta é de triagem e o resultado é uma lista; aqui é de análise e o
 * resultado é um número, e somar recortes diferentes dentro do mesmo total
 * produz número sem significado. Marcar "CS" e alguém que não é do CS devolve
 * zero, e isso está certo. O porquê completo está em
 * `@azvchat/shared/dashboard-filters`.
 */
function dashboardFilterConditions(query: StatsQuery): Prisma.ConversationWhereInput[] {
  const conditions: Prisma.ConversationWhereInput[] = [];
  if (query.instanceId.length > 0) {
    conditions.push({ whatsappInstanceId: { in: query.instanceId } });
  }
  if (query.status.length > 0) {
    // Entra no mesmo AND dos demais: pedir só `resolved` zera o card de
    // atraso por construção, porque lá o filtro convive com
    // `status != resolved`.
    conditions.push({ status: { in: query.status } });
  }

  // Departamento: os ids marcados somam entre si, e "sem departamento" é mais
  // um ramo do mesmo OU — a conversa que o número não classificou continua
  // sendo um recorte que a supervisão pede junto dos outros.
  const departmentIds = query.departmentId.filter((value) => value !== FILTER_NONE);
  const departmentBranches: Prisma.ConversationWhereInput[] = [
    ...(query.departmentId.includes(FILTER_NONE) ? [{ departmentId: null }] : []),
    ...(departmentIds.length > 0 ? [{ departmentId: { in: departmentIds } }] : []),
  ];
  const departmentWhere = ouEntre(departmentBranches);
  if (departmentWhere) conditions.push(departmentWhere);

  const userIds = query.assignedUserId.filter(
    (value) => value !== FILTER_NONE && value !== FILTER_ALL_USERS,
  );
  const assigneeBranches: Prisma.ConversationWhereInput[] = [
    // "Sem responsável" conta só as verdadeiramente órfãs: a coletiva tem
    // destino definido e sairia como problema de fila se entrasse aqui.
    ...(query.assignedUserId.includes(FILTER_NONE) ? [unassignedConversationWhere()] : []),
    ...(query.assignedUserId.includes(FILTER_ALL_USERS) ? [assignedToAllWhere()] : []),
    ...(userIds.length > 0 ? [{ assignedUserId: { in: userIds } }] : []),
  ];
  const assigneeWhere = ouEntre(assigneeBranches);
  if (assigneeWhere) conditions.push(assigneeWhere);

  return conditions;
}

/** Os ids de departamento e de pessoa marcados, sem os sentinelas. */
function filterEntityIds(query: StatsQuery): { departmentIds: string[]; userIds: string[] } {
  return {
    departmentIds: query.departmentId.filter((value) => value !== FILTER_NONE),
    userIds: query.assignedUserId.filter(
      (value) => value !== FILTER_NONE && value !== FILTER_ALL_USERS,
    ),
  };
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

    // Id que não existe na organização é RECUSADO, não ignorado: ignorar
    // devolveria um número plausível recortado por um critério diferente do
    // que a pessoa marcou, e número não se confere de olho. A tela poda o
    // item extinto antes de mandar, então chegar aqui um id desconhecido
    // significa link torto ou estado guardado corrompido.
    await assertKnownFilterIds(deps.prisma, organizationId, {
      ...filterEntityIds(query),
      tagIds: [],
      instanceIds: query.instanceId,
    });

    /**
     * O card de infraestrutura conta NÚMEROS, e não conversas: o único filtro
     * da tela que o recorta é o de número. Departamento e responsável são
     * atributos da conversa — restringir a lista de conexões por eles faria o
     * aviso de "fora do ar" esconder justamente o número que parou de receber
     * conversa (por estar fora do ar), que é o contrário do que o card serve.
     *
     * O filtro entra em `AND` com o escopo, e não espalhado no objeto: os dois
     * escrevem em `id`, e espalhar fazia o escopo SOBRESCREVER o filtro — o
     * card ignorava o número escolhido para todo mundo que não é admin.
     */
    const instanceScopeWhere = instanceIdScope(access.instanceIds);
    const instanceFilter =
      query.instanceId.length > 0
        ? { AND: [instanceScopeWhere, { id: { in: query.instanceId } }] }
        : instanceScopeWhere;
    // Quais departamentos são internos. Lido a cada requisição, como os
    // parâmetros de atendimento: marcar um departamento tem que limpar o
    // número na atualização seguinte, e não depois de reiniciar o container.
    const internalDepartmentIds = await loadInternalDepartmentIds(deps.prisma, organizationId);
    const conversationFilter = scopedConversationWhere(
      access,
      query,
      "active",
      internalDepartmentIds,
    );
    const messageFilter = { conversation: conversationFilter };

    // Números de desempenho da equipe são de supervisor para cima, igual ao
    // relatório por atendente. Para quem não é, o bloco nem é consultado.
    // Bloco de carga da equipe: chave do catálogo, não papel. Para quem não
    // pode, a rota nem consulta — e devolve `null`, que a tela lê como "não
    // desenha o bloco".
    const canSeeTeam = (await loadPermissions(deps.prisma, request.user)).can(
      "dashboard.view_team",
    );

    const [
      statusBuckets,
      archivedConversations,
      instanceBuckets,
      messagesReceived,
      messagesSent,
      topConversations,
    ] =
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
        /**
         * Card de conversas arquivadas: estado de agora, sem o corte de
         * período — arquivar é ação deliberada, não atividade. Os filtros de
         * número, departamento e responsável continuam valendo, como no
         * resto da tela.
         */
        deps.prisma.conversation.count({
          where: {
            organizationId,
            ...scopedConversationWhere(access, query, "archived", internalDepartmentIds),
          },
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

    const [rankingSplit, rankingConversations, overdue, activeConversations, sentByUser] =
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
                // Quem está com o atendimento na mão. A lista mostra isso
                // porque "conversa mais ativa" sem dono é justamente a que
                // precisa de alguém, e não só de atenção.
                assignedUser: { select: { id: true, name: true, avatarUrl: true } },
                // Sem dono pode ser fila ou decisão: a linha do ranking
                // precisa dizer qual das duas, como a lista da Inbox diz.
                assignedToAll: true,
              },
            })
          : Promise.resolve([]),
        /**
         * Atrasadas agora. O card ignora o filtro de período — ele é sempre o
         * estado agora —, mas respeita os filtros de número, departamento e
         * responsável: a tela inteira responde a eles.
         *
         * A conta sai de `lib/overdue.ts`, a MESMA que o filtro "Atrasadas" da
         * lista de conversas usa. Duas contas separadas fariam o clique no
         * card abrir uma lista que não bate com o número dele.
         */
        scanOverdueConversations(deps.prisma, organizationId, conversationFilter, settings, now),
        /**
         * Conversas com responsável que tiveram movimento no período. Servem
         * para saber quanto o cliente mandou para cada pessoa: mensagem de
         * entrada não tem autor do nosso lado, quem a "recebeu" é quem estava
         * com a conversa na mão.
         *
         * É em duas etapas porque o Prisma não agrupa por campo de relação —
         * não dá para pedir `groupBy(conversation.assignedUserId)`.
         */
        /**
         * Conversas com movimento no período. Servem para dois blocos: a
         * série por dia/hora e, para supervisor, o total por responsável.
         *
         * Uma busca só para os dois: é a mesma pergunta ("o que se mexeu no
         * período, dentro do recorte"), e ela já passa por `access.ts`.
         */
        deps.prisma.conversation.findMany({
          where: { organizationId, ...conversationFilter, lastMessageAt: withinPeriod },
          select: { id: true, assignedUserId: true },
          take: MAX_CONVERSATIONS_SCANNED,
        }),
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

    const activityBuckets = await loadActivityBuckets(
      deps,
      activeConversations.map((row) => row.id),
      settings.timezone,
      start,
      end,
    );
    const timeline = foldTimeline(
      activityBuckets,
      civilDaysOfRange({ start, end }, now, settings.timezone),
    );

    /**
     * O mapa de dia × hora tem janela fixa de 30 dias, e é o único bloco da
     * tela que ignora o período: padrão de horário só aparece com repetição,
     * e "hoje" mostraria um dia em vez do hábito do cliente. Os demais
     * filtros continuam valendo — é a mesma pergunta, recorte diferente.
     *
     * Com o período já em 30 dias a janela é a mesma, então reaproveita o que
     * já foi buscado em vez de repetir duas consultas por nada.
     */
    const hourlyBuckets =
      query.period === "30d"
        ? activityBuckets
        : await loadHeatmapBuckets(deps, organizationId, conversationFilter, settings.timezone, now);
    const hourly = foldHourly(hourlyBuckets);

    const topUsers = canSeeTeam
      ? await buildTopUsers(deps, organizationId, activeConversations, sentByUser, withinPeriod)
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
          // Só o mínimo para desenhar a linha — nada de dado de cadastro do
          // usuário viajando dentro do trabalho de outro.
          assignee: conversation.assignedUser
            ? {
                userId: conversation.assignedUser.id,
                name: conversation.assignedUser.name,
                hasAvatar: conversation.assignedUser.avatarUrl != null,
              }
            : null,
          assignedToAll: conversation.assignedToAll,
          received: receivedByConversation.get(row.conversationId) ?? 0,
          sent: sentByConversation.get(row.conversationId) ?? 0,
          total: row._count._all,
        },
      ];
    });

    if (activeConversations.length >= MAX_CONVERSATIONS_SCANNED) {
      // Nada de corte em silêncio: se o teto foi atingido, o número por
      // usuário está incompleto e isso precisa aparecer em algum lugar.
      request.log.warn(
        { event: "dashboard_scan_truncated", limit: MAX_CONVERSATIONS_SCANNED },
        "dashboard_scan_truncated",
      );
    }

    request.log.debug(
      {
        event: "dashboard_stats",
        period: query.period,
        filtered:
          query.instanceId.length +
            query.status.length +
            query.departmentId.length +
            query.assignedUserId.length >
          0,
        overdue: overdue.count,
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
        instanceIds: query.instanceId,
        statuses: query.status,
        departmentIds: query.departmentId,
        assignedUserIds: query.assignedUserId,
      },
      conversationsByStatus,
      archivedConversations,
      instancesByStatus,
      messagesReceived,
      messagesSent,
      overdue,
      ranking,
      topUsers,
      timeline,
      hourly,
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
    activeConversations: Array<{ id: string; assignedUserId: string | null }>,
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
    for (const row of activeConversations) {
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
   * Movimento dos últimos 30 dias para o mapa de dia × hora.
   *
   * Mesmo caminho do resto: as conversas saem de uma busca já escopada por
   * `access.ts` e pelos filtros da tela, e o SQL só agrega as mensagens
   * delas. O que muda aqui é só a janela de tempo, que é fixa.
   */
  async function loadHeatmapBuckets(
    { prisma }: AppDeps,
    organizationId: string,
    conversationFilter: Prisma.ConversationWhereInput,
    timezone: string,
    now: Date,
  ): Promise<ActivityBucket[]> {
    const window = periodRange("30d", now, timezone);
    const conversations = await prisma.conversation.findMany({
      where: { organizationId, ...conversationFilter, lastMessageAt: { gte: window.start } },
      select: { id: true },
      take: MAX_CONVERSATIONS_SCANNED,
    });
    return loadActivityBuckets(
      deps,
      conversations.map((row) => row.id),
      timezone,
      window.start,
      window.end,
    );
  }

  /**
   * Mensagens do período agrupadas por dia, dia da semana, hora e direção.
   *
   * A conta é feita **no banco**: 30 dias viram no máximo 30 × 24 × 2 linhas,
   * contra dezenas de milhares de mensagens que não precisam trafegar. O
   * agrupamento por dia/hora exige SQL porque o Prisma não agrupa por
   * expressão — e o `AT TIME ZONE` faz o corte no fuso do escritório, não no
   * UTC do container, igual ao resto da tela.
   *
   * O escopo de acesso continua valendo: os ids vêm de uma busca que já passou
   * por `conversationScope` e pelos filtros da tela, e esta consulta só olha as
   * mensagens deles. Os mesmos descartes dos cards valem aqui (apagada não
   * conta, saída ainda `pending` não conta), senão o gráfico contaria uma
   * história e os cards outra.
   */
  async function loadActivityBuckets(
    { prisma }: AppDeps,
    conversationIds: string[],
    timezone: string,
    start: Date,
    end: Date | null,
  ): Promise<ActivityBucket[]> {
    if (conversationIds.length === 0) return [];
    const timeZone = safeTimeZone(timezone);
    const upperBound = end ? Prisma.sql`AND "timestamp" <= ${end}` : Prisma.empty;
    return prisma.$queryRaw<ActivityBucket[]>(Prisma.sql`
      SELECT
        to_char(("timestamp" AT TIME ZONE 'UTC') AT TIME ZONE ${timeZone}, 'YYYY-MM-DD') AS "day",
        EXTRACT(DOW FROM ("timestamp" AT TIME ZONE 'UTC') AT TIME ZONE ${timeZone})::int AS "weekday",
        EXTRACT(HOUR FROM ("timestamp" AT TIME ZONE 'UTC') AT TIME ZONE ${timeZone})::int AS "hour",
        "direction"::text AS "direction",
        COUNT(*)::int AS "total"
      FROM "messages"
      WHERE "conversationId" IN (${Prisma.join(conversationIds)})
        AND "timestamp" >= ${start}
        ${upperBound}
        AND "deletedAt" IS NULL
        AND NOT ("direction" = 'outbound' AND "status" = 'pending')
      GROUP BY 1, 2, 3, 4
    `);
  }
}

/** Zera todos os status para o card ausente aparecer como 0, e não sumir. */
function emptyCounts<T extends string>(keys: readonly T[]): Record<T, number> {
  return Object.fromEntries(keys.map((key) => [key, 0])) as Record<T, number>;
}

export type ConversationStatusCounts = Record<ConversationStatus, number>;
export type ConnectionStatusCounts = Record<ConnectionStatus, number>;

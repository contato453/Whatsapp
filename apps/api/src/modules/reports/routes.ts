import type { FastifyInstance } from "fastify";
import type { Prisma } from "@azvchat/database";
import { z } from "zod";
import { conversationScope, loadConversationAccess } from "../../lib/access.js";
import { requirePermission } from "../../lib/permissions.js";
import { FILTER_NONE } from "@azvchat/shared";
import { assertKnownFilterIds, listaDe } from "../../lib/conversation-filters.js";
import { reportFilterConditions, resolvedHistoryWhere } from "../../lib/report-slice.js";
import { serializeUser } from "../../lib/serialize.js";
import {
  bucketQueueEntries,
  computeAgentTotals,
  emptyQueue,
  queueTotal,
  sumQueues,
  type QueueEntry,
  type ReportMessage,
} from "./metrics.js";
import type { AppDeps } from "../../types.js";

/**
 * Relatório de atendimentos por atendente.
 *
 * Quem abre é decidido pela chave `reports.view` do catálogo de permissões
 * (padrão: supervisor para cima) — são números de desempenho da equipe.
 * O recorte de acesso do próprio supervisor continua valendo — ele só
 * enxerga o movimento dos números e departamentos que já enxerga.
 */

const idOrNone = z.union([z.string().uuid(), z.literal(FILTER_NONE)]);

/**
 * O período mais os dois filtros da barra.
 *
 * Os dois aceitam LISTA (parâmetro repetido ou separado por vírgula), somam
 * dentro de si e cruzam entre si — a regra da casa, montada em
 * `lib/report-slice.ts` para a contagem da célula e a listagem do painel
 * lerem o mesmo recorte. Item que não existe na organização é RECUSADO com
 * 400, nunca ignorado: ignorar devolveria números plausíveis recortados por
 * um critério diferente do que a pessoa marcou.
 */
const querySchema = z.object({
  from: z.string().datetime(),
  to: z.string().datetime(),
  departmentId: listaDe(idOrNone),
  instanceId: listaDe(z.string().uuid()),
});

/** Teto de mensagens lidas por consulta, para o relatório não travar a API. */
const MAX_MESSAGES = 100_000;

export async function reportRoutes(app: FastifyInstance, deps: AppDeps): Promise<void> {
  app.get("/reports/agents", { preHandler: requirePermission(deps, "reports.view") }, async (request) => {
    const query = querySchema.parse(request.query);
    const start = new Date(query.from);
    const end = new Date(query.to);
    const organizationId = request.user.organizationId;

    // A tela poda o item extinto antes de mandar, então um id desconhecido
    // aqui significa link colado à mão ou estado corrompido — e aí o erro é
    // a resposta certa.
    await assertKnownFilterIds(deps.prisma, organizationId, {
      departmentIds: query.departmentId.filter((value) => value !== FILTER_NONE),
      userIds: [],
      tagIds: [],
      instanceIds: query.instanceId,
    });

    const access = await loadConversationAccess(deps.prisma, request.user);
    /**
     * O recorte de TODAS as consultas do relatório, montado uma vez só.
     *
     * Arquivada não conta como trabalho de ninguém, e os filtros da barra
     * entram POR CIMA do escopo de acesso, nunca no lugar dele: pedir um
     * chip que a pessoa não enxerga devolve vazio em vez de vazar. Como
     * `conversationScope` já ocupa o `AND`, os itens novos são
     * ACRESCENTADOS à lista existente — sobrescrevê-la faria o filtro por
     * departamento virar porta de saída do controle de acesso.
     *
     * Um recorte só para todas as consultas é o que mantém a tabela, os
     * quatro cards do topo e o painel lateral contando a MESMA coisa.
     */
    const escopo = conversationScope(access);
    const escopoAnd = Array.isArray(escopo.AND) ? escopo.AND : escopo.AND ? [escopo.AND] : [];
    const scope: Prisma.ConversationWhereInput = {
      ...escopo,
      archivedAt: null,
      AND: [...escopoAnd, ...reportFilterConditions(query)],
    };

    const [users, messages, resolvedEntries, queueEntries, receivedCount] = await Promise.all([
      deps.prisma.user.findMany({
        where: { organizationId },
        orderBy: { name: "asc" },
      }),
      deps.prisma.message.findMany({
        where: {
          organizationId,
          conversation: scope,
          timestamp: { gte: start, lte: end },
        },
        select: {
          conversationId: true,
          direction: true,
          sentByUserId: true,
          timestamp: true,
        },
        orderBy: { timestamp: "asc" },
        take: MAX_MESSAGES,
      }),
      /**
       * Concluídas: quem clicou em concluir, no período.
       *
       * O agrupamento é por (pessoa, CONVERSA), e não só por pessoa, porque
       * a célula abre um painel com as conversas que a formam: contando
       * linhas de histórico, concluir e reabrir a mesma conversa duas vezes
       * daria 2 na célula e 1 no painel. Contando pares distintos, o número
       * é "quantas conversas ela fechou", que é o que a pergunta significa
       * e o que o painel consegue listar.
       */
      deps.prisma.conversationAssignmentHistory.groupBy({
        by: ["performedByUserId", "conversationId"],
        where: {
          organizationId,
          ...resolvedHistoryWhere(start, end),
          conversation: scope,
        },
        _count: { _all: true },
      }),
      /**
       * Fila atual por status — retrato de agora, não do período.
       *
       * `assignedToAll` entra no agrupamento para as três formas de fila
       * saírem de UMA consulta só: a de cada pessoa, a coletiva ("@todos") e
       * a órfã. As duas últimas não cabem em nenhuma linha de atendente — a
       * coletiva é de todo o departamento por decisão e a órfã não é de
       * ninguém —, e distribuí-las entre as pessoas inflaria a fila de todo
       * mundo com a mesma conversa. Por isso elas ganharam LINHA PRÓPRIA na
       * tabela, separadas uma da outra: antes ficavam fora do relatório
       * inteiro, e o buraco era do tamanho da fila sem dono.
       */
      deps.prisma.conversation.groupBy({
        by: ["assignedUserId", "assignedToAll", "status"],
        where: {
          organizationId,
          ...scope,
          status: { not: "resolved" },
        },
        _count: { _all: true },
      }),
      deps.prisma.message.count({
        where: {
          organizationId,
          conversation: scope,
          direction: "inbound",
          timestamp: { gte: start, lte: end },
        },
      }),
    ]);

    const totals = computeAgentTotals(messages as ReportMessage[]);
    // Pares (pessoa, conversa) distintos: cada um é uma conversa concluída.
    const resolvedByUser = new Map<string, number>();
    for (const entry of resolvedEntries) {
      if (!entry.performedByUserId) continue;
      resolvedByUser.set(
        entry.performedByUserId,
        (resolvedByUser.get(entry.performedByUserId) ?? 0) + 1,
      );
    }
    const buckets = bucketQueueEntries(
      queueEntries.map(
        (entry): QueueEntry => ({
          assignedUserId: entry.assignedUserId,
          assignedToAll: entry.assignedToAll,
          status: entry.status,
          count: entry._count._all,
        }),
      ),
    );

    const rows = users
      .map((user) => {
        const agent = totals.get(user.id);
        const queue = buckets.byUser.get(user.id) ?? emptyQueue();
        return {
          user: serializeUser(user),
          messagesSent: agent?.messagesSent ?? 0,
          conversationsHandled: agent?.conversationsHandled ?? 0,
          avgResponseSeconds: agent?.avgResponseSeconds ?? null,
          responsesMeasured: agent?.responsesMeasured ?? 0,
          conversationsResolved: resolvedByUser.get(user.id) ?? 0,
          queue,
          openNow: queueTotal(queue),
        };
      })
      // Quem não teve movimento nem fila no período fica de fora do relatório.
      .filter(
        (row) =>
          row.messagesSent > 0 || row.conversationsResolved > 0 || row.openNow > 0,
      );

    /**
     * As duas linhas que não são de ninguém. Elas não têm mensagens, tempo
     * médio nem concluídas: essas medidas pertencem a uma PESSOA, e um zero
     * ali seria lido como "não trabalhou", quando o certo é "não se aplica".
     * A tela mostra traço.
     */
    const unassigned = { queue: buckets.unassigned, openNow: queueTotal(buckets.unassigned) };
    const allUsers = { queue: buckets.allUsers, openNow: queueTotal(buckets.allUsers) };

    // O total do cabeçalho tem que bater com a soma VISÍVEL da coluna, e as
    // duas linhas sem dono estão visíveis: elas entram na soma.
    const queue = sumQueues([
      ...rows.map((row) => row.queue),
      unassigned.queue,
      allUsers.queue,
    ]);

    return {
      from: start.toISOString(),
      to: end.toISOString(),
      rows,
      unassigned,
      allUsers,
      totals: {
        messagesReceived: receivedCount,
        messagesSent: rows.reduce((sum, row) => sum + row.messagesSent, 0),
        conversationsResolved: rows.reduce((sum, row) => sum + row.conversationsResolved, 0),
        openNow: queueTotal(queue),
        queue,
      },
      // Os filtros como a API os aplicou — a tela confere o que pediu.
      filters: { departmentId: query.departmentId, instanceId: query.instanceId },
      // Avisa quando o período é grande demais e os números ficaram parciais.
      truncated: messages.length >= MAX_MESSAGES,
    };
  });
}

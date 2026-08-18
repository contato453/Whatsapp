import type { Prisma, PrismaClient } from "@azvchat/database";

/**
 * Leitura de conversa POR USUÁRIO.
 *
 * **Por que guardamos "até onde a pessoa leu" e não um contador por pessoa?**
 * Porque contador obrigaria a escrever uma linha por usuário a cada mensagem
 * recebida: num grupo que dez atendentes enxergam, dez escritas por mensagem,
 * o dia inteiro. Com a marca (o instante da última mensagem lida), a escrita
 * acontece só quando alguém lê — e o número de não lidas é DERIVADO na
 * consulta: mensagens recebidas depois da marca.
 *
 * Linha ausente significa "nunca leu". Nada é semeado: conversa que a pessoa
 * nunca abriu aparece com tudo por ler, que é o estado seguro (o contrário
 * sumiria com aviso de verdade).
 *
 * Este arquivo é a fonte única da conta. Nada fora daqui deve montar SQL nem
 * `where` de não lidas por conta própria.
 */

/**
 * Teto da contagem. O badge da lista já mostra "99+" acima de noventa e nove,
 * então parar de contar no centésimo devolve exatamente o mesmo desenho de
 * tela por uma fração do trabalho: numa conversa com 4.000 mensagens não
 * lidas, o banco lê 100 linhas em vez de 4.000.
 */
export const UNREAD_COUNT_CAP = 100;

/** Instante da marca de quem nunca leu — antes de qualquer mensagem. */
const NEVER_READ = "-infinity";

interface UnreadRow {
  conversationId: string;
  unread: bigint | number;
}

/**
 * Não lidas de UM usuário para um conjunto de conversas (a página da lista).
 *
 * Uma consulta só para a página inteira — nunca uma por conversa dentro de
 * laço. Conversa arquivada não conta para ninguém, e some daqui pelo próprio
 * JOIN.
 */
export async function loadUnreadCounts(
  prisma: PrismaClient,
  userId: string,
  conversationIds: string[],
): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  if (conversationIds.length === 0) return counts;

  const marks = await prisma.conversationRead.findMany({
    where: { userId, conversationId: { in: conversationIds } },
    select: { conversationId: true, lastReadAt: true },
  });
  const markByConversation = new Map(marks.map((mark) => [mark.conversationId, mark.lastReadAt]));

  // A página vai como um único parâmetro JSON: um `unnest` de arrays exigiria
  // acertar o tipo de cada array no driver, e a lista de ids cresce até 100.
  const payload = conversationIds.map((conversationId) => ({
    conversation_id: conversationId,
    since: markByConversation.get(conversationId)?.toISOString() ?? null,
  }));

  const rows = await prisma.$queryRaw<UnreadRow[]>`
    SELECT t.conversation_id AS "conversationId",
           (
             SELECT COUNT(*) FROM (
               SELECT 1
                 FROM "messages" m
                WHERE m."conversationId" = t.conversation_id
                  AND m."direction" = 'inbound'
                  AND m."deletedAt" IS NULL
                  AND m."timestamp" > COALESCE(t.since, ${NEVER_READ}::timestamp)
                LIMIT ${UNREAD_COUNT_CAP}
             ) capped
           ) AS unread
      FROM jsonb_to_recordset(${JSON.stringify(payload)}::jsonb)
        AS t(conversation_id text, since timestamp)
      JOIN "conversations" c
        ON c."id" = t.conversation_id
       AND c."archivedAt" IS NULL
  `;

  for (const row of rows) {
    counts.set(row.conversationId, Number(row.unread));
  }
  return counts;
}

/** Não lidas de uma conversa só — usado depois de marcar lida/não lida. */
export async function loadUnreadCount(
  prisma: PrismaClient,
  userId: string,
  conversationId: string,
): Promise<number> {
  const counts = await loadUnreadCounts(prisma, userId, [conversationId]);
  return counts.get(conversationId) ?? 0;
}

/**
 * Avança a marca até a última mensagem da conversa.
 *
 * **A marca nunca RETROCEDE sozinha.** Quem rola para cima e relê mensagens
 * antigas não faz a conversa voltar a ter não lidas — o `lt` do `updateMany`
 * é o que garante isso, e ele também resolve a corrida entre duas abas da
 * mesma pessoa: a que chegar depois com marca mais velha não sobrescreve.
 */
export async function markConversationRead(
  prisma: PrismaClient,
  input: { organizationId: string; conversationId: string; userId: string },
): Promise<void> {
  const last = await prisma.message.findFirst({
    where: { conversationId: input.conversationId, deletedAt: null },
    orderBy: { timestamp: "desc" },
    select: { id: true, timestamp: true },
  });
  // Conversa sem mensagem nenhuma: não há o que marcar, e criar a linha só
  // gastaria escrita — a contagem já é zero por construção.
  if (!last) return;

  const updated = await prisma.conversationRead.updateMany({
    where: {
      userId: input.userId,
      conversationId: input.conversationId,
      lastReadAt: { lt: last.timestamp },
    },
    data: { lastReadAt: last.timestamp, lastReadMessageId: last.id },
  });
  if (updated.count > 0) return;

  try {
    await prisma.conversationRead.create({
      data: {
        organizationId: input.organizationId,
        conversationId: input.conversationId,
        userId: input.userId,
        lastReadAt: last.timestamp,
        lastReadMessageId: last.id,
      },
    });
  } catch (err) {
    // Corrida entre duas abas: a linha nasceu no intervalo entre o
    // `updateMany` e este `create`, e a marca de lá já está igual ou à
    // frente. Qualquer outro erro continua subindo.
    if (!isUniqueViolation(err)) throw err;
  }
}

/**
 * Recua a marca de propósito ("marcar como não lida"), para a pessoa
 * reservar a conversa para depois. Vale só para ela.
 *
 * Recua até um instante ANTES da última mensagem recebida, e não apaga a
 * linha: apagar faria a conversa voltar com todo o histórico por ler — 400
 * não lidas onde a pessoa queria um lembrete.
 */
export async function markConversationUnread(
  prisma: PrismaClient,
  input: { organizationId: string; conversationId: string; userId: string },
): Promise<void> {
  const lastInbound = await prisma.message.findFirst({
    where: { conversationId: input.conversationId, direction: "inbound", deletedAt: null },
    orderBy: { timestamp: "desc" },
    select: { timestamp: true },
  });
  // Sem mensagem recebida não existe "não lida" possível: a conversa só tem
  // o que a própria equipe escreveu.
  if (!lastInbound) return;

  const target = new Date(lastInbound.timestamp.getTime() - 1);
  await prisma.conversationRead.upsert({
    where: {
      userId_conversationId: { userId: input.userId, conversationId: input.conversationId },
    },
    create: {
      organizationId: input.organizationId,
      conversationId: input.conversationId,
      userId: input.userId,
      lastReadAt: target,
      lastReadMessageId: null,
    },
    update: { lastReadAt: target, lastReadMessageId: null },
  });
}

/**
 * Conversas que este usuário já leu até o fim — o complemento do filtro
 * "Não lidas".
 *
 * O filtro é expresso por exclusão porque a comparação "marca da pessoa
 * contra a última mensagem da conversa" cruza duas tabelas, e o Prisma não
 * compara coluna com coluna através de uma relação. Excluir é o lado barato:
 * a lista sai limitada às linhas que a pessoa tem em `conversation_reads`,
 * e quem nunca leu nada não gera exclusão nenhuma.
 */
export async function fullyReadConversationIds(
  prisma: PrismaClient,
  userId: string,
): Promise<string[]> {
  const rows = await prisma.$queryRaw<Array<{ conversationId: string }>>`
    SELECT r."conversationId" AS "conversationId"
      FROM "conversation_reads" r
     WHERE r."userId" = ${userId}
       AND NOT EXISTS (
         SELECT 1
           FROM "messages" m
          WHERE m."conversationId" = r."conversationId"
            AND m."direction" = 'inbound'
            AND m."deletedAt" IS NULL
            AND m."timestamp" > r."lastReadAt"
       )
  `;
  return rows.map((row) => row.conversationId);
}

/**
 * Filtro "Não lidas" da lista, aplicado POR CIMA do escopo de acesso — nunca
 * no lugar dele. Sem mensagem recebida não há não lida, então a primeira
 * condição já descarta a conversa que só tem o que a equipe escreveu.
 */
export function unreadConversationWhere(fullyReadIds: string[]): Prisma.ConversationWhereInput {
  return {
    messages: { some: { direction: "inbound", deletedAt: null } },
    ...(fullyReadIds.length > 0 ? { id: { notIn: fullyReadIds } } : {}),
  };
}

function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: unknown }).code === "P2002"
  );
}

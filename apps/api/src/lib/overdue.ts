import { Prisma, type PrismaClient } from "@azvchat/database";
import type { AttendanceSettings } from "@azvchat/shared";
import {
  computeOverdue,
  selectOverdue,
  type OverdueResult,
  type WaitingConversation,
} from "../modules/dashboard/metrics.js";

/**
 * Quem está atrasado AGORA — a fonte única da resposta, para o dashboard e
 * para a lista de conversas.
 *
 * O card "Atrasados agora" mostra o número e a lista mostra quais são: as
 * duas pontas precisam sair da MESMA conta, senão clicar no card abre uma
 * lista que não fecha com ele — e é exatamente esse tipo de divergência que
 * faz a equipe parar de confiar no painel.
 *
 * A definição, inteira: conversa **não resolvida** cuja **última mensagem é do
 * cliente** e que está esperando há mais que o limite **em tempo de
 * expediente**. Nota interna não é `Message` e não conta como resposta;
 * mensagem apagada e saída ainda `pending` também não.
 *
 * O recorte de acesso NÃO mora aqui: quem chama passa o `where` já escopado
 * por `access.ts` (mais os filtros da tela), e esta função só estreita o
 * conjunto. Ela nunca traz de volta conversa que a pessoa não enxergaria.
 */
export interface OverdueScan extends OverdueResult {
  /** Ids das atrasadas, para a lista filtrar por eles. */
  ids: string[];
}

/** Última mensagem de cada conversa candidata. */
interface LastMessageRow {
  conversationId: string;
  direction: "inbound" | "outbound";
  timestamp: Date;
}

export async function scanOverdueConversations(
  prisma: PrismaClient,
  organizationId: string,
  conversationWhere: Prisma.ConversationWhereInput,
  settings: Pick<AttendanceSettings, "timezone" | "businessHours" | "responseLimitMinutes">,
  now: Date,
): Promise<OverdueScan> {
  /**
   * O corte por tempo de relógio é só uma peneira: tempo de expediente nunca
   * passa do tempo corrido, então nada que ainda não completou o limite no
   * relógio pode estar atrasado. A conta de verdade, em tempo útil, roda
   * depois, só sobre o que sobrou.
   */
  const candidatas = await prisma.conversation.findMany({
    where: {
      organizationId,
      ...conversationWhere,
      status: { not: "resolved" },
      lastMessageAt: {
        not: null,
        lte: new Date(now.getTime() - settings.responseLimitMinutes * 60_000),
      },
    },
    select: { id: true },
  });
  const waiting = await loadWaitingConversations(
    prisma,
    candidatas.map((row) => row.id),
  );
  const atrasadas = selectOverdue(waiting, settings, now);
  return {
    ...computeOverdue(waiting, settings, now),
    ids: atrasadas.map((row) => row.conversationId),
  };
}

/**
 * Direção da última mensagem de cada conversa candidata.
 *
 * SQL cru porque o Prisma não faz "a última linha de cada grupo" — e sem isso
 * seria uma consulta por conversa. Os ids já vêm de uma busca escopada, e esta
 * consulta não amplia o conjunto: só olha as mensagens deles.
 */
async function loadWaitingConversations(
  prisma: PrismaClient,
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

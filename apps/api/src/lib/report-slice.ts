import type { Prisma } from "@azvchat/database";
import { assignedToAllWhere, unassignedConversationWhere } from "./conversation-assignment.js";

/**
 * O recorte de UMA célula do relatório "Atendimentos por atendente".
 *
 * **Por que este arquivo existe.** A célula mostra um número e o painel
 * lateral lista as conversas que formam esse número. Se a contagem e a
 * listagem montarem o critério cada uma por conta própria, elas divergem na
 * primeira mudança de regra — e o relatório passa a dizer "4" e mostrar 3.
 * Número que não bate com a lista é pior do que número nenhum: a equipe
 * perde a confiança na tela inteira, como já aconteceu com os cards do
 * Dashboard. Então o predicado nasce aqui, e os dois lados o importam.
 *
 * O painel não tem rota própria: ele reusa `GET /conversations`, que já
 * aplica `loadConversationAccess` + `conversationScope`. Este recorte entra
 * POR CIMA do escopo de acesso, nunca no lugar dele — quem olha o relatório
 * nunca pode ver pelo painel uma conversa que não veria na Inbox.
 */

/**
 * As três colunas de fila. **São o retrato de AGORA**, não do período: a
 * pergunta que elas respondem é "o que está parado na mão de quem", e um
 * recorte por data devolveria a fila de uma semana atrás. `resolved` fica de
 * fora de propósito — concluída não é fila, e ela tem coluna própria, essa
 * sim medida DENTRO do período (ver `resolvedInPeriodWhere`).
 */
export const REPORT_QUEUE_STATUSES = ["open", "waiting_client", "waiting_internal"] as const;

export type ReportQueueStatus = (typeof REPORT_QUEUE_STATUSES)[number];

/**
 * A quem a linha da tabela pertence. As três formas são disjuntas e cobrem
 * toda conversa não resolvida: ou tem responsável, ou é coletiva ("@todos"),
 * ou está órfã esperando alguém pegar.
 */
export type ReportRowKey =
  | { kind: "user"; userId: string }
  | { kind: "unassigned" }
  | { kind: "all_users" };

/**
 * O predicado da LINHA (sem status, sem período).
 *
 * O formato de `user` é `{ in: [id] }`, e não `id` direto, porque é
 * exatamente o que `assignmentFilterWhere` produz para o token
 * `user:<uuid>` — o filtro que o painel manda para `GET /conversations`.
 * Escrever igual deixa o teste comparar os dois lados por igualdade, em vez
 * de por "parece a mesma coisa".
 *
 * Órfã e coletiva saem das mesmas funções que o resto do sistema usa: "sem
 * responsável" nunca é `assignedUserId: null` na mão.
 */
export function reportRowWhere(row: ReportRowKey): Prisma.ConversationWhereInput {
  if (row.kind === "user") return { assignedUserId: { in: [row.userId] } };
  if (row.kind === "all_users") return assignedToAllWhere();
  return unassignedConversationWhere();
}

/** Uma célula das três colunas de fila: a linha mais o status daquela coluna. */
export function reportQueueCellWhere(
  row: ReportRowKey,
  status: ReportQueueStatus,
): Prisma.ConversationWhereInput {
  return { ...reportRowWhere(row), status: { in: [status] } };
}

/**
 * O critério de "concluída no período", do lado do histórico.
 *
 * Concluída é a única coluna medida por PERÍODO, e é medida pelo evento
 * (`AssignmentAction.resolved`), não pelo status atual: a conversa concluída
 * ontem e reaberta hoje continua sendo trabalho fechado ontem. Por isso o
 * painel dela não filtra por `status`, e o cabeçalho do painel diz as datas.
 */
export function resolvedHistoryWhere(
  from: Date,
  to: Date,
  performedByUserId?: string,
): Prisma.ConversationAssignmentHistoryWhereInput {
  return {
    action: "resolved",
    createdAt: { gte: from, lte: to },
    ...(performedByUserId ? { performedByUserId } : {}),
  };
}

/**
 * O mesmo critério, do lado da conversa — é o que o painel manda para
 * `GET /conversations`. A contagem da célula agrupa o histórico por
 * (pessoa, conversa) e conta pares distintos, então os dois lados descrevem
 * o mesmo conjunto: as conversas com ao menos um "concluída por fulano"
 * dentro das datas.
 */
export function resolvedInPeriodWhere(
  performedByUserId: string,
  from: Date,
  to: Date,
): Prisma.ConversationWhereInput {
  return { assignmentHistory: { some: resolvedHistoryWhere(from, to, performedByUserId) } };
}

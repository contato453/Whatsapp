import type { Prisma } from "@azvchat/database";
import { FILTER_NONE } from "@azvchat/shared";
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

/**
 * Os filtros da BARRA do relatório: departamento e conexão (chip).
 *
 * **OU dentro do filtro, E entre filtros** — a regra da casa. Marcar Contábil
 * e Fiscal mostra os dois; marcar Contábil junto de um chip mostra só o que
 * está nos dois ao mesmo tempo. Lista vazia é "todos", nunca "nenhum".
 *
 * **Aqui departamento CRUZA com o responsável da linha, e é assim de
 * propósito** — o mesmo desenho do Dashboard, e o oposto da Inbox. A célula
 * do relatório é um NÚMERO, e "as conversas do Contábil MAIS as da Ana" não
 * responde pergunta nenhuma (ainda conta duas vezes o trabalho dela dentro do
 * Contábil). Cruzando, "Contábil + Ana" é "os números dela dentro do
 * Contábil", que é o que a supervisão pergunta. Consequência aceita: marcar
 * um departamento em que a pessoa não atende zera a linha dela, e está certo.
 *
 * Estes itens são ACRESCENTADOS ao `AND` que já carrega `conversationScope`,
 * nunca postos no lugar dele: filtro refina o recorte, nunca o amplia.
 */
export interface ReportFilters {
  /** Ids de departamento; `FILTER_NONE` é "sem departamento". */
  departmentId: string[];
  instanceId: string[];
}

export function reportFilterConditions(filters: ReportFilters): Prisma.ConversationWhereInput[] {
  const conditions: Prisma.ConversationWhereInput[] = [];
  if (filters.instanceId.length > 0) {
    conditions.push({ whatsappInstanceId: { in: filters.instanceId } });
  }
  // "Sem departamento" é mais um ramo do mesmo OU, e não a ausência de
  // filtro: a conversa que o número não classificou é um recorte que a
  // supervisão pede junto dos outros, e sem este ramo não haveria como
  // olhar só para ela.
  const ids = filters.departmentId.filter((value) => value !== FILTER_NONE);
  const ramos: Prisma.ConversationWhereInput[] = [
    ...(filters.departmentId.includes(FILTER_NONE) ? [{ departmentId: null }] : []),
    ...(ids.length > 0 ? [{ departmentId: { in: ids } }] : []),
  ];
  if (ramos.length === 1) conditions.push(ramos[0] as Prisma.ConversationWhereInput);
  else if (ramos.length > 1) conditions.push({ OR: ramos });
  return conditions;
}

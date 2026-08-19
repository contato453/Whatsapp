import type { CSSProperties } from "react";
import {
  ALL_USERS_ASSIGNEE_LABEL,
  ASSIGNMENT_ALL_USERS,
  ASSIGNMENT_UNASSIGNED,
  CONVERSATION_STATUS_COLORS,
  CONVERSATION_STATUS_LABELS,
  userAssignmentToken,
  type ConversationStatus,
} from "@azvchat/shared";
import type { ReportSliceQuery } from "./api";

/**
 * Aparência e recorte das células do relatório de atendimentos.
 *
 * Regra pura, fora do componente, por dois motivos: a cor sai inteira de
 * `CONVERSATION_STATUS_COLORS` (`@azvchat/shared`) e não pode ser reescrita
 * na tela, e a tradução da célula para os filtros de `GET /conversations`
 * precisa ser testável sem montar a página.
 */

/**
 * Faixa de preenchimento das células com valor.
 *
 * O tom acompanha o volume relativo DENTRO da coluna, para o olho achar o
 * gargalo sem ler número por número. O teto é baixo de propósito: sobre
 * branco, mesmo o mais forte deixa o texto escuro da tabela bem acima do
 * mínimo de contraste, e uma escala que chega à cor cheia obrigaria a
 * inverter a letra em algumas linhas e não em outras — a tabela viraria um
 * mosaico de dois estilos de texto.
 */
const MIN_ALPHA = 0.12;
const MAX_ALPHA = 0.44;

function rgbOf(hex: string): [number, number, number] {
  const limpo = hex.replace("#", "");
  return [
    parseInt(limpo.slice(0, 2), 16),
    parseInt(limpo.slice(2, 4), 16),
    parseInt(limpo.slice(4, 6), 16),
  ];
}

/**
 * Preenchimento de uma célula de fila.
 *
 * **Zero não recebe cor** — e é decisão, não esquecimento. Colorir o zero
 * pinta a tabela inteira: a maioria das células de uma equipe grande está
 * vazia, e um fundo colorido em cada uma delas some com o sinal que a cor
 * existe para dar. Célula sem cor também não é clicável (não há o que
 * listar), e as duas coisas andam juntas de propósito: o que não tem
 * aparência de clicável não pode responder ao clique, e vice-versa.
 */
export function queueCellStyle(
  value: number,
  columnMax: number,
  status: ConversationStatus,
): CSSProperties | undefined {
  if (value <= 0) return undefined;
  const [r, g, b] = rgbOf(CONVERSATION_STATUS_COLORS[status]);
  // `columnMax` é sempre >= value quando value > 0, mas a divisão fica
  // protegida: coluna com um único valor não pode virar NaN.
  const ratio = columnMax > 0 ? value / columnMax : 1;
  const alpha = MIN_ALPHA + (MAX_ALPHA - MIN_ALPHA) * ratio;
  return { backgroundColor: `rgba(${r}, ${g}, ${b}, ${alpha.toFixed(3)})` };
}

/**
 * Concluídas tem tratamento próprio: contorno e texto na cor, sem
 * preenchimento.
 *
 * **Ela é do PERÍODO; as três colunas de fila são de AGORA.** Pintá-la com
 * o mesmo tipo de preenchimento colocaria as quatro na mesma escala visual,
 * e a pessoa somaria mentalmente coisas que não se somam: "35 abertas" é
 * o que está parado neste instante, "12 concluídas" é o que foi fechado nas
 * datas escolhidas. Formas diferentes avisam que as perguntas são
 * diferentes.
 */
export function resolvedCellStyle(value: number): CSSProperties | undefined {
  if (value <= 0) return undefined;
  return {
    color: CONVERSATION_STATUS_COLORS.resolved,
    borderColor: CONVERSATION_STATUS_COLORS.resolved,
  };
}

/** A quem pertence a linha da tabela. */
export type ReportRowRef =
  | { kind: "user"; userId: string; name: string }
  | { kind: "unassigned" }
  | { kind: "all_users" };

/** O token de atendimento que `GET /conversations` entende para a linha. */
export function rowAssignmentToken(row: ReportRowRef): string {
  if (row.kind === "user") return userAssignmentToken(row.userId);
  if (row.kind === "all_users") return ASSIGNMENT_ALL_USERS;
  return ASSIGNMENT_UNASSIGNED;
}

/** Rótulo da linha, para o cabeçalho do painel e para a tabela. */
export function rowLabel(row: ReportRowRef): string {
  if (row.kind === "user") return row.name;
  if (row.kind === "all_users") return ALL_USERS_ASSIGNEE_LABEL;
  return "Sem responsável";
}

/** O recorte aberto no painel lateral. */
export interface ReportSlice {
  /** Identidade da célula, para destacá-la enquanto o painel está aberto. */
  key: string;
  row: ReportRowRef;
  /** O que o cabeçalho do painel diz depois do nome. */
  columnLabel: string;
  /** A frase que deixa explícito se o recorte é de agora ou do período. */
  scopeNote: string;
  /** O número que a célula mostra — o painel tem que listar exatamente isso. */
  cellValue: number;
  query: ReportSliceQuery;
}

/** Célula de uma das três colunas de fila. */
export function queueSlice(row: ReportRowRef, status: ConversationStatus, value: number): ReportSlice {
  return {
    key: `${rowAssignmentToken(row)}|${status}`,
    row,
    columnLabel: CONVERSATION_STATUS_LABELS[status],
    scopeNote: "situação de agora",
    cellValue: value,
    query: { assignment: rowAssignmentToken(row), status },
  };
}

/**
 * Célula de concluídas. O intervalo entra no recorte porque a coluna mede o
 * evento de conclusão dentro das datas escolhidas — e o painel escreve isso
 * no cabeçalho, senão o número parece "concluídas de sempre".
 */
export function resolvedSlice(
  row: Extract<ReportRowRef, { kind: "user" }>,
  value: number,
  from: string,
  to: string,
): ReportSlice {
  return {
    key: `${rowAssignmentToken(row)}|resolved`,
    row,
    columnLabel: "Concluídas",
    scopeNote: `concluídas entre ${formatDay(from)} e ${formatDay(to)}`,
    cellValue: value,
    query: {
      // Sem token de atendimento de propósito: a coluna conta quem CONCLUIU
      // no período, e a conversa pode ter trocado de responsável desde então.
      resolvedBy: row.userId,
      resolvedFrom: from,
      resolvedTo: to,
    },
  };
}

/** "14/08/2026" a partir do ISO que o relatório devolveu. */
export function formatDay(iso: string): string {
  return new Date(iso).toLocaleDateString("pt-BR");
}

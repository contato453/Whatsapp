import {
  QUALITY_CONFIDENCE_LABELS,
  QUALITY_CRITERIA,
  QUALITY_FAILURE_REASON_LABELS,
  QUALITY_ITEM_STATUS_LABELS,
  QUALITY_OUTCOME_LABELS,
  QUALITY_RUN_STATUS_LABELS,
  QUALITY_SKIP_REASON_LABELS,
  QUALITY_SUBJECT_LABELS,
  type QualityCriterionKey,
  type QualityItemStatus,
  type QualityRunStatus,
} from "@azvchat/shared";

/**
 * Cola de apresentação do Quality: rótulos e cores que as telas do módulo
 * compartilham.
 *
 * Nenhum rótulo é escrito aqui — todos vêm do catálogo do shared, o MESMO que a
 * API valida e que o prompt manda ao modelo. Reescrever um deles faria a tela
 * chamar de "Contábil" o que o banco guardou como outra coisa.
 */

export { QUALITY_CONFIDENCE_LABELS, QUALITY_CRITERIA, QUALITY_OUTCOME_LABELS, QUALITY_SUBJECT_LABELS };

export function criterionLabel(key: QualityCriterionKey): string {
  return QUALITY_CRITERIA.find((criterion) => criterion.key === key)?.label ?? key;
}

export function criterionDescription(key: QualityCriterionKey): string {
  return QUALITY_CRITERIA.find((criterion) => criterion.key === key)?.description ?? "";
}

export function runStatusLabel(status: QualityRunStatus): string {
  return QUALITY_RUN_STATUS_LABELS[status];
}

export function itemStatusLabel(status: QualityItemStatus): string {
  return QUALITY_ITEM_STATUS_LABELS[status];
}

/** Por que a conversa ficou sem avaliação, ou por que falhou, em português. */
export function itemReasonText(item: {
  skipReason: string | null;
  failureReason: string | null;
}): string | null {
  if (item.skipReason && item.skipReason in QUALITY_SKIP_REASON_LABELS) {
    return QUALITY_SKIP_REASON_LABELS[item.skipReason as keyof typeof QUALITY_SKIP_REASON_LABELS];
  }
  if (item.failureReason && item.failureReason in QUALITY_FAILURE_REASON_LABELS) {
    return QUALITY_FAILURE_REASON_LABELS[item.failureReason as keyof typeof QUALITY_FAILURE_REASON_LABELS];
  }
  return null;
}

export function runReasonText(failureReason: string | null): string | null {
  if (!failureReason) return null;
  return failureReason in QUALITY_FAILURE_REASON_LABELS
    ? QUALITY_FAILURE_REASON_LABELS[failureReason as keyof typeof QUALITY_FAILURE_REASON_LABELS]
    : null;
}

/** Tom do selo de estado. Vermelho só em falha: "sem avaliação" não é erro. */
export const RUN_STATUS_TONE: Record<QualityRunStatus, "slate" | "blue" | "green" | "red"> = {
  queued: "slate",
  transcribing: "blue",
  analyzing: "blue",
  completed: "green",
  failed: "red",
};

export const ITEM_STATUS_TONE: Record<QualityItemStatus, "slate" | "blue" | "green" | "red" | "amber"> = {
  queued: "slate",
  transcribing: "blue",
  analyzing: "blue",
  completed: "green",
  skipped: "amber",
  failed: "red",
};

/**
 * Cor da nota. A faixa é a mesma em toda a tela, e por isso mora aqui: nota 7
 * pintada de verde num lugar e de âmbar noutro faria a leitura mudar de sentido
 * conforme a tela.
 */
export function scoreTone(score: number): "green" | "amber" | "red" {
  if (score >= 8) return "green";
  if (score >= 6) return "amber";
  return "red";
}

export function scoreClasses(score: number): string {
  const tone = scoreTone(score);
  if (tone === "green") return "bg-emerald-50 text-emerald-700 ring-emerald-200";
  if (tone === "amber") return "bg-amber-50 text-amber-700 ring-amber-200";
  return "bg-red-50 text-red-700 ring-red-200";
}

/** "8", "8,5" — uma casa só quando existe, e vírgula, que é o separador daqui. */
export function formatScore(score: number): string {
  const rounded = Math.round(score * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1).replace(".", ",");
}

/** "12 min", "1h 20min", "—" — minutos de expediente, como a API os devolve. */
export function formatMinutes(minutes: number | null): string {
  if (minutes == null) return "—";
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest > 0 ? `${hours}h ${rest}min` : `${hours}h`;
}

/** Custo estimado em micro-dólares → texto curto. Nulo é "—", nunca "US$ 0,00". */
export function formatCostMicros(costMicros: number | null): string {
  if (costMicros == null) return "—";
  const dollars = costMicros / 1_000_000;
  if (dollars > 0 && dollars < 0.01) return "menos de US$ 0,01";
  return `US$ ${dollars.toFixed(2).replace(".", ",")}`;
}

export function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" });
}

/** "AAAA-MM" → "set/2026", para o eixo da visão por atendente. */
export function formatMonth(month: string): string {
  const [year, monthNumber] = month.split("-");
  const date = new Date(Number(year), Number(monthNumber) - 1, 1);
  return date.toLocaleDateString("pt-BR", { month: "short", year: "numeric" }).replace(".", "");
}

/** Data de hoje e de N dias atrás no formato dos campos `date`. */
export function dateInputValue(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

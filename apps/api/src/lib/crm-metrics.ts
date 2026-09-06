import {
  crmEffectiveProbability,
  crmFinalValue,
  crmWeightedValue,
} from "@azvchat/shared";

/**
 * Os números do funil.
 *
 * As contas são PURAS e ficam aqui, longe da rota, por dois motivos que já
 * custaram caro no Dashboard: (1) o total da coluna e a soma dos cards têm de
 * fechar por construção, senão a equipe para de confiar no painel; (2) conta
 * dentro de handler não se testa sem subir rota, e a que ninguém testa é a que
 * passa a mentir depois de um filtro novo.
 *
 * Por que a agregação não é feita no banco: valor final e valor ponderado
 * dependem de desconto e de probabilidade que pode vir da oportunidade OU da
 * etapa. Em SQL isso viraria um CASE por coluna que precisaria ser mantido em
 * sincronia com `crmFinalValue`/`crmWeightedValue` do shared — a mesma conta
 * escrita duas vezes, que é exatamente o que este arquivo evita. O custo é
 * ler as linhas ABERTAS do funil (algumas centenas na prática, com um `select`
 * de cinco colunas), e o índice do Kanban já cobre essa leitura.
 */

/** O mínimo que uma oportunidade precisa entregar para entrar nas contas. */
export interface CrmMetricRow {
  stageId: string;
  value: number;
  discount: number | null;
  /** Ajuste manual; nulo = vale a da etapa. */
  probability: number | null;
  /** Probabilidade da etapa em que ela está. */
  stageProbability: number;
  assignedUserId?: string | null;
  origin?: string | null;
  status?: "open" | "won" | "lost";
  closedValue?: number | null;
  createdAt?: Date;
  closedAt?: Date | null;
  stageEnteredAt?: Date;
}

export interface CrmTotals {
  count: number;
  /** Soma dos valores finais (estimado menos desconto). */
  value: number;
  /** Soma de valor final × probabilidade. */
  weightedValue: number;
}

export function emptyTotals(): CrmTotals {
  return { count: 0, value: 0, weightedValue: 0 };
}

function addRow(totals: CrmTotals, row: CrmMetricRow): void {
  const finalValue = crmFinalValue(row.value, row.discount);
  const probability = crmEffectiveProbability(row.probability, row.stageProbability);
  totals.count += 1;
  totals.value = round2(totals.value + finalValue);
  totals.weightedValue = round2(totals.weightedValue + crmWeightedValue(finalValue, probability));
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/** Totais por etapa — é o cabeçalho de cada coluna do Kanban. */
export function totalsByStage(rows: CrmMetricRow[]): Map<string, CrmTotals> {
  const map = new Map<string, CrmTotals>();
  for (const row of rows) {
    const current = map.get(row.stageId) ?? emptyTotals();
    addRow(current, row);
    map.set(row.stageId, current);
  }
  return map;
}

/** Total do funil inteiro — o cartão acima do quadro. */
export function totalsOverall(rows: CrmMetricRow[]): CrmTotals {
  const totals = emptyTotals();
  for (const row of rows) addRow(totals, row);
  return totals;
}

/**
 * Indicadores do período. `abertas` são as que estão em jogo AGORA (o pipeline
 * não tem período: ou a oportunidade está aberta ou não está), e `fechadas` são
 * as ganhas e perdidas DENTRO do intervalo — a mesma divisão que o Dashboard
 * faz entre "estado de agora" e "atividade do período".
 */
export interface CrmPeriodSummary {
  /** Oportunidades em aberto agora, com valor e ponderado. */
  pipeline: CrmTotals;
  /** Criadas no período — o "novos leads". */
  created: number;
  won: number;
  lost: number;
  /** Receita das ganhas: o valor FECHADO quando existe, senão o final. */
  wonValue: number;
  lostValue: number;
  /** Ganhas ÷ (ganhas + perdidas). Sem fechamento nenhum, zero. */
  conversionRate: number;
  /** Receita ganha ÷ quantidade ganha. */
  averageTicket: number;
  /** Dias entre criar e fechar, média das ganhas do período. */
  averageDaysToClose: number;
}

export interface ClosedRow {
  status: "won" | "lost";
  value: number;
  discount: number | null;
  closedValue: number | null;
  createdAt: Date;
  closedAt: Date | null;
}

/**
 * O valor que a oportunidade ganha REPRESENTA.
 *
 * O fechado vence o estimado quando existe: um é o que se previu, o outro é o
 * que aconteceu, e somar o previsto num relatório de receita seria contar
 * dinheiro que ninguém viu. Sem valor fechado registrado, o estimado é a
 * melhor informação disponível — descartar a linha faria a receita do mês
 * sumir por causa de um campo em branco.
 */
export function realizedValue(row: Pick<ClosedRow, "value" | "discount" | "closedValue">): number {
  return row.closedValue ?? crmFinalValue(row.value, row.discount);
}

export function summarizePeriod(input: {
  openRows: CrmMetricRow[];
  closedRows: ClosedRow[];
  createdCount: number;
}): CrmPeriodSummary {
  const pipeline = totalsOverall(input.openRows);
  const ganhas = input.closedRows.filter((row) => row.status === "won");
  const perdidas = input.closedRows.filter((row) => row.status === "lost");

  const wonValue = round2(ganhas.reduce((soma, row) => soma + realizedValue(row), 0));
  const lostValue = round2(perdidas.reduce((soma, row) => soma + realizedValue(row), 0));
  const fechadas = ganhas.length + perdidas.length;

  const diasParaFechar = ganhas
    .filter((row) => row.closedAt)
    .map((row) => (row.closedAt as Date).getTime() - row.createdAt.getTime())
    .filter((ms) => ms >= 0);

  return {
    pipeline,
    created: input.createdCount,
    won: ganhas.length,
    lost: perdidas.length,
    wonValue,
    lostValue,
    // Sem nenhum fechamento a taxa é ZERO, e não "100%": dividir por zero e
    // arredondar para cima faria o relatório do mês vazio parecer o melhor mês
    // da história.
    conversionRate: fechadas === 0 ? 0 : Math.round((ganhas.length / fechadas) * 1000) / 10,
    averageTicket: ganhas.length === 0 ? 0 : round2(wonValue / ganhas.length),
    averageDaysToClose:
      diasParaFechar.length === 0
        ? 0
        : Math.round(
            (diasParaFechar.reduce((soma, ms) => soma + ms, 0) /
              diasParaFechar.length /
              86_400_000) *
              10,
          ) / 10,
  };
}

/** Uma linha do relatório por responsável (ou por origem — mesma forma). */
export interface CrmBreakdownRow {
  key: string;
  label: string;
  open: number;
  pipelineValue: number;
  won: number;
  lost: number;
  wonValue: number;
  conversionRate: number;
}

export function breakdown(
  openRows: Array<CrmMetricRow & { groupKey: string }>,
  closedRows: Array<ClosedRow & { groupKey: string }>,
  labelOf: (key: string) => string,
): CrmBreakdownRow[] {
  const chaves = new Set<string>([
    ...openRows.map((row) => row.groupKey),
    ...closedRows.map((row) => row.groupKey),
  ]);

  const linhas: CrmBreakdownRow[] = [];
  for (const key of chaves) {
    const abertas = openRows.filter((row) => row.groupKey === key);
    const fechadas = closedRows.filter((row) => row.groupKey === key);
    const ganhas = fechadas.filter((row) => row.status === "won");
    const perdidas = fechadas.filter((row) => row.status === "lost");
    const totalFechadas = ganhas.length + perdidas.length;
    linhas.push({
      key,
      label: labelOf(key),
      open: abertas.length,
      pipelineValue: totalsOverall(abertas).value,
      won: ganhas.length,
      lost: perdidas.length,
      wonValue: round2(ganhas.reduce((soma, row) => soma + realizedValue(row), 0)),
      conversionRate:
        totalFechadas === 0 ? 0 : Math.round((ganhas.length / totalFechadas) * 1000) / 10,
    });
  }
  // Maior pipeline primeiro: a pergunta da supervisão é "quem está segurando
  // mais dinheiro", não a ordem alfabética.
  return linhas.sort((a, b) => b.pipelineValue - a.pipelineValue || b.won - a.won);
}

/** Média de dias parados na etapa — o indicador de coluna travada. */
export function averageDaysInStage(rows: CrmMetricRow[], now: Date = new Date()): number {
  const dias = rows
    .filter((row) => row.stageEnteredAt)
    .map((row) => (now.getTime() - (row.stageEnteredAt as Date).getTime()) / 86_400_000)
    .filter((valor) => valor >= 0);
  if (dias.length === 0) return 0;
  return Math.round((dias.reduce((soma, valor) => soma + valor, 0) / dias.length) * 10) / 10;
}

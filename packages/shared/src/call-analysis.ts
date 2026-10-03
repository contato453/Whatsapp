/**
 * ANÁLISE DA GRAVAÇÃO DE UMA LIGAÇÃO PELA IA — transcrever e resumir.
 *
 * É a etapa 1 do recurso: o botão na tela de Ligações que transforma a
 * gravação em TEXTO (transcrição) e em RESUMO (assunto, o que o cliente pediu,
 * o que ficou combinado, próximos passos e os dados citados). Avaliar o
 * atendente pela ligação é outra etapa, de propósito: a gravação mistura as
 * duas vozes num canal só, e atribuir frase à pessoa errada distorce uma nota,
 * mas quase não atrapalha um resumo.
 *
 * Mora no shared porque a API valida a resposta do modelo com estes nomes e a
 * tela os rotula — divergindo, a tela mostraria um bloco vazio sem erro nenhum.
 */

export const CALL_ANALYSIS_LIMITS = {
  /**
   * Noventa minutos. Acima disso não é ligação de atendimento, é reunião, e o
   * custo de um clique deixaria de ser previsível. A gravação continua lá para
   * ouvir e baixar.
   */
  maxSeconds: 90 * 60,
  /**
   * A gravação é cortada em pedaços de dez minutos antes de ir ao provedor: a
   * API de transcrição tem teto de tamanho e de duração por arquivo, e um
   * pedaço que falha custa só ele na retentativa.
   */
  chunkSeconds: 10 * 60,
  /**
   * Teto do texto guardado. Noventa minutos de conversa falada rendem perto
   * disto; o corte protege a tabela e o contexto do resumo.
   */
  transcriptMaxChars: 120_000,
  /** Quantos itens cada lista do resumo aceita — resumo, não ata. */
  maxListItems: 12,
} as const;

/** O resumo, como o modelo devolve e a tela desenha. */
export interface CallSummary {
  /** Uma linha: do que a ligação tratou. */
  subject: string;
  /** Dois a cinco períodos, em português. */
  summary: string;
  clientRequests: string[];
  agreements: string[];
  nextSteps: string[];
  /**
   * CNPJ, valores, datas e nomes citados NA FALA. Vêm separados porque são o
   * que a transcrição mais erra (número ditado com a ligação picotando) e o que
   * a equipe precisa conferir antes de usar.
   */
  mentionedData: string[];
  /** Ressalva da própria IA sobre a gravação (trechos inaudíveis, corte...). */
  caveat: string | null;
}

export const CALL_SUMMARY_SECTION_LABELS = {
  clientRequests: "O que o cliente pediu",
  agreements: "O que ficou combinado",
  nextSteps: "Próximos passos",
  mentionedData: "Dados citados (conferir)",
} as const satisfies Record<Exclude<keyof CallSummary, "subject" | "summary" | "caveat">, string>;

export interface CallAnalysisDto {
  callId: string;
  /** Nulo = ainda não transcrita. String vazia = transcrita, sem fala reconhecida. */
  transcript: string | null;
  /** O texto passou do teto e foi cortado no fim. */
  transcriptTruncated: boolean;
  transcribedAt: string | null;
  /** Nulo = ainda sem resumo (ou gravação sem fala). */
  summary: CallSummary | null;
  summarizedAt: string | null;
  model: string | null;
  requestedByName: string | null;
}

function cleanString(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed.slice(0, max) : null;
}

function cleanList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => cleanString(entry, 500))
    .filter((entry): entry is string => entry !== null)
    .slice(0, CALL_ANALYSIS_LIMITS.maxListItems);
}

/**
 * Lê o resumo gravado (ou o que o modelo devolveu), tolerante: lista ausente
 * vira lista vazia, ressalva ausente vira nulo. Sem assunto E sem resumo não
 * há resumo nenhum — devolver um objeto vazio faria a tela mostrar uma análise
 * que não diz nada como se estivesse pronta.
 */
export function parseCallSummary(raw: unknown): CallSummary | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  const subject = cleanString(value.subject, 200);
  const summary = cleanString(value.summary, 2000);
  if (!subject && !summary) return null;
  return {
    subject: subject ?? "Ligação",
    summary: summary ?? "",
    clientRequests: cleanList(value.clientRequests),
    agreements: cleanList(value.agreements),
    nextSteps: cleanList(value.nextSteps),
    mentionedData: cleanList(value.mentionedData),
    caveat: cleanString(value.caveat, 500),
  };
}

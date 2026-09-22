import {
  QUALITY_CONFIDENCE_LEVELS,
  QUALITY_CRITERIA_KEYS,
  QUALITY_SUBJECTS,
  type QualityActionPlanDto,
  type QualityConfidence,
  type QualityCriterionScoreDto,
  type QualitySubject,
} from "@azvchat/shared";
import { z } from "zod";

/**
 * A RESPOSTA DA IA É VALIDADA AO CHEGAR, e resposta fora do formato é
 * DESCARTADA — a análise fica como falha e nada inválido é gravado.
 *
 * O motivo é o de sempre nesta casa: dado meio gravado é pior que dado nenhum.
 * Uma nota sem os cinco critérios, um assunto em texto livre ou um plano de ação
 * vazio entrariam no banco calados e o painel por atendente passaria a somar
 * coisas diferentes entre si. Aqui o catálogo do shared é a régua: assunto,
 * critério e confiança só passam se estiverem nele.
 */

const scoreSchema = z
  .number()
  .min(0)
  .max(10)
  // Meio ponto é aceito; o resto é arredondado para uma casa, porque nota com
  // três decimais dá falsa precisão a um julgamento subjetivo.
  .transform((value) => Math.round(value * 10) / 10);

const criterionSchema = z.object({
  key: z.enum(QUALITY_CRITERIA_KEYS),
  score: scoreSchema,
  justification: z.string().trim().min(1).max(600),
  messageIds: z.array(z.string().trim().min(1)).max(20).default([]),
});

export const qualityAiResponseSchema = z.object({
  overallScore: scoreSchema,
  criteria: z.array(criterionSchema).min(1).max(20),
  subject: z.enum(QUALITY_SUBJECTS),
  actionPlan: z.object({
    improvements: z
      .array(
        z.object({
          point: z.string().trim().min(1).max(400),
          action: z.string().trim().min(1).max(400),
        }),
      )
      .max(10)
      .default([]),
    strengths: z.array(z.string().trim().min(1).max(400)).max(10).default([]),
  }),
  confidence: z.enum(QUALITY_CONFIDENCE_LEVELS),
});

export type QualityAiResponse = z.infer<typeof qualityAiResponseSchema>;

export interface ParsedQualityEvaluation {
  overallScore: number;
  criteria: QualityCriterionScoreDto[];
  subject: QualitySubject;
  actionPlan: QualityActionPlanDto;
  confidence: QualityConfidence;
}

/**
 * Lê o JSON do modelo.
 *
 * O modelo às vezes embrulha o objeto em cerca de código, mesmo mandado não
 * fazê-lo. Tirar a cerca é tolerância de FORMA, não de conteúdo: o objeto de
 * dentro ainda passa inteiro pelo Zod. Nada além disso é perdoado — texto solto
 * antes do JSON, chave faltando ou critério fora do catálogo é descarte.
 */
export function parseQualityAiResponse(
  raw: string | null,
  references: Map<string, string>,
): ParsedQualityEvaluation | null {
  if (!raw) return null;
  const cleaned = stripCodeFence(raw.trim());
  let value: unknown;
  try {
    value = JSON.parse(cleaned);
  } catch {
    return null;
  }
  const parsed = qualityAiResponseSchema.safeParse(value);
  if (!parsed.success) return null;

  // Os cinco critérios, todos: nota por critério incompleta faria a média do
  // painel comparar linhas com denominadores diferentes.
  const byKey = new Map(parsed.data.criteria.map((criterion) => [criterion.key, criterion]));
  if (QUALITY_CRITERIA_KEYS.some((key) => !byKey.has(key))) return null;

  const criteria: QualityCriterionScoreDto[] = QUALITY_CRITERIA_KEYS.map((key) => {
    const criterion = byKey.get(key);
    if (!criterion) throw new Error("critério ausente após a conferência");
    return {
      key,
      score: criterion.score,
      justification: criterion.justification,
      // A citação volta do apelido (M3) para o id real da mensagem. Apelido que
      // não existe no material é DESCARTADO em silêncio: é alucinação de
      // referência, e um link para mensagem inexistente é pior que link nenhum.
      messageIds: criterion.messageIds
        .map((ref) => references.get(ref))
        .filter((id): id is string => typeof id === "string"),
    };
  });

  return {
    overallScore: parsed.data.overallScore,
    criteria,
    subject: parsed.data.subject,
    actionPlan: parsed.data.actionPlan,
    confidence: parsed.data.confidence,
  };
}

function stripCodeFence(text: string): string {
  if (!text.startsWith("```")) return text;
  const withoutOpen = text.replace(/^```[a-zA-Z]*\s*/, "");
  return withoutOpen.replace(/```\s*$/, "").trim();
}

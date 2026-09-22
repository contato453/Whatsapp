/**
 * QUALITY — avaliação do atendimento pela IA, exclusiva do administrador.
 *
 * Este arquivo é o catálogo fechado do módulo: os critérios de nota, os
 * assuntos possíveis, os níveis de confiança, os estados de execução e os
 * motivos de recusa. Ele existe no shared porque as três pontas precisam
 * concordar palavra por palavra:
 *   - o PROMPT da avaliação, que lista ao modelo o que ele pode devolver;
 *   - o ZOD da API, que recusa resposta fora do catálogo;
 *   - a TELA, que desenha rótulo e explicação sem inventar texto próprio.
 *
 * Assunto em texto livre foi descartado de propósito: "fiscal", "Fiscal" e
 * "questão fiscal" viram três grupos no relatório, e o painel por atendente
 * deixa de responder qual assunto mais aparece — o mesmo motivo pelo qual o
 * motivo de perda do CRM é tabela, e não campo de texto.
 */

// ---------------------------------------------------------------------------
// Critérios da nota
// ---------------------------------------------------------------------------

export const QUALITY_CRITERIA_KEYS = [
  "cordiality",
  "clarity",
  "technical",
  "resolution",
  "agility",
] as const;

export type QualityCriterionKey = (typeof QUALITY_CRITERIA_KEYS)[number];

export interface QualityCriterionInfo {
  key: QualityCriterionKey;
  label: string;
  /** O que a IA deve julgar; vai para o prompt e para o tooltip da tela. */
  description: string;
}

export const QUALITY_CRITERIA: readonly QualityCriterionInfo[] = [
  {
    key: "cordiality",
    label: "Cordialidade e linguagem",
    description:
      "Tratamento respeitoso, tom adequado ao cliente, português correto e ausência de secura ou impaciência.",
  },
  {
    key: "clarity",
    label: "Clareza da orientação",
    description:
      "A orientação foi compreensível para quem não é da área, sem jargão solto e sem deixar o cliente adivinhando o próximo passo.",
  },
  {
    key: "technical",
    // O rótulo diz "aparente" na TELA também: a IA não certifica que a
    // orientação está tecnicamente correta, e prometer isso seria pior do que
    // não ter o critério.
    label: "Precisão técnica aparente",
    description:
      "A orientação PARECE consistente e bem comunicada. Isto não certifica que ela está tecnicamente correta: julgue só a aparência de consistência do que foi dito.",
  },
  {
    key: "resolution",
    label: "Resolução do que o cliente pediu",
    description:
      "O que o cliente pediu foi atendido, encaminhado com destino claro ou explicitamente recusado com motivo.",
  },
  {
    key: "agility",
    label: "Agilidade percebida",
    description:
      "Ritmo do atendimento do ponto de vista do cliente, considerando as métricas objetivas informadas no material.",
  },
] as const;

export const QUALITY_CRITERION_LABELS: Record<QualityCriterionKey, string> = QUALITY_CRITERIA.reduce(
  (acc, criterion) => {
    acc[criterion.key] = criterion.label;
    return acc;
  },
  {} as Record<QualityCriterionKey, string>,
);

export function isQualityCriterionKey(value: unknown): value is QualityCriterionKey {
  return typeof value === "string" && QUALITY_CRITERIA_KEYS.some((key) => key === value);
}

// ---------------------------------------------------------------------------
// Assunto da conversa
// ---------------------------------------------------------------------------

export const QUALITY_SUBJECTS = [
  "fiscal",
  "accounting",
  "payroll",
  "corporate",
  "financial",
  "digital_certificate",
  "registration",
  "other",
] as const;

export type QualitySubject = (typeof QUALITY_SUBJECTS)[number];

export const QUALITY_SUBJECT_LABELS: Record<QualitySubject, string> = {
  fiscal: "Fiscal",
  accounting: "Contábil",
  payroll: "Departamento pessoal",
  corporate: "Societário",
  financial: "Financeiro e cobrança",
  digital_certificate: "Certificado digital",
  registration: "Cadastral",
  other: "Outro",
};

/** O que cabe em cada assunto — vai para o prompt, para o modelo não chutar. */
export const QUALITY_SUBJECT_HINTS: Record<QualitySubject, string> = {
  fiscal: "notas, impostos, apuração, Simples Nacional, obrigações acessórias fiscais",
  accounting: "balancetes, lançamentos, escrituração contábil, demonstrativos",
  payroll: "folha, admissão, rescisão, férias, eSocial, ponto",
  corporate: "abertura, alteração e baixa de empresa, contrato social, sócios",
  financial: "honorários, boletos, pagamentos ao escritório, cobrança",
  digital_certificate: "emissão, renovação e uso de certificado digital, procuração eletrônica",
  registration: "dados cadastrais, endereço, contato, atualização de informações",
  other: "qualquer coisa que não caiba nos demais",
};

export function isQualitySubject(value: unknown): value is QualitySubject {
  return typeof value === "string" && QUALITY_SUBJECTS.some((subject) => subject === value);
}

// ---------------------------------------------------------------------------
// Confiança da própria análise
// ---------------------------------------------------------------------------

export const QUALITY_CONFIDENCE_LEVELS = ["low", "medium", "high"] as const;
export type QualityConfidence = (typeof QUALITY_CONFIDENCE_LEVELS)[number];

export const QUALITY_CONFIDENCE_LABELS: Record<QualityConfidence, string> = {
  low: "Baixa",
  medium: "Média",
  high: "Alta",
};

// ---------------------------------------------------------------------------
// Estados de execução
// ---------------------------------------------------------------------------

export const QUALITY_RUN_STATUSES = ["queued", "transcribing", "analyzing", "completed", "failed"] as const;
export type QualityRunStatus = (typeof QUALITY_RUN_STATUSES)[number];

export const QUALITY_RUN_STATUS_LABELS: Record<QualityRunStatus, string> = {
  queued: "Na fila",
  transcribing: "Transcrevendo",
  analyzing: "Analisando",
  completed: "Concluída",
  failed: "Falhou",
};

export const QUALITY_ITEM_STATUSES = [
  "queued",
  "transcribing",
  "analyzing",
  "completed",
  "skipped",
  "failed",
] as const;
export type QualityItemStatus = (typeof QUALITY_ITEM_STATUSES)[number];

export const QUALITY_ITEM_STATUS_LABELS: Record<QualityItemStatus, string> = {
  queued: "Na fila",
  transcribing: "Transcrevendo",
  analyzing: "Analisando",
  completed: "Concluída",
  skipped: "Sem avaliação",
  failed: "Falhou",
};

/**
 * Por que uma conversa ficou sem avaliação. Código, e não frase: o banco guarda
 * a razão e a TELA a traduz — a mesma divisão de `status`/`statusLabel` do
 * Azevedo-OS, e o que permite mudar o texto sem migration.
 */
export const QUALITY_SKIP_REASONS = [
  "no_messages",
  "no_agent_messages",
  "no_readable_content",
] as const;
export type QualitySkipReason = (typeof QUALITY_SKIP_REASONS)[number];

export const QUALITY_SKIP_REASON_LABELS: Record<QualitySkipReason, string> = {
  no_messages: "Nenhuma mensagem no período escolhido.",
  no_agent_messages:
    "Nenhum atendente enviou mensagem nesta conversa dentro do período, então não há atuação a avaliar.",
  no_readable_content:
    "A conversa só tem áudio e nenhum deles pôde ser transcrito, então não sobrou conteúdo legível para avaliar.",
};

/** Por que a análise de uma conversa falhou. Também código, também traduzido na tela. */
export const QUALITY_FAILURE_REASONS = [
  "ai_not_configured",
  "ai_unavailable",
  "invalid_response",
  "budget_blocked",
  "unexpected",
] as const;
export type QualityFailureReason = (typeof QUALITY_FAILURE_REASONS)[number];

export const QUALITY_FAILURE_REASON_LABELS: Record<QualityFailureReason, string> = {
  ai_not_configured: "A inteligência artificial não está configurada nesta organização.",
  ai_unavailable: "A inteligência artificial não respondeu. Tente disparar de novo mais tarde.",
  invalid_response:
    "A inteligência artificial devolveu uma resposta fora do formato esperado, e nada foi gravado.",
  budget_blocked: "O orçamento mensal de IA foi atingido e a política em vigor bloqueia novas chamadas.",
  unexpected: "Erro inesperado durante a análise.",
};

// ---------------------------------------------------------------------------
// Desfecho da conversa (métrica objetiva, medida pelo sistema)
// ---------------------------------------------------------------------------

export const QUALITY_OUTCOMES = ["resolved", "reopened", "unanswered", "ongoing"] as const;
export type QualityOutcome = (typeof QUALITY_OUTCOMES)[number];

export const QUALITY_OUTCOME_LABELS: Record<QualityOutcome, string> = {
  resolved: "Concluída no período",
  reopened: "Reaberta depois de concluída",
  unanswered: "Ficou sem resposta do atendimento",
  ongoing: "Seguia em atendimento",
};

// ---------------------------------------------------------------------------
// Tetos padrão
// ---------------------------------------------------------------------------

/**
 * Valores iniciais dos tetos. Eles semeiam a linha de configuração e servem de
 * fallback enquanto ela não existe — o que vale em runtime é sempre o banco,
 * mesma regra dos parâmetros de atendimento.
 */
export const QUALITY_DEFAULT_SETTINGS = {
  /** Conversas por disparo. Controla custo: acima disso o disparo é recusado. */
  maxConversationsPerRun: 20,
  /** Áudio acima disso entra como marcador com a duração, e pesa na cobertura. */
  maxAudioSeconds: 600,
  /** Abaixo disso a avaliação sai marcada como PARCIAL. */
  minCoveragePercent: 60,
} as const;

export const QUALITY_SETTINGS_LIMITS = {
  maxConversationsPerRun: { min: 1, max: 100 },
  maxAudioSeconds: { min: 60, max: 3600 },
  minCoveragePercent: { min: 0, max: 100 },
} as const;

/** Teto do material que vai para a AVALIAÇÃO, em caracteres. Ver `quality/material.ts`. */
export const QUALITY_MATERIAL_MAX_CHARS = 60_000;

// ---------------------------------------------------------------------------
// Papéis no material avaliado
// ---------------------------------------------------------------------------

/**
 * Como cada pessoa aparece no material que sai para a IA. NUNCA pelo nome:
 * nome de atendente e de cliente são dado pessoal que a avaliação não precisa,
 * e o nome do avaliado ainda enviesaria o julgamento do modelo.
 */
export const QUALITY_SPEAKER_LABELS = {
  evaluatedAgent: "Atendente avaliado",
  otherAgent: "Outro atendente",
  client: "Cliente",
  system: "Sistema",
} as const;

// ---------------------------------------------------------------------------
// DTOs
// ---------------------------------------------------------------------------

export interface QualitySettingsDto {
  maxConversationsPerRun: number;
  maxAudioSeconds: number;
  minCoveragePercent: number;
  /** Nulo = usa o modelo padrão do provedor configurado. */
  model: string | null;
  updatedAt: string | null;
}

/** O módulo está disponível? Sem IA configurada ele fica desligado e o menu some. */
export interface QualityAvailabilityDto {
  enabled: boolean;
  /** Motivo em português quando desligado; nulo quando ligado. */
  reason: string | null;
}

export interface QualityCriterionScoreDto {
  key: QualityCriterionKey;
  score: number;
  justification: string;
  /** Ids das mensagens que sustentam o julgamento, para o admin conferir. */
  messageIds: string[];
}

export interface QualityImprovementDto {
  point: string;
  action: string;
}

export interface QualityActionPlanDto {
  improvements: QualityImprovementDto[];
  strengths: string[];
}

export interface QualityMetricsDto {
  firstResponseMinutes: number | null;
  avgResponseMinutes: number | null;
  responsesMeasured: number;
  limitBreaches: number;
  messagesSent: number;
  outcome: QualityOutcome;
}

export interface QualityEvaluationDto {
  id: string;
  runId: string;
  itemId: string;
  conversationId: string;
  conversationTitle: string | null;
  userId: string | null;
  userName: string;
  overallScore: number;
  criteria: QualityCriterionScoreDto[];
  subject: QualitySubject;
  actionPlan: QualityActionPlanDto;
  confidence: QualityConfidence;
  coveragePercent: number;
  partial: boolean;
  metrics: QualityMetricsDto;
  discardedAt: string | null;
  adminComment: string | null;
  createdAt: string;
}

/** Um áudio do período, com o que se conseguiu (ou não) transcrever. */
export interface QualityTranscriptDto {
  messageId: string;
  at: string;
  direction: "inbound" | "outbound";
  durationSeconds: number | null;
  status: string;
  /** Texto ÍNTEGRO, sem máscara: é conteúdo da conversa que o admin já pode ver. */
  text: string | null;
}

export interface QualityRunItemDto {
  id: string;
  conversationId: string;
  conversationTitle: string | null;
  status: QualityItemStatus;
  skipReason: QualitySkipReason | null;
  failureReason: QualityFailureReason | null;
  coveragePercent: number | null;
  partial: boolean;
  truncated: boolean;
  messageCount: number;
  audioCount: number;
  audioTranscribedCount: number;
  promptChars: number;
  model: string | null;
  costMicros: number | null;
  evaluations: QualityEvaluationDto[];
}

export interface QualityRunDto {
  id: string;
  status: QualityRunStatus;
  periodFrom: string;
  periodTo: string;
  requestedByName: string;
  model: string;
  conversationCount: number;
  failureReason: QualityFailureReason | null;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
}

export interface QualityRunDetailDto extends QualityRunDto {
  items: QualityRunItemDto[];
}

/** Uma linha da visão por atendente. */
export interface QualityAgentSummaryDto {
  userId: string | null;
  userName: string;
  evaluations: number;
  averageScore: number;
  averageByCriterion: Array<{ key: QualityCriterionKey; score: number }>;
  /** Média por mês civil, do mais antigo para o mais novo ("AAAA-MM"). */
  timeline: Array<{ month: string; score: number; evaluations: number }>;
  subjects: Array<{ subject: QualitySubject; total: number }>;
  /** Pontos a melhorar que mais se repetem nos planos de ação. */
  recurringImprovements: Array<{ point: string; total: number }>;
}

/** Estado de um disparo, em tempo real (evento `quality:run`). */
export interface QualityRunPayload {
  run: QualityRunDto;
}

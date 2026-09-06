/**
 * Inteligência artificial — a fonte única do domínio.
 *
 * Tudo o que a API valida, a tela desenha e o motor de atendimento por IA
 * executa sai daqui: provedores, estados, a CONFIGURAÇÃO ESTRUTURADA do
 * agente (campos, e não um prompt solto), as capacidades que viram
 * ferramentas, os gatilhos de transferência, a tabela de preços por modelo e
 * os DTOs. Duplicar qualquer um desses no frontend ou na API é bug — é a
 * mesma regra do resto do `@azvchat/shared`.
 *
 * O desenho tem duas peças separadas de propósito, e a separação é a
 * decisão mais importante aqui:
 *
 *   - o AGENTE (`AiAgent`) é a configuração reutilizável — objetivo, limites,
 *     conhecimento, permissões. Configura-se "IA Comercial" UMA vez;
 *   - a AUTOMAÇÃO (`AiAutomation`) é o gatilho que põe o agente para atender:
 *     "conversa individual que chega neste número, sem responsável, vai para
 *     a IA Comercial". A mesma IA serve a várias automações sem ser
 *     "treinada" de novo em cada uma.
 *
 * Este repositório NÃO tem construtor visual de fluxos, CRM nem follow-up
 * como módulos próprios (ver CLAUDE.md §19). A automação é o "bloco de IA"
 * possível hoje; as ações da IA reutilizam o que existe — etiquetas, notas
 * internas, status do atendimento, mensagem agendada (o follow-up da casa),
 * atribuição e transferência de departamento.
 */

import type { ConversationStatus, ConversationType } from "./enums.js";

// ---------------------------------------------------------------------------
// Provedores
// ---------------------------------------------------------------------------

export const AI_PROVIDERS = ["openai"] as const;
export type AiProviderKind = (typeof AI_PROVIDERS)[number];

export const AI_PROVIDER_LABELS: Record<AiProviderKind, string> = {
  openai: "OpenAI",
};

export function isAiProviderKind(value: string): value is AiProviderKind {
  return (AI_PROVIDERS as readonly string[]).includes(value);
}

export const AI_PROVIDER_STATUSES = ["not_connected", "connected", "error"] as const;
export type AiProviderStatus = (typeof AI_PROVIDER_STATUSES)[number];

export const AI_PROVIDER_STATUS_LABELS: Record<AiProviderStatus, string> = {
  not_connected: "Não conectado",
  connected: "Conectado",
  error: "Com erro",
};

/**
 * Modelos conhecidos, com a finalidade escrita para quem escolhe. É o
 * CATÁLOGO DE RESERVA: a lista de verdade vem do provedor (`GET /v1/models`)
 * e é guardada em cache; este catálogo entra quando o provedor não responde
 * e para dar rótulo/finalidade a um id que ele devolve pelado.
 *
 * Preços em DÓLARES POR MILHÃO de tokens, entrada e saída, conforme a tabela
 * pública da OpenAI na data de escrita (set/2026). Custo é ESTIMATIVA: a
 * tela diz isso, e modelo fora da tabela sai como "sem tabela de preço" em
 * vez de custo zero, que seria mentira mais perigosa. Quem administra pode
 * sobrepor o preço em Consumo e Limites.
 */
export interface AiModelInfo {
  id: string;
  label: string;
  purpose: string;
  /** USD por 1M tokens de entrada; `null` = preço desconhecido. */
  inputPerMillion: number | null;
  /** USD por 1M tokens de saída; `null` = preço desconhecido. */
  outputPerMillion: number | null;
  /** Recomendado para atendimento (custo/qualidade). */
  recommended?: boolean;
}

export const AI_MODEL_CATALOG: readonly AiModelInfo[] = [
  {
    id: "gpt-4.1-mini",
    label: "GPT-4.1 mini",
    purpose: "Equilíbrio entre custo e qualidade — bom padrão para atendimento",
    inputPerMillion: 0.4,
    outputPerMillion: 1.6,
    recommended: true,
  },
  {
    id: "gpt-4.1",
    label: "GPT-4.1",
    purpose: "Mais capaz em instruções longas e casos delicados; custa mais",
    inputPerMillion: 2,
    outputPerMillion: 8,
  },
  {
    id: "gpt-4.1-nano",
    label: "GPT-4.1 nano",
    purpose: "O mais barato e rápido; serve para triagem simples",
    inputPerMillion: 0.1,
    outputPerMillion: 0.4,
  },
  {
    id: "gpt-4o-mini",
    label: "GPT-4o mini",
    purpose: "Geração anterior, barato e estável",
    inputPerMillion: 0.15,
    outputPerMillion: 0.6,
  },
  {
    id: "gpt-4o",
    label: "GPT-4o",
    purpose: "Geração anterior, mais capaz",
    inputPerMillion: 2.5,
    outputPerMillion: 10,
  },
  {
    id: "gpt-5-mini",
    label: "GPT-5 mini",
    purpose: "Raciocínio com custo contido; respostas um pouco mais lentas",
    inputPerMillion: 0.25,
    outputPerMillion: 2,
  },
  {
    id: "gpt-5",
    label: "GPT-5",
    purpose: "Mais capaz da linha; mais lento e mais caro para chat",
    inputPerMillion: 1.25,
    outputPerMillion: 10,
  },
  {
    id: "gpt-5-nano",
    label: "GPT-5 nano",
    purpose: "Menor da linha 5, para classificação e tarefas curtas",
    inputPerMillion: 0.05,
    outputPerMillion: 0.4,
  },
];

export const AI_DEFAULT_MODEL = "gpt-4.1-mini";

/** Informação do catálogo para um id de modelo, ou `null` se não conhecemos. */
export function aiModelInfo(modelId: string): AiModelInfo | null {
  return AI_MODEL_CATALOG.find((model) => model.id === modelId) ?? null;
}

/**
 * Preço por modelo, com a sobreposição da organização por cima do catálogo.
 * Devolve `null` quando NINGUÉM sabe o preço — e aí o custo não é calculado,
 * em vez de sair zero.
 */
export interface AiModelPricing {
  inputPerMillion: number;
  outputPerMillion: number;
}

export type AiPricingOverrides = Record<string, AiModelPricing>;

export function resolveModelPricing(
  modelId: string,
  overrides: AiPricingOverrides | null | undefined,
): AiModelPricing | null {
  const override = overrides?.[modelId];
  if (override) return override;
  const info = aiModelInfo(modelId);
  if (info && info.inputPerMillion != null && info.outputPerMillion != null) {
    return { inputPerMillion: info.inputPerMillion, outputPerMillion: info.outputPerMillion };
  }
  return null;
}

/** Um dólar em "micros" — a unidade em que o custo é guardado no banco (inteiro). */
export const AI_USD_MICROS = 1_000_000;

/**
 * Custo estimado de uma chamada, em micro-dólares. `null` quando o modelo
 * não tem preço conhecido: a chamada é registrada com os tokens, e o custo
 * dela some dos totais em vez de entrar como zero.
 */
export function estimateCostMicros(
  modelId: string,
  inputTokens: number,
  outputTokens: number,
  overrides?: AiPricingOverrides | null,
): number | null {
  const pricing = resolveModelPricing(modelId, overrides);
  if (!pricing) return null;
  const usd =
    (inputTokens / 1_000_000) * pricing.inputPerMillion +
    (outputTokens / 1_000_000) * pricing.outputPerMillion;
  return Math.round(usd * AI_USD_MICROS);
}

export function formatUsdFromMicros(micros: number | null): string {
  if (micros == null) return "—";
  const usd = micros / AI_USD_MICROS;
  return `US$ ${usd.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: usd < 1 ? 4 : 2 })}`;
}

// ---------------------------------------------------------------------------
// Estados
// ---------------------------------------------------------------------------

export const AI_AGENT_STATUSES = ["draft", "active", "inactive"] as const;
export type AiAgentStatus = (typeof AI_AGENT_STATUSES)[number];

export const AI_AGENT_STATUS_LABELS: Record<AiAgentStatus, string> = {
  draft: "Rascunho",
  active: "Ativo",
  inactive: "Inativo",
};

export const AI_AGENT_STATUS_COLORS: Record<AiAgentStatus, string> = {
  draft: "#64748b",
  active: "#16a34a",
  inactive: "#b45309",
};

/**
 * Estados de uma SESSÃO de atendimento por IA (um atendimento, numa
 * conversa, por um agente). `active` é o único em que a IA responde.
 */
export const AI_SESSION_STATUSES = [
  "active",
  "resolved",
  "transferred",
  "stopped",
  "limit_reached",
  "error",
  "expired",
] as const;
export type AiSessionStatus = (typeof AI_SESSION_STATUSES)[number];

export const AI_SESSION_STATUS_LABELS: Record<AiSessionStatus, string> = {
  active: "Em atendimento",
  resolved: "Resolvido pela IA",
  transferred: "Transferido para humano",
  stopped: "Interrompido pela equipe",
  limit_reached: "Limite atingido",
  error: "Encerrado por erro",
  expired: "Tempo máximo atingido",
};

export const AI_SESSION_STATUS_COLORS: Record<AiSessionStatus, string> = {
  active: "#4f46e5",
  resolved: "#16a34a",
  transferred: "#0284c7",
  stopped: "#64748b",
  limit_reached: "#b45309",
  error: "#dc2626",
  expired: "#b45309",
};

/** Motivos de encerramento, gravados na sessão e no histórico da conversa. */
export const AI_SESSION_END_REASONS = [
  "resolved_by_ai",
  "customer_requested_human",
  "ai_transfer",
  "human_takeover",
  "stopped_by_user",
  "message_limit",
  "attempt_limit",
  "duration_limit",
  "provider_error",
  "budget_exceeded",
  "agent_disabled",
  "conversation_archived",
] as const;
export type AiSessionEndReason = (typeof AI_SESSION_END_REASONS)[number];

export const AI_SESSION_END_REASON_LABELS: Record<AiSessionEndReason, string> = {
  resolved_by_ai: "A IA concluiu o atendimento",
  customer_requested_human: "O cliente pediu um atendente",
  ai_transfer: "A IA transferiu conforme as regras",
  human_takeover: "Um atendente assumiu a conversa",
  stopped_by_user: "Encerrado manualmente pela equipe",
  message_limit: "Limite de mensagens da IA atingido",
  attempt_limit: "Limite de tentativas sem resolver",
  duration_limit: "Tempo máximo sob atendimento da IA",
  provider_error: "Falha do provedor de IA",
  budget_exceeded: "Orçamento mensal de IA atingido",
  agent_disabled: "O agente foi desativado",
  conversation_archived: "A conversa foi arquivada",
};

// ---------------------------------------------------------------------------
// Configuração do agente — CAMPOS ESTRUTURADOS, não um prompt só
// ---------------------------------------------------------------------------

export const AI_TONES = ["professional", "friendly", "formal", "consultive", "custom"] as const;
export type AiTone = (typeof AI_TONES)[number];
export const AI_TONE_LABELS: Record<AiTone, string> = {
  professional: "Profissional",
  friendly: "Amigável",
  formal: "Formal",
  consultive: "Consultivo",
  custom: "Personalizado",
};

export const AI_RESPONSE_LENGTHS = ["very_short", "short", "medium", "detailed"] as const;
export type AiResponseLength = (typeof AI_RESPONSE_LENGTHS)[number];
export const AI_RESPONSE_LENGTH_LABELS: Record<AiResponseLength, string> = {
  very_short: "Muito curto",
  short: "Curto",
  medium: "Médio",
  detailed: "Detalhado",
};

export const AI_EMOJI_USAGES = ["no", "moderate", "yes"] as const;
export type AiEmojiUsage = (typeof AI_EMOJI_USAGES)[number];
export const AI_EMOJI_USAGE_LABELS: Record<AiEmojiUsage, string> = {
  no: "Não",
  moderate: "Moderadamente",
  yes: "Sim",
};

export const AI_COLLECTION_ORDERS = ["free", "defined"] as const;
export type AiCollectionOrder = (typeof AI_COLLECTION_ORDERS)[number];
export const AI_COLLECTION_ORDER_LABELS: Record<AiCollectionOrder, string> = {
  free: "Livre / inteligente (a IA decide a ordem natural)",
  defined: "Ordem definida (na sequência da lista)",
};

/**
 * Nomes técnicos das FERRAMENTAS que a IA pode pedir. Cada uma é executada
 * pelo BACKEND (`services/ai/actions.ts`), que confere a permissão
 * estruturada do agente ANTES de fazer qualquer coisa — nunca o prompt.
 */
export const AI_TOOL_NAMES = [
  "save_collected_data",
  "update_contact_name",
  "add_tag",
  "remove_tag",
  "add_internal_note",
  "set_conversation_status",
  "schedule_followup",
  "search_knowledge_base",
  "lookup_company",
  "transfer_to_human",
  "finish_conversation",
] as const;
export type AiToolName = (typeof AI_TOOL_NAMES)[number];

export const AI_TOOL_LABELS: Record<AiToolName, string> = {
  save_collected_data: "Registrar dado coletado",
  update_contact_name: "Atualizar nome do contato",
  add_tag: "Adicionar etiqueta",
  remove_tag: "Remover etiqueta",
  add_internal_note: "Registrar nota interna",
  set_conversation_status: "Alterar status do atendimento",
  schedule_followup: "Agendar follow-up",
  search_knowledge_base: "Consultar base de conhecimento",
  lookup_company: "Consultar empresa (Azevedo-OS)",
  transfer_to_human: "Transferir para humano",
  finish_conversation: "Finalizar atendimento",
};

/**
 * O que a IA PODE FAZER — as permissões estruturadas. Cada capacidade
 * libera ZERO ou UMA ferramenta: desligada, a ferramenta nem é oferecida ao
 * modelo, e se ele a pedir mesmo assim o backend recusa e registra.
 *
 * `answer_questions` e `ask_questions` não têm ferramenta: são instruções
 * de conduta (entram no prompt), e existem como caixa para o administrador
 * desenhar o agente que só coleta, ou o que só responde.
 */
export interface AiCapabilityDefinition {
  key: AiCapabilityKey;
  label: string;
  description: string;
  tool: AiToolName | null;
  default: boolean;
}

export const AI_CAPABILITY_KEYS = [
  "answer_questions",
  "ask_questions",
  "collect_data",
  "update_contact_name",
  "add_tags",
  "remove_tags",
  "add_internal_note",
  "set_status",
  "schedule_followup",
  "search_knowledge",
  "lookup_company",
  "transfer",
  "finish",
  "send_links",
] as const;
export type AiCapabilityKey = (typeof AI_CAPABILITY_KEYS)[number];

export const AI_CAPABILITIES: readonly AiCapabilityDefinition[] = [
  {
    key: "answer_questions",
    label: "Responder perguntas",
    description: "Explica serviços, tira dúvidas e responde ao que o cliente pergunta.",
    tool: null,
    default: true,
  },
  {
    key: "ask_questions",
    label: "Fazer perguntas",
    description: "Pergunta ao cliente o que precisa para entender a necessidade.",
    tool: null,
    default: true,
  },
  {
    key: "collect_data",
    label: "Coletar dados",
    description: "Registra os dados da seção \"Dados a coletar\" conforme o cliente informa.",
    tool: "save_collected_data",
    default: true,
  },
  {
    key: "update_contact_name",
    label: "Atualizar o nome do contato",
    description:
      "Quando a conversa ainda aparece pelo telefone, grava o nome que o cliente informou como nome da conversa.",
    tool: "update_contact_name",
    default: true,
  },
  {
    key: "add_tags",
    label: "Adicionar etiquetas",
    description: "Aplica etiquetas já cadastradas à conversa (ex.: \"Lead\", \"Abertura de empresa\").",
    tool: "add_tag",
    default: true,
  },
  {
    key: "remove_tags",
    label: "Remover etiquetas",
    description: "Tira etiquetas da conversa.",
    tool: "remove_tag",
    default: false,
  },
  {
    key: "add_internal_note",
    label: "Registrar nota interna",
    description:
      "Escreve nota interna na conversa (o cliente nunca vê). É o registro de oportunidade/atividade da casa.",
    tool: "add_internal_note",
    default: true,
  },
  {
    key: "set_status",
    label: "Alterar o status do atendimento",
    description: "Muda entre Aberto, Aguardando cliente e Aguardando interno.",
    tool: "set_conversation_status",
    default: true,
  },
  {
    key: "schedule_followup",
    label: "Agendar follow-up",
    description:
      "Agenda uma mensagem para mais tarde (o follow-up da casa), quando o cliente diz que vai retornar.",
    tool: "schedule_followup",
    default: false,
  },
  {
    key: "search_knowledge",
    label: "Consultar base de conhecimento",
    description: "Busca nas fontes autorizadas deste agente antes de responder.",
    tool: "search_knowledge_base",
    default: true,
  },
  {
    key: "lookup_company",
    label: "Consultar a empresa vinculada (Azevedo-OS)",
    description:
      "Lê o cadastro da empresa vinculada à conversa (nome, CNPJ, regime, status). Nunca dados financeiros.",
    tool: "lookup_company",
    default: false,
  },
  {
    key: "transfer",
    label: "Transferir atendimento",
    description: "Passa a conversa para um atendente humano, com resumo.",
    tool: "transfer_to_human",
    default: true,
  },
  {
    key: "finish",
    label: "Finalizar atendimento",
    description: "Marca a conversa como concluída quando o cliente foi atendido por completo.",
    tool: "finish_conversation",
    default: true,
  },
  {
    key: "send_links",
    label: "Enviar links autorizados",
    description: "Só os links da lista abaixo podem ser enviados ao cliente.",
    tool: null,
    default: false,
  },
];

export const AI_CAPABILITY_BY_KEY: ReadonlyMap<AiCapabilityKey, AiCapabilityDefinition> = new Map(
  AI_CAPABILITIES.map((capability) => [capability.key, capability]),
);

/** Capacidade que libera esta ferramenta (ferramenta sem capacidade não existe). */
export function capabilityForTool(tool: AiToolName): AiCapabilityDefinition | null {
  return AI_CAPABILITIES.find((capability) => capability.tool === tool) ?? null;
}

/**
 * Quando TRANSFERIR PARA HUMANO. Cada gatilho é uma instrução ao modelo e,
 * para os de limite, também uma regra que o backend aplica sozinho — o
 * modelo não é a única defesa.
 */
export const AI_HANDOFF_TRIGGER_KEYS = [
  "customer_requests_human",
  "cannot_answer",
  "insufficient_info",
  "attempt_limit",
  "message_limit",
  "dissatisfaction",
  "complaint",
  "cancellation_request",
  "discount_request",
  "specific_department",
] as const;
export type AiHandoffTriggerKey = (typeof AI_HANDOFF_TRIGGER_KEYS)[number];

export const AI_HANDOFF_TRIGGER_LABELS: Record<AiHandoffTriggerKey, string> = {
  customer_requests_human: "Cliente solicitar atendente humano",
  cannot_answer: "IA não souber responder",
  insufficient_info: "IA não tiver informação suficiente",
  attempt_limit: "Limite de tentativas atingido",
  message_limit: "Limite de interações atingido",
  dissatisfaction: "Cliente demonstrar insatisfação",
  complaint: "Cliente fizer reclamação",
  cancellation_request: "Cliente pedir cancelamento",
  discount_request: "Cliente pedir desconto",
  specific_department: "Assunto exigir departamento específico",
};

export const AI_BEHAVIOR_KEYS = [
  "no_repeat_questions",
  "no_fabrication",
  "admit_unknown",
  "consult_knowledge_first",
  "transfer_out_of_scope",
  "use_collected_data",
  "consider_history",
  "avoid_long_answers",
] as const;
export type AiBehaviorKey = (typeof AI_BEHAVIOR_KEYS)[number];

export const AI_BEHAVIOR_LABELS: Record<AiBehaviorKey, string> = {
  no_repeat_questions: "Não repetir pergunta já respondida",
  no_fabrication: "Não inventar informações",
  admit_unknown: "Admitir quando não souber",
  consult_knowledge_first: "Consultar a base antes de responder quando necessário",
  transfer_out_of_scope: "Transferir quando estiver fora da competência",
  use_collected_data: "Utilizar dados já coletados",
  consider_history: "Considerar o histórico da conversa",
  avoid_long_answers: "Evitar respostas excessivamente longas",
};

export const AI_ASSIGNEE_MODES = ["rules", "unassigned", "specific"] as const;
export type AiAssigneeMode = (typeof AI_ASSIGNEE_MODES)[number];
export const AI_ASSIGNEE_MODE_LABELS: Record<AiAssigneeMode, string> = {
  rules: "Automático (responsável padrão do departamento/número)",
  unassigned: "Sem responsável (fica na fila)",
  specific: "Pessoa específica",
};

/** Um dado que a IA deve coletar. `key` é o nome técnico que o modelo usa. */
export interface AiCollectField {
  key: string;
  label: string;
  required: boolean;
  /** Dica de formato para o modelo, ex.: "CNPJ com 14 dígitos". */
  hint: string;
}

/** Campos sugeridos na tela — a lista final é livre. */
export const AI_SUGGESTED_COLLECT_FIELDS: readonly AiCollectField[] = [
  { key: "nome", label: "Nome", required: true, hint: "Como o cliente quer ser chamado" },
  { key: "cpf_cnpj", label: "CPF/CNPJ", required: false, hint: "Só dígitos, 11 ou 14" },
  { key: "empresa", label: "Empresa", required: false, hint: "Razão social ou nome fantasia" },
  { key: "servico_interesse", label: "Serviço de interesse", required: true, hint: "" },
  { key: "cidade", label: "Cidade", required: false, hint: "" },
  { key: "faturamento", label: "Faturamento", required: false, hint: "Faixa aproximada mensal" },
  { key: "email", label: "E-mail", required: false, hint: "" },
];

export interface AiAgentConfig {
  identity: {
    /** Apresentação enviada ao cliente ao iniciar, quando `sendGreeting`. */
    greeting: string;
    sendGreeting: boolean;
  };
  objective: string;
  canDo: {
    instructions: string;
    capabilities: Record<AiCapabilityKey, boolean>;
    /** Links que a IA pode enviar (vale só com `send_links` ligado). */
    allowedLinks: string[];
  };
  cannotDo: string;
  limits: {
    maxAiMessages: number;
    maxFailedAttempts: number;
    /** Nulo = sem limite de tempo. */
    maxDurationMinutes: number | null;
  };
  handoff: {
    triggers: Record<AiHandoffTriggerKey, boolean>;
    customTriggers: string;
    departmentId: string | null;
    assigneeMode: AiAssigneeMode;
    assigneeUserId: string | null;
    /** Mensagem ao cliente quando a IA transfere por decisão própria. */
    transferMessage: string;
    /** Mensagem ao cliente quando a IA para por erro, limite ou orçamento. */
    fallbackMessage: string;
  };
  communication: {
    tone: AiTone;
    customTone: string;
    responseLength: AiResponseLength;
    emojis: AiEmojiUsage;
    useFirstName: boolean;
    oneQuestionAtATime: boolean;
    avoidJargon: boolean;
    customInstructions: string;
  };
  behaviors: Record<AiBehaviorKey, boolean>;
  dataCollection: {
    order: AiCollectionOrder;
    fields: AiCollectField[];
  };
  knowledge: {
    /** Respostas rápidas que valem para a conversa entram como conhecimento. */
    includeQuickReplies: boolean;
    /** Deixa o modelo usar conhecimento geral quando a base não cobre. */
    allowGeneralKnowledge: boolean;
  };
  advanced: {
    additionalInstructions: string;
    /** Nulo = modelo padrão do sistema. */
    model: string | null;
    temperature: number | null;
    /** Quantas mensagens recentes da conversa vão a cada chamada. */
    contextMessageLimit: number;
  };
}

export const AI_CONFIG_LIMITS = {
  maxAiMessages: { min: 1, max: 200, default: 20 },
  maxFailedAttempts: { min: 1, max: 20, default: 3 },
  maxDurationMinutes: { min: 5, max: 7 * 24 * 60 },
  contextMessageLimit: { min: 4, max: 60, default: 20 },
  temperature: { min: 0, max: 2 },
  allowedLinks: { max: 30 },
  collectFields: { max: 20 },
} as const;

export const AI_DEFAULT_TRANSFER_MESSAGE =
  "Vou encaminhar você para um de nossos atendentes, que continua daqui. Só um instante.";
export const AI_DEFAULT_FALLBACK_MESSAGE =
  "Neste momento vou encaminhar você para um de nossos atendentes. Em breve alguém continua o atendimento.";

function recordOf<K extends string>(keys: readonly K[], value: (key: K) => boolean): Record<K, boolean> {
  return Object.fromEntries(keys.map((key) => [key, value(key)])) as Record<K, boolean>;
}

/** Configuração de fábrica de um agente novo — tudo ligado no que é seguro. */
export function defaultAiAgentConfig(): AiAgentConfig {
  return {
    identity: { greeting: "Olá! Sou a assistente virtual do escritório.", sendGreeting: true },
    objective: "",
    canDo: {
      instructions: "",
      capabilities: recordOf(AI_CAPABILITY_KEYS, (key) => AI_CAPABILITY_BY_KEY.get(key)?.default ?? false),
      allowedLinks: [],
    },
    cannotDo:
      "- não conceder descontos nem negociar valores;\n- não prometer prazos;\n- não dar parecer jurídico ou contábil conclusivo;\n- não cancelar contratos nem alterar cobranças;\n- não fornecer informações internas;\n- não inventar informações nem afirmar algo sem dados suficientes.",
    limits: {
      maxAiMessages: AI_CONFIG_LIMITS.maxAiMessages.default,
      maxFailedAttempts: AI_CONFIG_LIMITS.maxFailedAttempts.default,
      maxDurationMinutes: null,
    },
    handoff: {
      triggers: recordOf(AI_HANDOFF_TRIGGER_KEYS, () => true),
      customTriggers: "",
      departmentId: null,
      assigneeMode: "rules",
      assigneeUserId: null,
      transferMessage: AI_DEFAULT_TRANSFER_MESSAGE,
      fallbackMessage: AI_DEFAULT_FALLBACK_MESSAGE,
    },
    communication: {
      tone: "professional",
      customTone: "",
      responseLength: "short",
      emojis: "no",
      useFirstName: true,
      oneQuestionAtATime: true,
      avoidJargon: true,
      customInstructions: "",
    },
    behaviors: recordOf(AI_BEHAVIOR_KEYS, () => true),
    dataCollection: { order: "free", fields: [] },
    knowledge: { includeQuickReplies: false, allowGeneralKnowledge: false },
    advanced: {
      additionalInstructions: "",
      model: null,
      temperature: null,
      contextMessageLimit: AI_CONFIG_LIMITS.contextMessageLimit.default,
    },
  };
}

/** A ferramenta está liberada nesta configuração? Fonte única para API e tela. */
export function agentAllowsTool(config: AiAgentConfig, tool: AiToolName): boolean {
  const capability = capabilityForTool(tool);
  if (!capability) return false;
  return config.canDo.capabilities[capability.key] === true;
}

// ---------------------------------------------------------------------------
// Base de conhecimento
// ---------------------------------------------------------------------------

export const AI_KNOWLEDGE_KINDS = ["text", "faq"] as const;
export type AiKnowledgeKind = (typeof AI_KNOWLEDGE_KINDS)[number];
export const AI_KNOWLEDGE_KIND_LABELS: Record<AiKnowledgeKind, string> = {
  text: "Texto livre",
  faq: "Perguntas e respostas",
};

/** Teto do conteúdo de uma fonte — é texto, não anexo. */
export const AI_KNOWLEDGE_MAX_CHARS = 60_000;

// ---------------------------------------------------------------------------
// Orçamento
// ---------------------------------------------------------------------------

export const AI_BUDGET_POLICIES = ["alert_only", "block_new", "transfer_human"] as const;
export type AiBudgetPolicy = (typeof AI_BUDGET_POLICIES)[number];
export const AI_BUDGET_POLICY_LABELS: Record<AiBudgetPolicy, string> = {
  alert_only: "Apenas alertar",
  block_new: "Bloquear novas conversas por IA",
  transfer_human: "Encaminhar novos atendimentos direto para humano",
};
export const AI_BUDGET_POLICY_DESCRIPTIONS: Record<AiBudgetPolicy, string> = {
  alert_only: "A IA continua atendendo; os administradores recebem o aviso.",
  block_new:
    "Conversa nova não entra na IA e fica exatamente como chegou. Atendimento em andamento é encerrado com a mensagem de fallback.",
  transfer_human:
    "Conversa nova vai para o departamento/responsável de transferência do agente, como se a IA tivesse transferido. Atendimento em andamento é encerrado com a mensagem de fallback.",
};

export const AI_BUDGET_ALERT_THRESHOLDS = [50, 80, 90, 100] as const;

// ---------------------------------------------------------------------------
// Automação (o "bloco de IA")
// ---------------------------------------------------------------------------

export const AI_AUTOMATION_CONVERSATION_TYPES = ["any", "individual", "group"] as const;
export type AiAutomationConversationType = (typeof AI_AUTOMATION_CONVERSATION_TYPES)[number];
export const AI_AUTOMATION_CONVERSATION_TYPE_LABELS: Record<AiAutomationConversationType, string> = {
  any: "Qualquer conversa",
  individual: "Só conversa individual",
  group: "Só grupo",
};

/** Valor do seletor de departamento da tela para "só conversa sem departamento". */
export const AI_AUTOMATION_NO_DEPARTMENT = "none";

// ---------------------------------------------------------------------------
// Origem da mensagem
// ---------------------------------------------------------------------------

/** `Message.metadata.origem` de tudo o que a IA envia. */
export const AI_MESSAGE_ORIGIN = "ai";

export interface AiMessageOriginMetadata {
  origem: typeof AI_MESSAGE_ORIGIN;
  aiAgentId: string;
  aiAgentName: string;
  aiSessionId: string;
  aiProvider: AiProviderKind;
  aiModel: string;
}

export function isAiMessage(metadata: unknown): metadata is AiMessageOriginMetadata {
  return (
    typeof metadata === "object" &&
    metadata !== null &&
    (metadata as { origem?: unknown }).origem === AI_MESSAGE_ORIGIN
  );
}

// ---------------------------------------------------------------------------
// Consumo
// ---------------------------------------------------------------------------

export const AI_USAGE_KINDS = ["chat", "test", "connection_test", "models"] as const;
export type AiUsageKind = (typeof AI_USAGE_KINDS)[number];
export const AI_USAGE_KIND_LABELS: Record<AiUsageKind, string> = {
  chat: "Atendimento",
  test: "Testador",
  connection_test: "Teste de conexão",
  models: "Lista de modelos",
};

export const AI_USAGE_OUTCOMES = ["ok", "error", "timeout", "blocked"] as const;
export type AiUsageOutcome = (typeof AI_USAGE_OUTCOMES)[number];
export const AI_USAGE_OUTCOME_LABELS: Record<AiUsageOutcome, string> = {
  ok: "OK",
  error: "Erro",
  timeout: "Timeout",
  blocked: "Bloqueado",
};

export const AI_USAGE_PERIODS = ["today", "7d", "30d", "month"] as const;
export type AiUsagePeriod = (typeof AI_USAGE_PERIODS)[number];
export const AI_USAGE_PERIOD_LABELS: Record<AiUsagePeriod, string> = {
  today: "Hoje",
  "7d": "7 dias",
  "30d": "30 dias",
  month: "Este mês",
};

// ---------------------------------------------------------------------------
// DTOs
// ---------------------------------------------------------------------------

export interface AiProviderDto {
  provider: AiProviderKind;
  status: AiProviderStatus;
  /** Ex.: "sk-••••••••8F2A". A chave completa NUNCA sai da API. */
  apiKeyHint: string | null;
  defaultModel: string | null;
  lastTestedAt: string | null;
  lastTestError: string | null;
  modelsFetchedAt: string | null;
  updatedAt: string | null;
}

export interface AiModelDto extends AiModelInfo {
  /** Veio do provedor (true) ou só do catálogo local (false). */
  fromProvider: boolean;
}

export interface AiProviderBillingDto {
  available: boolean;
  /** Por que não está disponível, em português. */
  reason: string | null;
  /** Custo do mês corrente informado pelo provedor, em micro-dólares. */
  monthCostMicros: number | null;
  checkedAt: string;
}

export interface AiSettingsDto {
  monthlyBudgetCents: number | null;
  alertThresholds: number[];
  budgetPolicy: AiBudgetPolicy;
  timeoutMs: number;
  contextMessageLimit: number;
  pricingOverrides: AiPricingOverrides;
  updatedAt: string | null;
}

export interface AiAgentSummaryDto {
  id: string;
  name: string;
  description: string;
  status: AiAgentStatus;
  isGeneral: boolean;
  departments: Array<{ id: string; name: string; color: string | null }>;
  provider: AiProviderKind;
  /** Modelo efetivo (o do agente ou o padrão do sistema). */
  model: string;
  version: number;
  sessionsCount: number;
  costMicros: number;
  knowledgeSourceIds: string[];
  updatedAt: string;
  createdAt: string;
}

export interface AiAgentDto extends AiAgentSummaryDto {
  config: AiAgentConfig;
}

export interface AiAgentVersionDto {
  id: string;
  version: number;
  model: string | null;
  createdBy: { id: string; name: string } | null;
  createdAt: string;
}

export interface AiKnowledgeSourceDto {
  id: string;
  title: string;
  kind: AiKnowledgeKind;
  content: string;
  active: boolean;
  /** Quantos agentes usam esta fonte. */
  agentsCount: number;
  updatedAt: string;
}

export interface AiAutomationDto {
  id: string;
  name: string;
  active: boolean;
  agentId: string;
  agentName: string;
  agentStatus: AiAgentStatus;
  whatsappInstanceId: string | null;
  /** Nulo = qualquer departamento (salvo `onlyWithoutDepartment`). */
  departmentId: string | null;
  /** Só conversa que o número não classificou (departamento nulo). */
  onlyWithoutDepartment: boolean;
  conversationType: AiAutomationConversationType;
  onlyUnassigned: boolean;
  onlyNewConversations: boolean;
  resolvedTagId: string | null;
  priority: number;
  sessionsCount: number;
  createdAt: string;
}

/** Estado vivo de um atendimento por IA — o que a Inbox mostra. */
export interface AiSessionDto {
  id: string;
  conversationId: string;
  agentId: string;
  agentName: string;
  agentVersion: number;
  status: AiSessionStatus;
  aiMessageCount: number;
  customerMessageCount: number;
  startedAt: string;
  lastActivityAt: string;
  endedAt: string | null;
  endReason: AiSessionEndReason | null;
  endedBy: { id: string; name: string } | null;
  collectedData: Record<string, string>;
  summary: string | null;
  inputTokens: number;
  outputTokens: number;
  costMicros: number;
}

export interface AiUsageTotalsDto {
  requests: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  costMicros: number;
  /** Chamadas cujo modelo não tem preço: o custo delas não está no total. */
  unpricedRequests: number;
}

export interface AiUsageBucketDto extends AiUsageTotalsDto {
  key: string;
  label: string;
}

export interface AiUsageDto {
  period: AiUsagePeriod;
  today: AiUsageTotalsDto;
  month: AiUsageTotalsDto;
  period_totals: AiUsageTotalsDto;
  byAgent: AiUsageBucketDto[];
  byDepartment: AiUsageBucketDto[];
  byModel: AiUsageBucketDto[];
  budget: {
    monthlyBudgetCents: number | null;
    spentMicros: number;
    percent: number | null;
    policy: AiBudgetPolicy;
    blocked: boolean;
  };
}

export interface AiStatsAgentRowDto {
  agentId: string;
  agentName: string;
  sessions: number;
  resolved: number;
  transferred: number;
  resolutionRate: number | null;
  avgMessages: number | null;
  costMicros: number;
  avgCostMicros: number | null;
}

export interface AiStatsDto {
  period: AiUsagePeriod;
  sessions: number;
  active: number;
  resolved: number;
  transferred: number;
  other: number;
  resolutionRate: number | null;
  avgMessages: number | null;
  monthCostMicros: number;
  costMicros: number;
  avgCostMicros: number | null;
  byAgent: AiStatsAgentRowDto[];
}

export interface AiUsageLogDto {
  id: string;
  createdAt: string;
  kind: AiUsageKind;
  outcome: AiUsageOutcome;
  agentId: string | null;
  agentName: string | null;
  conversationId: string | null;
  conversationTitle: string | null;
  sessionId: string | null;
  provider: AiProviderKind;
  model: string;
  inputTokens: number;
  outputTokens: number;
  costMicros: number | null;
  durationMs: number;
  toolsRequested: string[];
  toolsExecuted: string[];
  toolsBlocked: string[];
  handoffReason: string | null;
  errorCode: string | null;
}

/** Uma mensagem do testador (ou do contexto enviado ao modelo). */
export interface AiChatTurn {
  role: "customer" | "assistant";
  content: string;
}

export interface AiTestDebugDto {
  agentId: string;
  agentVersion: number;
  model: string;
  knowledgeUsed: Array<{ sourceTitle: string; excerpt: string }>;
  toolsRequested: Array<{ name: string; arguments: Record<string, unknown> }>;
  toolsBlocked: Array<{ name: string; reason: string }>;
  toolsExecuted: Array<{ name: string; result: string }>;
  inputTokens: number;
  outputTokens: number;
  costMicros: number | null;
  handoff: { reason: string; summary: string } | null;
  finished: boolean;
}

export interface AiTestResultDto {
  reply: string | null;
  state: Record<string, unknown>;
  ended: "transferred" | "resolved" | null;
  debug: AiTestDebugDto | null;
}

export interface AiTestRequestDto {
  transcript: AiChatTurn[];
  state: Record<string, unknown> | null;
  debug: boolean;
}

/** Status que a IA pode gravar pela ferramenta (concluir é outra ferramenta). */
export const AI_SETTABLE_STATUSES: readonly ConversationStatus[] = [
  "open",
  "waiting_client",
  "waiting_internal",
];

/** A automação casa com este tipo de conversa? */
export function automationMatchesType(
  automationType: AiAutomationConversationType,
  conversationType: ConversationType,
): boolean {
  return automationType === "any" || automationType === conversationType;
}

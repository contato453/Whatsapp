/**
 * DISPAROS EM MASSA — o contrato compartilhado entre API e tela.
 *
 * O módulo tem três peças, e a separação é a decisão mais importante do
 * desenho:
 *
 *   AUDIÊNCIA (quem)  →  CAMPANHA (o quê, por onde, em que ritmo)  →
 *   ENTREGA (uma linha por contato, o que de fato aconteceu com ele)
 *
 * A audiência é REUTILIZÁVEL: a mesma lista serve a quantas campanhas o
 * escritório quiser, e corrigir um telefone nela vale para as campanhas
 * seguintes. A entrega é o oposto — ela CONGELA o que foi enviado (telefone
 * e texto final), porque o histórico precisa responder "o que exatamente
 * esta pessoa recebeu em tal dia" mesmo depois de alguém editar o contato
 * ou apagar a audiência inteira.
 *
 * TUDO AQUI É DESENHADO CONTRA O BLOQUEIO DO WHATSAPP. Disparo em massa é a
 * forma mais rápida de perder um número, e o número é o ativo do escritório:
 * perdê-lo é perder o histórico vivo de todos os clientes daquele chip. Por
 * isso as travas não são opcionais nem configuráveis para zero — ver
 * `BROADCAST_LIMITS` abaixo e a seção 24 do CLAUDE.md.
 */

// ============================================================
// Estados
// ============================================================

/**
 * `draft` — montando, ainda não gerou entrega nenhuma.
 * `scheduled` — tem hora marcada e as entregas já foram geradas.
 * `running` — o worker está mandando.
 * `paused` — parada por uma pessoa OU pela trava automática (ver `pausedReason`).
 * `completed` — não sobrou entrega pendente.
 * `canceled` — interrompida de vez; o que não saiu não sai mais.
 */
export const BROADCAST_CAMPAIGN_STATUSES = [
  "draft",
  "scheduled",
  "running",
  "paused",
  "completed",
  "canceled",
] as const;
export type BroadcastCampaignStatus = (typeof BROADCAST_CAMPAIGN_STATUSES)[number];

export const BROADCAST_CAMPAIGN_STATUS_LABELS: Record<BroadcastCampaignStatus, string> = {
  draft: "Rascunho",
  scheduled: "Agendada",
  running: "Enviando",
  paused: "Pausada",
  completed: "Concluída",
  canceled: "Cancelada",
};

/** Cores de ESTADO (as mesmas famílias do resto do sistema, nunca a paleta de marca). */
export const BROADCAST_CAMPAIGN_STATUS_COLORS: Record<BroadcastCampaignStatus, string> = {
  draft: "#64748b",
  scheduled: "#2563eb",
  running: "#16a34a",
  paused: "#d97706",
  completed: "#0891b2",
  canceled: "#dc2626",
};

/**
 * `pending` → `sent` no caminho feliz.
 * `failed` é erro do envio (com `failureReason`), e ainda pode ser retentado.
 * `skipped` é decisão NOSSA de não enviar (ver `BroadcastSkipReason`) — e é
 * diferente de falha de propósito: pular quem pediu descadastro é o sistema
 * funcionando, não um problema a investigar.
 */
export const BROADCAST_DELIVERY_STATUSES = ["pending", "sent", "failed", "skipped"] as const;
export type BroadcastDeliveryStatus = (typeof BROADCAST_DELIVERY_STATUSES)[number];

export const BROADCAST_DELIVERY_STATUS_LABELS: Record<BroadcastDeliveryStatus, string> = {
  pending: "Na fila",
  sent: "Enviada",
  failed: "Falhou",
  skipped: "Pulada",
};

export const BROADCAST_SKIP_REASONS = [
  "opted_out",
  "invalid_phone",
  "duplicate",
  "canceled",
] as const;
export type BroadcastSkipReason = (typeof BROADCAST_SKIP_REASONS)[number];

export const BROADCAST_SKIP_REASON_LABELS: Record<BroadcastSkipReason, string> = {
  opted_out: "Pediu descadastro",
  invalid_phone: "Telefone inválido",
  duplicate: "Número repetido na campanha",
  canceled: "Campanha cancelada antes do envio",
};

/** Por que a campanha parou sozinha — nunca é só "pausada", sempre tem motivo. */
export const BROADCAST_PAUSE_REASONS = [
  "manual",
  "instance_offline",
  "too_many_failures",
  "daily_limit",
] as const;
export type BroadcastPauseReason = (typeof BROADCAST_PAUSE_REASONS)[number];

export const BROADCAST_PAUSE_REASON_LABELS: Record<BroadcastPauseReason, string> = {
  manual: "Pausada por alguém da equipe",
  instance_offline: "A conexão do número caiu — o disparo parou sozinho",
  too_many_failures: "Falhas seguidas demais — o disparo parou por segurança",
  daily_limit: "Teto diário atingido; continua no próximo dia útil",
};

export const BROADCAST_CONTACT_SOURCES = ["manual", "import"] as const;
export type BroadcastContactSource = (typeof BROADCAST_CONTACT_SOURCES)[number];

/**
 * Quando a oportunidade do CRM nasce.
 *
 * **O padrão é `on_reply`, e isso é decisão, não acaso.** Criar um card por
 * contato disparado entope o funil com 5.000 cartas que ninguém respondeu, e
 * o Kanban deixa de significar "negócio em andamento" no dia seguinte ao
 * primeiro disparo. Quem respondeu, sim, é lead de verdade — e a resposta é
 * o evento que o sistema já sabe detectar (ver `repliedAt` na entrega).
 */
export const BROADCAST_CRM_MODES = ["never", "on_send", "on_reply"] as const;
export type BroadcastCrmMode = (typeof BROADCAST_CRM_MODES)[number];

export const BROADCAST_CRM_MODE_LABELS: Record<BroadcastCrmMode, string> = {
  never: "Não criar oportunidade",
  on_send: "Ao enviar a mensagem",
  on_reply: "Quando o contato responder (recomendado)",
};

export const BROADCAST_CRM_MODE_DESCRIPTIONS: Record<BroadcastCrmMode, string> = {
  never: "O disparo não mexe no CRM. A conversa aparece na Inbox como qualquer outra.",
  on_send:
    "Abre o card assim que a mensagem sai. Use para lista curta e qualificada — numa lista grande, o funil enche de card que ninguém respondeu.",
  on_reply:
    "Abre o card só para quem responder. É o que mantém o Kanban significando negócio em andamento.",
};

// ============================================================
// Travas contra bloqueio — o coração do módulo
// ============================================================

/**
 * Os limites que o sistema NÃO deixa ninguém furar.
 *
 * Cada número aqui existe por um motivo, e afrouxá-lo é decisão consciente
 * de quem aceita o risco de perder o chip:
 *
 * - `MIN_INTERVAL_SECONDS` (5): abaixo disso o padrão de envio deixa de
 *   parecer gente. O campo aceita configurar acima, nunca abaixo.
 * - `DEFAULT_MIN/MAX_INTERVAL_SECONDS` (30/90): o intervalo é uma FAIXA, e o
 *   worker sorteia dentro dela a cada mensagem. Intervalo fixo é assinatura
 *   de robô — 1.000 mensagens exatamente a cada 20s é o padrão mais fácil de
 *   detectar que existe. A faixa custa nada e quebra a regularidade.
 * - `DEFAULT_DAILY_LIMIT` (200): teto por campanha por dia. Número novo
 *   aguenta muito menos; número antigo com conversa de verdade aguenta mais.
 * - `MAX_CONSECUTIVE_FAILURES` (5): falha seguida é sintoma de bloqueio em
 *   curso. Parar no quinto erro salva o número; insistir até o fim da lista
 *   é o que o derruba.
 * - `MAX_AUDIENCE_SIZE` (10.000): teto por audiência, para o import não virar
 *   uma carga que trava a API.
 */
export const BROADCAST_LIMITS = {
  MIN_INTERVAL_SECONDS: 5,
  MAX_INTERVAL_SECONDS: 3600,
  DEFAULT_MIN_INTERVAL_SECONDS: 30,
  DEFAULT_MAX_INTERVAL_SECONDS: 90,
  DEFAULT_DAILY_LIMIT: 200,
  MAX_DAILY_LIMIT: 5000,
  MAX_CONSECUTIVE_FAILURES: 5,
  MAX_AUDIENCE_SIZE: 10_000,
  MAX_IMPORT_ROWS: 10_000,
  MESSAGE_MAX_LENGTH: 4096,
  /** Variações de texto além da principal (anti-padrão de mensagem idêntica). */
  MAX_MESSAGE_VARIANTS: 4,
} as const;

/**
 * Palavras que, recebidas de um contato disparado, o descadastram na hora.
 *
 * É a trava que evita a denúncia por spam — o caminho mais rápido para o
 * número ser banido não é o volume, é o cliente marcando "bloquear e
 * denunciar". Quem pede para sair e recebe de novo denuncia; quem pede para
 * sair e para de receber, não.
 *
 * A comparação é sobre a mensagem inteira NORMALIZADA (minúscula, sem
 * acento, sem pontuação) e exige igualdade, nunca "contém": uma frase como
 * "não quero parar de receber" contém "parar" e significa o contrário.
 */
export const BROADCAST_OPT_OUT_KEYWORDS = [
  "sair",
  "parar",
  "pare",
  "cancelar",
  "descadastrar",
  "remover",
  "stop",
  "nao quero mais receber",
  "nao quero receber",
] as const;

/** Normaliza para a comparação de descadastro (minúscula, sem acento e sem pontuação). */
export function normalizeOptOutText(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** A mensagem recebida é um pedido de descadastro? */
export function isOptOutMessage(text: string | null | undefined): boolean {
  if (!text) return false;
  const normalized = normalizeOptOutText(text);
  if (!normalized) return false;
  return (BROADCAST_OPT_OUT_KEYWORDS as readonly string[]).includes(normalized);
}

// ============================================================
// Variáveis da mensagem
// ============================================================

export interface BroadcastVariableDefinition {
  /** Nome técnico, como aparece entre chaves duplas. */
  key: string;
  label: string;
  description: string;
  example: string;
}

/**
 * Catálogo das variáveis do texto do disparo — a tela monta o menu com ele
 * e a API resolve com ele, fonte única como no catálogo da resposta rápida.
 *
 * `campo.<coluna>` é o curinga: QUALQUER coluna extra da planilha importada
 * vira variável com esse prefixo, sem cadastro nenhum. É o que permite a
 * planilha do escritório ter "cidade", "vencimento" ou "regime" e o texto
 * usar os três sem migration.
 */
export const BROADCAST_VARIABLES: BroadcastVariableDefinition[] = [
  {
    key: "nome",
    label: "Nome do contato",
    description: "Como o contato foi cadastrado na audiência.",
    example: "Maria Souza",
  },
  {
    key: "primeiro_nome",
    label: "Primeiro nome",
    description: "Só a primeira palavra do nome — o tratamento mais natural.",
    example: "Maria",
  },
  {
    key: "empresa",
    label: "Empresa",
    description: "A empresa do contato, quando a audiência trouxe esse campo.",
    example: "Souza Comércio Ltda",
  },
  {
    key: "telefone",
    label: "Telefone",
    description: "O número do contato, formatado.",
    example: "(11) 99999-8888",
  },
  {
    key: "saudacao",
    label: "Saudação do horário",
    description:
      "Bom dia, Boa tarde ou Boa noite conforme a hora do ENVIO (não a de montar a campanha).",
    example: "Boa tarde",
  },
  {
    key: "campo.<coluna>",
    label: "Coluna da planilha",
    description:
      "Qualquer coluna extra que a planilha trouxe. Ex.: {{campo.cidade}}, {{campo.vencimento}}.",
    example: "{{campo.cidade}}",
  },
];

const VARIABLE_PATTERN = /\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g;

/** Todas as chaves usadas num texto, na ordem em que aparecem, sem repetir. */
export function extractBroadcastVariables(template: string): string[] {
  const found: string[] = [];
  for (const match of template.matchAll(VARIABLE_PATTERN)) {
    const key = match[1];
    if (key && !found.includes(key)) found.push(key);
  }
  return found;
}

export interface BroadcastContactValues {
  name: string | null;
  company: string | null;
  /** Telefone já formatado para exibição. */
  phone: string;
  /** Colunas extras da planilha, chaveadas pelo nome normalizado da coluna. */
  fields: Record<string, string>;
}

/** "Bom dia" / "Boa tarde" / "Boa noite" pela hora informada. */
export function greetingForHour(hour: number): string {
  if (hour < 12) return "Bom dia";
  if (hour < 18) return "Boa tarde";
  return "Boa noite";
}

/**
 * Resolve o texto do disparo para UM contato.
 *
 * **Variável sem valor vira vazio, e o texto é costurado depois.** O
 * costurar não é enfeite: "Olá {{nome}}, tudo bem?" com nome vazio viraria
 * "Olá , tudo bem?" — uma vírgula solta que denuncia disparo automático na
 * primeira linha da mensagem. A limpeza tira o espaço antes da pontuação e
 * colapsa espaço duplo, então a frase continua lendo como gente escreveu.
 *
 * Diferente da resposta rápida (que vira `[Rótulo]` porque tem uma atendente
 * lendo antes do Enter), aqui **não há ninguém revisando no momento do
 * envio** — o nome técnico chegando ao cliente seria pior que o buraco. Quem
 * avisa é a tela de revisão, ANTES de começar: ela conta quantos contatos
 * ficariam com cada variável vazia.
 */
export function resolveBroadcastTemplate(
  template: string,
  values: BroadcastContactValues,
  now: Date = new Date(),
): string {
  const replaced = template.replace(VARIABLE_PATTERN, (_full, rawKey: string) => {
    const key = rawKey.trim();
    if (key.startsWith("campo.")) {
      return values.fields[key.slice("campo.".length).toLowerCase()] ?? "";
    }
    switch (key) {
      case "nome":
        return values.name ?? "";
      case "primeiro_nome":
        return (values.name ?? "").trim().split(/\s+/)[0] ?? "";
      case "empresa":
        return values.company ?? "";
      case "telefone":
        return values.phone;
      case "saudacao":
        return greetingForHour(now.getHours());
      default:
        return "";
    }
  });
  return tidyResolvedText(replaced);
}

/**
 * Costura o texto depois da substituição: espaço antes de pontuação, espaço
 * duplo e linha com só espaços somem. Sem isto, variável vazia deixa cicatriz
 * visível na mensagem que o cliente recebe.
 */
export function tidyResolvedText(text: string): string {
  return text
    .replace(/[ \t]+([,.;:!?])/g, "$1")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/^[ \t]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Nome de coluna da planilha → chave de variável (minúscula, sem acento, com "_"). */
export function normalizeColumnKey(column: string): string {
  return column
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

/**
 * Colunas que a importação reconhece sozinha, por nome. Qualquer outra vira
 * `campo.<coluna>` — não existe coluna "não suportada", só coluna que não é
 * nome, telefone nem empresa.
 */
export const BROADCAST_IMPORT_ALIASES: Record<"name" | "phone" | "company", string[]> = {
  name: ["nome", "name", "contato", "cliente", "nome_do_contato", "nome_completo"],
  phone: ["telefone", "phone", "celular", "whatsapp", "numero", "fone", "tel"],
  company: ["empresa", "company", "razao_social", "nome_da_empresa", "organizacao"],
};

/** Adivinha o papel de uma coluna pelo nome; null = vira `campo.<coluna>`. */
export function guessImportRole(column: string): "name" | "phone" | "company" | null {
  const key = normalizeColumnKey(column);
  for (const [role, aliases] of Object.entries(BROADCAST_IMPORT_ALIASES)) {
    if (aliases.includes(key)) return role as "name" | "phone" | "company";
  }
  return null;
}

// ============================================================
// Ritmo do envio
// ============================================================

/**
 * Sorteia o intervalo até a próxima mensagem, em milissegundos.
 *
 * O sorteio é o ponto: o WhatsApp não procura "muitas mensagens", procura
 * PADRÃO. Uma mensagem a cada 30s exatos por duas horas é padrão; entre 30 e
 * 90 segundos, não é. A função fica aqui, e não no worker, porque o teste
 * precisa fixá-la e a tela precisa mostrar a estimativa com a MESMA média.
 */
export function pickIntervalMs(
  minSeconds: number,
  maxSeconds: number,
  random: () => number = Math.random,
): number {
  const min = Math.max(BROADCAST_LIMITS.MIN_INTERVAL_SECONDS, Math.floor(minSeconds));
  const max = Math.max(min, Math.floor(maxSeconds));
  return (min + Math.floor(random() * (max - min + 1))) * 1000;
}

/** Estimativa de duração da campanha, em minutos, pela média do intervalo. */
export function estimateCampaignMinutes(
  pendingCount: number,
  minSeconds: number,
  maxSeconds: number,
): number {
  if (pendingCount <= 0) return 0;
  const average = (Math.max(minSeconds, BROADCAST_LIMITS.MIN_INTERVAL_SECONDS) + maxSeconds) / 2;
  return Math.ceil((pendingCount * average) / 60);
}

/** "cerca de 2 h 15 min" — o texto que a tela mostra na revisão. */
export function formatEstimate(minutes: number): string {
  if (minutes <= 0) return "imediato";
  if (minutes < 60) return `cerca de ${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `cerca de ${hours} h` : `cerca de ${hours} h ${rest} min`;
}

// ============================================================
// DTOs
// ============================================================

export interface BroadcastAudienceDto {
  id: string;
  name: string;
  description: string | null;
  contactCount: number;
  /** Quantos contatos da audiência estão na lista de descadastro da organização. */
  optedOutCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface BroadcastContactDto {
  id: string;
  name: string | null;
  company: string | null;
  phone: string;
  /** Telefone formatado para leitura. */
  phoneLabel: string;
  fields: Record<string, string>;
  source: BroadcastContactSource;
  /** Está descadastrado na organização — não recebe disparo nenhum. */
  optedOut: boolean;
  createdAt: string;
}

export interface BroadcastCampaignCountsDto {
  total: number;
  pending: number;
  sent: number;
  failed: number;
  skipped: number;
  /** Quantos responderam depois do disparo — a métrica que importa. */
  replied: number;
}

export interface BroadcastCampaignDto {
  id: string;
  name: string;
  status: BroadcastCampaignStatus;
  pausedReason: BroadcastPauseReason | null;
  audienceId: string;
  audienceName: string;
  whatsappInstanceId: string;
  instanceName: string | null;
  message: string;
  messageVariants: string[];
  scheduledFor: string | null;
  minIntervalSeconds: number;
  maxIntervalSeconds: number;
  dailyLimit: number | null;
  respectBusinessHours: boolean;
  crmMode: BroadcastCrmMode;
  crmPipelineId: string | null;
  crmStageId: string | null;
  crmPipelineName: string | null;
  crmStageName: string | null;
  tagId: string | null;
  tagName: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  nextSendAt: string | null;
  counts: BroadcastCampaignCountsDto;
  createdAt: string;
  updatedAt: string;
}

export interface BroadcastDeliveryDto {
  id: string;
  contactName: string | null;
  contactCompany: string | null;
  phone: string;
  phoneLabel: string;
  status: BroadcastDeliveryStatus;
  skipReason: BroadcastSkipReason | null;
  failureReason: string | null;
  /** O texto EXATO que saiu — congelado no envio. */
  content: string | null;
  sentAt: string | null;
  repliedAt: string | null;
  conversationId: string | null;
  attempts: number;
}

export interface BroadcastOptOutDto {
  id: string;
  phone: string;
  phoneLabel: string;
  reason: string;
  createdAt: string;
}

/** O que a prévia da planilha devolve antes de gravar qualquer coisa. */
export interface BroadcastImportPreviewDto {
  columns: string[];
  /** Papel adivinhado por coluna — a tela já abre com o mapeamento sugerido. */
  suggested: Record<string, "name" | "phone" | "company" | null>;
  /** Primeiras linhas, para a pessoa conferir que leu a planilha certa. */
  sample: Record<string, string>[];
  totalRows: number;
}

export interface BroadcastImportResultDto {
  imported: number;
  duplicated: number;
  invalid: number;
  optedOut: number;
  /** Até 20 linhas recusadas, com o motivo — para a pessoa corrigir a planilha. */
  rejected: { row: number; phone: string; reason: string }[];
}

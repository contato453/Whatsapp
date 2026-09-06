/**
 * CRM — o vocabulário do funil, compartilhado entre banco, API e tela.
 *
 * O CRM não é um sistema à parte: ele é uma camada de INTENÇÃO COMERCIAL por
 * cima do atendimento que já existe. Contato continua sendo a conversa do
 * WhatsApp, etiqueta continua sendo `Tag`, responsável continua sendo `User`,
 * departamento continua sendo `Department` e follow-up continua sendo
 * `ScheduledMessage` — nada disso ganha cópia aqui. O que nasce é só o que
 * não existia: funil, etapa, oportunidade, atividade e o histórico dela.
 *
 * Rótulo, cor e padrão moram neste arquivo pelo mesmo motivo de sempre: a API
 * valida com ele e a tela desenha com ele. Lista escrita duas vezes diverge
 * na primeira manutenção, e a divergência aparece como opção que a tela
 * oferece e o servidor recusa.
 */

// ============================================================
// Etapas
// ============================================================

/**
 * O que a etapa SIGNIFICA para o funil, independente do nome que o
 * escritório deu a ela.
 *
 * O tipo existe porque "Fechado" e "Perdido" não são só mais duas colunas:
 * cair numa etapa `won` encerra a oportunidade e cancela follow-up, cair numa
 * `lost` exige motivo. Sem o tipo, o sistema teria de adivinhar pelo nome — e
 * um funil chamado "Ganhamos!" quebraria a adivinhação em silêncio.
 */
export const CRM_STAGE_TYPES = ["open", "in_progress", "won", "lost"] as const;
export type CrmStageType = (typeof CRM_STAGE_TYPES)[number];

export const CRM_STAGE_TYPE_LABELS: Record<CrmStageType, string> = {
  open: "Aberta",
  in_progress: "Em andamento",
  won: "Ganha",
  lost: "Perdida",
};

export const CRM_STAGE_TYPE_DESCRIPTIONS: Record<CrmStageType, string> = {
  open: "Entrada do funil: a oportunidade ainda vai ser trabalhada.",
  in_progress: "Negociação em andamento — o grosso das colunas fica aqui.",
  won: "Fechamento: a oportunidade é marcada como ganha ao entrar nesta etapa.",
  lost: "Encerramento sem venda: ao entrar aqui o sistema exige o motivo da perda.",
};

/** Etapas que encerram a oportunidade — as duas que mudam o status dela. */
export function isClosingStageType(type: CrmStageType): boolean {
  return type === "won" || type === "lost";
}

// ============================================================
// Oportunidade
// ============================================================

export const CRM_OPPORTUNITY_STATUSES = ["open", "won", "lost"] as const;
export type CrmOpportunityStatus = (typeof CRM_OPPORTUNITY_STATUSES)[number];

export const CRM_OPPORTUNITY_STATUS_LABELS: Record<CrmOpportunityStatus, string> = {
  open: "Em aberto",
  won: "Ganha",
  lost: "Perdida",
};

/**
 * Verde fechou, vermelho perdeu, azul segue em jogo. O verde é o MESMO
 * `#16a34a` do status de atendimento (`CONVERSATION_STATUS_COLORS.open`), e
 * não o verde da marca: aqui ele responde "como está", que é exatamente a
 * pergunta do semáforo do atendimento.
 */
export const CRM_OPPORTUNITY_STATUS_COLORS: Record<CrmOpportunityStatus, string> = {
  open: "#2563eb",
  won: "#16a34a",
  lost: "#dc2626",
};

/**
 * De onde veio o lead. Texto de catálogo, e não enum do banco: origem nova
 * aparece com frequência (uma campanha, um evento) e não pode exigir
 * migration. O valor gravado é a chave; o rótulo sai daqui.
 */
export const CRM_ORIGINS = [
  "whatsapp",
  "indicacao",
  "instagram",
  "google",
  "site",
  "campanha",
  "formulario",
  "trafego_pago",
  "evento",
  "manual",
  "outro",
] as const;
export type CrmOrigin = (typeof CRM_ORIGINS)[number];

export const CRM_ORIGIN_LABELS: Record<CrmOrigin, string> = {
  whatsapp: "WhatsApp",
  indicacao: "Indicação",
  instagram: "Instagram",
  google: "Google",
  site: "Site",
  campanha: "Campanha",
  formulario: "Formulário",
  trafego_pago: "Tráfego pago",
  evento: "Evento",
  manual: "Cadastro manual",
  outro: "Outro",
};

export function isCrmOrigin(value: string): value is CrmOrigin {
  return (CRM_ORIGINS as readonly string[]).includes(value);
}

/** Rótulo de uma origem gravada; chave desconhecida volta como veio. */
export function crmOriginLabel(value: string | null | undefined): string {
  if (!value) return "Sem origem";
  return isCrmOrigin(value) ? CRM_ORIGIN_LABELS[value] : value;
}

/**
 * Origem de quem nasce dentro do atendimento. A oportunidade criada a partir
 * de uma conversa já sabe de onde veio — perguntar seria burocracia.
 */
export const CRM_ORIGIN_FROM_CONVERSATION: CrmOrigin = "whatsapp";

// ============================================================
// Dinheiro
// ============================================================

/**
 * Valor final = valor estimado menos o desconto, nunca negativo.
 *
 * Fica no shared porque a API grava e a tela mostra: se cada lado fizer a
 * conta, o card e o relatório passam a discordar por centavos e ninguém
 * descobre de onde vem a diferença.
 */
export function crmFinalValue(value: number, discount: number | null | undefined): number {
  const bruto = Number.isFinite(value) ? value : 0;
  const abatimento = discount && Number.isFinite(discount) ? discount : 0;
  return Math.max(0, round2(bruto - abatimento));
}

/**
 * Valor ponderado = valor final × probabilidade.
 *
 * É o número que o dono do escritório soma para saber quanto o funil vale
 * "de verdade" — a coluna Proposta com dez propostas de R$ 10.000 a 60% vale
 * R$ 60.000, não R$ 100.000.
 */
export function crmWeightedValue(finalValue: number, probability: number): number {
  const chance = Math.min(100, Math.max(0, probability));
  return round2(finalValue * (chance / 100));
}

/** Duas casas: dinheiro somado em ponto flutuante junta lixo depois da vírgula. */
function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * A probabilidade que vale para a oportunidade: a dela quando alguém a
 * definiu à mão, senão a da etapa.
 *
 * A da pessoa vence de propósito — quem está negociando sabe mais do que a
 * média da coluna. Mover de etapa NÃO apaga o ajuste manual: apagar faria a
 * correção sumir sem aviso no meio do arrasto.
 */
export function crmEffectiveProbability(
  opportunityProbability: number | null | undefined,
  stageProbability: number,
): number {
  return opportunityProbability ?? stageProbability;
}

/** Formata dinheiro em real — a mesma régua no card, na tabela e no relatório. */
export function formatCurrencyBRL(value: number): string {
  return new Intl.NumberFormat("pt-BR", {
    style: "currency",
    currency: "BRL",
    maximumFractionDigits: 2,
  }).format(Number.isFinite(value) ? value : 0);
}

// ============================================================
// Atividades
// ============================================================

export const CRM_ACTIVITY_TYPES = [
  "call",
  "whatsapp",
  "meeting",
  "proposal",
  "document",
  "billing",
  "followup",
  "task",
  "other",
] as const;
export type CrmActivityType = (typeof CRM_ACTIVITY_TYPES)[number];

export const CRM_ACTIVITY_TYPE_LABELS: Record<CrmActivityType, string> = {
  call: "Ligação",
  whatsapp: "WhatsApp",
  meeting: "Reunião",
  proposal: "Enviar proposta",
  document: "Enviar documento",
  billing: "Cobrança",
  followup: "Retorno",
  task: "Tarefa",
  other: "Outro",
};

export const CRM_ACTIVITY_STATUSES = ["pending", "done", "canceled"] as const;
export type CrmActivityStatus = (typeof CRM_ACTIVITY_STATUSES)[number];

export const CRM_ACTIVITY_STATUS_LABELS: Record<CrmActivityStatus, string> = {
  pending: "Pendente",
  done: "Concluída",
  canceled: "Cancelada",
};

export const CRM_ACTIVITY_PRIORITIES = ["low", "normal", "high"] as const;
export type CrmActivityPriority = (typeof CRM_ACTIVITY_PRIORITIES)[number];

export const CRM_ACTIVITY_PRIORITY_LABELS: Record<CrmActivityPriority, string> = {
  low: "Baixa",
  normal: "Normal",
  high: "Alta",
};

export const CRM_ACTIVITY_PRIORITY_COLORS: Record<CrmActivityPriority, string> = {
  low: "#64748b",
  normal: "#2563eb",
  high: "#dc2626",
};

/**
 * "Atrasada" NÃO é status gravado, é a leitura do relógio sobre uma
 * atividade pendente.
 *
 * Gravar o atraso obrigaria um processo varrendo a tabela para mudar linha de
 * status na virada da hora — e uma queda desse processo faria a tela mentir
 * dizendo que não há nada atrasado. Derivado, o atraso está sempre certo, e
 * concluir a atividade tira o vermelho sozinho.
 */
export function isCrmActivityOverdue(
  activity: { status: CrmActivityStatus; dueAt: string | Date | null },
  now: Date = new Date(),
): boolean {
  if (activity.status !== "pending" || !activity.dueAt) return false;
  const due = activity.dueAt instanceof Date ? activity.dueAt : new Date(activity.dueAt);
  return due.getTime() < now.getTime();
}

/** Recortes de prazo da tela de Atividades — a mesma lista nos dois lados. */
export const CRM_ACTIVITY_RANGES = ["overdue", "today", "tomorrow", "week", "done"] as const;
export type CrmActivityRange = (typeof CRM_ACTIVITY_RANGES)[number];

export const CRM_ACTIVITY_RANGE_LABELS: Record<CrmActivityRange, string> = {
  overdue: "Atrasadas",
  today: "Hoje",
  tomorrow: "Amanhã",
  week: "Esta semana",
  done: "Concluídas",
};

// ============================================================
// Ações de etapa (as "automações" do CRM)
// ============================================================

/**
 * Quando a ação roda: ao ENTRAR na etapa ou ao SAIR dela.
 *
 * Duas e não mais: "ficou X dias parada" é a mesma pergunta do SLA e sai
 * calculada de `stageEnteredAt`, sem precisar de gatilho gravado.
 */
export const CRM_STAGE_ACTION_TRIGGERS = ["enter", "leave"] as const;
export type CrmStageActionTrigger = (typeof CRM_STAGE_ACTION_TRIGGERS)[number];

export const CRM_STAGE_ACTION_TRIGGER_LABELS: Record<CrmStageActionTrigger, string> = {
  enter: "Ao entrar na etapa",
  leave: "Ao sair da etapa",
};

/**
 * O que a ação FAZ. Toda opção aqui é uma coisa que o AZVCHAT já sabia fazer
 * — etiqueta, responsável, departamento, nota interna, mensagem agendada.
 * Nenhum motor novo: a ação só chama o caminho que a equipe já usa na mão.
 *
 * `schedule_message` é o follow-up: ele cria uma `ScheduledMessage` de
 * verdade, com o mesmo `services/scheduler.ts` que envia as agendadas do
 * composer. Duplicar aquele motor aqui seria o erro clássico — dois
 * agendadores discordando sobre o que já foi enviado.
 */
export const CRM_STAGE_ACTION_TYPES = [
  "add_tag",
  "remove_tag",
  "assign_user",
  "change_department",
  "create_activity",
  "schedule_message",
  "internal_note",
] as const;
export type CrmStageActionType = (typeof CRM_STAGE_ACTION_TYPES)[number];

export const CRM_STAGE_ACTION_TYPE_LABELS: Record<CrmStageActionType, string> = {
  add_tag: "Adicionar etiqueta na conversa",
  remove_tag: "Remover etiqueta da conversa",
  assign_user: "Definir responsável da oportunidade",
  change_department: "Mudar o departamento da oportunidade",
  create_activity: "Criar atividade",
  schedule_message: "Agendar mensagem de follow-up",
  internal_note: "Registrar nota interna na conversa",
};

export const CRM_STAGE_ACTION_TYPE_HINTS: Record<CrmStageActionType, string> = {
  add_tag: "Usa as etiquetas que já existem no escritório — nada de lista paralela.",
  remove_tag: "Tira a etiqueta da conversa vinculada, se ela estiver lá.",
  assign_user: "Só vale para quem enxerga a conversa; quem não enxerga é recusado.",
  change_department: "Muda o departamento da oportunidade, não o da conversa.",
  create_activity: "Abre uma tarefa com prazo contado a partir da entrada na etapa.",
  schedule_message:
    "Cria uma mensagem agendada de verdade na conversa. Sai pelo agendador do sistema e é cancelada se o cliente responder antes.",
  internal_note: "Escreve na conversa uma nota que o cliente nunca vê.",
};

/** Ações que só fazem sentido com conversa vinculada (mexem no WhatsApp). */
export const CRM_STAGE_ACTIONS_REQUIRING_CONVERSATION: readonly CrmStageActionType[] = [
  "add_tag",
  "remove_tag",
  "schedule_message",
  "internal_note",
];

export function crmStageActionNeedsConversation(type: CrmStageActionType): boolean {
  return CRM_STAGE_ACTIONS_REQUIRING_CONVERSATION.includes(type);
}

// ============================================================
// Histórico
// ============================================================

/**
 * O que a linha do tempo registra. Um tipo por FATO, e não um texto livre:
 * o relatório de motivos e o filtro "movidas hoje" leem daqui, e texto livre
 * não se agrupa.
 */
export const CRM_EVENT_TYPES = [
  "created",
  "stage_changed",
  "assignee_changed",
  "department_changed",
  "value_changed",
  "tag_added",
  "tag_removed",
  "activity_created",
  "activity_done",
  "follow_up_scheduled",
  "follow_up_canceled",
  "client_replied",
  "won",
  "lost",
  "reopened",
  "updated",
  "note",
] as const;
export type CrmEventType = (typeof CRM_EVENT_TYPES)[number];

export const CRM_EVENT_TYPE_LABELS: Record<CrmEventType, string> = {
  created: "Oportunidade criada",
  stage_changed: "Movida de etapa",
  assignee_changed: "Responsável alterado",
  department_changed: "Departamento alterado",
  value_changed: "Valor alterado",
  tag_added: "Etiqueta adicionada",
  tag_removed: "Etiqueta removida",
  activity_created: "Atividade criada",
  activity_done: "Atividade concluída",
  follow_up_scheduled: "Follow-up agendado",
  follow_up_canceled: "Follow-up cancelado",
  client_replied: "Cliente respondeu",
  won: "Oportunidade ganha",
  lost: "Oportunidade perdida",
  reopened: "Oportunidade reaberta",
  updated: "Cadastro alterado",
  note: "Observação",
};

// ============================================================
// Modelo inicial do funil
// ============================================================

/**
 * O funil que o escritório recebe pronto. Existe porque CRM em branco é CRM
 * que ninguém usa: a primeira tela precisa ter colunas para arrastar.
 *
 * As probabilidades são as sugeridas pela operação, e tudo aqui é editável
 * depois — nada neste modelo é fixo no código.
 */
export interface CrmStageTemplate {
  name: string;
  probability: number;
  type: CrmStageType;
  color: string;
}

export const DEFAULT_PIPELINE_NAME = "Comercial";

export const DEFAULT_PIPELINE_STAGES: readonly CrmStageTemplate[] = [
  { name: "Novo Lead", probability: 10, type: "open", color: "#64748b" },
  { name: "Primeiro Contato", probability: 20, type: "in_progress", color: "#0ea5e9" },
  { name: "Qualificado", probability: 35, type: "in_progress", color: "#6366f1" },
  { name: "Proposta Enviada", probability: 60, type: "in_progress", color: "#a855f7" },
  { name: "Negociação", probability: 80, type: "in_progress", color: "#f59e0b" },
  { name: "Fechado", probability: 100, type: "won", color: "#16a34a" },
  { name: "Perdido", probability: 0, type: "lost", color: "#dc2626" },
];

/**
 * Motivos de perda de partida. Alimentam o relatório por motivo, então o
 * escritório começa com uma lista curta e fecha o que aprender depois —
 * campo livre não vira gráfico.
 */
export const DEFAULT_LOSS_REASONS: readonly string[] = [
  "Preço",
  "Sem interesse",
  "Fechou com concorrente",
  "Sem retorno",
  "Não qualificado",
  "Prazo",
  "Desistência",
  "Duplicado",
  "Outro",
];

// ============================================================
// Regras de tela que a API também precisa conhecer
// ============================================================

/** Teto de cards por coluna numa carga do Kanban — o resto vem por "carregar mais". */
export const CRM_BOARD_PAGE_SIZE = 30;

/** Teto da lista de Oportunidades (tabela) por página. */
export const CRM_LIST_PAGE_SIZE = 50;

/**
 * Passo entre posições de card dentro da coluna.
 *
 * Guardamos posição ESPAÇADA (10, 20, 30...) em vez de índice contíguo: mover
 * um card no meio da coluna passa a ser UMA escrita (a média entre os
 * vizinhos), e não a renumeração da coluna inteira a cada arrasto — que é o
 * que trava um Kanban com muitos cards e o que faz dois usuários arrastando
 * ao mesmo tempo embaralharem a ordem um do outro.
 */
export const CRM_POSITION_STEP = 1000;

/**
 * Posição de um card solto entre dois vizinhos. Sem vizinho de cima ele vai
 * para o topo; sem o de baixo, para o fim.
 */
export function crmPositionBetween(
  before: number | null | undefined,
  after: number | null | undefined,
): number {
  if (before == null && after == null) return CRM_POSITION_STEP;
  if (before == null) return (after as number) - CRM_POSITION_STEP;
  if (after == null) return before + CRM_POSITION_STEP;
  return (before + after) / 2;
}

/**
 * Quantos dias a oportunidade está parada na etapa. É o "2 dias nesta etapa"
 * do card e o que acende o alerta de parada quando passa do SLA da etapa.
 */
export function crmDaysInStage(stageEnteredAt: string | Date, now: Date = new Date()): number {
  const entrada = stageEnteredAt instanceof Date ? stageEnteredAt : new Date(stageEnteredAt);
  const ms = now.getTime() - entrada.getTime();
  return Math.max(0, Math.floor(ms / 86_400_000));
}

/** A oportunidade passou do prazo da etapa? SLA nulo = etapa sem prazo. */
export function crmStageSlaBroken(
  stageEnteredAt: string | Date,
  slaDays: number | null | undefined,
  now: Date = new Date(),
): boolean {
  if (slaDays == null || slaDays <= 0) return false;
  return crmDaysInStage(stageEnteredAt, now) >= slaDays;
}

/** Texto do tempo na etapa, já em português e no singular certo. */
export function crmTimeInStageLabel(stageEnteredAt: string | Date, now: Date = new Date()): string {
  const dias = crmDaysInStage(stageEnteredAt, now);
  if (dias === 0) return "hoje";
  if (dias === 1) return "1 dia nesta etapa";
  return `${dias} dias nesta etapa`;
}

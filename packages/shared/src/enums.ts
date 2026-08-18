/**
 * Enums compartilhados entre backend, frontend e provider de WhatsApp.
 * Espelham os enums do banco (Prisma) — a fonte de verdade do domínio.
 */

export const CONNECTION_STATUSES = [
  "disconnected",
  "connecting",
  "qr_required",
  "connected",
  "reconnecting",
  "error",
] as const;
export type ConnectionStatus = (typeof CONNECTION_STATUSES)[number];

/** Rótulos do estado do número (chip) — fonte única para badge, lista e dashboard. */
export const CONNECTION_STATUS_LABELS: Record<ConnectionStatus, string> = {
  disconnected: "Desconectado",
  connecting: "Conectando",
  qr_required: "Aguardando QR Code",
  connected: "Conectado",
  reconnecting: "Reconectando",
  error: "Erro",
};

/**
 * Verde no ar, âmbar em transição (vai voltar sozinho), vermelho travado,
 * cinza fora do ar por escolha de alguém.
 */
export const CONNECTION_STATUS_COLORS: Record<ConnectionStatus, string> = {
  disconnected: "#64748b",
  connecting: "#d97706",
  qr_required: "#d97706",
  connected: "#16a34a",
  reconnecting: "#d97706",
  error: "#dc2626",
};

export const CONVERSATION_TYPES = ["individual", "group"] as const;
export type ConversationType = (typeof CONVERSATION_TYPES)[number];

export const CONVERSATION_STATUSES = [
  "open",
  "waiting_client",
  "waiting_internal",
  "resolved",
] as const;
export type ConversationStatus = (typeof CONVERSATION_STATUSES)[number];

/** Rótulos exibidos na interface — fonte única para badges, abas e seletores. */
export const CONVERSATION_STATUS_LABELS: Record<ConversationStatus, string> = {
  open: "Aberto",
  waiting_client: "AG. Cliente",
  waiting_internal: "AG. Operacional",
  resolved: "Concluído",
};

/**
 * Cores do semáforo do atendimento: verde anda, amarelo espera o cliente,
 * vermelho está travado internamente, azul terminou.
 */
export const CONVERSATION_STATUS_COLORS: Record<ConversationStatus, string> = {
  open: "#16a34a",
  waiting_client: "#eab308",
  waiting_internal: "#dc2626",
  resolved: "#2563eb",
};

/** Status em que a conversa ainda exige acompanhamento da equipe. */
export const CONVERSATION_STATUSES_ACTIVE = [
  "open",
  "waiting_client",
  "waiting_internal",
] as const;

export const MESSAGE_DIRECTIONS = ["inbound", "outbound"] as const;
export type MessageDirection = (typeof MESSAGE_DIRECTIONS)[number];

export const MESSAGE_TYPES = [
  "text",
  "image",
  "audio",
  "video",
  "document",
  "sticker",
  "location",
  "contact",
  "poll",
  "call",
  "other",
] as const;
export type MessageType = (typeof MESSAGE_TYPES)[number];

export const MESSAGE_STATUSES = [
  "pending",
  "sent",
  "delivered",
  "read",
  "failed",
] as const;
export type MessageStatus = (typeof MESSAGE_STATUSES)[number];

export const USER_ROLES = ["admin", "supervisor", "agent"] as const;
export type UserRole = (typeof USER_ROLES)[number];

/** Rótulos exibidos na interface — o papel `agent` chama-se "Usuário" para o operador. */
export const USER_ROLE_LABELS: Record<UserRole, string> = {
  admin: "Administrador",
  supervisor: "Supervisor",
  agent: "Usuário",
};

/**
 * Hierarquia dos papéis. Fonte única: a API usa para proteger rota e o
 * frontend para montar o menu, então os dois nunca divergem.
 */
const ROLE_LEVEL: Record<UserRole, number> = {
  admin: 3,
  supervisor: 2,
  agent: 1,
};

/** true quando o papel do usuário atende ao mínimo exigido. */
export function hasRole(userRole: UserRole, minimumRole: UserRole): boolean {
  return ROLE_LEVEL[userRole] >= ROLE_LEVEL[minimumRole];
}

/**
 * Papel mínimo para gravar o departamento de uma conversa.
 *
 * Departamento não é classificação de atendimento: é o campo que decide
 * QUEM ENXERGA a conversa (ver `conversationScope` em `lib/access.ts`).
 * Deixar o atendente trocá-lo significa deixá-lo tirar a conversa do campo
 * de visão de um time inteiro — ou fazer a própria conversa sumir da tela
 * dele, sem que ele entenda o porquê. Classificar é decisão de supervisão.
 *
 * Fonte única do valor: a API protege a rota com ele e o painel de contexto
 * decide com ele se desenha o campo. Mudou aqui, muda nos dois.
 */
export const CONVERSATION_DEPARTMENT_MIN_ROLE: UserRole = "supervisor";

export const USER_STATUSES = ["active", "inactive"] as const;
export type UserStatus = (typeof USER_STATUSES)[number];

/**
 * Som do aviso de mensagem recebida — preferência pessoal de cada atendente,
 * como `signMessages`. Os três sons são sintetizados no navegador (Web Audio),
 * não há arquivo de áudio no repositório.
 *
 * `none` é silêncio escolhido de propósito, nunca o estado inicial: quem nunca
 * abriu Configurações ouve `sound_1`, porque a razão do recurso é justamente
 * a mensagem que passa despercebida com a Inbox em segundo plano.
 */
export const NOTIFICATION_SOUNDS = ["none", "sound_1", "sound_2", "sound_3"] as const;
export type NotificationSound = (typeof NOTIFICATION_SOUNDS)[number];

export const NOTIFICATION_SOUND_LABELS: Record<NotificationSound, string> = {
  none: "Nenhum",
  sound_1: "Som 1",
  sound_2: "Som 2",
  sound_3: "Som 3",
};

/**
 * Descrição curta do timbre, para a pessoa reconhecer o que vai ouvir antes
 * mesmo de clicar em ouvir — e depois lembrar qual escolheu.
 */
export const NOTIFICATION_SOUND_DESCRIPTIONS: Record<NotificationSound, string> = {
  none: "Sem som ao receber mensagem",
  sound_1: "Dois toques curtos, subindo",
  sound_2: "Toque único, tipo sino",
  sound_3: "Dois toques graves, descendo",
};

/**
 * Volume do aviso, em três degraus. O ganho de cada um mora no módulo de
 * áudio do frontend — aqui ficam só o domínio e os rótulos.
 */
export const NOTIFICATION_VOLUMES = ["low", "medium", "high"] as const;
export type NotificationVolume = (typeof NOTIFICATION_VOLUMES)[number];

export const NOTIFICATION_VOLUME_LABELS: Record<NotificationVolume, string> = {
  low: "Baixo",
  medium: "Médio",
  high: "Alto",
};

/**
 * Papel da pessoa dentro do cliente, marcado pela equipe no painel do grupo.
 *
 * Nada a ver com `isAdmin` do participante, que é administrador do GRUPO no
 * WhatsApp e vem do sync. Aqui é cadastro: quem decide (sócio) e quem
 * resolve o dia a dia (administrativo). Ausência de marcação = null.
 */
export const PARTICIPANT_CLIENT_ROLES = ["partner", "administrative"] as const;
export type ParticipantClientRole = (typeof PARTICIPANT_CLIENT_ROLES)[number];

export const PARTICIPANT_CLIENT_ROLE_LABELS: Record<ParticipantClientRole, string> = {
  partner: "Sócio",
  administrative: "ADM",
};

/**
 * Cores propositalmente distantes do âmbar do selo "admin" do WhatsApp: a
 * equipe precisa distinguir de relance papel no cliente de administrador do
 * grupo. Azul-marinho para sócio (decisão), azul claro para administrativo
 * (operação) — dois degraus da mesma família, separados pela luminância.
 *
 * O sócio era roxo (`#7c3aed`) e mudou junto com a saída do indigo da
 * interface. Não virou verde de propósito: verde aqui encostaria no `#16a34a`
 * de "Aberto"/"conectado", e este marcador é papel de pessoa, não estado.
 */
export const PARTICIPANT_CLIENT_ROLE_COLORS: Record<ParticipantClientRole, string> = {
  partner: "#102a4c",
  administrative: "#0284c7",
};

/**
 * Último degrau da cadeia de nomes do participante: nem nome nem telefone
 * conhecidos, o que acontece em grupo com endereçamento "@lid" de gente que
 * nunca escreveu. Um rótulo neutro é a única saída honesta — o LID é
 * identificador interno e exibi-lo faria a equipe achar que é telefone.
 */
export const PARTICIPANT_WITHOUT_NAME_LABEL = "Participante sem nome";

export const ASSIGNMENT_ACTIONS = [
  "assigned",
  "transferred_user",
  "transferred_department",
  "unassigned",
  "assigned_to_all",
  "unassigned_from_all",
  "resolved",
  "reopened",
] as const;
export type AssignmentAction = (typeof ASSIGNMENT_ACTIONS)[number];

/**
 * Como cada ação aparece no histórico do painel de contexto. Vive aqui, e não
 * no componente, pelo mesmo motivo dos outros rótulos: ação nova no enum sem
 * rótulo correspondente é linha em branco no histórico.
 */
export const ASSIGNMENT_ACTION_LABELS: Record<AssignmentAction, string> = {
  assigned: "assumiu o atendimento",
  transferred_user: "transferiu o atendimento",
  transferred_department: "transferiu para departamento",
  unassigned: "removeu o responsável",
  assigned_to_all: "marcou como @todos",
  unassigned_from_all: "tirou de @todos",
  resolved: "concluiu o atendimento",
  reopened: "reabriu o atendimento",
};

/**
 * Atendimento coletivo: a conversa é de todo o departamento, e não de uma
 * pessoa.
 *
 * O rótulo começa com "@" para não se confundir com nome de gente — na lista
 * de conversas ele ocupa exatamente o lugar onde apareceria o responsável.
 * No banco não existe usuário "@todos": a conversa marcada continua com
 * `assignedUserId` nulo, e é a coluna `assignedToAll` que distingue o
 * coletivo por decisão da conversa órfã esperando alguém pegar.
 */
export const ALL_USERS_ASSIGNEE_LABEL = "@todos";

/** Linha de apoio do seletor de responsável, para o efeito ficar explícito. */
export const ALL_USERS_ASSIGNEE_HINT = "Aparece para todo o departamento, sem dono fixo";

/**
 * Mídia anexável a uma resposta rápida: só imagem, áudio e vídeo. Documento
 * fica de fora de propósito — resposta rápida é conteúdo padronizado de
 * atendimento, não repositório de arquivos; boleto e contrato variam por
 * cliente e continuam indo pelo clipe do composer.
 */
export const QUICK_REPLY_MEDIA_TYPES = ["image", "audio", "video"] as const;
export type QuickReplyMediaType = (typeof QUICK_REPLY_MEDIA_TYPES)[number];

export const QUICK_REPLY_MEDIA_TYPE_LABELS: Record<QuickReplyMediaType, string> = {
  image: "Imagem",
  audio: "Áudio",
  video: "Vídeo",
};

/**
 * Deduz o tipo pelo mime type; null significa "não pode ser anexado". Vive
 * no shared porque a mesma decisão vale nas duas pontas: a API recusa o
 * upload e a tela recusa o arquivo antes mesmo de enviar.
 */
export function quickReplyMediaTypeFromMime(
  mimeType: string | null | undefined,
): QuickReplyMediaType | null {
  // "audio/ogg; codecs=opus" precisa contar como áudio: só a base decide.
  const base = (mimeType ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
  if (base.startsWith("image/")) return "image";
  if (base.startsWith("audio/")) return "audio";
  if (base.startsWith("video/")) return "video";
  return null;
}

/**
 * A etiqueta ou resposta rápida vale para uma conversa? Geral vale sempre;
 * conversa sem departamento aceita qualquer item visível (ela existe quando
 * o número não tem departamento padrão); restrita exige o departamento da
 * conversa na lista. Fonte única da regra: a tela decide o que oferecer e a
 * API valida o envio com a MESMA decisão.
 */
export function departmentResourceAppliesTo(
  isGeneral: boolean,
  departmentIds: string[],
  conversationDepartmentId: string | null,
): boolean {
  if (isGeneral) return true;
  if (conversationDepartmentId === null) return true;
  return departmentIds.includes(conversationDepartmentId);
}

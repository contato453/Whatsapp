import type { AiBudgetPolicy, AiSessionDto } from "./ai.js";
import type { ConnectionStatus, MessageStatus } from "./enums.js";

/**
 * Nomes e payloads dos eventos Socket.IO trocados entre API e frontend.
 * Payloads carregam DTOs serializados (datas como string ISO).
 */
export const RealtimeEvents = {
  MessageNew: "message:new",
  MessageStatus: "message:status",
  MessageReaction: "message:reaction",
  MessageUpdated: "message:updated",
  /** Chamada tocando agora — aviso na tela do atendente responsável. */
  CallIncoming: "call:incoming",
  /**
   * Mudança de estado de UMA chamada (tocando → atendida → encerrada). O painel
   * do discador acompanha por aqui: numa chamada de SAÍDA a tela dispara, mas
   * quem avisa que o outro lado atendeu ou desligou é este evento. Vai para a
   * audiência da conversa, como os demais eventos de chamada.
   */
  CallStatus: "call:status",
  ConversationUpdated: "conversation:updated",
  /**
   * Leitura de uma conversa mudou — e é a única coisa do sistema que vai
   * para UMA PESSOA, e não para a audiência da conversa: leitura é estado
   * pessoal. Mandá-lo para a sala da conversa zeraria o aviso de quem não
   * leu, que é exatamente o defeito que a leitura por usuário conserta.
   */
  ConversationRead: "conversation:read",
  GroupParticipants: "group:participants",
  InternalNote: "note:new",
  /**
   * Fixações (pin) da conversa mudaram — fixar, desafixar ou substituir a
   * mais antiga. Carrega a LISTA INTEIRA (no máximo 3, ver `MAX_PINNED_ITEMS`
   * em `lib/pinned-items.ts` na API), porque reenviar tudo é mais simples do
   * que sincronizar patches e o tamanho já é pequeno por construção. Evento
   * próprio, e não `conversation:updated`: aquele DTO é o da LISTA da Inbox,
   * publicado a cada card, e carregar fixações nele pagaria a consulta em
   * toda linha — o mesmo motivo pelo qual `scheduledPendingCount` fica de
   * fora dele. Também não é `message:updated`: fixação pode ser de uma NOTA
   * interna, que não é `Message`.
   */
  PinnedItems: "conversation:pinned-items",
  InstanceStatus: "instance:status",
  InstanceQr: "instance:qr",
  /** Quantos agendamentos pendentes a conversa tem agora. */
  ScheduledPending: "scheduled:pending",
  /** Falta pouco para o horário de uso fechar — aviso na tela. */
  SessionClosing: "session:closing",
  /** O horário fechou: a sessão acabou de ser encerrada. */
  SessionClosed: "session:closed",
  /**
   * O atendimento por IA de uma conversa mudou: começou, respondeu (contador
   * de mensagens), transferiu, foi assumido ou encerrado. Carrega a sessão
   * inteira (ou `null` quando nunca houve) — é a faixa "Atendimento por IA"
   * da Inbox. Vai para a `conversationAudience()` da conversa, como todo
   * evento de conversa. Evento próprio, e não `conversation:updated`, pelo
   * mesmo motivo das fixações: aquele DTO é o da lista, e carregar a sessão
   * de IA nele pagaria uma consulta por linha.
   */
  AiSession: "ai:session",
  /**
   * O consumo de IA cruzou um degrau do orçamento mensal (50/80/90/100%).
   * Vai para a sala da organização (só administradores a ouvem).
   */
  AiBudgetAlert: "ai:budget-alert",
} as const;

/** Sessão de IA de uma conversa mudou. `session` nulo = nenhuma sessão. */
export interface AiSessionPayload {
  conversationId: string;
  session: AiSessionDto | null;
}

export interface AiBudgetAlertPayload {
  threshold: number;
  percent: number;
  spentMicros: number;
  monthlyBudgetCents: number;
  /** Política aplicada ao cruzar 100%. */
  policy: AiBudgetPolicy;
}

/**
 * Aviso de que o horário de uso do sistema está para fechar.
 *
 * Vai só para quem a restrição alcança (quem não é supervisor, com a
 * restrição ligada), e é reenviado a cada minuto enquanto durar a contagem
 * — assim o aviso na tela conta para trás sozinho, sem o frontend precisar
 * manter um relógio próprio que erraria se a aba dormisse.
 */
export interface SessionClosingPayload {
  minutesLeft: number;
  /** "HH:MM" do fechamento, no fuso do escritório. */
  closesAt: string;
}

/**
 * A sessão foi encerrada pelo fim do horário. O servidor já recusa qualquer
 * requisição desta pessoa; o evento existe para a aba parada saber disso na
 * hora, em vez de mostrar uma Inbox congelada até alguém clicar em algo.
 */
export interface SessionClosedPayload {
  reason: "login_schedule";
  message: string;
}

/**
 * Contador de mensagens agendadas ainda por sair de uma conversa.
 *
 * `pending` é o único status que entra: `sent`, `failed` e `canceled` já
 * saíram da fila. Tentativa que falhou e será repetida continua `pending`
 * (só sobe `attempts`), então o número não muda por causa de retentativa.
 */
export interface ScheduledPendingPayload {
  conversationId: string;
  pending: number;
}

/**
 * Quantas mensagens recebidas ESTA PESSOA ainda não leu na conversa.
 *
 * Vai só para as abas de quem leu (sala `user:<userId>`), para a segunda aba
 * da mesma pessoa acompanhar sem recarregar. O contador nunca viaja no DTO da
 * conversa: aquele payload é de audiência, e um número pessoal ali vazaria
 * para todo mundo que enxerga a conversa.
 */
export interface ConversationReadPayload {
  conversationId: string;
  unreadCount: number;
}

export interface InstanceStatusPayload {
  instanceId: string;
  status: ConnectionStatus;
  phoneNumber?: string | null;
  reason?: string;
}

export interface InstanceQrPayload {
  instanceId: string;
  qrDataUrl: string;
}

export interface MessageStatusPayload {
  conversationId: string;
  messageId: string;
  status: MessageStatus;
}

/** Estado ao vivo de uma chamada, para o painel do discador. */
export type CallLiveStatus = "ringing" | "accepted" | "ended" | "rejected" | "missed";

export interface CallStatusPayload {
  callId: string;
  conversationId: string;
  status: CallLiveStatus;
}

/** Grupo conhecido de que quem liga participa — diz "de qual cliente" é a pessoa. */
export interface CallerGroupRef {
  /** Conversa do grupo na Inbox; null quando o grupo ainda não virou conversa. */
  conversationId: string | null;
  name: string;
}

/**
 * De onde vem a foto de quem liga. A chave do arquivo nunca viaja — o
 * frontend busca pelo endpoint autenticado correspondente à fonte.
 */
export interface CallerAvatarRef {
  source: "conversation" | "participant";
  id: string;
}

/**
 * Chamada tocando agora. O sistema não atende nem rejeita — este aviso
 * existe para o atendente saber na hora e poder retornar.
 *
 * A identidade de quem liga chega RESOLVIDA pela API (nome, telefone real,
 * grupos, foto): a tela não consulta nada, só desenha. Mesma audiência de
 * sempre — quem não enxerga o número nunca recebe este evento.
 */
export interface CallIncomingPayload {
  conversationId: string;
  /** Id da chamada no provider — necessário para ATENDER/recusar pelo discador. */
  callId: string;
  conversationTitle: string;
  /** Nome resolvido pela API; null = contato não identificado. Nunca é um LID. */
  callerName: string | null;
  /**
   * Telefone REAL, quando alguma fonte o conhece. Chamada por "@lid" sem
   * telefone no cadastro chega com null — os dígitos do LID não são número
   * discável e não podem ser exibidos como se fossem.
   */
  callerPhone: string | null;
  /** Grupos do sistema de que a pessoa participa (vazio em chamada de grupo). */
  callerGroups: CallerGroupRef[];
  /** Foto de quem liga; null = sem foto conhecida (a tela mostra iniciais). */
  callerAvatar: CallerAvatarRef | null;
  isVideo: boolean;
  isGroup: boolean;
  /** Responsável pela conversa; null = ninguém assumiu ainda */
  assignedUserId: string | null;
  instanceId: string;
  /** Nome do número da casa por onde a chamada entrou — o "chip" exibido no aviso. */
  instanceName: string | null;
  at: string;
}

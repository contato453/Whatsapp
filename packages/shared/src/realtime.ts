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
  InstanceStatus: "instance:status",
  InstanceQr: "instance:qr",
  /** Quantos agendamentos pendentes a conversa tem agora. */
  ScheduledPending: "scheduled:pending",
  /** Falta pouco para o horário de uso fechar — aviso na tela. */
  SessionClosing: "session:closing",
  /** O horário fechou: a sessão acabou de ser encerrada. */
  SessionClosed: "session:closed",
} as const;

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

/**
 * Chamada tocando agora. O sistema não atende nem rejeita — este aviso
 * existe para o atendente saber na hora e poder retornar.
 */
export interface CallIncomingPayload {
  conversationId: string;
  conversationTitle: string;
  callerName: string | null;
  callerPhone: string | null;
  isVideo: boolean;
  isGroup: boolean;
  /** Responsável pela conversa; null = ninguém assumiu ainda */
  assignedUserId: string | null;
  instanceId: string;
  at: string;
}

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
  GroupParticipants: "group:participants",
  InternalNote: "note:new",
  InstanceStatus: "instance:status",
  InstanceQr: "instance:qr",
} as const;

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

import type { ConnectionStatus, MessageStatus } from "./enums.js";

/**
 * Nomes e payloads dos eventos Socket.IO trocados entre API e frontend.
 * Payloads carregam DTOs serializados (datas como string ISO).
 */
export const RealtimeEvents = {
  MessageNew: "message:new",
  MessageStatus: "message:status",
  ConversationUpdated: "conversation:updated",
  GroupParticipants: "group:participants",
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

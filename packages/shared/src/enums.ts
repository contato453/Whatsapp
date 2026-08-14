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

export const CONVERSATION_TYPES = ["individual", "group"] as const;
export type ConversationType = (typeof CONVERSATION_TYPES)[number];

export const CONVERSATION_STATUSES = [
  "new",
  "open",
  "waiting",
  "resolved",
  "archived",
] as const;
export type ConversationStatus = (typeof CONVERSATION_STATUSES)[number];

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

export const USER_STATUSES = ["active", "inactive"] as const;
export type UserStatus = (typeof USER_STATUSES)[number];

export const ASSIGNMENT_ACTIONS = [
  "assigned",
  "transferred_user",
  "transferred_department",
  "unassigned",
  "resolved",
  "reopened",
] as const;
export type AssignmentAction = (typeof ASSIGNMENT_ACTIONS)[number];

import type {
  ConnectionStatus,
  ConversationStatus,
  ConversationType,
  MessageDirection,
  MessageStatus,
  MessageType,
  UserRole,
} from "@azvchat/shared";

/** DTOs retornados pela API (datas como string ISO). */

export interface UserDto {
  id: string;
  name: string;
  email: string;
  role: UserRole;
  status: "active" | "inactive";
  avatarUrl: string | null;
  createdAt: string;
}

/**
 * Usuário na tela de atendentes: inclui as conexões de WhatsApp liberadas.
 * Lista vazia = acesso a todas as conexões da organização.
 */
export interface UserWithAccessDto extends UserDto {
  whatsappInstanceIds: string[];
}

export interface InstanceDto {
  id: string;
  name: string;
  phoneNumber: string | null;
  status: ConnectionStatus;
  provider: string;
  lastConnectionAt: string | null;
  lastDisconnectionAt: string | null;
  createdAt: string;
}

export interface DepartmentDto {
  id: string;
  name: string;
  description: string | null;
  color: string | null;
}

export interface TagDto {
  id: string;
  name: string;
  color: string;
}

export interface ConversationDto {
  id: string;
  whatsappInstanceId: string;
  instanceName: string | null;
  instanceStatus: ConnectionStatus | null;
  externalChatId: string;
  type: ConversationType;
  title: string;
  hasAvatar: boolean;
  status: ConversationStatus;
  assignedUser: UserDto | null;
  department: DepartmentDto | null;
  tags: TagDto[];
  unreadCount: number;
  lastMessageAt: string | null;
  lastMessagePreview: string | null;
  createdAt: string;
}

export interface MessageReactionDto {
  emoji: string;
  senderName: string | null;
  fromMe: boolean;
}

export interface QuotedPreviewDto {
  id: string | null;
  senderName: string | null;
  content: string | null;
  type: string;
}

export interface MessageDto {
  id: string;
  conversationId: string;
  externalMessageId: string | null;
  reactions: MessageReactionDto[];
  quoted: QuotedPreviewDto | null;
  senderExternalId: string | null;
  senderName: string | null;
  senderPhone: string | null;
  direction: MessageDirection;
  type: MessageType;
  content: string | null;
  hasMedia: boolean;
  mimeType: string | null;
  filename: string | null;
  quotedMessageId: string | null;
  timestamp: string;
  status: MessageStatus;
  sentByUserId: string | null;
  deletedAt: string | null;
  editedAt: string | null;
  /** Dados extras por tipo — em enquetes traz { pollOptions } */
  metadata: {
    pollOptions?: string[];
    selectableCount?: number;
    callStatus?: string;
    isVideo?: boolean;
  } | null;
}

export interface GroupDetailDto {
  id: string;
  name: string;
  description: string | null;
  participantCount: number;
  participants: Array<{
    id: string;
    phoneNumber: string;
    name: string | null;
    isAdmin: boolean;
    hasAvatar: boolean;
  }>;
}

export interface NoteDto {
  id: string;
  conversationId?: string;
  content: string;
  user: UserDto | null;
  createdAt: string;
}

export interface AssignmentHistoryDto {
  id: string;
  action: string;
  performedBy: UserDto | null;
  note: string | null;
  createdAt: string;
}

export interface ConversationDetailDto {
  conversation: ConversationDto;
  group: GroupDetailDto | null;
  assignmentHistory: AssignmentHistoryDto[];
  notes: NoteDto[];
}

export interface ScheduledMessageDto {
  id: string;
  conversationId: string;
  content: string;
  scheduledFor: string;
  status: "pending" | "sent" | "failed" | "canceled";
  error: string | null;
  createdBy: UserDto | null;
  createdAt: string;
}

export interface QuickReplyDto {
  id: string;
  shortcut: string;
  title: string | null;
  content: string;
  createdAt: string;
}

export interface DashboardStatsDto {
  instancesConnected: number;
  instancesDisconnected: number;
  conversationsOpen: number;
  conversationsWaiting: number;
  conversationsUnassigned: number;
  messagesReceivedToday: number;
  messagesSentToday: number;
  conversationsByDepartment: Array<{
    departmentId: string | null;
    departmentName: string;
    count: number;
  }>;
}

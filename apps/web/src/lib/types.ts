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

/**
 * Usuário como ele aparece dentro do trabalho de outro: responsável pela
 * conversa, autor de nota, opção no seletor de atribuição. É tudo o que a
 * API devolve para quem não administra usuários.
 */
export interface UserDirectoryDto {
  id: string;
  name: string;
  role: UserRole;
  status: "active" | "inactive";
  avatarUrl: string | null;
}

/** Cadastro completo: só chega para o próprio usuário (/auth/me) e para o administrador. */
export interface UserDto extends UserDirectoryDto {
  email: string;
  /** Prefixa as mensagens enviadas com o nome do atendente */
  signMessages: boolean;
  /** Último acesso ao sistema — null se nunca entrou */
  lastLoginAt: string | null;
  createdAt: string;
}

/**
 * Usuário na tela de usuários: inclui as conexões de WhatsApp liberadas.
 * Lista vazia = acesso a todas as conexões da organização.
 */
export interface UserWithAccessDto extends UserDto {
  whatsappInstanceIds: string[];
  departmentIds: string[];
}

export interface InstanceDto {
  id: string;
  name: string;
  phoneNumber: string | null;
  departmentId: string | null;
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
  /** Responsável padrão: assume as conversas que entram sem ninguém */
  defaultAssigneeId: string | null;
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
  assignedUser: UserDirectoryDto | null;
  department: DepartmentDto | null;
  tags: TagDto[];
  unreadCount: number;
  lastMessageAt: string | null;
  lastMessagePreview: string | null;
  /** Código do cadastro no escritório ("EMPRESA 001", "GRUPO 040") */
  externalReference: string | null;
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
    externalContactId: string;
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
  user: UserDirectoryDto | null;
  createdAt: string;
}

export interface AssignmentHistoryDto {
  id: string;
  action: string;
  performedBy: UserDirectoryDto | null;
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
  createdBy: UserDirectoryDto | null;
  createdAt: string;
}

export interface QuickReplyDto {
  id: string;
  shortcut: string;
  title: string | null;
  content: string;
  createdAt: string;
}

export interface AgentReportRowDto {
  user: UserDto;
  messagesSent: number;
  conversationsHandled: number;
  /** Média em segundos; null quando não houve resposta a medir */
  avgResponseSeconds: number | null;
  responsesMeasured: number;
  conversationsResolved: number;
  /** Fila atual da pessoa — não depende do período */
  openNow: number;
}

export interface AgentReportDto {
  from: string;
  to: string;
  rows: AgentReportRowDto[];
  totals: {
    messagesReceived: number;
    messagesSent: number;
    conversationsResolved: number;
    openNow: number;
  };
  /** true quando o período estourou o teto e os números ficaram parciais */
  truncated: boolean;
}

export interface DashboardStatsDto {
  instancesConnected: number;
  instancesDisconnected: number;
  conversationsOpen: number;
  conversationsWaitingClient: number;
  conversationsWaitingInternal: number;
  conversationsUnassigned: number;
  messagesReceivedToday: number;
  messagesSentToday: number;
  conversationsByDepartment: Array<{
    departmentId: string | null;
    departmentName: string;
    count: number;
  }>;
}

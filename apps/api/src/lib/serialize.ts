import type {
  Conversation,
  Department,
  Message,
  Tag,
  User,
  WhatsAppInstance,
} from "@zapdesk/database";

/**
 * Serializadores de entidades para a API — controlam exatamente o que
 * sai para o frontend (nunca passwordHash, sessionId etc.).
 */

export function serializeUser(user: User) {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role,
    status: user.status,
    avatarUrl: user.avatarUrl,
    createdAt: user.createdAt.toISOString(),
  };
}

/**
 * Versão usada na tela de atendentes: inclui as conexões de WhatsApp
 * liberadas para o usuário (lista vazia = acesso a todas).
 */
export function serializeUserWithAccess(
  user: User & { whatsappAccess?: Array<{ whatsappInstanceId: string }> },
) {
  return {
    ...serializeUser(user),
    whatsappInstanceIds: user.whatsappAccess?.map((link) => link.whatsappInstanceId) ?? [],
  };
}

export function serializeInstance(instance: WhatsAppInstance) {
  return {
    id: instance.id,
    name: instance.name,
    phoneNumber: instance.phoneNumber,
    status: instance.status,
    provider: instance.provider,
    lastConnectionAt: instance.lastConnectionAt?.toISOString() ?? null,
    lastDisconnectionAt: instance.lastDisconnectionAt?.toISOString() ?? null,
    createdAt: instance.createdAt.toISOString(),
  };
}

export function serializeDepartment(department: Department) {
  return {
    id: department.id,
    name: department.name,
    description: department.description,
    color: department.color,
  };
}

export function serializeTag(tag: Tag) {
  return {
    id: tag.id,
    name: tag.name,
    color: tag.color,
  };
}

type ConversationWithRelations = Conversation & {
  assignedUser?: User | null;
  department?: Department | null;
  tags?: Array<{ tag: Tag }>;
  instance?: WhatsAppInstance | null;
};

export function serializeConversation(conversation: ConversationWithRelations) {
  return {
    id: conversation.id,
    whatsappInstanceId: conversation.whatsappInstanceId,
    instanceName: conversation.instance?.name ?? null,
    externalChatId: conversation.externalChatId,
    type: conversation.type,
    title: conversation.title,
    // A chave interna do arquivo nunca vai ao frontend; ele busca a imagem
    // pelo endpoint autenticado /conversations/:id/avatar.
    hasAvatar: conversation.profilePicture != null,
    status: conversation.status,
    assignedUser: conversation.assignedUser ? serializeUser(conversation.assignedUser) : null,
    department: conversation.department ? serializeDepartment(conversation.department) : null,
    tags: conversation.tags?.map((entry) => serializeTag(entry.tag)) ?? [],
    unreadCount: conversation.unreadCount,
    lastMessageAt: conversation.lastMessageAt?.toISOString() ?? null,
    lastMessagePreview: conversation.lastMessagePreview,
    externalReference: conversation.externalReference,
    externalSource: conversation.externalSource,
    createdAt: conversation.createdAt.toISOString(),
  };
}

export function serializeMessage(message: Message) {
  return {
    id: message.id,
    conversationId: message.conversationId,
    externalMessageId: message.externalMessageId,
    senderExternalId: message.senderExternalId,
    senderName: message.senderName,
    senderPhone: message.senderPhone,
    direction: message.direction,
    type: message.type,
    content: message.content,
    hasMedia: message.mediaUrl != null,
    mimeType: message.mimeType,
    filename: message.filename,
    quotedMessageId: message.quotedMessageId,
    timestamp: message.timestamp.toISOString(),
    status: message.status,
    sentByUserId: message.sentByUserId,
  };
}

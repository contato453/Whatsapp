import type {
  Conversation,
  Department,
  Message,
  QuickReply,
  Tag,
  User,
  WhatsAppInstance,
} from "@azvchat/database";

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
    // A chave do arquivo nunca sai da API; a imagem vem por /users/:id/avatar.
    hasAvatar: user.avatarUrl != null,
    signMessages: user.signMessages,
    lastLoginAt: user.lastLoginAt?.toISOString() ?? null,
    createdAt: user.createdAt.toISOString(),
  };
}

/**
 * Versão mínima, usada sempre que um usuário aparece dentro do trabalho de
 * outro: responsável pela conversa, autor de nota, seletor de atribuição.
 *
 * E-mail, último acesso e o mapa de números/departamentos são dados de
 * cadastro — só saem para quem administra usuários, nunca embutidos em
 * outra entidade.
 */
export function serializeUserDirectory(user: User) {
  return {
    id: user.id,
    name: user.name,
    role: user.role,
    status: user.status,
    // A chave do arquivo nunca sai da API; a imagem vem por /users/:id/avatar.
    hasAvatar: user.avatarUrl != null,
  };
}

/**
 * Versão usada na tela de atendentes: inclui as conexões de WhatsApp
 * liberadas para o usuário (lista vazia = acesso a todas).
 */
export function serializeUserWithAccess(
  user: User & {
    whatsappAccess?: Array<{ whatsappInstanceId: string }>;
    departmentAccess?: Array<{ departmentId: string }>;
  },
) {
  return {
    ...serializeUser(user),
    whatsappInstanceIds: user.whatsappAccess?.map((link) => link.whatsappInstanceId) ?? [],
    departmentIds: user.departmentAccess?.map((link) => link.departmentId) ?? [],
  };
}

export function serializeInstance(instance: WhatsAppInstance) {
  return {
    id: instance.id,
    name: instance.name,
    phoneNumber: instance.phoneNumber,
    departmentId: instance.departmentId,
    // Só o id: o nome é resolvido no frontend, que já carrega os usuários.
    defaultAssigneeId: instance.defaultAssigneeId,
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
    // Só o id: o nome é resolvido no frontend, que já carrega os usuários.
    defaultAssigneeId: department.defaultAssigneeId,
  };
}

/**
 * Departamentos de um recurso N:N, no formato em que as duas junções
 * (`TagDepartment` e `QuickReplyDepartment`) chegam com `include`.
 */
type DepartmentLink = { department: Department };

/**
 * A lista de departamentos vai completa para a tela, inclusive os que o
 * usuário não acessa: nome de departamento não é dado sensível, e sem ela a
 * pessoa não entenderia por que não consegue salvar a edição. Quem barra a
 * gravação parcial é `canWriteInAllDepartments`, na rota.
 */
function serializeResourceDepartments(links: DepartmentLink[] | undefined) {
  return (links ?? []).map((link) => ({
    id: link.department.id,
    name: link.department.name,
    color: link.department.color,
  }));
}

export function serializeTag(tag: Tag & { departments?: DepartmentLink[] }) {
  return {
    id: tag.id,
    name: tag.name,
    color: tag.color,
    // Geral é a flag, não a lista vazia: etiqueta restrita que perdeu todos
    // os departamentos fica com lista vazia e isGeneral false — invisível
    // para quem não é admin, que é o lado seguro.
    isGeneral: tag.isGeneral,
    departments: serializeResourceDepartments(tag.departments),
  };
}

export function serializeQuickReply(reply: QuickReply & { departments?: DepartmentLink[] }) {
  return {
    id: reply.id,
    shortcut: reply.shortcut,
    title: reply.title,
    content: reply.content,
    isGeneral: reply.isGeneral,
    departments: serializeResourceDepartments(reply.departments),
    createdAt: reply.createdAt.toISOString(),
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
    // Status da conexão do número, para sinalizar na lista de conversas
    instanceStatus: conversation.instance?.status ?? null,
    externalChatId: conversation.externalChatId,
    type: conversation.type,
    // `title` é o nome efetivo: o que a equipe definiu tem prioridade sobre o
    // que vem do WhatsApp. Assim toda a interface exibe o nome certo sem
    // precisar decidir nada.
    title: conversation.customTitle || conversation.title,
    customTitle: conversation.customTitle,
    /// Nome do WhatsApp, exibido como referência quando há nome próprio.
    whatsappTitle: conversation.title,
    partnerName: conversation.partnerName,
    // A chave interna do arquivo nunca vai ao frontend; ele busca a imagem
    // pelo endpoint autenticado /conversations/:id/avatar.
    hasAvatar: conversation.profilePicture != null,
    status: conversation.status,
    assignedUser: conversation.assignedUser
      ? serializeUserDirectory(conversation.assignedUser)
      : null,
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

/**
 * Conversa aberta na Inbox: o mesmo DTO da lista mais o que só faz sentido
 * na tela de uma conversa.
 *
 * `scheduledPendingCount` fica fora de `serializeConversation` de propósito:
 * a lista de conversas renderiza dezenas de linhas por carga e um `count`
 * por linha sairia caro justamente na tela mais usada do sistema.
 */
export function serializeConversationDetail(
  conversation: ConversationWithRelations,
  scheduledPendingCount: number,
) {
  return {
    ...serializeConversation(conversation),
    scheduledPendingCount,
  };
}

export interface MessageReactionView {
  emoji: string;
  senderName: string | null;
  fromMe: boolean;
}

/** Mensagem citada, resumida para a pré-visualização no chat. */
export interface QuotedPreview {
  id: string | null;
  senderName: string | null;
  content: string | null;
  type: string;
}

export function serializeMessage(
  message: Message & { reactions?: Array<{ emoji: string; senderName: string | null; fromMe: boolean }> },
  quoted?: QuotedPreview | null,
  /**
   * Nome/telefone resolvidos no cadastro de participantes ou contatos.
   * Usado quando a mensagem não carrega o telefone — caso dos grupos com
   * endereçamento "@lid". Nunca sobrescreve o que veio na mensagem.
   */
  sender?: { phoneNumber: string | null; name: string | null } | null,
) {
  return {
    id: message.id,
    conversationId: message.conversationId,
    externalMessageId: message.externalMessageId,
    reactions: message.reactions?.map((entry) => ({
      emoji: entry.emoji,
      senderName: entry.senderName,
      fromMe: entry.fromMe,
    })) ?? [],
    quoted: quoted ?? null,
    senderExternalId: message.senderExternalId,
    senderName: message.senderName ?? sender?.name ?? null,
    senderPhone: message.senderPhone ?? sender?.phoneNumber ?? null,
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
    deletedAt: message.deletedAt?.toISOString() ?? null,
    editedAt: message.editedAt?.toISOString() ?? null,
    // Dados extras por tipo (opções da enquete, por exemplo)
    metadata: (message.metadata as Record<string, unknown> | null) ?? null,
  };
}

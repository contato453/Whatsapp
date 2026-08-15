import type {
  Conversation,
  Department,
  GroupParticipant,
  Message,
  QuickReply,
  Tag,
  User,
  WhatsAppInstance,
} from "@azvchat/database";
import {
  formatPhone,
  PARTICIPANT_WITHOUT_NAME_LABEL,
  type AttendanceSettings,
  type ConnectionStatus,
  type ConversationStatus,
  type ConversationType,
  type DashboardPeriod,
  type UserRole,
} from "@azvchat/shared";

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
    // Preferência pessoal, só do próprio dono: fica fora de
    // serializeUserDirectory, que é o usuário visto por terceiros.
    notificationSound: user.notificationSound,
    notificationVolume: user.notificationVolume,
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

/**
 * Parâmetros de atendimento no formato da tela: o expediente sai sempre com
 * os sete dias em ordem, mesmo quando a organização ainda não tem linha no
 * banco e o que sai são os padrões de `@azvchat/shared`.
 */
export function serializeAttendanceSettings(settings: AttendanceSettings) {
  return {
    responseLimitMinutes: settings.responseLimitMinutes,
    timezone: settings.timezone,
    businessHours: settings.businessHours.map((day) => ({
      weekday: day.weekday,
      active: day.active,
      startTime: day.startTime,
      endTime: day.endTime,
    })),
  };
}

/** Uma linha do ranking das conversas mais ativas do período. */
export interface DashboardRankingRow {
  conversationId: string;
  title: string;
  type: ConversationType;
  instanceName: string | null;
  /** Responsável pelo atendimento; `null` quando a conversa está sem dono. */
  assignee: { userId: string; name: string; hasAvatar: boolean } | null;
  received: number;
  sent: number;
  total: number;
}

/**
 * Uma linha do top de usuários. `received` é o que o cliente mandou nas
 * conversas em que a pessoa é a responsável — mensagem de entrada não tem
 * autor do nosso lado, quem a recebeu é quem estava com a conversa na mão.
 */
export interface DashboardTopUserRow {
  userId: string;
  name: string;
  role: UserRole;
  hasAvatar: boolean;
  sent: number;
  received: number;
  total: number;
}

export interface DashboardStatsInput {
  period: DashboardPeriod;
  periodStart: Date;
  /** Nulo nos atalhos, que não têm corte superior — vale "até agora". */
  periodEnd: Date | null;
  generatedAt: Date;
  settings: AttendanceSettings;
  filters: {
    instanceId: string | null;
    departmentId: string | null;
    assignedUserId: string | null;
  };
  conversationsByStatus: Record<ConversationStatus, number>;
  instancesByStatus: Record<ConnectionStatus, number>;
  messagesReceived: number;
  messagesSent: number;
  overdue: { count: number; oldestWaitingMinutes: number | null };
  ranking: DashboardRankingRow[];
  /** `null` para quem não é supervisor: o bloco nem aparece na tela dele. */
  topUsers: DashboardTopUserRow[] | null;
  /** Um ponto por dia civil do período, inclusive os dias zerados. */
  timeline: Array<{ date: string; received: number; sent: number }>;
  /** Só as células com movimento; a tela desenha a grade vazia sozinha. */
  hourly: Array<{ weekday: number; hour: number; received: number; sent: number }>;
}

/**
 * Indicadores do dashboard. O total de conversas ativas é somado aqui, dos
 * mesmos quatro números que vão para a tela: se ele viesse de outra consulta,
 * a soma poderia não fechar e ninguém desconfiaria.
 *
 * O limite de resposta vigente viaja junto para a tela poder dizer contra o
 * que o atraso está sendo medido.
 */
export function serializeDashboardStats(input: DashboardStatsInput) {
  const byStatus = input.conversationsByStatus;
  const instances = input.instancesByStatus;
  return {
    period: input.period,
    periodStart: input.periodStart.toISOString(),
    periodEnd: input.periodEnd?.toISOString() ?? null,
    generatedAt: input.generatedAt.toISOString(),
    responseLimitMinutes: input.settings.responseLimitMinutes,
    timezone: input.settings.timezone,
    // Os filtros voltam como vieram: a tela confere que está desenhando o
    // recorte que a API realmente aplicou, e não o que ela pediu.
    filters: input.filters,
    conversations: {
      active: Object.values(byStatus).reduce((total, count) => total + count, 0),
      byStatus,
    },
    overdue: {
      count: input.overdue.count,
      oldestWaitingMinutes: input.overdue.oldestWaitingMinutes,
    },
    instances: {
      connected: instances.connected,
      disconnected: Object.entries(instances).reduce(
        (total, [status, count]) => (status === "connected" ? total : total + count),
        0,
      ),
      byStatus: instances,
    },
    messages: {
      received: input.messagesReceived,
      sent: input.messagesSent,
    },
    ranking: input.ranking,
    topUsers: input.topUsers,
    timeline: input.timeline,
    hourly: input.hourly,
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

/**
 * Fontes externas ao registro do participante que ajudam a descobrir nome e
 * telefone: o cadastro de contatos do número conectado e o `pushName` que o
 * WhatsApp envia junto das mensagens.
 */
export interface ParticipantNameSources {
  /** Contato salvo na agenda do número conectado, quando casa o identificador. */
  contact?: { phoneNumber: string | null; name: string | null } | null;
  /** Nome que a própria pessoa configurou, visto na última mensagem dela. */
  pushName?: string | null;
}

/**
 * Participante de grupo para o painel de contexto.
 *
 * A tela recebe o nome JÁ DECIDIDO (`name`) e também os campos crus, que a
 * edição precisa — nenhum componente refaz essa escolha.
 *
 * A cadeia, do mais forte para o mais fraco:
 *
 *   a. `customName` — o que a equipe definiu. Vence sempre porque é a única
 *      fonte que a casa controla: o sync do WhatsApp nunca a toca, então é a
 *      única que não some nem muda sozinha na próxima sincronização.
 *   b. nome do `Contact` — quem está salvo na agenda do número conectado.
 *      Vem antes do pushName porque é escolha de alguém do escritório
 *      ("Marina Contabilidade"), não o apelido que a pessoa pôs em si mesma.
 *   c. `name` do participante — o pushName que a própria pessoa configurou.
 *      Chega por duas vias: gravado na ingestão quando ela escreve, e o
 *      `sources.pushName` da última mensagem, que cobre quem já escreveu
 *      antes dessa gravação existir, sem precisar de backfill.
 *   d. telefone formatado.
 *   e. rótulo neutro. Nunca o LID cru: ele é identificador interno e exibi-lo
 *      faria a equipe tratá-lo como telefone.
 */
export function serializeGroupParticipant(
  participant: GroupParticipant,
  sources: ParticipantNameSources = {},
) {
  const phoneNumber = participant.phoneNumber || sources.contact?.phoneNumber || "";
  // Nome de origem: o melhor nome que NÃO veio da equipe. Vai para a tela
  // como referência ao editar, e é o degrau (b)+(c) da cadeia.
  const whatsappName =
    sources.contact?.name || participant.name || sources.pushName || null;
  const formattedPhone = formatPhone(phoneNumber);
  const name =
    participant.customName || whatsappName || formattedPhone || PARTICIPANT_WITHOUT_NAME_LABEL;
  return {
    id: participant.id,
    // Permite ligar o remetente de cada mensagem ao participante
    // (e, com isso, exibir a foto dele no chat).
    externalContactId: participant.externalContactId,
    phoneNumber,
    name,
    // Avisa a tela que o nome exibido É o telefone, para a segunda linha não
    // repetir a mesma informação. Quem decide continua sendo o backend.
    nameIsPhone: name === formattedPhone,
    // Sem nenhum nome real, o botão de renomear convida a dar um; com nome,
    // convida a editar. A tela não precisa refazer a conta.
    hasKnownName: (participant.customName ?? whatsappName) != null,
    customName: participant.customName,
    /// Nome de origem, exibido como referência quando há nome próprio.
    whatsappName,
    isAdmin: participant.isAdmin || participant.isSuperAdmin,
    // Papel no cliente, marcado pela equipe. Distinto de `isAdmin`, que é
    // administrador do grupo no WhatsApp.
    clientRole: participant.clientRole,
    hasAvatar: participant.avatarUrl != null,
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

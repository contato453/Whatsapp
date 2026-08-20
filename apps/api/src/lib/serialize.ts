import type {
  Conversation,
  Department,
  GroupParticipant,
  InternalNote,
  Message,
  ParticipantClientRole,
  QuickReply,
  Tag,
  User,
  WhatsAppInstance,
} from "@azvchat/database";
import {
  formatPhone,
  PARTICIPANT_WITHOUT_NAME_LABEL,
  quickReplyMediaTypeFromMime,
  readQuotedSnapshot,
  type AttendanceSettings,
  type ConnectionStatus,
  type ConversationStatus,
  type ConversationType,
  type ConfigurableRole,
  type DashboardPeriod,
  type PermissionAction,
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
 * A sessão: o usuário mais o conjunto de ações que ele pode executar agora.
 *
 * As permissões viajam JUNTO com o usuário, e não numa rota à parte, porque
 * a tela precisa das duas coisas no mesmo instante: sem elas ela deduziria
 * o que mostrar pelo papel, e toda configuração da tela de Permissões
 * viraria mentira visual — botão aparecendo para quem a API recusa.
 */
export function serializeSessionUser(user: User, permissions: PermissionAction[]) {
  return { ...serializeUser(user), permissions };
}

/**
 * Uma linha da tela de Permissões: a ação do catálogo, o valor efetivo por
 * papel e quem mudou por último. O catálogo em si não é serializado daqui —
 * a tela o importa de `@azvchat/shared`, que é a fonte única dos rótulos.
 */
export function serializeRolePermission(row: {
  role: ConfigurableRole;
  action: string;
  allowed: boolean;
  updatedAt: Date;
  updatedBy: User | null;
}) {
  return {
    role: row.role,
    action: row.action,
    allowed: row.allowed,
    updatedAt: row.updatedAt.toISOString(),
    updatedBy: row.updatedBy ? serializeUserDirectory(row.updatedBy) : null,
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
    // Número de backup: conversa nova nele nasce arquivada.
    isBackup: instance.isBackup,
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
    // A tela precisa dizer quais departamentos ficam fora dos números; sem
    // isso a equipe marcaria a caixa e não teria como conferir onde ela vale.
    isInternal: department.isInternal,
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
  // O tipo sai derivado do mime, nunca gravado: uma fonte só de decisão.
  const mediaType = quickReplyMediaTypeFromMime(reply.mediaMimeType);
  return {
    id: reply.id,
    shortcut: reply.shortcut,
    title: reply.title,
    content: reply.content,
    isGeneral: reply.isGeneral,
    departments: serializeResourceDepartments(reply.departments),
    // A chave do arquivo nunca sai da API; o binário vem por
    // GET /quick-replies/:id/media, autenticado e escopado.
    media:
      reply.mediaUrl && mediaType
        ? { type: mediaType, mimeType: reply.mediaMimeType, filename: reply.mediaFilename }
        : null,
    lastUsedAt: reply.lastUsedAt?.toISOString() ?? null,
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
    loginRestrictionEnabled: settings.loginRestrictionEnabled,
    loginHours: settings.loginHours.map((day) => ({
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
  /** Atendimento coletivo ("@todos") — sem dono por decisão, não por falta. */
  assignedToAll: boolean;
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
  /**
   * O recorte pedido, cada filtro em LISTA. Volta na resposta para a tela
   * conferir que está desenhando o que a API aplicou — com multisseleção isso
   * deixou de ser detalhe: o resumo do recorte ativo abaixo da barra é o
   * único jeito de a pessoa saber o que está vendo antes de ler os números.
   */
  filters: {
    instanceIds: string[];
    statuses: ConversationStatus[];
    /** Ids de departamento, mais o sentinela "sem departamento". */
    departmentIds: string[];
    /** Ids de pessoa, mais "sem responsável" e o coletivo "@todos". */
    assignedUserIds: string[];
  };
  conversationsByStatus: Record<ConversationStatus, number>;
  /** Total de arquivadas no recorte — estado de agora, ignora o período. */
  archivedConversations: number;
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
      // Fora da soma de ativas de propósito: arquivada não é atendimento.
      archived: input.archivedConversations,
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
  archivedBy?: User | null;
};

export function serializeConversation(
  conversation: ConversationWithRelations,
  /**
   * Nome da PESSOA (`PersonProfile.customName`) resolvido para conversa
   * individual — ver `lib/person-profile.ts`. Opcional porque nem todo ponto
   * de emissão precisa dele; quando vem, entra entre o apelido da conversa e
   * o título do WhatsApp: corrigir a pessoa no grupo corrige o privado.
   */
  personName?: string | null,
) {
  return {
    id: conversation.id,
    whatsappInstanceId: conversation.whatsappInstanceId,
    instanceName: conversation.instance?.name ?? null,
    // Status da conexão do número, para sinalizar na lista de conversas
    instanceStatus: conversation.instance?.status ?? null,
    externalChatId: conversation.externalChatId,
    type: conversation.type,
    // `title` é o nome efetivo: o que a equipe definiu tem prioridade sobre o
    // que vem do WhatsApp — o apelido DESTA conversa primeiro (decisão local
    // explícita), depois o nome da pessoa (vale no sistema inteiro).
    title: conversation.customTitle || personName || conversation.title,
    customTitle: conversation.customTitle,
    /// Nome do WhatsApp, exibido como referência quando há nome próprio.
    whatsappTitle: conversation.title,
    // A chave interna do arquivo nunca vai ao frontend; ele busca a imagem
    // pelo endpoint autenticado /conversations/:id/avatar.
    hasAvatar: conversation.profilePicture != null,
    status: conversation.status,
    assignedUser: conversation.assignedUser
      ? serializeUserDirectory(conversation.assignedUser)
      : null,
    // Atendimento coletivo: a tela mostra "@todos" no lugar do nome. Nunca
    // vem junto de `assignedUser` — as duas coisas se excluem no banco.
    assignedToAll: conversation.assignedToAll,
    department: conversation.department ? serializeDepartment(conversation.department) : null,
    tags: conversation.tags?.map((entry) => serializeTag(entry.tag)) ?? [],
    // Não lidas NÃO saem daqui: elas são por usuário, e este DTO é publicado
    // para a audiência inteira da conversa (`conversation:updated`,
    // `message:new`). Um número pessoal neste payload chegaria à tela de
    // todo mundo — o defeito que a leitura por usuário veio consertar. Quem
    // conta é `lib/conversation-reads.ts`, e o número viaja na resposta da
    // lista e no evento `conversation:read`, dirigido a uma pessoa só.
    // Nulo = não arquivada. Vai na lista e no evento de conversa: é como o
    // frontend sabe tirar (ou manter) a linha da visão certa sem reload.
    archivedAt: conversation.archivedAt?.toISOString() ?? null,
    // Nulo também no arquivamento automático do número de backup.
    archivedBy: conversation.archivedBy ? serializeUserDirectory(conversation.archivedBy) : null,
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
 * `scheduledPendingCount` e `pinnedItems` ficam fora de `serializeConversation`
 * de propósito: a lista de conversas renderiza dezenas de linhas por carga, e
 * um `count`/consulta a mais por linha sairia caro justamente na tela mais
 * usada do sistema. `pinnedItems` chega aqui só na carga inicial da conversa
 * aberta; depois disso quem mantém a lista em dia é o evento
 * `conversation:pinned-items`.
 */
export function serializeConversationDetail(
  conversation: ConversationWithRelations,
  scheduledPendingCount: number,
  pinnedItems: Parameters<typeof serializePinnedItems>[0],
  personName?: string | null,
) {
  return {
    ...serializeConversation(conversation, personName),
    scheduledPendingCount,
    pinnedItems: serializePinnedItems(pinnedItems),
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
  /**
   * Registro da PESSOA (`PersonProfile`), único na organização. Três estados,
   * e a diferença importa: objeto = a equipe decidiu no nível da pessoa e os
   * valores dele valem MESMO NULOS (limpar o nome é decisão); `null` =
   * resolvido e sem registro, vale o legado da linha do grupo; ausente
   * (`undefined`) = quem chamou não resolveu perfis, mesmo fallback.
   */
  profile?: { customName: string | null; clientRole: ParticipantClientRole | null } | null;
  /** Em quantos grupos da organização a pessoa está — o aviso da edição. */
  groupCount?: number;
}

/**
 * Participante de grupo para o painel de contexto.
 *
 * A tela recebe o nome JÁ DECIDIDO (`name`) e também os campos crus, que a
 * edição precisa — nenhum componente refaz essa escolha.
 *
 * A cadeia, do mais forte para o mais fraco:
 *
 *   a. o nome definido pela equipe — no registro da PESSOA (`PersonProfile`,
 *      único na organização e válido em todos os grupos) quando ele existe,
 *      senão o legado `customName` da linha deste grupo. Vence sempre porque
 *      é a única fonte que a casa controla: o sync do WhatsApp nunca a toca,
 *      então é a única que não some nem muda sozinha na próxima
 *      sincronização.
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
  // O que a equipe decidiu vive no registro da PESSOA quando ele existe —
  // registro presente vale inteiro, mesmo com campos nulos (limpar o nome é
  // decisão). Sem registro, vale o legado gravado na linha deste grupo.
  const customName = sources.profile ? sources.profile.customName : participant.customName;
  const clientRole = sources.profile ? sources.profile.clientRole : participant.clientRole;
  // Nome de origem: o melhor nome que NÃO veio da equipe. Vai para a tela
  // como referência ao editar, e é o degrau (b)+(c) da cadeia.
  const whatsappName =
    sources.contact?.name || participant.name || sources.pushName || null;
  const formattedPhone = formatPhone(phoneNumber);
  const name = customName || whatsappName || formattedPhone || PARTICIPANT_WITHOUT_NAME_LABEL;
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
    hasKnownName: (customName ?? whatsappName) != null,
    customName,
    /// Nome de origem, exibido como referência quando há nome próprio.
    whatsappName,
    isAdmin: participant.isAdmin || participant.isSuperAdmin,
    // Papel no cliente, marcado pela equipe. Distinto de `isAdmin`, que é
    // administrador do grupo no WhatsApp.
    clientRole,
    // Em quantos grupos da organização a pessoa está: é o número do aviso
    // "a alteração vale para todos os grupos". 1 é o piso — a pessoa está,
    // no mínimo, no grupo que a tela está mostrando.
    groupCount: sources.groupCount ?? 1,
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
    // Sem a leitura ao vivo (resposta do POST, eventos de tempo real, ou
    // original fora do banco), vale o resumo congelado no metadata — era a
    // falta deste fallback que fazia a resposta recém-enviada aparecer sem
    // o bloco de citação. Citação nunca é descartada em silêncio.
    quoted: quoted ?? readQuotedSnapshot(message.metadata),
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

/**
 * Nota interna, no formato usado pela faixa de fixadas
 * (`serializePinnedItems`). As rotas de nota (criar/editar/excluir) montam o
 * mesmo formato à mão, ponto a ponto — esta função existe para o código
 * NOVO não repetir a lista de campos pela quarta vez.
 */
export function serializeInternalNote(note: InternalNote & { user?: User | null }) {
  return {
    id: note.id,
    conversationId: note.conversationId,
    content: note.content,
    user: note.user ? serializeUserDirectory(note.user) : null,
    createdAt: note.createdAt.toISOString(),
  };
}

/**
 * Fixação (pin) — mensagem ou nota interna, nunca as duas: `message`/`note`
 * saem um deles nulo, conforme `kind`. Usado tanto no detalhe da conversa
 * (`GET /conversations/:id`) quanto no evento `conversation:pinned-items`,
 * que reenvia a lista inteira a cada mudança.
 */
export function serializePinnedItem(
  pin: {
    id: string;
    pinnedAt: Date;
    pinnedBy: User | null;
    message: (Message & { reactions?: never }) | null;
    note: (InternalNote & { user: User | null }) | null;
  },
) {
  return {
    id: pin.id,
    kind: pin.message ? ("message" as const) : ("note" as const),
    pinnedAt: pin.pinnedAt.toISOString(),
    pinnedBy: pin.pinnedBy ? serializeUserDirectory(pin.pinnedBy) : null,
    message: pin.message ? serializeMessage(pin.message) : null,
    note: pin.note ? serializeInternalNote(pin.note) : null,
  };
}

export function serializePinnedItems(
  pins: Array<Parameters<typeof serializePinnedItem>[0]>,
) {
  return pins.map(serializePinnedItem);
}

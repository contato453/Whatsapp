import type {
  ConnectionStatus,
  ConversationStatus,
  ConversationType,
  DashboardPeriod,
  MessageDirection,
  MessageStatus,
  MessageType,
  NotificationSound,
  NotificationVolume,
  ConfigurableRole,
  ParticipantClientRole,
  PermissionAction,
  QuickReplyMediaType,
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
  /** Tem foto de perfil interna — a imagem vem por /users/:id/avatar */
  hasAvatar: boolean;
}

/** Cadastro completo: só chega para o próprio usuário (/auth/me) e para o administrador. */
export interface UserDto extends UserDirectoryDto {
  /**
   * O que ESTA pessoa pode fazer agora, resolvido pela API a partir do
   * catálogo e da configuração da organização.
   *
   * A tela decide o que mostrar por esta lista, NUNCA deduzindo pelo papel:
   * deduzir faria a tela de Permissões virar mentira visual — botão
   * aparecendo para quem a API recusa, ou escondido para quem ela aceita.
   */
  permissions: PermissionAction[];
  email: string;
  /** Prefixa as mensagens enviadas com o nome do atendente */
  signMessages: boolean;
  /** Som do aviso de mensagem recebida — "none" desliga */
  notificationSound: NotificationSound;
  /** Volume do aviso de mensagem recebida */
  notificationVolume: NotificationVolume;
  /** Último acesso ao sistema — null se nunca entrou */
  lastLoginAt: string | null;
  createdAt: string;
}

/**
 * Usuário na tela de usuários: inclui as conexões de WhatsApp e os
 * departamentos liberados, os dois já dentro da resposta de `GET /users`.
 * Lista vazia = não enxerga conversa alguma por ali — não existe "sem
 * marcação = vê tudo" (ver `lib/access.ts` na API).
 */
export interface RolePermissionOverrideDto {
  role: ConfigurableRole;
  action: PermissionAction;
  allowed: boolean;
  updatedAt: string;
  updatedBy: UserDirectoryDto | null;
}

export interface UserWithAccessDto extends Omit<UserDto, "permissions"> {
  whatsappInstanceIds: string[];
  departmentIds: string[];
}

export interface InstanceDto {
  id: string;
  name: string;
  phoneNumber: string | null;
  departmentId: string | null;
  defaultAssigneeId: string | null;
  /** Número de backup: conversa nova nele já nasce arquivada. */
  isBackup: boolean;
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
  /**
   * Departamento interno: as conversas dele ficam fora dos NÚMEROS
   * (dashboard, atrasados agora, relatório por atendente). Não é
   * arquivamento — elas continuam na lista, contando não lidas e tocando o
   * som —, e não muda quem enxerga o quê.
   */
  isInternal: boolean;
  /**
   * Quem atua no departamento, supervisores primeiro. Só vem na listagem
   * completa (/departments); em /departments/mine fica ausente.
   */
  members?: Array<{ id: string; name: string; role: UserRole }>;
}

/** Departamento a que uma etiqueta ou resposta rápida está vinculada. */
export interface ResourceDepartmentDto {
  id: string;
  name: string;
  color: string | null;
}

export interface TagDto {
  id: string;
  name: string;
  color: string;
  /** Vale para todos os departamentos. Ligada, `departments` vem vazia. */
  isGeneral: boolean;
  /**
   * Todos os departamentos da etiqueta, inclusive os que o usuário não
   * acessa: nome de departamento não é dado sensível, e sem a lista completa
   * ele não entenderia por que a edição é recusada. Quem barra a gravação
   * parcial é a API.
   */
  departments: ResourceDepartmentDto[];
}

export interface ConversationDto {
  id: string;
  whatsappInstanceId: string;
  instanceName: string | null;
  instanceStatus: ConnectionStatus | null;
  externalChatId: string;
  type: ConversationType;
  /** Nome efetivo: o próprio, quando existe; senão o do WhatsApp. */
  title: string;
  /** Nome definido pela equipe (null = usando o do WhatsApp). */
  customTitle: string | null;
  /** Nome que veio do WhatsApp, exibido como referência. */
  whatsappTitle: string;
  hasAvatar: boolean;
  status: ConversationStatus;
  assignedUser: UserDirectoryDto | null;
  /**
   * Atendimento coletivo ("@todos"): a conversa é de todo o departamento.
   * Nunca vem junto de `assignedUser` — as duas coisas se excluem no banco.
   */
  assignedToAll: boolean;
  department: DepartmentDto | null;
  tags: TagDto[];
  /** Nulo = não arquivada. Arquivada não conta em número nenhum do sistema. */
  archivedAt: string | null;
  /** Quem arquivou; nulo no arquivamento automático do número de backup. */
  archivedBy: UserDirectoryDto | null;
  lastMessageAt: string | null;
  lastMessagePreview: string | null;
  /**
   * Referência externa: ou o código do cadastro digitado no escritório
   * ("EMPRESA 001"), ou o identificador da empresa no Azevedo-OS — quem
   * diz qual é `externalSource`.
   */
  externalReference: string | null;
  /**
   * `manual` = código digitado; `azevedo-os` = empresa vinculada pela
   * integração (`AZEVEDO_OS_SOURCE`); nulo = sem referência. A tela precisa
   * saber: o identificador do Azevedo-OS é interno e não vira chip.
   */
  externalSource: string | null;
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
    /**
     * JIDs marcados na mensagem ("@"). Vem do WhatsApp (recebidas) ou do
     * envio (enviadas) — nunca é deduzido do texto, porque o texto sozinho
     * não diz quem foi notificado.
     */
    mentions?: string[];
    /**
     * Histórico de edições: o que a mensagem dizia ANTES de cada correção,
     * do mais antigo para o mais recente. Chega pelo mesmo `metadata` que
     * já viajava no DTO, então o evento `message:updated` não mudou de
     * forma. Leia com `readMessageVersions` de `@azvchat/shared`.
     */
    versions?: Array<{ content: string | null; at: string }>;
    /**
     * O cliente editou e o WhatsApp não entregou o texto novo. A bolha
     * mostra o conteúdo anterior com aviso, em vez de fingir que está
     * atualizada.
     */
    editedContentUnavailable?: boolean;
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
    /**
     * Nome já decidido pela API — nunca nulo. A cadeia (customName, agenda
     * do número, pushName, telefone, rótulo neutro) é resolvida no
     * serializer; a tela só exibe.
     */
    name: string;
    /** O nome exibido é o próprio telefone: não repetir na segunda linha. */
    nameIsPhone: boolean;
    /** Existe algum nome de verdade (não é telefone nem rótulo neutro). */
    hasKnownName: boolean;
    customName: string | null;
    whatsappName: string | null;
    /** Administrador do GRUPO no WhatsApp — vem do sync, ninguém edita. */
    isAdmin: boolean;
    /** Papel da pessoa dentro do cliente, marcado pela equipe. */
    clientRole: ParticipantClientRole | null;
    /**
     * Em quantos grupos da organização a pessoa está. A edição vale para
     * todos eles (é o aviso mostrado antes de salvar); 1 é o piso.
     */
    groupCount: number;
    hasAvatar: boolean;
  }>;
}

export interface ConversationFileDto {
  id: string;
  type: MessageType;
  filename: string | null;
  mimeType: string | null;
  direction: MessageDirection;
  senderName: string | null;
  timestamp: string;
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

/**
 * Fixação (pin) de mensagem OU nota interna, nunca as duas — `kind` diz
 * qual dos dois vem preenchido. Fixação é INTERNA ao AZVCHAT: destaca algo
 * no topo da conversa só para a equipe, e nunca é enviada ao WhatsApp.
 */
export interface PinnedItemDto {
  id: string;
  kind: "message" | "note";
  pinnedAt: string;
  pinnedBy: UserDirectoryDto | null;
  message: MessageDto | null;
  note: NoteDto | null;
}

/**
 * Conversa aberta: o DTO da lista mais o que só o detalhe carrega.
 * `scheduledPendingCount` e `pinnedItems` não existem na lista de
 * propósito (um count/consulta a mais por linha sairia caro na tela mais
 * usada). Depois da carga inicial, `pinnedItems` é mantido em dia pelo
 * evento `conversation:pinned-items`.
 */
export interface ConversationDetailConversationDto extends ConversationDto {
  scheduledPendingCount: number;
  pinnedItems: PinnedItemDto[];
}

export interface ConversationDetailDto {
  conversation: ConversationDetailConversationDto;
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

/** Mídia anexada à resposta — o binário vem por /quick-replies/:id/media. */
export interface QuickReplyMediaDto {
  type: QuickReplyMediaType;
  mimeType: string;
  filename: string | null;
}

export interface QuickReplyDto {
  id: string;
  shortcut: string;
  title: string | null;
  content: string;
  /** Vale para todos os departamentos. Ligada, `departments` vem vazia. */
  isGeneral: boolean;
  /** Lista completa — ver a observação em TagDto. */
  departments: ResourceDepartmentDto[];
  media: QuickReplyMediaDto | null;
  /** Último ENVIO pelo composer; null = nunca usada desde que existe o registro. */
  lastUsedAt: string | null;
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
  /** Fila atual da pessoa, por status — não depende do período */
  queue: QueueByStatusDto;
  /** Soma da fila: aberto + AG. cliente + AG. operacional */
  openNow: number;
}

export interface QueueByStatusDto {
  open: number;
  waitingClient: number;
  waitingInternal: number;
}

/**
 * Linha da tabela que não pertence a ninguém: as conversas órfãs e as
 * coletivas ("@todos"). Só fila — mensagens, tempo médio e concluídas são
 * medidas de uma PESSOA, e zero ali seria lido como "não trabalhou".
 */
export interface AgentReportQueueRowDto {
  queue: QueueByStatusDto;
  openNow: number;
}

export interface AgentReportDto {
  from: string;
  to: string;
  rows: AgentReportRowDto[];
  /** Conversas sem responsável de verdade (nem pessoa, nem @todos). */
  unassigned: AgentReportQueueRowDto;
  /** Atendimento coletivo: sem dono por decisão, não por falta. */
  allUsers: AgentReportQueueRowDto;
  totals: {
    messagesReceived: number;
    messagesSent: number;
    conversationsResolved: number;
    /** Soma das três colunas de fila, incluindo as linhas sem dono. */
    openNow: number;
    /**
     * Total de cada coluna de status, para o cabeçalho. Inclui as linhas de
     * sem responsável e de @todos: o número do cabeçalho tem que bater com a
     * soma do que está visível na coluna.
     */
    queue: QueueByStatusDto;
  };
  /** Os filtros como a API os aplicou — a tela confere o que pediu. */
  filters: { departmentId: string[]; instanceId: string[] };
  /** true quando o período estourou o teto e os números ficaram parciais */
  truncated: boolean;
}

/** Uma linha do ranking das conversas mais ativas do período. */
export interface DashboardRankingRowDto {
  conversationId: string;
  /** Já resolvido pela API: `customTitle` vence `title`, como na Inbox. */
  title: string;
  type: ConversationType;
  instanceName: string | null;
  /** Responsável pelo atendimento; `null` quando a conversa está sem dono. */
  assignee: { userId: string; name: string; hasAvatar: boolean } | null;
  /** Atendimento coletivo ("@todos"): sem dono por decisão, não por falta. */
  assignedToAll: boolean;
  received: number;
  sent: number;
  total: number;
}

/**
 * Uma linha do top de usuários. `received` é o que o cliente mandou nas
 * conversas em que a pessoa é a responsável.
 */
export interface DashboardTopUserDto {
  userId: string;
  name: string;
  role: UserRole;
  hasAvatar: boolean;
  sent: number;
  received: number;
  total: number;
}

export interface DashboardStatsDto {
  period: DashboardPeriod;
  periodStart: string;
  /** Nulo nos atalhos, que valem "até agora". */
  periodEnd: string | null;
  generatedAt: string;
  /** Devolvidos como a API os aplicou, para a tela conferir o que desenhou. */
  filters: {
    instanceIds: string[];
    statuses: ConversationStatus[];
    /** Ids de departamento, mais o sentinela "sem departamento". */
    departmentIds: string[];
    /** Ids de pessoa, mais "sem responsável" e o coletivo "@todos". */
    assignedUserIds: string[];
  };
  /** Limite vigente nos parâmetros de atendimento, para a tela dizer contra o que mede. */
  responseLimitMinutes: number;
  timezone: string;
  conversations: {
    /** Soma exata dos quatro status abaixo — vem do mesmo agrupamento. */
    active: number;
    byStatus: Record<ConversationStatus, number>;
    /** Arquivadas no recorte — estado de agora, fora da soma de ativas. */
    archived: number;
  };
  /** Estado agora, sem relação com o período escolhido. */
  overdue: {
    count: number;
    /** Maior espera em minutos de expediente, ou null quando não há atraso. */
    oldestWaitingMinutes: number | null;
  };
  instances: {
    connected: number;
    disconnected: number;
    byStatus: Record<ConnectionStatus, number>;
  };
  messages: {
    received: number;
    sent: number;
  };
  ranking: DashboardRankingRowDto[];
  /** `null` para quem não é supervisor — o bloco não aparece na tela dele. */
  topUsers: DashboardTopUserDto[] | null;
  /** Um ponto por dia civil do período, inclusive os zerados. */
  timeline: DashboardTimelinePointDto[];
  /** Só as células com movimento; a grade vazia é desenhada pela tela. */
  hourly: DashboardHourlyCellDto[];
}

/** Mensagens de um dia do período, no fuso do escritório. */
export interface DashboardTimelinePointDto {
  /** "AAAA-MM-DD" no fuso configurado. */
  date: string;
  received: number;
  sent: number;
}

/** Uma célula do mapa dia da semana × hora, somando os dias do período. */
export interface DashboardHourlyCellDto {
  /** 0 = domingo ... 6 = sábado. */
  weekday: number;
  /** 0 a 23. */
  hour: number;
  received: number;
  sent: number;
}

/**
 * Como o recorte por característica do cliente saiu na última consulta de
 * `GET /conversations`. Vem nulo quando nenhum dos dois filtros está ativo.
 */
export interface CompanyFilterStateDto {
  /** O Azevedo-OS não respondeu: a lista veio SEM o recorte. */
  unavailable: boolean;
  /** O portal cortou a lista de empresas no teto dele. */
  truncated: boolean;
  /** Conversas do recorte atual que ficaram de fora por não terem empresa. */
  unlinkedExcluded: number;
}

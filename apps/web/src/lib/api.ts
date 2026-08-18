"use client";

import { AZEVEDO_OS_SOURCE } from "@azvchat/shared";
import type {
  AttendanceSettings,
  AzevedoOsCompanyDto,
  ConfigurableRole,
  ConversationStatus,
  DashboardPeriod,
  ParticipantClientRole,
  PermissionAction,
} from "@azvchat/shared";
import type {
  DashboardStatsDto,
  MessageDto,
  QuickReplyDto,
  RolePermissionOverrideDto,
  TagDto,
} from "./types";

export const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

const TOKEN_KEY = "zapdesk.token";

/**
 * Marca na URL do login que a pessoa caiu por fim do horário de uso, e não
 * por token vencido. É só isso: o motivo real quem decide é a API.
 */
export const LOGIN_REASON_SCHEDULE = "horario";

export function getToken(): string | null {
  if (typeof window === "undefined") return null;
  return window.localStorage.getItem(TOKEN_KEY);
}

export function setToken(token: string | null): void {
  if (typeof window === "undefined") return;
  if (token) {
    window.localStorage.setItem(TOKEN_KEY, token);
  } else {
    window.localStorage.removeItem(TOKEN_KEY);
  }
}

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code?: string,
  ) {
    super(message);
  }
}

/**
 * Sessão inválida tem tratamento único: limpa o token e manda para o login.
 * O motivo importa: sessão encerrada pelo fim do horário de uso não é
 * token vencido, e mandar a pessoa para o login sem explicar faria ela
 * tentar entrar de novo achando que foi falha do sistema.
 *
 * Extraído para as buscas de mídia (lightbox, download) reusarem — engolir
 * o 401 ali deixaria a pessoa clicando numa tela morta sem entender o porquê.
 */
async function handleUnauthorized(response: Response): Promise<never> {
  const body = (await response.json().catch(() => null)) as {
    error?: string;
    message?: string;
  } | null;
  const outsideSchedule = body?.error === "session_outside_schedule";
  setToken(null);
  if (typeof window !== "undefined" && !window.location.pathname.startsWith("/login")) {
    window.location.href = outsideSchedule ? `/login?motivo=${LOGIN_REASON_SCHEDULE}` : "/login";
  }
  throw new ApiError(
    outsideSchedule ? (body?.message ?? "Horário encerrado") : "Sessão expirada",
    401,
    body?.error,
  );
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const token = getToken();
  const response = await fetch(`${API_URL}${path}`, {
    ...init,
    headers: {
      ...(init?.body && !(init.body instanceof FormData)
        ? { "Content-Type": "application/json" }
        : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...init?.headers,
    },
  });
  if (response.status === 401) {
    return handleUnauthorized(response);
  }
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as {
      message?: string;
      error?: string;
    } | null;
    throw new ApiError(body?.message ?? "Erro na requisição", response.status, body?.error);
  }
  return response.json() as Promise<T>;
}

export const api = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: "POST", body: body === undefined ? undefined : JSON.stringify(body) }),
  postForm: <T>(path: string, form: FormData) =>
    request<T>(path, { method: "POST", body: form }),
  patch: <T>(path: string, body: unknown) =>
    request<T>(path, { method: "PATCH", body: JSON.stringify(body) }),
  put: <T>(path: string, body: unknown) =>
    request<T>(path, { method: "PUT", body: JSON.stringify(body) }),
  delete: <T>(path: string) => request<T>(path, { method: "DELETE" }),
};

/**
 * Vínculo com departamento — o mesmo contrato para etiqueta e resposta
 * rápida: ou vale para todos, ou traz pelo menos um departamento.
 */
export interface DepartmentTargetInput {
  isGeneral: boolean;
  departmentIds: string[];
}

export interface TagInput extends DepartmentTargetInput {
  name: string;
  color: string;
}

export const tagsApi = {
  list: () => api.get<{ tags: TagDto[] }>("/tags").then((data) => data.tags),
  create: (input: TagInput) => api.post<{ tag: TagDto }>("/tags", input).then((data) => data.tag),
  update: (id: string, input: Partial<TagInput>) =>
    api.patch<{ tag: TagDto }>(`/tags/${id}`, input).then((data) => data.tag),
  remove: (id: string) => api.delete<{ ok: boolean }>(`/tags/${id}`),
};

/**
 * Cadastro do participante de grupo feito pela equipe. Os dois campos são
 * opcionais: enviar só `clientRole` não mexe no nome, e vice-versa.
 */
export interface GroupParticipantInput {
  customName: string | null;
  clientRole: ParticipantClientRole | null;
}

export const groupParticipantsApi = {
  update: (id: string, input: Partial<GroupParticipantInput>) =>
    api.patch<{ ok: boolean }>(`/group-participants/${id}`, input),
};

export interface QuickReplyInput extends DepartmentTargetInput {
  shortcut: string;
  title?: string;
  content: string;
}

export const quickRepliesApi = {
  list: () =>
    api.get<{ quickReplies: QuickReplyDto[] }>("/quick-replies").then((data) => data.quickReplies),
  create: (input: QuickReplyInput) =>
    api.post<{ quickReply: QuickReplyDto }>("/quick-replies", input).then((data) => data.quickReply),
  update: (id: string, input: Partial<QuickReplyInput>) =>
    api
      .patch<{ quickReply: QuickReplyDto }>(`/quick-replies/${id}`, input)
      .then((data) => data.quickReply),
  remove: (id: string) => api.delete<{ ok: boolean }>(`/quick-replies/${id}`),
  uploadMedia: (id: string, file: File) => {
    const form = new FormData();
    form.append("file", file);
    return api
      .postForm<{ quickReply: QuickReplyDto }>(`/quick-replies/${id}/media`, form)
      .then((data) => data.quickReply);
  },
  removeMedia: (id: string) =>
    api
      .delete<{ quickReply: QuickReplyDto }>(`/quick-replies/${id}/media`)
      .then((data) => data.quickReply),
  /** Fire-and-forget após o envio: falha aqui não pode atrapalhar o atendimento. */
  markUsed: (id: string) =>
    api.post<{ ok: boolean }>(`/quick-replies/${id}/used`).catch(() => undefined),
};


/**
 * Envio de arquivo para a conversa — o MESMO caminho do clipe do composer,
 * da gravação de áudio e do arrastar/colar: `POST
 * /conversations/:id/messages/media`, um arquivo por requisição (o multipart
 * da API aceita um só, e cada arquivo é uma mensagem no chat do cliente).
 *
 * Passa pelo `api.postForm` de propósito: é ele que trata o 401 limpando o
 * token e mandando para o login. Um `fetch`/XHR próprio aqui (que daria a
 * barra de progresso em bytes) engoliria a sessão vencida no meio do upload e
 * deixaria a pessoa olhando um envio parado para sempre.
 */
export const conversationMediaApi = {
  send: (
    conversationId: string,
    file: File,
    options: { caption?: string; asVoiceNote?: boolean } = {},
  ) => {
    const form = new FormData();
    if (options.asVoiceNote) form.append("asVoiceNote", "true");
    if (options.caption) form.append("caption", options.caption);
    form.append("file", file);
    return api
      .postForm<{ message: MessageDto }>(`/conversations/${conversationId}/messages/media`, form)
      .then((data) => data.message);
  },
  /** Texto puro na mesma conversa — usado quando a legenda não cabe na mídia. */
  sendText: (conversationId: string, content: string) =>
    api
      .post<{ message: MessageDto }>(`/conversations/${conversationId}/messages`, { content })
      .then((data) => data.message),
};

/**
 * Envio de texto pelo composer.
 *
 * `mentions` viaja SEPARADO do conteúdo porque menção não é formatação: o
 * WhatsApp notifica pela lista de identificadores, e o "@5511..." que aparece
 * no texto é só o que o aplicativo de quem recebe usa para desenhar o
 * destaque. Mandar o texto sem a lista entrega uma mensagem bonita que não
 * chama ninguém.
 */
export interface SendMessageInput {
  content: string;
  replyToMessageId?: string;
  /** `externalContactId` dos participantes marcados. */
  mentions?: string[];
}

export const messagesApi = {
  send: (conversationId: string, input: SendMessageInput) =>
    api
      .post<{ message: MessageDto }>(`/conversations/${conversationId}/messages`, input)
      .then((data) => data.message),
  /**
   * Edita o texto (ou a legenda, em mídia) de uma mensagem já enviada. O
   * WhatsApp só aceita por alguns minutos — passado o prazo, a API recusa em
   * vez de gravar um texto que o cliente nunca vai ver.
   */
  edit: (messageId: string, content: string) =>
    api
      .patch<{ message: MessageDto }>(`/messages/${messageId}`, { content })
      .then((data) => data.message),
};

/**
 * Cliente do Azevedo-OS visto pelo navegador: tudo passa pela API do
 * AZVCHAT, que é quem tem o token. Nenhuma chamada daqui sai para o
 * Azevedo-OS.
 *
 * Vincular e desvincular reusam `PATCH /conversations/:id/reference` — o
 * campo é o mesmo do código de cadastro manual, e dois caminhos de escrita
 * para o mesmo campo seria pedir para eles divergirem.
 */
export const azevedoOsApi = {
  /** Empresa vinculada; `null` quando a conversa não tem vínculo. */
  company: (conversationId: string) =>
    api
      .get<{ company: AzevedoOsCompanyDto | null }>(
        `/conversations/${conversationId}/external-company`,
      )
      .then((data) => data.company),
  /** A conversa vai junto: a API confere o acesso a ela antes de pesquisar. */
  search: (conversationId: string, search: string) =>
    api
      .get<{ companies: AzevedoOsCompanyDto[] }>(
        `/integrations/azevedo-os/companies?conversationId=${conversationId}&search=${encodeURIComponent(search)}`,
      )
      .then((data) => data.companies),
  link: (conversationId: string, companyId: string) =>
    api.patch<{ ok: boolean }>(`/conversations/${conversationId}/reference`, {
      externalReference: companyId,
      externalSource: AZEVEDO_OS_SOURCE,
    }),
  unlink: (conversationId: string) =>
    api.patch<{ ok: boolean }>(`/conversations/${conversationId}/reference`, {
      externalReference: null,
    }),
};

/**
 * Arquivamento de conversa: some da Inbox e deixa de contar nos números do
 * sistema, sem apagar nada. Responder não desarquiva — só o botão.
 */
export const conversationArchiveApi = {
  archive: (conversationId: string) =>
    api.post<{ ok: boolean }>(`/conversations/${conversationId}/archive`),
  unarchive: (conversationId: string) =>
    api.post<{ ok: boolean }>(`/conversations/${conversationId}/unarchive`),
};

/**
 * Responsável da conversa. As três saídas do seletor num lugar só: uma
 * pessoa, o atendimento coletivo ("@todos") ou ninguém.
 *
 * Passar de @todos para uma pessoa não precisa de chamada extra — a API
 * desliga a marcação na própria atribuição, porque as duas nunca coexistem.
 */
export const conversationAssignmentApi = {
  assign: (conversationId: string, userId: string) =>
    api.post<{ ok: boolean }>(`/conversations/${conversationId}/assign`, { userId }),
  assignAll: (conversationId: string) =>
    api.post<{ ok: boolean }>(`/conversations/${conversationId}/assign-all`),
  unassign: (conversationId: string) =>
    api.post<{ ok: boolean }>(`/conversations/${conversationId}/unassign`),
};

/**
 * Número de backup: marcação da instância e arquivamento em massa. Tudo de
 * supervisor para cima — a API recusa por conta própria quem chamar direto.
 */
export const instanceBackupApi = {
  setBackup: (instanceId: string, isBackup: boolean) =>
    api.patch<{ instance: unknown }>(`/whatsapp-instances/${instanceId}`, { isBackup }),
  /** Quantas conversas o arquivamento em massa alcançaria agora. */
  archivableCount: (instanceId: string) =>
    api
      .get<{ count: number }>(`/whatsapp-instances/${instanceId}/archivable-count`)
      .then((data) => data.count),
  archiveAll: (instanceId: string) =>
    api.post<{ archived: number }>(`/whatsapp-instances/${instanceId}/archive-all`),
};

/**
 * Filtros do dashboard. Valem para a tela inteira: os cards, o ranking e o
 * top de usuários respondem todos ao mesmo recorte.
 *
 * `from`/`to` são datas civis "AAAA-MM-DD" e só valem com `period=custom`.
 * `departmentId` e `assignedUserId` aceitam "none" para "sem departamento" e
 * "sem responsável".
 */
export interface DashboardFilters {
  period: DashboardPeriod;
  from?: string;
  to?: string;
  instanceId?: string;
  /** Recorta a tela inteira para um status de atendimento. */
  status?: ConversationStatus;
  departmentId?: string;
  assignedUserId?: string;
}

export const dashboardApi = {
  stats: (filters: DashboardFilters) => {
    const params = new URLSearchParams({ period: filters.period });
    if (filters.period === "custom" && filters.from && filters.to) {
      params.set("from", filters.from);
      params.set("to", filters.to);
    }
    if (filters.instanceId) params.set("instanceId", filters.instanceId);
    if (filters.status) params.set("status", filters.status);
    if (filters.departmentId) params.set("departmentId", filters.departmentId);
    if (filters.assignedUserId) params.set("assignedUserId", filters.assignedUserId);
    return api.get<DashboardStatsDto>(`/dashboard/stats?${params.toString()}`);
  },
};

/**
 * Parâmetros de atendimento da organização. A leitura é liberada para todo
 * mundo (o dashboard depende dela); a gravação exige supervisor e é barrada
 * pela API mesmo que alguém chame direto.
 */
/**
 * Tela de Permissões. O CATÁLOGO não vem da API: a tela o importa de
 * `@azvchat/shared`, que é a fonte única dos rótulos, das áreas e dos
 * padrões. Daqui vem só o que a organização gravou por cima.
 */
export const permissionsApi = {
  list: () =>
    api
      .get<{ overrides: RolePermissionOverrideDto[] }>("/permissions")
      .then((data) => data.overrides),
  save: (entries: Array<{ role: ConfigurableRole; action: PermissionAction; allowed: boolean }>) =>
    api
      .put<{ overrides: RolePermissionOverrideDto[] }>("/permissions", { entries })
      .then((data) => data.overrides),
};

export const attendanceSettingsApi = {
  get: () =>
    api
      .get<{ settings: AttendanceSettings }>("/attendance-settings")
      .then((data) => data.settings),
  save: (input: AttendanceSettings) =>
    api
      .put<{ settings: AttendanceSettings }>("/attendance-settings", input)
      .then((data) => data.settings),
};

/**
 * URL autenticável de mídia — a rota exige o header Authorization e token por
 * query não é aceito, então um `src`/`href` apontando direto para a API nunca
 * funcionaria: o binário vem por fetch autenticado e vira blob temporário.
 * Quem consome é responsável por revogar a URL criada (`URL.revokeObjectURL`),
 * senão a memória cresce a cada mídia aberta ao longo do dia.
 */
export async function fetchMediaBlobUrl(messageId: string): Promise<string> {
  const token = getToken();
  const response = await fetch(`${API_URL}/messages/${messageId}/media`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  // Sessão vencida no meio da ação segue o mesmo caminho do client: limpa o
  // token e vai para o login, em vez de virar um "falha ao carregar" mudo.
  if (response.status === 401) return handleUnauthorized(response);
  if (!response.ok) throw new ApiError("Falha ao carregar mídia", response.status);
  const blob = await response.blob();
  return URL.createObjectURL(blob);
}

/**
 * Fotos de perfil aparecem em várias telas ao mesmo tempo (lista, cabeçalho,
 * painel). O cache evita baixar a mesma imagem repetidas vezes.
 */
const avatarCache = new Map<string, Promise<string>>();

function fetchAvatar(cacheKey: string, path: string): Promise<string> {
  const cached = avatarCache.get(cacheKey);
  if (cached) return cached;
  const token = getToken();
  const promise = fetch(`${API_URL}${path}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  })
    .then(async (response) => {
      if (!response.ok) throw new ApiError("Sem foto de perfil", response.status);
      return URL.createObjectURL(await response.blob());
    })
    .catch((err) => {
      avatarCache.delete(cacheKey);
      throw err;
    });
  avatarCache.set(cacheKey, promise);
  return promise;
}

export function fetchConversationAvatarUrl(conversationId: string): Promise<string> {
  return fetchAvatar(`conv:${conversationId}`, `/conversations/${conversationId}/avatar`);
}

export function fetchParticipantAvatarUrl(participantId: string): Promise<string> {
  return fetchAvatar(`part:${participantId}`, `/group-participants/${participantId}/avatar`);
}

/** Foto de perfil interna do usuário do sistema (não é a do WhatsApp). */
export function fetchUserAvatarUrl(userId: string): Promise<string> {
  return fetchAvatar(`user:${userId}`, `/users/${userId}/avatar`);
}

/** Descarta o cache da foto de um usuário (após troca ou remoção). */
export function invalidateUserAvatar(userId: string): void {
  avatarCache.delete(`user:${userId}`);
}

/** Descarta o cache de uma foto (após atualização manual). */
export function invalidateConversationAvatar(conversationId: string): void {
  avatarCache.delete(`conv:${conversationId}`);
}

"use client";

import type { QuickReplyDto, TagDto } from "./types";

export const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

const TOKEN_KEY = "zapdesk.token";

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
    setToken(null);
    if (typeof window !== "undefined" && !window.location.pathname.startsWith("/login")) {
      window.location.href = "/login";
    }
    throw new ApiError("Sessão expirada", 401);
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
};

/** URL autenticável de mídia — o token vai por query não é aceito; usamos fetch+blob. */
export async function fetchMediaBlobUrl(messageId: string): Promise<string> {
  const token = getToken();
  const response = await fetch(`${API_URL}/messages/${messageId}/media`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
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

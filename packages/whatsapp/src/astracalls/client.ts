import type { Logger } from "pino";

/**
 * Cliente HTTP fino do AstraCalls. Concentra a autenticação (`X-API-Key`) e
 * o formato das rotas num lugar só — o provider fala com este cliente, nunca
 * com `fetch` cru, do mesmo jeito que o resto do sistema fala com o provider
 * e nunca com o Baileys.
 */
export interface AstraCallsClientOptions {
  baseUrl: string;
  apiKey: string;
  logger?: Logger;
}

/** Sessão como o AstraCalls devolve em `GET /api/sessions`. */
export interface AstraSession {
  id: string;
  name?: string;
  jid?: string;
  /** open | connecting | close | qr */
  state?: string;
  paired?: boolean;
  recording?: boolean;
}

/** Resposta padrão de envio (`SendOK`). */
export interface AstraSendOk {
  id?: string;
  to?: string;
  timestamp?: number;
}

export interface AstraGroupParticipant {
  jid?: string;
  number?: string;
  pn?: string;
  id?: string;
  isAdmin?: boolean;
  isSuperAdmin?: boolean;
  role?: string;
}

export interface AstraGroupInfo {
  jid?: string;
  id?: string;
  name?: string;
  subject?: string;
  topic?: string;
  description?: string;
  owner?: string;
  announce?: boolean;
  locked?: boolean;
  created?: number;
  participants?: AstraGroupParticipant[];
}

export interface AstraContact {
  jid?: string;
  number?: string;
  fullName?: string;
  firstName?: string;
  pushName?: string;
  businessName?: string;
}

export interface AstraChatOverview {
  chat?: string;
  lastMessage?: string;
  lastType?: string;
  timestamp?: number;
  count?: number;
  lastFromMe?: boolean;
  /** individual | group | channel | broadcast — separa canal de conversa. */
  type?: string;
}

/** Corpo de mídia compartilhado (`base64` OU `url`). */
export interface AstraMediaBody {
  to: string;
  base64?: string;
  url?: string;
  mimetype?: string;
  caption?: string;
  ptt?: boolean;
  /** Nota de voz: duração em segundos (item 7b — vai para audioMessage.seconds). */
  seconds?: number;
  /** Nota de voz: waveform (64 bytes em base64 — vai para audioMessage.waveform). */
  waveform?: string;
  filename?: string;
  /** Citação (reply): id da mensagem original. */
  quotedMessageId?: string;
  /** Em grupo, JID de quem enviou a citada, quando precisa forçar. */
  participant?: string;
  fromMe?: boolean;
  /** Menções (@): números ou JIDs que notificam (o texto/legenda leva os @). */
  mentions?: string[];
}

export class AstraCallsHttpError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly body: string,
  ) {
    super(message);
    this.name = "AstraCallsHttpError";
  }
}

export class AstraCallsClient {
  readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly logger?: Logger;

  constructor(options: AstraCallsClientOptions) {
    // Sem barra no fim para os `path` sempre começarem com "/api/...".
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.apiKey = options.apiKey;
    this.logger = options.logger;
  }

  get key(): string {
    return this.apiKey;
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        "X-API-Key": this.apiKey,
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new AstraCallsHttpError(
        `AstraCalls ${method} ${path} respondeu ${response.status}`,
        response.status,
        text,
      );
    }
    // 204 e afins não têm corpo JSON.
    if (response.status === 204) return undefined as T;
    const text = await response.text();
    if (!text) return undefined as T;
    return JSON.parse(text) as T;
  }

  // --- Sessões ---
  createSession(name?: string): Promise<{ id: string }> {
    return this.request<{ id: string }>("POST", "/api/sessions", name ? { name } : {});
  }

  listSessions(): Promise<{ sessions?: AstraSession[] }> {
    return this.request<{ sessions?: AstraSession[] }>("GET", "/api/sessions");
  }

  deleteSession(sid: string): Promise<void> {
    return this.request<void>("DELETE", `/api/sessions/${sid}`);
  }

  logoutSession(sid: string): Promise<void> {
    return this.request<void>("POST", `/api/sessions/${sid}/logout`);
  }

  pair(sid: string): Promise<void> {
    return this.request<void>("POST", `/api/sessions/${sid}/pair`);
  }

  setWebhook(sid: string, url: string): Promise<void> {
    return this.request<void>("POST", `/api/sessions/${sid}/webhook`, { url });
  }

  /** Liga/desliga a gravação de chamadas da conta (por sessão). */
  setRecording(sid: string, enabled: boolean): Promise<void> {
    return this.request<void>("PUT", `/api/sessions/${sid}/recording`, { enabled });
  }

  // --- Envio ---
  sendText(
    sid: string,
    to: string,
    text: string,
    extra?: { quotedMessageId?: string; mentions?: string[]; participant?: string; fromMe?: boolean },
  ): Promise<AstraSendOk> {
    return this.request<AstraSendOk>("POST", `/api/sessions/${sid}/messages/text`, {
      to,
      text,
      ...extra,
    });
  }

  sendMedia(
    sid: string,
    kind: "image" | "audio" | "video" | "document" | "sticker",
    body: AstraMediaBody,
  ): Promise<AstraSendOk> {
    return this.request<AstraSendOk>("POST", `/api/sessions/${sid}/messages/${kind}`, body);
  }

  sendLocation(
    sid: string,
    body: { to: string; latitude: number; longitude: number; name?: string; address?: string },
  ): Promise<AstraSendOk> {
    return this.request<AstraSendOk>("POST", `/api/sessions/${sid}/messages/location`, body);
  }

  sendPoll(
    sid: string,
    body: { to: string; name: string; options: string[]; multipleAnswers?: boolean },
  ): Promise<AstraSendOk> {
    return this.request<AstraSendOk>("POST", `/api/sessions/${sid}/messages/poll`, body);
  }

  react(
    sid: string,
    body: { to: string; messageId: string; reaction: string; participant?: string; fromMe?: boolean },
  ): Promise<AstraSendOk> {
    return this.request<AstraSendOk>("PUT", `/api/sessions/${sid}/messages/react`, body);
  }

  /** Vota numa enquete RECEBIDA. `selectedNames` é a seleção completa. */
  pollVote(
    sid: string,
    body: { to: string; pollMessageId: string; selectedNames: string[] },
  ): Promise<AstraSendOk> {
    return this.request<AstraSendOk>("POST", `/api/sessions/${sid}/messages/poll-vote`, body);
  }

  edit(sid: string, body: { to: string; messageId: string; text: string }): Promise<AstraSendOk> {
    return this.request<AstraSendOk>("PUT", `/api/sessions/${sid}/messages/edit`, body);
  }

  deleteMessage(
    sid: string,
    body: { to: string; messageId: string; participant?: string; fromMe?: boolean },
  ): Promise<void> {
    return this.request<void>("DELETE", `/api/sessions/${sid}/messages`, body);
  }

  seen(
    sid: string,
    body: { to: string; messageId?: string; messageIds?: string[]; participant?: string },
  ): Promise<void> {
    return this.request<void>("POST", `/api/sessions/${sid}/messages/seen`, body);
  }

  typing(sid: string, body: { to: string; typing: boolean; audio?: boolean }): Promise<void> {
    return this.request<void>("POST", `/api/sessions/${sid}/messages/typing`, body);
  }

  // --- Leitura ---
  getChats(sid: string): Promise<AstraChatOverview[]> {
    return this.request<AstraChatOverview[]>("GET", `/api/sessions/${sid}/chats`);
  }

  getContacts(sid: string): Promise<AstraContact[]> {
    return this.request<AstraContact[]>("GET", `/api/sessions/${sid}/contacts`);
  }

  getContactPicture(sid: string, jid: string, preview = false): Promise<{ url?: string }> {
    const q = preview ? "?preview=true" : "";
    return this.request<{ url?: string }>(
      "GET",
      `/api/sessions/${sid}/contacts/${encodeURIComponent(jid)}/picture${q}`,
    );
  }

  getGroups(sid: string): Promise<AstraGroupInfo[]> {
    return this.request<AstraGroupInfo[]>("GET", `/api/sessions/${sid}/groups`);
  }

  getProfile(sid: string): Promise<{ jid?: string; number?: string; pushName?: string }> {
    return this.request<{ jid?: string; number?: string; pushName?: string }>(
      "GET",
      `/api/sessions/${sid}/profile`,
    );
  }

  // --- Chamadas (discador) ---
  // O áudio vai por WebRTC direto (UDP) entre o navegador e o servidor do
  // AstraCalls; aqui trafega só a SINALIZAÇÃO (iniciar/atender/recusar/encerrar
  // e a troca de SDP), sempre com a chave no servidor — o navegador nunca fala
  // com o AstraCalls direto.
  async startCall(
    sid: string,
    phone: string,
    opts?: { video?: boolean; record?: boolean },
  ): Promise<{ callId: string | null }> {
    // A resposta vem aninhada: { call: { callId } }. Aceitamos variações por
    // robustez (callId/id no topo ou dentro de `call`).
    const res = await this.request<{
      call?: { callId?: string; id?: string };
      callId?: string;
      id?: string;
    }>("POST", `/api/sessions/${sid}/calls`, {
      phone,
      duration_ms: 300000,
      record: opts?.record ?? false,
      video: opts?.video ?? false,
    });
    return { callId: res.call?.callId ?? res.call?.id ?? res.callId ?? res.id ?? null };
  }

  acceptCall(sid: string, callId: string): Promise<void> {
    return this.request<void>("POST", `/api/sessions/${sid}/calls/${callId}/accept`, {});
  }

  rejectCall(sid: string, callId: string): Promise<void> {
    return this.request<void>("POST", `/api/sessions/${sid}/calls/${callId}/reject`, {});
  }

  endCall(sid: string, callId: string): Promise<void> {
    return this.request<void>("DELETE", `/api/sessions/${sid}/calls/${callId}`);
  }

  /** Troca de SDP do WebRTC: manda a oferta do navegador, recebe a resposta. */
  webrtc(sid: string, callId: string, sdpOffer: string): Promise<{ sdp_answer?: string }> {
    return this.request<{ sdp_answer?: string }>(
      "POST",
      `/api/sessions/${sid}/calls/${callId}/webrtc`,
      { sdp_offer: sdpOffer },
    );
  }

  /**
   * Baixa os BYTES já decifrados de uma mídia recebida. `id` é o mesmo que
   * chega no webhook `message` (data.id). É a rota que fechou o P0#1 (mídia
   * recebida na Inbox) — não passa por `request()` porque a resposta é binária.
   */
  async fetchMedia(sid: string, id: string): Promise<Buffer> {
    const response = await fetch(
      `${this.baseUrl}/api/sessions/${sid}/messages/${encodeURIComponent(id)}/media`,
      { headers: { "X-API-Key": this.apiKey } },
    );
    if (!response.ok) {
      throw new AstraCallsHttpError(
        `AstraCalls GET media ${id} respondeu ${response.status}`,
        response.status,
        await response.text().catch(() => ""),
      );
    }
    return Buffer.from(await response.arrayBuffer());
  }

  /**
   * Baixa o MP3 de uma GRAVAÇÃO de chamada (`/recordings/{id}`). Rota
   * pública/capability, mas mandamos a chave por garantia — ela nunca sai do
   * servidor. `{ data, mimeType }`, ou null em 404 (gravação ainda não pronta).
   */
  async fetchRecording(id: string): Promise<{ data: Buffer; mimeType: string } | null> {
    // A rota é `/recordings/{callId}.mp3` — a extensão é obrigatória (sem ela
    // dá 404). O id da gravação é o próprio id da chamada.
    const response = await fetch(`${this.baseUrl}/recordings/${encodeURIComponent(id)}.mp3`, {
      headers: { "X-API-Key": this.apiKey },
    });
    if (response.status === 404) return null;
    if (!response.ok) {
      throw new AstraCallsHttpError(
        `AstraCalls GET recording ${id} respondeu ${response.status}`,
        response.status,
        await response.text().catch(() => ""),
      );
    }
    return {
      data: Buffer.from(await response.arrayBuffer()),
      mimeType: response.headers.get("content-type") ?? "audio/mpeg",
    };
  }
}

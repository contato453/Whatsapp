import { EventEmitter } from "node:events";
import { rm, mkdir } from "node:fs/promises";
import path from "node:path";
import makeWASocketImport, {
  DisconnectReason,
  downloadMediaMessage,
  fetchLatestBaileysVersion,
  useMultiFileAuthState,
  type AnyMessageContent,
  type ConnectionState,
  type WAMessage,
  type WASocket,
} from "@whiskeysockets/baileys";
import type { Boom } from "@hapi/boom";
import { HttpsProxyAgent } from "https-proxy-agent";
import pino, { type Logger } from "pino";
import QRCode from "qrcode";
import type {
  ConnectionStatus,
  MediaPayload,
  MessageResult,
  MessageStatus,
  NormalizedMessage,
  ProviderChat,
  ProviderContact,
  ProviderGroup,
} from "@zapdesk/shared";
import type { WhatsAppProvider, WhatsAppProviderEvents } from "../provider.js";
import {
  chatTypeFromJid,
  directionFromKey,
  extractContent,
  extractQuotedMessageId,
  extractSender,
  isGroupJid,
  isIgnorableJid,
  jidToPhone,
  toDate,
} from "./normalize.js";

// Interop ESM/CJS: o export default do Baileys pode vir aninhado dependendo do runtime.
const makeWASocket: typeof makeWASocketImport =
  (makeWASocketImport as unknown as { default?: typeof makeWASocketImport }).default ??
  makeWASocketImport;

interface SessionState {
  socket: WASocket | null;
  status: ConnectionStatus;
  qrDataUrl: string | null;
  phoneNumber: string | null;
  ownJid: string | null;
  /** true quando o desligamento foi solicitado pela aplicação (não reconectar) */
  intentionalClose: boolean;
  reconnectAttempts: number;
  reconnectTimer: NodeJS.Timeout | null;
  chats: Map<string, ProviderChat>;
  contacts: Map<string, ProviderContact>;
}

export interface QrCodeProviderOptions {
  /** Diretório raiz onde as credenciais de cada instância são persistidas */
  sessionDir: string;
  logger?: Logger;
  /** Proxy HTTPS opcional para o WebSocket do WhatsApp (ambientes restritos) */
  proxyUrl?: string;
}

const MAX_RECONNECT_DELAY_MS = 60_000;

/**
 * Implementação do WhatsAppProvider baseada em sessão via QR Code,
 * usando Baileys (WebSocket direto com o WhatsApp Web, sem browser).
 *
 * Toda dependência de Baileys vive EXCLUSIVAMENTE neste arquivo e em
 * normalize.ts. Nada fora de packages/whatsapp pode importar Baileys.
 */
export class QrCodeWhatsAppProvider implements WhatsAppProvider {
  private readonly sessions = new Map<string, SessionState>();
  private readonly emitter = new EventEmitter();
  private readonly sessionDir: string;
  private readonly logger: Logger;
  private readonly proxyAgent: HttpsProxyAgent<string> | undefined;

  constructor(options: QrCodeProviderOptions) {
    this.sessionDir = options.sessionDir;
    this.logger = options.logger ?? pino({ level: process.env.LOG_LEVEL ?? "info" });
    this.proxyAgent = options.proxyUrl ? new HttpsProxyAgent(options.proxyUrl) : undefined;
    this.emitter.setMaxListeners(50);
  }

  on<E extends keyof WhatsAppProviderEvents>(event: E, listener: WhatsAppProviderEvents[E]): void {
    this.emitter.on(event, listener as (...args: unknown[]) => void);
  }

  off<E extends keyof WhatsAppProviderEvents>(event: E, listener: WhatsAppProviderEvents[E]): void {
    this.emitter.off(event, listener as (...args: unknown[]) => void);
  }

  private emit<E extends keyof WhatsAppProviderEvents>(
    event: E,
    ...args: Parameters<WhatsAppProviderEvents[E]>
  ): void {
    this.emitter.emit(event, ...args);
  }

  private getOrCreateState(instanceId: string): SessionState {
    let state = this.sessions.get(instanceId);
    if (!state) {
      state = {
        socket: null,
        status: "disconnected",
        qrDataUrl: null,
        phoneNumber: null,
        ownJid: null,
        intentionalClose: false,
        reconnectAttempts: 0,
        reconnectTimer: null,
        chats: new Map(),
        contacts: new Map(),
      };
      this.sessions.set(instanceId, state);
    }
    return state;
  }

  private setStatus(instanceId: string, status: ConnectionStatus, reason?: string): void {
    const state = this.getOrCreateState(instanceId);
    if (state.status === status) return;
    state.status = status;
    this.logger.info({ instanceId, event: "instance_status", status, reason });
    this.emit("status", { instanceId, status, reason, phoneNumber: state.phoneNumber });
  }

  private authDir(instanceId: string): string {
    // instanceId é um UUID gerado pela aplicação — sanitizamos mesmo assim.
    const safe = instanceId.replace(/[^a-zA-Z0-9_-]/g, "");
    return path.join(this.sessionDir, safe);
  }

  async connect(instanceId: string): Promise<void> {
    const state = this.getOrCreateState(instanceId);
    if (state.socket && (state.status === "connected" || state.status === "connecting" || state.status === "qr_required")) {
      return; // idempotente
    }
    state.intentionalClose = false;
    await this.startSocket(instanceId);
  }

  private async startSocket(instanceId: string): Promise<void> {
    const state = this.getOrCreateState(instanceId);
    if (state.reconnectTimer) {
      clearTimeout(state.reconnectTimer);
      state.reconnectTimer = null;
    }
    this.setStatus(instanceId, state.reconnectAttempts > 0 ? "reconnecting" : "connecting");

    await mkdir(this.authDir(instanceId), { recursive: true });
    const { state: authState, saveCreds } = await useMultiFileAuthState(this.authDir(instanceId));

    let version: [number, number, number] | undefined;
    try {
      const fetched = await fetchLatestBaileysVersion();
      version = fetched.version as [number, number, number];
    } catch {
      // offline/bloqueado: usa a versão embutida do Baileys
      version = undefined;
    }

    const socket = makeWASocket({
      version,
      auth: authState,
      logger: this.logger.child({ instanceId, module: "baileys" }, { level: "warn" }),
      browser: ["ZapDesk", "Chrome", "1.0.0"],
      agent: this.proxyAgent,
      syncFullHistory: false,
      markOnlineOnConnect: false,
      generateHighQualityLinkPreview: false,
    });
    state.socket = socket;

    socket.ev.on("creds.update", saveCreds);

    socket.ev.on("connection.update", (update) => {
      void this.handleConnectionUpdate(instanceId, update);
    });

    socket.ev.on("messaging-history.set", ({ chats, contacts }) => {
      this.handleHistorySync(instanceId, chats, contacts);
    });

    socket.ev.on("chats.upsert", (chats) => {
      this.handleHistorySync(instanceId, chats, []);
    });

    socket.ev.on("contacts.upsert", (contacts) => {
      this.handleHistorySync(instanceId, [], contacts);
    });

    socket.ev.on("messages.upsert", ({ messages, type }) => {
      if (type !== "notify" && type !== "append") return;
      for (const message of messages) {
        void this.handleIncomingMessage(instanceId, message);
      }
    });

    socket.ev.on("messages.update", (updates) => {
      for (const update of updates) {
        this.handleMessageStatusUpdate(instanceId, update.key, update.update?.status ?? undefined);
      }
    });

    socket.ev.on("groups.update", () => {
      void this.syncGroups(instanceId).catch(() => undefined);
    });

    socket.ev.on("group-participants.update", () => {
      void this.syncGroups(instanceId).catch(() => undefined);
    });
  }

  private async handleConnectionUpdate(
    instanceId: string,
    update: Partial<ConnectionState>,
  ): Promise<void> {
    const state = this.getOrCreateState(instanceId);
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      try {
        state.qrDataUrl = await QRCode.toDataURL(qr, { margin: 1, width: 320 });
        this.setStatus(instanceId, "qr_required");
        this.emit("qr", { instanceId, qrDataUrl: state.qrDataUrl });
      } catch (err) {
        this.logger.error({ instanceId, event: "qr_generation_failed", error: String(err) });
      }
    }

    if (connection === "open") {
      state.qrDataUrl = null;
      state.reconnectAttempts = 0;
      state.ownJid = state.socket?.user?.id ?? null;
      state.phoneNumber = jidToPhone(state.ownJid);
      this.setStatus(instanceId, "connected");
      // Grupos são sincronizados a cada conexão — são entidade central do produto.
      void this.syncGroups(instanceId).catch((err) =>
        this.logger.warn({ instanceId, event: "group_sync_failed", error: String(err) }),
      );
    }

    if (connection === "close") {
      const statusCode = (lastDisconnect?.error as Boom | undefined)?.output?.statusCode;
      const loggedOut = statusCode === DisconnectReason.loggedOut;
      state.socket = null;
      state.qrDataUrl = null;

      if (loggedOut) {
        this.logger.warn({ instanceId, event: "logged_out" });
        await this.clearSession(instanceId);
        this.setStatus(instanceId, "disconnected", "logged_out");
        return;
      }
      if (state.intentionalClose) {
        this.setStatus(instanceId, "disconnected", "requested");
        return;
      }

      // Queda não intencional: reconecta com backoff exponencial (infinito, com teto).
      state.reconnectAttempts += 1;
      const delay = Math.min(1000 * 2 ** state.reconnectAttempts, MAX_RECONNECT_DELAY_MS);
      this.setStatus(instanceId, "reconnecting", `retry_in_${delay}ms`);
      this.logger.warn({
        instanceId,
        event: "connection_lost",
        statusCode,
        attempt: state.reconnectAttempts,
        retryInMs: delay,
      });
      state.reconnectTimer = setTimeout(() => {
        void this.startSocket(instanceId).catch((err) => {
          this.logger.error({ instanceId, event: "reconnect_failed", error: String(err) });
          this.setStatus(instanceId, "error", String(err));
        });
      }, delay);
    }
  }

  private handleHistorySync(
    instanceId: string,
    chats: ReadonlyArray<{ id: string; name?: string | null; unreadCount?: number | null; conversationTimestamp?: number | { toString(): string } | null }>,
    contacts: ReadonlyArray<{ id: string; name?: string | null; notify?: string | null; verifiedName?: string | null }>,
  ): void {
    const state = this.getOrCreateState(instanceId);
    const newChats: ProviderChat[] = [];
    for (const chat of chats) {
      if (isIgnorableJid(chat.id)) continue;
      const normalized: ProviderChat = {
        externalChatId: chat.id,
        type: chatTypeFromJid(chat.id),
        name: chat.name ?? null,
        unreadCount: chat.unreadCount ?? 0,
        lastMessageAt: chat.conversationTimestamp ? toDate(chat.conversationTimestamp) : null,
      };
      state.chats.set(chat.id, normalized);
      newChats.push(normalized);
    }
    const newContacts: ProviderContact[] = [];
    for (const contact of contacts) {
      if (isIgnorableJid(contact.id) || isGroupJid(contact.id)) continue;
      const normalized: ProviderContact = {
        externalId: contact.id,
        phoneNumber: jidToPhone(contact.id) ?? "",
        name: contact.name ?? contact.verifiedName ?? contact.notify ?? null,
      };
      state.contacts.set(contact.id, normalized);
      newContacts.push(normalized);
    }
    if (newChats.length > 0) {
      this.emit("chats-sync", { instanceId, chats: newChats });
    }
    if (newContacts.length > 0) {
      this.emit("contacts-sync", { instanceId, contacts: newContacts });
    }
  }

  private async handleIncomingMessage(instanceId: string, message: WAMessage): Promise<void> {
    const state = this.getOrCreateState(instanceId);
    const remoteJid = message.key?.remoteJid;
    if (!remoteJid || isIgnorableJid(remoteJid)) return;

    const extracted = extractContent(message.message);
    if (!extracted) return; // protocolo/reação — não exibível

    const { senderExternalId, senderPhone } = extractSender(message.key, state.ownJid);
    const socket = state.socket;

    const normalized: NormalizedMessage = {
      instanceId,
      externalMessageId: message.key?.id ?? `unknown-${Date.now()}`,
      externalChatId: remoteJid,
      chatType: chatTypeFromJid(remoteJid),
      chatName: null,
      direction: directionFromKey(message.key),
      type: extracted.type,
      content: extracted.content,
      senderExternalId,
      senderPhone,
      senderName: message.pushName ?? null,
      quotedExternalMessageId: extractQuotedMessageId(message.message),
      timestamp: toDate(message.messageTimestamp),
      media: extracted.hasMedia && socket
        ? {
            mimeType: extracted.mimeType,
            filename: extracted.filename,
            download: async () => {
              const buffer = await downloadMediaMessage(
                message,
                "buffer",
                {},
                {
                  logger: this.logger.child({ instanceId, module: "media" }, { level: "error" }),
                  reuploadRequest: socket.updateMediaMessage,
                },
              );
              return buffer as Buffer;
            },
          }
        : null,
    };

    this.logger.info({
      instanceId,
      event: "message_received",
      messageId: normalized.externalMessageId,
      chatId: remoteJid,
      type: normalized.type,
      direction: normalized.direction,
    });
    this.emit("message", normalized);
  }

  private handleMessageStatusUpdate(
    instanceId: string,
    key: WAMessage["key"] | undefined,
    status: number | undefined,
  ): void {
    if (!key?.remoteJid || !key.id || status == null) return;
    // proto.WebMessageInfo.Status: 2=SERVER_ACK, 3=DELIVERY_ACK, 4=READ, 5=PLAYED
    const mapped: MessageStatus | null =
      status === 2 ? "sent" : status === 3 ? "delivered" : status >= 4 ? "read" : null;
    if (!mapped) return;
    this.emit("message-status", {
      instanceId,
      externalChatId: key.remoteJid,
      externalMessageId: key.id,
      status: mapped,
    });
  }

  private async syncGroups(instanceId: string): Promise<void> {
    const groups = await this.getGroups(instanceId);
    if (groups.length > 0) {
      this.emit("groups-sync", { instanceId, groups });
    }
  }

  async disconnect(instanceId: string): Promise<void> {
    const state = this.getOrCreateState(instanceId);
    state.intentionalClose = true;
    if (state.reconnectTimer) {
      clearTimeout(state.reconnectTimer);
      state.reconnectTimer = null;
    }
    if (state.socket) {
      try {
        state.socket.end(undefined);
      } catch {
        // socket já encerrado
      }
      state.socket = null;
    }
    state.qrDataUrl = null;
    this.setStatus(instanceId, "disconnected", "requested");
  }

  async logout(instanceId: string): Promise<void> {
    const state = this.getOrCreateState(instanceId);
    state.intentionalClose = true;
    if (state.reconnectTimer) {
      clearTimeout(state.reconnectTimer);
      state.reconnectTimer = null;
    }
    if (state.socket) {
      try {
        await state.socket.logout();
      } catch {
        // sessão pode já estar inválida — segue para limpeza local
      }
      state.socket = null;
    }
    await this.clearSession(instanceId);
    state.qrDataUrl = null;
    state.phoneNumber = null;
    state.ownJid = null;
    this.setStatus(instanceId, "disconnected", "logged_out");
  }

  private async clearSession(instanceId: string): Promise<void> {
    await rm(this.authDir(instanceId), { recursive: true, force: true });
  }

  async getQRCode(instanceId: string): Promise<string | null> {
    return this.sessions.get(instanceId)?.qrDataUrl ?? null;
  }

  async getConnectionStatus(instanceId: string): Promise<ConnectionStatus> {
    return this.sessions.get(instanceId)?.status ?? "disconnected";
  }

  getPhoneNumber(instanceId: string): string | null {
    return this.sessions.get(instanceId)?.phoneNumber ?? null;
  }

  private requireSocket(instanceId: string): WASocket {
    const state = this.sessions.get(instanceId);
    if (!state?.socket || state.status !== "connected") {
      throw new Error(`Instância ${instanceId} não está conectada`);
    }
    return state.socket;
  }

  async sendText(instanceId: string, chatId: string, text: string): Promise<MessageResult> {
    const socket = this.requireSocket(instanceId);
    const result = await socket.sendMessage(chatId, { text });
    this.logger.info({ instanceId, event: "message_sent", chatId, messageId: result?.key?.id });
    return {
      externalMessageId: result?.key?.id ?? `local-${Date.now()}`,
      timestamp: toDate(result?.messageTimestamp),
    };
  }

  async sendMedia(instanceId: string, chatId: string, media: MediaPayload): Promise<MessageResult> {
    const socket = this.requireSocket(instanceId);
    let content: AnyMessageContent;
    switch (media.type) {
      case "image":
        content = { image: media.data, mimetype: media.mimeType, caption: media.caption };
        break;
      case "video":
        content = { video: media.data, mimetype: media.mimeType, caption: media.caption };
        break;
      case "audio":
        content = {
          audio: media.data,
          mimetype: media.asVoiceNote ? "audio/ogg; codecs=opus" : media.mimeType,
          ptt: media.asVoiceNote ?? false,
        };
        break;
      case "sticker":
        content = { sticker: media.data };
        break;
      case "document":
      default:
        content = {
          document: media.data,
          mimetype: media.mimeType,
          fileName: media.filename ?? "arquivo",
          caption: media.caption,
        };
        break;
    }
    const result = await socket.sendMessage(chatId, content);
    this.logger.info({
      instanceId,
      event: "media_sent",
      chatId,
      mediaType: media.type,
      messageId: result?.key?.id,
    });
    return {
      externalMessageId: result?.key?.id ?? `local-${Date.now()}`,
      timestamp: toDate(result?.messageTimestamp),
    };
  }

  /**
   * Retorna null quando o perfil definitivamente não tem foto acessível
   * (sem foto ou bloqueado por privacidade) e LANÇA em falhas temporárias
   * (limite de requisições, timeout, rede) — assim a aplicação sabe que
   * vale tentar de novo mais tarde em vez de marcar como "sem foto".
   */
  async getProfilePicture(
    instanceId: string,
    externalId: string,
  ): Promise<{ data: Buffer; mimeType: string } | null> {
    const socket = this.requireSocket(instanceId);
    let url: string | undefined;
    try {
      // "image" = alta resolução
      url = await socket.profilePictureUrl(externalId, "image");
    } catch (err) {
      const statusCode = (err as Boom | undefined)?.output?.statusCode;
      // 404 = sem foto; 401/403 = privacidade. Demais: falha temporária.
      if (statusCode === 404 || statusCode === 401 || statusCode === 403) {
        return null;
      }
      throw err;
    }
    if (!url) return null;

    const response = await fetch(url);
    if (!response.ok) {
      // A URL do WhatsApp expira: 404/410 aqui significa foto trocada/removida.
      if (response.status === 404 || response.status === 410) return null;
      throw new Error(`Falha ao baixar foto de perfil (HTTP ${response.status})`);
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    const mimeType = response.headers.get("content-type") ?? "image/jpeg";
    return { data: buffer, mimeType };
  }

  async getChats(instanceId: string): Promise<ProviderChat[]> {
    const state = this.sessions.get(instanceId);
    return state ? [...state.chats.values()] : [];
  }

  async getGroups(instanceId: string): Promise<ProviderGroup[]> {
    const socket = this.requireSocket(instanceId);
    const groupMap = await socket.groupFetchAllParticipating();
    return Object.values(groupMap).map((group) => ({
      externalId: group.id,
      name: group.subject,
      description: group.desc ?? null,
      participantCount: group.participants.length,
      participants: group.participants.map((participant) => ({
        externalContactId: participant.id,
        phoneNumber: jidToPhone(participant.id) ?? "",
        name: null,
        isAdmin: participant.admin === "admin",
        isSuperAdmin: participant.admin === "superadmin",
      })),
    }));
  }

  async getContacts(instanceId: string): Promise<ProviderContact[]> {
    const state = this.sessions.get(instanceId);
    return state ? [...state.contacts.values()] : [];
  }

  async shutdownAll(): Promise<void> {
    for (const instanceId of this.sessions.keys()) {
      const state = this.sessions.get(instanceId);
      if (!state) continue;
      state.intentionalClose = true;
      if (state.reconnectTimer) clearTimeout(state.reconnectTimer);
      try {
        state.socket?.end(undefined);
      } catch {
        // ignore
      }
      state.socket = null;
    }
    this.sessions.clear();
  }
}

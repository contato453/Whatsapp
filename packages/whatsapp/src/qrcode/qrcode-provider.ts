import { EventEmitter } from "node:events";
import { rm, mkdir } from "node:fs/promises";
import path from "node:path";
import makeWASocketImport, {
  DisconnectReason,
  downloadMediaMessage,
  fetchLatestBaileysVersion,
  generateMessageIDV2,
  generateWAMessage,
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
  EditMessageOptions,
  QuotedMessageRef,
  SendTextOptions,
} from "@azvchat/shared";
import { detectAudioContainer, resolveAudioDeclaration } from "../audio/container.js";
import type { MessageTarget, WhatsAppProvider, WhatsAppProviderEvents } from "../provider.js";
import type { ProtocolAction } from "./normalize.js";
import { extractMessageSecret, extractSecretEncryptedEdit } from "./message-secret.js";
import {
  chatTypeFromJid,
  directionFromKey,
  extractContent,
  extractEditedContent,
  extractMentionedJids,
  extractProtocolAction,
  extractQuotedContext,
  extractSender,
  isDisplayableContent,
  isGroupJid,
  isIgnorableJid,
  jidToPhone,
  messageKeyPaths,
  phoneFromJid,
  stripDeviceSuffix,
  toDate,
  unwrapMessage,
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

    // SEMPRE a versão mais recente. Fixar uma anterior já foi tentado para
    // fazer o servidor voltar a mandar a edição em claro, e o WhatsApp
    // simplesmente recusou a conexão: o número inteiro saiu do ar. Ver a
    // armadilha registrada no CLAUDE.md antes de cogitar isso de novo.
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
      browser: ["AZVCHAT", "Chrome", "1.0.0"],
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
        // ESTE é o canal por onde a edição chega. O Baileys intercepta o
        // pacote de protocolo e o converte em "messages.update", com o id
        // da mensagem ORIGINAL na chave e o conteúdo novo embrulhado em
        // `editedMessage` — enquanto este listener só olhava `status`, toda
        // edição feita pelo cliente era descartada aqui, em silêncio.
        if (this.handleMessageMutation(instanceId, update.key, update.update)) continue;
        this.handleMessageStatusUpdate(instanceId, update.key, update.update?.status ?? undefined);
      }
    });

    // Chamadas de voz/vídeo: viram registro na conversa.
    socket.ev.on("call", (calls) => {
      for (const call of calls) {
        const rawChatId = call.chatId ?? call.from;
        if (!rawChatId) continue;
        // Diferente das mensagens, o evento de chamada costuma trazer o JID
        // COM o sufixo de aparelho ("...:51@lid"). Os cadastros guardam o
        // JID limpo, então sem normalizar aqui a chamada não casaria com
        // contato nem conversa nenhuma — e criaria uma conversa duplicada.
        const chatId = stripDeviceSuffix(rawChatId);
        const from = call.from ? stripDeviceSuffix(call.from) : null;
        const status =
          call.status === "accept"
            ? "accepted"
            : call.status === "reject"
              ? "rejected"
              : call.status === "timeout"
                ? "missed"
                : "ringing";
        this.emit("call", {
          instanceId,
          callId: call.id,
          externalChatId: chatId,
          fromExternalId: from,
          // Sem fallback para jidToPhone: um "@lid" viraria telefone falso.
          fromPhone: phoneFromJid(from),
          isVideo: call.isVideo ?? false,
          isGroup: call.isGroup ?? isGroupJid(chatId),
          status,
          timestamp: call.date instanceof Date ? call.date : new Date(),
        });
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
    contacts: ReadonlyArray<{
      id: string;
      /** Identificador interno anônimo (@lid), quando o contato usa esse modo */
      lid?: string | null;
      /** JID de telefone (@s.whatsapp.net), quando conhecido */
      jid?: string | null;
      name?: string | null;
      notify?: string | null;
      verifiedName?: string | null;
    }>,
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
      const name = contact.name ?? contact.verifiedName ?? contact.notify ?? null;
      // O telefone só pode vir de um JID de telefone. Quando o contato é
      // endereçado por "@lid", os dígitos do identificador NÃO são número.
      const phoneNumber = phoneFromJid(contact.jid) ?? phoneFromJid(contact.id) ?? "";
      const normalized: ProviderContact = { externalId: contact.id, phoneNumber, name };
      state.contacts.set(contact.id, normalized);
      newContacts.push(normalized);

      // Registra também sob o "@lid": é esse o identificador que aparece
      // como remetente das mensagens em grupos anônimos, e é por ele que a
      // aplicação procura o telefone depois.
      const lid = contact.lid;
      if (lid && lid !== contact.id && !isIgnorableJid(lid)) {
        const byLid: ProviderContact = { externalId: lid, phoneNumber, name };
        state.contacts.set(lid, byLid);
        newContacts.push(byLid);
      }
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

    // Apagar/editar NUNCA são mensagem: chegam como pacote de protocolo e
    // viram eventos próprios. A busca desembrulha os invólucros no caminho
    // — sem isso a edição escapava do teste e ia parar no classificador de
    // conteúdo, que a transformava numa mensagem "other" sem texto e sem
    // mídia (a bolha "Mídia indisponível" que a equipe via).
    const protocolAction = extractProtocolAction(message.message);
    if (protocolAction) {
      this.emitProtocolAction(instanceId, remoteJid, protocolAction, message.key?.id ?? null, message.message);
      // Pacote de protocolo nunca vira bolha, mesmo quando não soubemos o
      // que ele pede: seguir daqui criaria mensagem lixo no histórico.
      return;
    }

    // Edição CIFRADA: o WhatsApp trocou o mecanismo e passou a mandar o
    // texto novo num envelope, com a chave derivada do segredo da mensagem
    // original. Aqui só se reconhece e se repassa — abrir exige aquele
    // segredo, que está no banco.
    const encryptedEdit = extractSecretEncryptedEdit(unwrapMessage(message.message));
    if (encryptedEdit) {
      const editor = message.key?.fromMe
        ? (state.ownJid ?? "")
        : (message.key?.participant ?? remoteJid);
      this.emit("message-edit-encrypted", {
        instanceId,
        externalChatId: remoteJid,
        targetExternalMessageId: encryptedEdit.targetExternalMessageId,
        encPayload: encryptedEdit.encPayload,
        encIv: encryptedEdit.encIv,
        editorExternalId: stripDeviceSuffix(editor),
        // Em conversa individual o autor da original é o próprio chat; em
        // grupo o pacote não diz, e quem resolve é o banco.
        originalSenderExternalId:
          encryptedEdit.targetFromMe && state.ownJid
            ? stripDeviceSuffix(state.ownJid)
            : isGroupJid(remoteJid)
              ? null
              : stripDeviceSuffix(remoteJid),
        // O Baileys anexa à chave o telefone e o identificador interno, de
        // quem enviou e de quem participa. São eles os candidatos autênticos
        // da derivação — muito melhores do que remontar um JID a partir do
        // telefone que gravamos.
        keyCandidates: [
          message.key?.senderPn,
          message.key?.senderLid,
          message.key?.participantPn,
          message.key?.participantLid,
          message.key?.participant,
          message.key?.remoteJid,
        ]
          .filter((value): value is string => typeof value === "string" && value.length > 0)
          .map(stripDeviceSuffix),
        targetRemoteJid: encryptedEdit.targetRemoteJid
          ? stripDeviceSuffix(encryptedEdit.targetRemoteJid)
          : null,
        editedAt: message.messageTimestamp ? toDate(message.messageTimestamp) : null,
      });
      return;
    }

    // Reações vêm como mensagens; viram evento próprio.
    const reaction = unwrapMessage(message.message)?.reactionMessage;
    if (reaction?.key?.id) {
      const senderJid = message.key?.fromMe
        ? (state.ownJid ?? "")
        : (message.key?.participant ?? remoteJid);
      this.emit("message-reaction", {
        instanceId,
        externalChatId: remoteJid,
        targetExternalMessageId: reaction.key.id,
        emoji: reaction.text ?? "",
        senderExternalId: senderJid,
        senderName: message.pushName ?? null,
        fromMe: message.key?.fromMe ?? false,
      });
      return;
    }

    const extracted = extractContent(message.message);
    // Protocolo, ou formato que não sabemos ler: nos dois casos não há bolha
    // a criar. Gravar assim mesmo produzia a linha "Mídia indisponível", que
    // não diz nada ao atendente e ainda esconde que algo chegou errado — o
    // log conta, o histórico fica limpo.
    if (!extracted) return;
    if (!isDisplayableContent(extracted)) {
      // Nada de exibível: antes de descartar, procura o pacote de protocolo
      // em QUALQUER profundidade. A lista de invólucros conhecidos é uma
      // aposta no que o WhatsApp já usou, e foi por ela que a edição vinha
      // parar aqui — reconhecida como "mensagem sem conteúdo" em vez de
      // como edição. Mensagem de verdade nunca chega neste ponto.
      const deepAction = extractProtocolAction(message.message, { deep: true });
      if (deepAction) {
        this.emitProtocolAction(instanceId, remoteJid, deepAction, message.key?.id ?? null, message.message);
        return;
      }
      this.logger.info({
        instanceId,
        messageId: message.key?.id ?? null,
        event: "message_without_content_skipped",
        // Os NOMES dos campos, nunca os valores: é o que permite reconhecer
        // uma estrutura nova do WhatsApp sem registrar o que o cliente
        // escreveu.
        shape: messageKeyPaths(message.message),
      });
      return;
    }

    const messageSecret = extractMessageSecret(message.message);
    const { senderExternalId, senderPhone } = extractSender(message.key, state.ownJid);
    const socket = state.socket;

    // O contexto inteiro da citação, não só o id: é o `quotedMessage` do
    // payload que permite exibir o bloco quando a original nunca foi
    // sincronizada (mensagem anterior à conexão do número).
    const quotedContext = extractQuotedContext(message.message);

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
      quotedExternalMessageId: quotedContext?.externalMessageId ?? null,
      quotedInfo: quotedContext
        ? {
            participantExternalId: quotedContext.participantExternalId,
            content: quotedContext.content,
            type: quotedContext.type,
          }
        : null,
      mentionedExternalIds: extractMentionedJids(message.message),
      // Sem este segredo não há como abrir a EDIÇÃO que o cliente fizer
      // depois nesta mensagem: o WhatsApp cifra o texto novo com uma chave
      // derivada dele.
      ...(messageSecret ? { messageSecret } : {}),
      ...(extracted.pollOptions ? { pollOptions: extracted.pollOptions } : {}),
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

  /**
   * Publica a ação pedida por um pacote de protocolo: apagar ou editar.
   *
   * Fica separado porque os DOIS pontos de reconhecimento chegam aqui — o
   * teste normal e a busca profunda, que só roda quando a mensagem não tem
   * nada de exibível.
   */
  private emitProtocolAction(
    instanceId: string,
    externalChatId: string,
    action: ProtocolAction,
    messageId: string | null,
    rawMessage: WAMessage["message"],
  ): void {
    if (action.kind === "revoke") {
      this.emit("message-deleted", {
        instanceId,
        externalChatId,
        targetExternalMessageId: action.targetExternalMessageId,
      });
      return;
    }
    if (action.newContent) {
      this.emit("message-edited", {
        instanceId,
        externalChatId,
        targetExternalMessageId: action.targetExternalMessageId,
        newText: action.newContent,
        editedAt: action.editedAt,
      });
      return;
    }
    // Edição reconhecida e SEM texto novo é a falha silenciosa desta
    // história: nada vira bolha, nada é atualizado e ninguém percebe. Só
    // esse caso deixa rastro, e dos NOMES dos campos, nunca do conteúdo.
    this.logger.warn({
      instanceId,
      messageId,
      event: "message_edit_without_content",
      shape: messageKeyPaths(rawMessage),
    });
  }

  /**
   * Trata o `messages.update` que o Baileys emite quando o pacote de
   * protocolo é de EDIÇÃO ou de APAGAR. Devolve true quando o evento era
   * disso — aí ele não é um aviso de status e não deve seguir adiante.
   *
   * O mesmo par edição/exclusão também pode aparecer no `messages.upsert`,
   * e é de propósito que os dois caminhos emitem: a forma do pacote varia
   * com a versão do aplicativo do cliente, e perder a edição é pior do que
   * recebê-la duas vezes. Quem consome é idempotente.
   */
  private handleMessageMutation(
    instanceId: string,
    key: WAMessage["key"] | undefined,
    update: Partial<WAMessage> | undefined,
  ): boolean {
    if (!key?.remoteJid || !key.id || !update) return false;
    if (isIgnorableJid(key.remoteJid)) return false;

    // WebMessageInfo.StubType.REVOKE = 1 (não confundir com o REVOKE = 0 do
    // ProtocolMessage.Type: são duas tabelas diferentes do protocolo).
    if (update.messageStubType === 1) {
      this.emit("message-deleted", {
        instanceId,
        externalChatId: key.remoteJid,
        targetExternalMessageId: key.id,
      });
      return true;
    }

    // A chave já vem com o id da mensagem ORIGINAL, trocado pelo Baileys, e
    // o conteúdo novo chega embrulhado em `editedMessage`.
    if (!update.message) return false;
    const newText = extractEditedContent(update.message);
    if (!newText) return false;
    this.emit("message-edited", {
      instanceId,
      externalChatId: key.remoteJid,
      targetExternalMessageId: key.id,
      newText,
      editedAt: update.messageTimestamp ? toDate(update.messageTimestamp) : null,
    });
    return true;
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

  /**
   * Monta o objeto de mensagem citada aceito pelo Baileys a partir dos
   * dados que persistimos. Não temos o proto original, então recriamos o
   * mínimo necessário — a citação aparece no WhatsApp com o texto salvo.
   */
  private buildQuoted(chatId: string, quoted: QuotedMessageRef): WAMessage {
    return {
      key: {
        remoteJid: chatId,
        id: quoted.externalMessageId,
        fromMe: quoted.fromMe,
        ...(quoted.participantExternalId ? { participant: quoted.participantExternalId } : {}),
      },
      message: { conversation: quoted.text ?? "" },
    } as WAMessage;
  }

  async sendText(
    instanceId: string,
    chatId: string,
    text: string,
    quoted?: QuotedMessageRef,
    options?: SendTextOptions,
  ): Promise<MessageResult> {
    const socket = this.requireSocket(instanceId);
    // `mentions` é o que o Baileys transforma em `contextInfo.mentionedJid` —
    // a única coisa que faz o WhatsApp notificar quem foi marcado. O texto
    // com "@5511..." só serve para o aplicativo de quem recebe desenhar o
    // destaque; sozinho, ele não avisa ninguém.
    const mentions = options?.mentionedExternalIds ?? [];
    const result = await socket.sendMessage(
      chatId,
      { text, ...(mentions.length > 0 ? { mentions } : {}) },
      quoted ? { quoted: this.buildQuoted(chatId, quoted) } : undefined,
    );
    this.logger.info({
      instanceId,
      event: "message_sent",
      chatId,
      messageId: result?.key?.id,
      // Só a quantidade: número mencionado é conteúdo, não vai para o log.
      mentions: mentions.length,
    });
    return {
      externalMessageId: result?.key?.id ?? `local-${Date.now()}`,
      timestamp: toDate(result?.messageTimestamp),
    };
  }

  /** Chave da mensagem no formato esperado pelo Baileys. */
  private targetKey(chatId: string, target: MessageTarget) {
    return {
      remoteJid: chatId,
      id: target.externalMessageId,
      fromMe: target.fromMe,
      ...(target.participantExternalId ? { participant: target.participantExternalId } : {}),
    };
  }

  async sendReaction(
    instanceId: string,
    chatId: string,
    target: MessageTarget,
    emoji: string,
  ): Promise<void> {
    const socket = this.requireSocket(instanceId);
    await socket.sendMessage(chatId, {
      react: {
        text: emoji, // string vazia remove a reação
        key: this.targetKey(chatId, target),
      },
    });
    this.logger.info({
      instanceId,
      event: emoji ? "reaction_sent" : "reaction_removed",
      chatId,
      messageId: target.externalMessageId,
    });
  }

  async sendPoll(
    instanceId: string,
    chatId: string,
    poll: { question: string; options: string[]; selectableCount?: number },
  ): Promise<MessageResult> {
    const socket = this.requireSocket(instanceId);
    const result = await socket.sendMessage(chatId, {
      poll: {
        name: poll.question,
        values: poll.options,
        selectableCount: poll.selectableCount ?? 1,
      },
    });
    this.logger.info({
      instanceId,
      event: "poll_sent",
      chatId,
      messageId: result?.key?.id,
      options: poll.options.length,
    });
    return {
      externalMessageId: result?.key?.id ?? `local-${Date.now()}`,
      timestamp: toDate(result?.messageTimestamp),
    };
  }

  async deleteMessage(instanceId: string, chatId: string, target: MessageTarget): Promise<void> {
    const socket = this.requireSocket(instanceId);
    await socket.sendMessage(chatId, { delete: this.targetKey(chatId, target) });
    this.logger.info({
      instanceId,
      event: "message_deleted",
      chatId,
      messageId: target.externalMessageId,
    });
  }

  async requestMessageResend(
    instanceId: string,
    externalChatId: string,
    target: MessageTarget,
  ): Promise<boolean> {
    const socket = this.sessions.get(instanceId)?.socket;
    if (!socket) return false;
    try {
      // O próprio Baileys guarda quais reenvios já foram pedidos, então
      // chamar de novo para a mesma mensagem não vira enxurrada de pedidos.
      await socket.requestPlaceholderResend({
        remoteJid: externalChatId,
        id: target.externalMessageId,
        fromMe: target.fromMe,
        ...(target.participantExternalId ? { participant: target.participantExternalId } : {}),
      });
      this.logger.info({
        instanceId,
        messageId: target.externalMessageId,
        event: "message_resend_requested",
      });
      return true;
    } catch (err) {
      this.logger.warn({
        instanceId,
        messageId: target.externalMessageId,
        event: "message_resend_failed",
        error: String(err),
      });
      return false;
    }
  }

  async editMessage(
    instanceId: string,
    chatId: string,
    target: MessageTarget,
    newText: string,
    options?: EditMessageOptions,
  ): Promise<void> {
    const socket = this.requireSocket(instanceId);
    // A edição substitui a mensagem inteira, e não só o texto dela. Em mídia
    // isso quer dizer remandar o arquivo com a legenda nova: mandar só o
    // texto transformaria a foto do cliente em uma mensagem de texto.
    const content: AnyMessageContent = options?.media
      ? this.mediaContent({ ...options.media, caption: newText })
      : { text: newText };
    await socket.sendMessage(chatId, {
      ...content,
      edit: this.targetKey(chatId, target),
    } as AnyMessageContent);
    this.logger.info({
      instanceId,
      event: "message_edited",
      chatId,
      messageId: target.externalMessageId,
      withMedia: !!options?.media,
    });
  }

  /**
   * Traduz a mídia neutra da aplicação para o conteúdo que o Baileys envia.
   * Usada tanto no envio quanto na edição de legenda — a segunda remanda o
   * arquivo, porque o WhatsApp troca a mensagem inteira pela versão editada.
   */
  private mediaContent(media: MediaPayload): AnyMessageContent {
    let content: AnyMessageContent;
    switch (media.type) {
      case "image":
        content = { image: media.data, mimetype: media.mimeType, caption: media.caption };
        break;
      case "video":
        content = { video: media.data, mimetype: media.mimeType, caption: media.caption };
        break;
      case "audio": {
        // Mime type e flag de voz saem dos BYTES, nunca do que quem chamou
        // pediu: ver resolveAudioDeclaration.
        const { mimetype, ptt } = resolveAudioDeclaration(
          media.data,
          media.mimeType,
          media.asVoiceNote ?? false,
        );
        content = {
          audio: media.data,
          mimetype,
          ptt,
          ...(media.seconds !== undefined ? { seconds: media.seconds } : {}),
          // Waveform é campo de MENSAGEM DE VOZ. Mandá-la num áudio comum
          // produz uma combinação que nenhum cliente oficial gera, e o
          // objetivo aqui é o áudio comum sair idêntico ao arquivo anexado,
          // que é o que comprovadamente toca no celular do cliente.
          ...(ptt && media.waveform !== undefined ? { waveform: media.waveform } : {}),
        };
        break;
      }
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
    return content;
  }

  /**
   * Envia a mensagem de voz montando a mensagem aqui, em vez de pelo
   * `sendMessage` do Baileys.
   *
   * O motivo é uma perda silenciosa: com `ptt` ligado, o Baileys recalcula a
   * waveform por conta própria (`Utils/messages.js`) chamando `audio-decode`,
   * uma biblioteca que ele NÃO declara como dependência. O import falha, o
   * erro é engolido, a função devolve `undefined` e isso sobrescreve a
   * waveform que a API calculou. Resultado: toda mensagem de voz saía sem
   * waveform, e só a mensagem de voz, porque esse trecho do Baileys só roda
   * quando `ptt === true`.
   *
   * Montando a mensagem e relayando, a waveform que sai é a nossa. O caminho
   * vale SÓ para mensagem de voz: imagem, vídeo, documento e áudio comum
   * continuam no `sendMessage` de sempre, que funciona.
   */
  private async relayVoiceNote(
    socket: WASocket,
    chatId: string,
    content: AnyMessageContent,
    media: MediaPayload,
    quoted?: QuotedMessageRef,
  ): Promise<WAMessage> {
    const userJid = socket.user?.id;
    const fullMsg = await generateWAMessage(chatId, content, {
      logger: this.logger.child({ module: "baileys" }, { level: "warn" }),
      userJid: userJid ?? "",
      upload: socket.waUploadToServer,
      messageId: generateMessageIDV2(userJid),
      ...(quoted ? { quoted: this.buildQuoted(chatId, quoted) } : {}),
    });
    const audio = fullMsg.message?.audioMessage;
    if (audio && media.waveform) {
      audio.waveform = media.waveform;
    }
    if (!fullMsg.message || !fullMsg.key.id) {
      throw new Error("Não foi possível montar a mensagem de voz");
    }
    await socket.relayMessage(chatId, fullMsg.message, { messageId: fullMsg.key.id });
    // O `sendMessage` publica a própria mensagem em `messages.upsert` com o
    // tipo "append", e o resto do sistema escuta esse evento. Sem reemitir,
    // a mensagem de voz seria a única que não aparece por ali.
    socket.ev.emit("messages.upsert", { messages: [fullMsg], type: "append" });
    return fullMsg;
  }

  async sendMedia(
    instanceId: string,
    chatId: string,
    media: MediaPayload,
    quoted?: QuotedMessageRef,
  ): Promise<MessageResult> {
    const socket = this.requireSocket(instanceId);
    const content = this.mediaContent(media);
    const isVoiceNote = media.type === "audio" && "ptt" in content && content.ptt === true;
    const result = isVoiceNote
      ? await this.relayVoiceNote(socket, chatId, content, media, quoted)
      : await socket.sendMessage(
          chatId,
          content,
          quoted ? { quoted: this.buildQuoted(chatId, quoted) } : undefined,
        );
    this.logger.info({
      instanceId,
      event: "media_sent",
      chatId,
      mediaType: media.type,
      messageId: result?.key?.id,
      ...(media.type === "audio"
        ? {
            audioContainer: detectAudioContainer(media.data),
            seconds: media.seconds,
            voiceNote: isVoiceNote,
            waveform: media.waveform?.length ?? 0,
          }
        : {}),
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
        // participant.id pode ser um LID (identificador interno); o telefone
        // real, quando disponível, vem em participant.jid.
        phoneNumber: phoneFromJid(participant.jid ?? participant.id) ?? "",
        name:
          participant.name ?? participant.notify ?? participant.verifiedName ?? null,
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

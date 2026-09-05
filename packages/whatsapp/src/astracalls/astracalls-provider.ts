import { EventEmitter } from "node:events";
import QRCode from "qrcode";
import pino, { type Logger } from "pino";
import type {
  ConnectionStatus,
  EditMessageOptions,
  MediaPayload,
  MessageResult,
  MessageStatus,
  ProviderChat,
  ProviderContact,
  ProviderGroup,
  QuotedMessageRef,
  SendTextOptions,
} from "@azvchat/shared";
import type {
  MessageTarget,
  WhatsAppProvider,
  WhatsAppProviderEvents,
} from "../provider.js";
import { AstraCallsClient } from "./client.js";
import { SessionMapping } from "./mapping.js";
import { SseConsumer, type AstraSseEvent } from "./sse.js";
import {
  asBool,
  asNumber,
  asRecord,
  asString,
  astraTimestampToDate,
  extractEditedText,
  messageTypeFromAstra,
  normalizeJid,
  parseInboundMessage,
  phoneFromJid,
} from "./parse.js";

export interface AstraCallsProviderOptions {
  /** Base do AstraCalls, ex.: https://astracalls.azvchat.com.br */
  apiUrl: string;
  apiKey: string;
  /** URL pública que o AstraCalls chama com os eventos de cada sessão. */
  webhookUrl?: string;
  /** Onde persistir a associação instanceId↔sid (mesma pasta das sessões). */
  sessionDir: string;
  logger?: Logger;
}

interface AstraState {
  sid: string | null;
  status: ConnectionStatus;
  qrDataUrl: string | null;
  phoneNumber: string | null;
}

/**
 * Implementação de WhatsAppProvider apoiada na API HTTP do AstraCalls
 * (whatsmeow). Espelha a forma do QrCodeWhatsAppProvider (EventEmitter
 * interno, estado por instância), mas troca o WebSocket do Baileys por
 * chamadas REST + webhook (mensagens/receipt) + SSE (QR, auth, chamadas).
 *
 * INCREMENTAL: o caminho de ENVIO e as leituras seguem o spec; o caminho de
 * RECEBIMENTO tem pontos `TODO(astracalls-live)` que só fecham observando o
 * tráfego real de um número pareado.
 */
export class AstraCallsProvider implements WhatsAppProvider {
  private readonly states = new Map<string, AstraState>();
  private readonly emitter = new EventEmitter();
  private readonly client: AstraCallsClient;
  private readonly mapping: SessionMapping;
  private readonly sse: SseConsumer;
  private readonly webhookUrl?: string;
  private readonly logger: Logger;
  private sseStarted = false;
  /**
   * Identidade de cada chamada em andamento, por callId. O AstraCalls manda
   * vários eventos por chamada (tocando → atendida → encerrada) e nem todos
   * trazem o `peer`: o `call-ended` costuma vir SEM ele. Sem lembrar quem é a
   * chamada, o encerramento caía numa conversa de id VAZIO — abrindo um ticket
   * fantasma ao lado do verdadeiro a cada ligação/perdida. Guardamos a
   * identidade no primeiro evento e reusamos nos seguintes; some no fim.
   */
  private readonly activeCalls = new Map<
    string,
    {
      externalChatId: string;
      fromExternalId: string | null;
      fromPhone: string | null;
      isVideo: boolean;
      accepted: boolean;
      direction: "inbound" | "outbound";
      recordingId: string | null;
      /** Epoch(ms) em que a chamada foi atendida, para calcular a duração. */
      acceptedAtMs: number | null;
    }
  >();

  constructor(options: AstraCallsProviderOptions) {
    this.logger = options.logger ?? pino({ level: process.env.LOG_LEVEL ?? "info" });
    this.client = new AstraCallsClient({
      baseUrl: options.apiUrl,
      apiKey: options.apiKey,
      logger: this.logger,
    });
    this.mapping = new SessionMapping(options.sessionDir, this.logger);
    this.webhookUrl = options.webhookUrl;
    this.sse = new SseConsumer({
      baseUrl: options.apiUrl,
      apiKey: options.apiKey,
      clientId: "azvchat",
      onEvent: (event) => this.handleSseEvent(event),
      logger: this.logger,
    });
    this.emitter.setMaxListeners(50);
    // Carrega o mapa sid→instanceId no boot: o webhook resolve a sessão de
    // forma síncrona (getInstanceIdSync) e pode chegar antes do primeiro connect.
    void this.mapping.preload();
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

  private getOrCreateState(instanceId: string): AstraState {
    let state = this.states.get(instanceId);
    if (!state) {
      state = { sid: null, status: "disconnected", qrDataUrl: null, phoneNumber: null };
      this.states.set(instanceId, state);
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

  private mapSessionState(state: string | undefined): ConnectionStatus {
    switch (state) {
      case "open":
        return "connected";
      case "qr":
        return "qr_required";
      case "connecting":
        return "connecting";
      case "close":
        return "disconnected";
      default:
        return "disconnected";
    }
  }

  private ensureSse(): void {
    if (this.sseStarted) return;
    this.sseStarted = true;
    this.sse.start();
  }

  /** Garante que a instância tem uma sessão no AstraCalls; cria se faltar. */
  private async ensureSid(instanceId: string): Promise<string> {
    const state = this.getOrCreateState(instanceId);
    if (state.sid) return state.sid;
    const existing = await this.mapping.getSid(instanceId);
    if (existing) {
      state.sid = existing;
      return existing;
    }
    const created = await this.client.createSession(`azvchat-${instanceId.slice(0, 8)}`);
    await this.mapping.set(instanceId, created.id);
    state.sid = created.id;
    this.logger.info({ instanceId, sid: created.id, event: "astracalls_session_created" });
    return created.id;
  }

  async connect(instanceId: string): Promise<void> {
    this.ensureSse();
    const sid = await this.ensureSid(instanceId);
    // Aponta o webhook desta sessão para a nossa API. O envelope traz o sid,
    // e é por ele que a rota resolve de volta a instância.
    if (this.webhookUrl) {
      try {
        await this.client.setWebhook(sid, this.webhookUrl);
      } catch (err) {
        this.logger.warn({ instanceId, sid, event: "astracalls_webhook_set_failed", error: String(err) });
      }
    }
    // Gravação de chamadas LIGADA por sessão: é conta a conta, e o registro de
    // Ligações depende dela. Sem isto, cada número novo nascia sem gravar e a
    // gravação ficava vazia — foi o que aconteceu com o segundo número.
    try {
      await this.client.setRecording(sid, true);
    } catch (err) {
      this.logger.warn({ instanceId, sid, event: "astracalls_recording_enable_failed", error: String(err) });
    }
    // Já pareada? Então já está conectada; senão dispara o pareamento (o QR
    // sai pelo SSE em `session-qr`).
    const list = await this.client.listSessions();
    const session = list.sessions?.find((s) => s.id === sid);
    if (session?.paired && session.state === "open") {
      const state = this.getOrCreateState(instanceId);
      state.phoneNumber = phoneFromJid(session.jid ?? null);
      this.setStatus(instanceId, "connected");
      return;
    }
    this.setStatus(instanceId, "connecting");
    try {
      await this.client.pair(sid);
    } catch (err) {
      this.logger.warn({ instanceId, sid, event: "astracalls_pair_failed", error: String(err) });
    }
  }

  async disconnect(instanceId: string): Promise<void> {
    const sid = this.getOrCreateState(instanceId).sid ?? (await this.mapping.getSid(instanceId));
    if (sid) {
      // logout do AstraCalls = desconecta MAS mantém a sessão (reconecta sem QR).
      await this.client.logoutSession(sid).catch((err) => {
        this.logger.warn({ instanceId, event: "astracalls_logout_failed", error: String(err) });
      });
    }
    this.setStatus(instanceId, "disconnected", "manual_disconnect");
  }

  async logout(instanceId: string): Promise<void> {
    const sid = this.getOrCreateState(instanceId).sid ?? (await this.mapping.getSid(instanceId));
    if (sid) {
      // DELETE = apaga a conta no AstraCalls; próxima conexão exige QR novo.
      await this.client.deleteSession(sid).catch((err) => {
        this.logger.warn({ instanceId, event: "astracalls_delete_failed", error: String(err) });
      });
    }
    await this.mapping.remove(instanceId);
    const state = this.getOrCreateState(instanceId);
    state.sid = null;
    state.qrDataUrl = null;
    state.phoneNumber = null;
    this.setStatus(instanceId, "disconnected", "logged_out");
  }

  async getQRCode(instanceId: string): Promise<string | null> {
    return this.getOrCreateState(instanceId).qrDataUrl;
  }

  async getConnectionStatus(instanceId: string): Promise<ConnectionStatus> {
    const sid = this.getOrCreateState(instanceId).sid ?? (await this.mapping.getSid(instanceId));
    if (!sid) return "disconnected";
    try {
      const list = await this.client.listSessions();
      const session = list.sessions?.find((s) => s.id === sid);
      return this.mapSessionState(session?.state);
    } catch {
      // Falha de rede não é "desconectado" definitivo, mas é o mais seguro aqui.
      return this.getOrCreateState(instanceId).status;
    }
  }

  getPhoneNumber(instanceId: string): string | null {
    return this.getOrCreateState(instanceId).phoneNumber;
  }

  async getProfilePicture(
    instanceId: string,
    externalId: string,
  ): Promise<{ data: Buffer; mimeType: string } | null> {
    const sid = await this.requireSid(instanceId);
    let url: string | undefined;
    try {
      const res = await this.client.getContactPicture(sid, externalId);
      url = res.url;
    } catch {
      return null;
    }
    if (!url) return null;
    const response = await fetch(url);
    if (!response.ok) return null;
    const data = Buffer.from(await response.arrayBuffer());
    return { data, mimeType: response.headers.get("content-type") ?? "image/jpeg" };
  }

  private async requireSid(instanceId: string): Promise<string> {
    const sid = this.getOrCreateState(instanceId).sid ?? (await this.mapping.getSid(instanceId));
    if (!sid) throw new Error(`Instância ${instanceId} não tem sessão no AstraCalls.`);
    return sid;
  }

  // --- Chamadas (discador) ---
  // Métodos FORA da interface WhatsAppProvider (o resto do sistema não conhece
  // chamada). A rota de calls os alcança por narrowing, igual ao handleWebhook.
  // O áudio é WebRTC direto (UDP); aqui só a sinalização, com a chave no
  // servidor — o navegador nunca fala com o AstraCalls.
  async startCall(
    instanceId: string,
    phone: string,
    opts?: { video?: boolean },
  ): Promise<{ callId: string }> {
    const sid = await this.requireSid(instanceId);
    const call = await this.client.startCall(sid, phone, { video: opts?.video });
    if (!call.callId) throw new Error("AstraCalls não devolveu o id da chamada.");
    return { callId: call.callId };
  }

  async acceptCall(instanceId: string, callId: string): Promise<void> {
    await this.client.acceptCall(await this.requireSid(instanceId), callId);
  }

  /** Baixa o MP3 de uma gravação de chamada; null se ainda não existe. */
  async getCallRecording(
    _instanceId: string,
    recordingId: string,
  ): Promise<{ data: Buffer; mimeType: string } | null> {
    return this.client.fetchRecording(recordingId);
  }

  async rejectCall(instanceId: string, callId: string): Promise<void> {
    await this.client.rejectCall(await this.requireSid(instanceId), callId);
  }

  async endCall(instanceId: string, callId: string): Promise<void> {
    await this.client.endCall(await this.requireSid(instanceId), callId);
  }

  async webrtcOffer(
    instanceId: string,
    callId: string,
    sdpOffer: string,
  ): Promise<{ sdpAnswer: string }> {
    const sid = await this.requireSid(instanceId);
    const res = await this.client.webrtc(sid, callId, sdpOffer);
    if (!res.sdp_answer) throw new Error("AstraCalls não devolveu o sdp_answer.");
    return { sdpAnswer: res.sdp_answer };
  }

  async sendText(
    instanceId: string,
    chatId: string,
    text: string,
    quoted?: QuotedMessageRef,
    options?: SendTextOptions,
  ): Promise<MessageResult> {
    const sid = await this.requireSid(instanceId);
    // Citação (reply) e menções: campos que o AstraCalls passou a aceitar.
    const extra: { quotedMessageId?: string; mentions?: string[]; participant?: string; fromMe?: boolean } = {};
    if (quoted) {
      extra.quotedMessageId = quoted.externalMessageId;
      extra.fromMe = quoted.fromMe;
      if (quoted.participantExternalId) extra.participant = quoted.participantExternalId;
    }
    if (options?.mentionedExternalIds?.length) extra.mentions = options.mentionedExternalIds;
    const result = await this.client.sendText(
      sid,
      chatId,
      text,
      Object.keys(extra).length ? extra : undefined,
    );
    return this.toResult(result);
  }

  async sendMedia(
    instanceId: string,
    chatId: string,
    media: MediaPayload,
    quoted?: QuotedMessageRef,
  ): Promise<MessageResult> {
    const sid = await this.requireSid(instanceId);
    const result = await this.client.sendMedia(sid, media.type, {
      to: chatId,
      base64: media.data.toString("base64"),
      mimetype: media.mimeType,
      ...(media.caption ? { caption: media.caption } : {}),
      // Nota de voz: além do ptt, mandamos duração e waveform que o app já
      // calcula (prepareOutboundAudio) — item 7b. Sem eles, o WhatsApp do
      // destinatário desenhava a barra reta; com eles vem onda e tempo.
      ...(media.type === "audio"
        ? {
            ptt: media.asVoiceNote ?? false,
            ...(media.asVoiceNote && media.seconds !== undefined ? { seconds: media.seconds } : {}),
            ...(media.asVoiceNote && media.waveform
              ? { waveform: Buffer.from(media.waveform).toString("base64") }
              : {}),
          }
        : {}),
      ...(media.type === "document" && media.filename ? { filename: media.filename } : {}),
      // Citação (reply) na mídia — mesmo campo do texto.
      ...(quoted
        ? {
            quotedMessageId: quoted.externalMessageId,
            fromMe: quoted.fromMe,
            ...(quoted.participantExternalId ? { participant: quoted.participantExternalId } : {}),
          }
        : {}),
    });
    return this.toResult(result);
  }

  async sendReaction(
    instanceId: string,
    chatId: string,
    target: MessageTarget,
    emoji: string,
  ): Promise<void> {
    const sid = await this.requireSid(instanceId);
    await this.client.react(sid, {
      to: chatId,
      messageId: target.externalMessageId,
      reaction: emoji,
      fromMe: target.fromMe,
      ...(target.participantExternalId ? { participant: target.participantExternalId } : {}),
    });
  }

  async sendPoll(
    instanceId: string,
    chatId: string,
    poll: { question: string; options: string[]; selectableCount?: number },
  ): Promise<MessageResult> {
    const sid = await this.requireSid(instanceId);
    const result = await this.client.sendPoll(sid, {
      to: chatId,
      name: poll.question,
      options: poll.options,
      // selectableCount !== 1 vira "aceita mais de uma resposta".
      multipleAnswers: (poll.selectableCount ?? 1) !== 1,
    });
    return this.toResult(result);
  }

  // Fora da interface WhatsAppProvider (o Baileys não vota por API). A rota
  // alcança por narrowing, igual às chamadas. Voto é a seleção completa atual.
  async votePoll(
    instanceId: string,
    chatId: string,
    pollExternalMessageId: string,
    selectedNames: string[],
  ): Promise<void> {
    const sid = await this.requireSid(instanceId);
    await this.client.pollVote(sid, { to: chatId, pollMessageId: pollExternalMessageId, selectedNames });
  }

  async deleteMessage(instanceId: string, chatId: string, target: MessageTarget): Promise<void> {
    const sid = await this.requireSid(instanceId);
    await this.client.deleteMessage(sid, {
      to: chatId,
      messageId: target.externalMessageId,
      fromMe: target.fromMe,
      ...(target.participantExternalId ? { participant: target.participantExternalId } : {}),
    });
  }

  async requestMessageResend(): Promise<boolean> {
    // GAP AstraCalls: não há rota para pedir reenvio de mensagem. E, sem a
    // edição CIFRADA do Baileys, também não é necessário aqui.
    return false;
  }

  async editMessage(
    instanceId: string,
    chatId: string,
    target: MessageTarget,
    newText: string,
    options?: EditMessageOptions,
  ): Promise<void> {
    const sid = await this.requireSid(instanceId);
    // GAP AstraCalls: a edição só tem `text`. Editar LEGENDA de mídia
    // remandando o arquivo (como o Baileys faz) não é suportado — avisamos.
    if (options?.media) {
      this.logger.warn({ instanceId, event: "astracalls_edit_media_unsupported", messageId: target.externalMessageId });
    }
    await this.client.edit(sid, { to: chatId, messageId: target.externalMessageId, text: newText });
  }

  async getChats(instanceId: string): Promise<ProviderChat[]> {
    const sid = await this.requireSid(instanceId);
    const chats = await this.client.getChats(sid).catch(() => []);
    return chats
      .map((c): ProviderChat | null => {
        const jid = asString(c.chat);
        if (!jid) return null;
        // Canal (@newsletter) e broadcast NÃO viram conversa: não se responde
        // a eles (o WhatsApp recusa o envio) e misturá-los na lista era o bug
        // do canal-como-conversa. O campo `type` do /chats agora os separa.
        const kind = asString(c.type);
        if (kind === "channel" || kind === "broadcast" || jid.includes("@newsletter")) return null;
        const ts = asNumber(c.timestamp);
        return {
          externalChatId: jid,
          type: kind === "group" || jid.includes("@g.us") ? "group" : "individual",
          name: null,
          unreadCount: asNumber(c.count) ?? 0,
          lastMessageAt: ts ? astraTimestampToDate(ts) : null,
        };
      })
      .filter((c): c is ProviderChat => c !== null);
  }

  async getGroups(instanceId: string): Promise<ProviderGroup[]> {
    const sid = await this.requireSid(instanceId);
    const groups = await this.client.getGroups(sid).catch(() => []);
    return groups
      .map((g): ProviderGroup | null => {
        const externalId = g.jid ?? g.id;
        if (!externalId) return null;
        const participants = (g.participants ?? []).map((p) => {
          const pid = p.jid ?? p.id ?? "";
          return {
            externalContactId: pid,
            phoneNumber: p.number ?? p.pn ?? phoneFromJid(pid) ?? "",
            name: null,
            isAdmin: p.isAdmin === true || p.role === "admin" || p.role === "superadmin",
            isSuperAdmin: p.isSuperAdmin === true || p.role === "superadmin",
          };
        });
        return {
          externalId,
          name: g.name ?? g.subject ?? "",
          description: g.topic ?? g.description ?? null,
          participantCount: participants.length,
          participants,
        };
      })
      .filter((g): g is ProviderGroup => g !== null);
  }

  async getContacts(instanceId: string): Promise<ProviderContact[]> {
    const sid = await this.requireSid(instanceId);
    const contacts = await this.client.getContacts(sid).catch(() => []);
    return contacts
      .map((c): ProviderContact | null => {
        const jid = c.jid;
        if (!jid) return null;
        return {
          externalId: jid,
          phoneNumber: c.number ?? phoneFromJid(jid) ?? "",
          name: c.fullName ?? c.pushName ?? c.firstName ?? c.businessName ?? null,
        };
      })
      .filter((c): c is ProviderContact => c !== null);
  }

  async shutdownAll(): Promise<void> {
    this.sse.stop();
    this.sseStarted = false;
    this.states.clear();
  }

  // ---------------------------------------------------------------------------
  // Recebimento: webhook (mensagens/receipt) e SSE (QR, auth, chamadas).
  // ---------------------------------------------------------------------------

  /** Chamado pela rota de webhook da API. Nunca lança — só loga e ignora. */
  handleWebhook(payload: unknown): void {
    const envelope = asRecord(payload);
    if (!envelope) return;
    const sid = asString(envelope.session);
    const event = asString(envelope.event);
    const data = asRecord(envelope.data);
    if (!sid || !event) return;
    const instanceId = this.mapping.getInstanceIdSync(sid);
    if (!instanceId) {
      this.logger.warn({ sid, event: "astracalls_webhook_unknown_session", type: event });
      return;
    }
    try {
      switch (event) {
        case "message": {
          if (!data) return;
          // Edição do cliente: chega no PRÓPRIO `message` com edited/editedId.
          // É atualização da ORIGINAL (achada por editedId), nunca linha nova —
          // e o endpoint já entrega o texto em claro (inclusive a edição
          // cifrada), então `message-edit-encrypted` nunca é emitido.
          if (asBool(data.edited)) {
            const chat = asString(data.chat);
            const editedId = asString(data.editedId);
            if (chat && editedId) {
              // O texto novo mora no `raw` (o `data.text` do topo vem vazio na
              // edição) — sem isto a mensagem editada era gravada em branco.
              const newText = extractEditedText(data);
              // Diagnóstico sem conteúdo: se a extração falhar, os CAMINHOS das
              // chaves do raw permitem reconhecer o formato sem logar o texto.
              if (!newText) {
                const raw = asRecord(data.raw);
                this.logger.warn({
                  instanceId,
                  event: "astracalls_edit_without_text",
                  editedId,
                  rawKeys: raw ? Object.keys(raw) : [],
                });
              }
              this.emit("message-edited", {
                instanceId,
                externalChatId: normalizeJid(chat),
                targetExternalMessageId: editedId,
                newText,
                editedAt: astraTimestampToDate(asNumber(data.timestamp)),
              });
            }
            return;
          }
          const normalized = parseInboundMessage(instanceId, data, (d) => this.buildDownload(sid, d));
          if (normalized) this.emit("message", normalized);
          return;
        }
        case "deleted": {
          // Contato apagou a mensagem para todos: atualiza a ORIGINAL por id.
          if (!data) return;
          const chat = asString(data.chat);
          const id = asString(data.id);
          if (chat && id) {
            this.emit("message-deleted", {
              instanceId,
              externalChatId: normalizeJid(chat),
              targetExternalMessageId: id,
            });
          }
          return;
        }
        case "reaction": {
          if (!data) return;
          const chat = asString(data.chat);
          const messageId = asString(data.messageId);
          const reactor = asString(data.reactor);
          if (!chat || !messageId || !reactor) return;
          const removed = asBool(data.removed);
          // fromMe = quem reagiu é o próprio número (compara pelo telefone real).
          const ownPhone = this.getOrCreateState(instanceId).phoneNumber;
          const reactorPhone = asString(data.reactorPhone);
          this.emit("message-reaction", {
            instanceId,
            externalChatId: normalizeJid(chat),
            targetExternalMessageId: messageId,
            emoji: removed ? "" : asString(data.emoji) ?? "",
            senderExternalId: normalizeJid(reactor),
            senderName: asString(data.reactorName),
            fromMe: !!ownPhone && reactorPhone === ownPhone,
          });
          return;
        }
        case "receipt": {
          // Confirmação de entrega/leitura → status da mensagem. `type` é o
          // nível: "" = enviado, delivered, read, played (áudio/vídeo tocado).
          if (!data) return;
          const chat = asString(data.chat);
          const status = this.mapReceiptStatus(asString(data.type));
          if (!chat || !status) return;
          const externalChatId = normalizeJid(chat);
          const ids = Array.isArray(data.ids) ? data.ids : [];
          for (const raw of ids) {
            const id = asString(raw);
            if (id) this.emit("message-status", { instanceId, externalChatId, externalMessageId: id, status });
          }
          return;
        }
        case "poll_vote": {
          // Voto decifrado pelo AstraCalls: `selectedNames` é a seleção ATUAL
          // completa do votante (o WhatsApp reenvia tudo a cada mudança).
          if (!data) return;
          const chat = asString(data.chat);
          const pollId = asString(data.pollMessageId);
          if (!chat || !pollId) return;
          const voter = asString(data.voter);
          this.emit("poll-vote", {
            instanceId,
            externalChatId: normalizeJid(chat),
            pollExternalMessageId: pollId,
            voterExternalId: voter ? normalizeJid(voter) : null,
            voterPhone: asString(data.voterPhone),
            voterName: asString(data.voterName) ?? asString(data.pushName),
            selectedNames: Array.isArray(data.selectedNames)
              ? data.selectedNames.map((n) => asString(n)).filter((n): n is string => !!n)
              : [],
            at: astraTimestampToDate(asNumber(data.timestamp)),
          });
          return;
        }
        case "group_participants": {
          // TODO: traduzir para atualização de participantes (entrou/saiu/admin).
          this.logger.debug({ instanceId, event: "astracalls_group_participants" });
          return;
        }
        default:
          this.logger.debug({ instanceId, event: "astracalls_webhook_ignored", type: event });
      }
    } catch (err) {
      this.logger.warn({ instanceId, event: "astracalls_webhook_handle_failed", error: String(err) });
    }
  }

  /** Nível de confirmação do WhatsApp → MessageStatus; null = ignorar. */
  private mapReceiptStatus(type: string | null): MessageStatus | null {
    switch (type) {
      case "":
        return "sent";
      case "delivered":
        return "delivered";
      case "read":
      case "played":
        return "read";
      default:
        return null;
    }
  }

  /**
   * Baixa a mídia recebida. Preferimos `base64`/`url` quando vierem no payload
   * (evita uma ida à rede); senão usamos a rota de mídia do AstraCalls
   * (`/messages/{id}/media`, bytes já decifrados — P0#1 resolvido), só para
   * tipos de mídia. Devolve null quando não há o que baixar (texto etc.).
   */
  private buildDownload(sid: string, data: Record<string, unknown>): (() => Promise<Buffer>) | null {
    const base64 = asString(data.base64);
    if (base64) {
      const clean = base64.replace(/^data:[^;]+;base64,/, "");
      return () => Promise.resolve(Buffer.from(clean, "base64"));
    }
    const url = asString(data.url) ?? asString(data.mediaUrl);
    if (url) {
      const apiKey = this.client.key;
      const sameHost = url.startsWith(this.client.baseUrl);
      return async () => {
        const response = await fetch(url, sameHost ? { headers: { "X-API-Key": apiKey } } : undefined);
        if (!response.ok) throw new Error(`Falha ao baixar mídia (HTTP ${response.status})`);
        return Buffer.from(await response.arrayBuffer());
      };
    }
    const type = messageTypeFromAstra(asString(data.type));
    const id = asString(data.id) ?? asString(data.messageId);
    const isMedia =
      type === "image" ||
      type === "audio" ||
      type === "video" ||
      type === "document" ||
      type === "sticker";
    if (isMedia && id) {
      return () => this.client.fetchMedia(sid, id);
    }
    return null;
  }

  private handleSseEvent(event: AstraSseEvent): void {
    const type = asString(event.type);
    if (!type) return;
    try {
      switch (type) {
        case "session-qr":
        case "auth-state":
          void this.handleAuthEvent(event);
          return;
        case "session-list":
          this.handleSessionList(event);
          return;
        case "incoming":
          // Chamada tocando.
          this.emitCall(event, "ringing");
          return;
        case "call-status":
          // Só "connected" nos interessa como evento (atendida); starting/
          // ringing já vêm por `incoming`.
          if (asString(event.status) === "connected") this.emitCall(event, "accepted");
          return;
        case "call-ended": {
          const reason = (asString(event.reason) ?? "").toLowerCase();
          const rejected = reason.includes("reject") || reason.includes("decline");
          // Encerramento: recusada continua recusada; senão, se a chamada
          // chegou a ser atendida, permanece "atendida" (encerrar não vira
          // perdida); só é "perdida" quando nunca foi atendida.
          const callId = asString(event.id) ?? "";
          const accepted = this.activeCalls.get(callId)?.accepted ?? false;
          // Recusada continua recusada; atendida-e-encerrada vira `ended`
          // (terminal, mas conta como atendida no registro); nunca atendida é
          // perdida. `ended` é o sinal que faz a TELA parar de contar minutos.
          const status = rejected ? "rejected" : accepted ? "ended" : "missed";
          this.emitCall(event, status);
          return;
        }
        case "incoming-claimed":
          // Outra aba/instância assumiu a chamada — só registra.
          this.logger.debug({ event: "astracalls_call_claimed" });
          return;
        default:
          return;
      }
    } catch (err) {
      this.logger.warn({ event: "astracalls_sse_handle_failed", type, error: String(err) });
    }
  }

  private async handleAuthEvent(event: AstraSseEvent): Promise<void> {
    const sid = asString(event.sessionId);
    if (!sid) return;
    const instanceId = this.mapping.getInstanceIdSync(sid);
    if (!instanceId) return;
    const state = this.getOrCreateState(instanceId);
    const paired = asBool(event.paired);
    const authState = asString(event.state);
    const qr = asString(event.qr);

    if (paired || authState === "open") {
      state.qrDataUrl = null;
      this.setStatus(instanceId, "connected");
      return;
    }
    if (qr) {
      // O campo `qr` é a STRING do WhatsApp (URL de dispositivos vinculados);
      // rendemos em imagem para satisfazer QrCodeEvent.qrDataUrl.
      const dataUrl = await QRCode.toDataURL(qr, { margin: 1, width: 320 });
      state.qrDataUrl = dataUrl;
      this.setStatus(instanceId, "qr_required");
      this.emit("qr", { instanceId, qrDataUrl: dataUrl });
    }
  }

  private handleSessionList(event: AstraSseEvent): void {
    const sessions = Array.isArray(event.sessions) ? event.sessions : [];
    for (const raw of sessions) {
      const s = asRecord(raw);
      if (!s) continue;
      const sid = asString(s.id);
      if (!sid) continue;
      const instanceId = this.mapping.getInstanceIdSync(sid);
      if (!instanceId) continue;
      const state = this.getOrCreateState(instanceId);
      const jid = asString(s.jid);
      if (jid) state.phoneNumber = phoneFromJid(jid);
      this.setStatus(instanceId, this.mapSessionState(asString(s.state) ?? undefined));
    }
  }

  /** Traduz um evento de chamada do SSE em CallEvent e emite. */
  private emitCall(
    event: AstraSseEvent,
    status: "ringing" | "accepted" | "ended" | "rejected" | "missed",
  ): void {
    const sid = asString(event.sessionId);
    if (!sid) return;
    const instanceId = this.mapping.getInstanceIdSync(sid);
    if (!instanceId) return;
    const callId = asString(event.id) ?? "";

    // Peer pode chegar em campos diferentes conforme o evento; aceitamos todos.
    const peer =
      asString(event.peer) ??
      asString(event.from) ??
      asString(event.jid) ??
      asString(event.chat) ??
      "";
    let externalChatId = peer ? normalizeJid(peer) : "";
    let fromPhone =
      asString(event.phone) ??
      asString(event.callerPhone) ??
      asString(event.peerPhone) ??
      phoneFromJid(externalChatId);
    let isVideo = asBool(event.video);

    // O evento não trouxe o peer (típico do call-ended): reusa a identidade
    // aprendida no início da chamada, para todos os eventos caírem no MESMO
    // ticket em vez de um novo (ou de id vazio).
    const cached = callId ? this.activeCalls.get(callId) : undefined;
    if (!externalChatId && cached) externalChatId = cached.externalChatId;
    if (!fromPhone && cached) fromPhone = cached.fromPhone;
    if (!isVideo && cached) isVideo = cached.isVideo;
    const fromExternalId = externalChatId || cached?.fromExternalId || null;

    // Sem nenhuma identidade (peer vazio e nada em cache): não há para quem
    // abrir ticket. Ignorar é melhor que criar uma conversa de id vazio.
    if (!externalChatId) {
      this.logger.warn({ instanceId, event: "astracalls_call_without_peer", callId, status });
      return;
    }

    // Direção: chamada recebida começa por `incoming` (status "ringing").
    // Sem `incoming` antes, é chamada que NÓS fizemos (outbound). Uma vez
    // sabida, fica no cache para os eventos seguintes (accept/ended) manterem.
    const direction: "inbound" | "outbound" =
      cached?.direction ?? (status === "ringing" ? "inbound" : "outbound");

    // Marca o instante em que atendeu, para calcular a duração no fim.
    const acceptedAtMs =
      cached?.acceptedAtMs ??
      (status === "accepted" ? (asNumber(event.startedAt) ?? Date.now()) : null);

    const accepted = status === "accepted" || (cached?.accepted ?? false);

    // Id da gravação. O AstraCalls NÃO manda um id nos eventos (confirmado no
    // tráfego real: incoming/call-status/call-ended não trazem campo de
    // gravação) — a gravação é buscada em `/recordings/{callId}`, ou seja, a
    // CHAVE é o próprio id da chamada. Só existe gravação de chamada ATENDIDA:
    // perdida/recusada não tem áudio. Aceitamos ainda um campo explícito, caso
    // uma versão futura passe a mandar.
    const recordingId =
      asString(event.recordingId) ??
      asString(event.recording_id) ??
      asString(event.recording) ??
      cached?.recordingId ??
      (accepted && callId ? callId : null);

    if (callId) {
      this.activeCalls.set(callId, {
        externalChatId,
        fromExternalId,
        fromPhone,
        isVideo,
        accepted,
        direction,
        recordingId,
        acceptedAtMs,
      });
    }

    const ts = asNumber(event.offeredAt) ?? asNumber(event.startedAt) ?? asNumber(event.endedAt);

    // Duração: o provider manda pronta, ou calculamos de atendida→encerrada.
    let durationSeconds = asNumber(event.duration) ?? asNumber(event.durationSeconds) ?? null;
    if (durationSeconds === null) {
      const durationMs = asNumber(event.durationMs);
      if (durationMs !== null) durationSeconds = Math.round(durationMs / 1000);
    }
    if (durationSeconds === null && acceptedAtMs && asNumber(event.endedAt)) {
      const endedAt = asNumber(event.endedAt);
      if (endedAt) durationSeconds = Math.max(0, Math.round((endedAt - acceptedAtMs) / 1000));
    }

    this.emit("call", {
      instanceId,
      callId,
      externalChatId,
      fromExternalId,
      fromPhone,
      isVideo,
      isGroup: externalChatId.includes("@g.us"),
      status,
      direction,
      recordingId,
      durationSeconds,
      timestamp: astraTimestampToDate(ts),
    });

    // Chamada terminou: esquece a identidade para não vazar memória. Só os
    // estados TERMINAIS limpam — `accepted` chega no meio da chamada (atendida)
    // e precisa do cache até o `ended`/`rejected`/`missed` do encerramento.
    if (callId && (status === "rejected" || status === "missed" || status === "ended")) {
      this.activeCalls.delete(callId);
    }
  }

  private toResult(result: { id?: string; timestamp?: number }): MessageResult {
    return {
      externalMessageId: result.id ?? `local-${Date.now()}`,
      timestamp: astraTimestampToDate(result.timestamp ?? null),
    };
  }
}

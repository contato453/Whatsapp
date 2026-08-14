import type {
  CallEvent,
  ConnectionStatus,
  InstanceStatusEvent,
  MediaPayload,
  MessageResult,
  MessageStatusUpdate,
  NormalizedMessage,
  ProviderChat,
  ProviderContact,
  ProviderGroup,
  QrCodeEvent,
  QuotedMessageRef,
  ReactionEvent,
} from "@zapdesk/shared";

/**
 * Eventos emitidos por qualquer implementação de WhatsAppProvider.
 * A aplicação consome SOMENTE estes eventos normalizados — nunca os
 * eventos crus da biblioteca subjacente.
 */
/** Identifica uma mensagem existente no WhatsApp. */
export interface MessageTarget {
  externalMessageId: string;
  fromMe: boolean;
  /** JID do autor (obrigatório em grupos) */
  participantExternalId: string | null;
}

export interface WhatsAppProviderEvents {
  qr: (event: QrCodeEvent) => void;
  status: (event: InstanceStatusEvent & { phoneNumber?: string | null }) => void;
  message: (message: NormalizedMessage) => void;
  "message-status": (update: MessageStatusUpdate) => void;
  "message-reaction": (reaction: ReactionEvent) => void;
  /** Alguém apagou uma mensagem para todos */
  "message-deleted": (event: {
    instanceId: string;
    externalChatId: string;
    targetExternalMessageId: string;
  }) => void;
  /** Alguém editou o texto de uma mensagem */
  "message-edited": (event: {
    instanceId: string;
    externalChatId: string;
    targetExternalMessageId: string;
    newText: string;
  }) => void;
  /** Chamada de voz/vídeo registrada no chat */
  call: (event: CallEvent) => void;
  "chats-sync": (event: { instanceId: string; chats: ProviderChat[] }) => void;
  "contacts-sync": (event: { instanceId: string; contacts: ProviderContact[] }) => void;
  "groups-sync": (event: { instanceId: string; groups: ProviderGroup[] }) => void;
}

/**
 * Abstração do conector de WhatsApp.
 *
 * REGRA ARQUITETURAL: controllers, services, banco e frontend consomem
 * exclusivamente esta interface. Nenhuma outra camada pode importar
 * Baileys, whatsapp-web.js ou qualquer SDK concreto. Isso permite
 * substituir a implementação (ex.: MetaCloudApiProvider) sem tocar
 * na regra de negócio.
 *
 * Todos os métodos recebem `instanceId` porque o sistema é
 * multi-instância: cada número de WhatsApp conectado é uma instância
 * independente — a queda de uma nunca afeta as demais.
 */
export interface WhatsAppProvider {
  /** Inicia (ou retoma) a sessão da instância. Idempotente. */
  connect(instanceId: string): Promise<void>;

  /** Encerra a sessão mantendo as credenciais (poderá reconectar sem QR). */
  disconnect(instanceId: string): Promise<void>;

  /** Encerra a sessão e APAGA as credenciais (próxima conexão exige QR). */
  logout(instanceId: string): Promise<void>;

  /** Último QR Code gerado (data URL) ou null se não houver QR pendente. */
  getQRCode(instanceId: string): Promise<string | null>;

  getConnectionStatus(instanceId: string): Promise<ConnectionStatus>;

  /** Número conectado (E.164 sem +) ou null se desconhecido. */
  getPhoneNumber(instanceId: string): string | null;

  /**
   * Foto de perfil de um contato ou grupo, já baixada como binário.
   * Retorna null quando não há foto ou o perfil é privado.
   * O provider é responsável por resolver a URL interna — a aplicação
   * nunca lida com CDNs específicos do fornecedor.
   */
  getProfilePicture(
    instanceId: string,
    externalId: string,
  ): Promise<{ data: Buffer; mimeType: string } | null>;

  sendText(
    instanceId: string,
    chatId: string,
    text: string,
    quoted?: QuotedMessageRef,
  ): Promise<MessageResult>;

  sendMedia(
    instanceId: string,
    chatId: string,
    media: MediaPayload,
    quoted?: QuotedMessageRef,
  ): Promise<MessageResult>;

  /**
   * Reage a uma mensagem. Emoji vazio remove a reação.
   * `target` identifica a mensagem original no WhatsApp.
   */
  sendReaction(
    instanceId: string,
    chatId: string,
    target: MessageTarget,
    emoji: string,
  ): Promise<void>;

  /**
   * Envia uma enquete. `selectableCount` = quantas opções cada pessoa
   * pode escolher (1 = resposta única).
   */
  sendPoll(
    instanceId: string,
    chatId: string,
    poll: { question: string; options: string[]; selectableCount?: number },
  ): Promise<MessageResult>;

  /** Apaga a mensagem para todos os participantes do chat. */
  deleteMessage(instanceId: string, chatId: string, target: MessageTarget): Promise<void>;

  /** Edita o texto de uma mensagem já enviada. */
  editMessage(
    instanceId: string,
    chatId: string,
    target: MessageTarget,
    newText: string,
  ): Promise<void>;

  getChats(instanceId: string): Promise<ProviderChat[]>;

  getGroups(instanceId: string): Promise<ProviderGroup[]>;

  getContacts(instanceId: string): Promise<ProviderContact[]>;

  on<E extends keyof WhatsAppProviderEvents>(event: E, listener: WhatsAppProviderEvents[E]): void;

  off<E extends keyof WhatsAppProviderEvents>(event: E, listener: WhatsAppProviderEvents[E]): void;

  /** Encerra todas as sessões de forma graciosa (shutdown do processo). */
  shutdownAll(): Promise<void>;
}

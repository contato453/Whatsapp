import type {
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
} from "@zapdesk/shared";

/**
 * Eventos emitidos por qualquer implementação de WhatsAppProvider.
 * A aplicação consome SOMENTE estes eventos normalizados — nunca os
 * eventos crus da biblioteca subjacente.
 */
export interface WhatsAppProviderEvents {
  qr: (event: QrCodeEvent) => void;
  status: (event: InstanceStatusEvent & { phoneNumber?: string | null }) => void;
  message: (message: NormalizedMessage) => void;
  "message-status": (update: MessageStatusUpdate) => void;
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

  sendText(instanceId: string, chatId: string, text: string): Promise<MessageResult>;

  sendMedia(instanceId: string, chatId: string, media: MediaPayload): Promise<MessageResult>;

  getChats(instanceId: string): Promise<ProviderChat[]>;

  getGroups(instanceId: string): Promise<ProviderGroup[]>;

  getContacts(instanceId: string): Promise<ProviderContact[]>;

  on<E extends keyof WhatsAppProviderEvents>(event: E, listener: WhatsAppProviderEvents[E]): void;

  off<E extends keyof WhatsAppProviderEvents>(event: E, listener: WhatsAppProviderEvents[E]): void;

  /** Encerra todas as sessões de forma graciosa (shutdown do processo). */
  shutdownAll(): Promise<void>;
}

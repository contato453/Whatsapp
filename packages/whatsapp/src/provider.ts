import type {
  CallEvent,
  ConnectionStatus,
  EditMessageOptions,
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
  SendTextOptions,
} from "@azvchat/shared";

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
  /** Alguém editou o texto (ou a legenda) de uma mensagem já enviada */
  "message-edited": (event: {
    instanceId: string;
    externalChatId: string;
    /** Id da mensagem ORIGINAL — edição é atualização, nunca mensagem nova */
    targetExternalMessageId: string;
    newText: string;
    /** Momento informado pelo WhatsApp; nulo quando o pacote não traz */
    editedAt: Date | null;
  }) => void;
  /**
   * Alguém editou uma mensagem, e o WhatsApp entregou o texto novo CIFRADO.
   *
   * Só a chave sai daqui: abrir o payload exige o `messageSecret` da
   * mensagem ORIGINAL, que está no banco, e por isso a decifragem acontece
   * de fora — com a função que este pacote exporta, para que nada fora dele
   * conheça o formato.
   */
  "message-edit-encrypted": (event: {
    instanceId: string;
    externalChatId: string;
    /** Id da mensagem ORIGINAL, a que precisa ser atualizada */
    targetExternalMessageId: string;
    encPayload: Uint8Array;
    encIv: Uint8Array;
    /** Quem fez a edição, sem sufixo de aparelho */
    editorExternalId: string;
    /** Quem mandou a original, quando o pacote permite saber */
    originalSenderExternalId: string | null;
    /** JID da conversa como veio na CHAVE da original, que é o que o WhatsApp usou */
    targetRemoteJid: string | null;
    /**
     * Todos os identificadores que a CHAVE do pacote carrega: o telefone e o
     * identificador interno, de quem enviou e de quem participa. O WhatsApp
     * manda os dois formatos, e é de um deles que ele deriva a chave da
     * edição — sem isso, só temos o que gravamos, que nem sempre é o mesmo.
     */
    keyCandidates: string[];
    editedAt: Date | null;
  }) => void;
  /**
   * Alguém votou numa enquete. O WhatsApp manda a seleção ATUAL completa do
   * votante a cada voto (trocar de opção reenvia a lista inteira), então
   * `selectedNames` substitui o voto anterior daquela pessoa, nunca soma.
   */
  "poll-vote": (event: {
    instanceId: string;
    externalChatId: string;
    /** Id externo da mensagem de enquete que recebeu o voto */
    pollExternalMessageId: string;
    voterExternalId: string | null;
    voterPhone: string | null;
    voterName: string | null;
    /** Opções escolhidas AGORA (rótulos já decifrados pelo AstraCalls) */
    selectedNames: string[];
    at: Date;
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

  /**
   * `options.mentionedExternalIds` é a lista de quem a mensagem marca.
   * Ela é obrigatória para a marcação funcionar: o WhatsApp notifica pelo
   * `contextInfo`, nunca pelo texto — mandar "@Fulano" escrito na frase, sem
   * a lista, entrega a mensagem sem aviso nenhum para o Fulano.
   */
  sendText(
    instanceId: string,
    chatId: string,
    text: string,
    quoted?: QuotedMessageRef,
    options?: SendTextOptions,
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

  /**
   * Edita o texto de uma mensagem já enviada.
   *
   * Com `options.media`, o que muda é a LEGENDA da mídia — e o arquivo vai
   * junto porque o WhatsApp substitui a mensagem inteira pela versão
   * editada. O prazo de edição é do WhatsApp (poucos minutos): passado ele,
   * o servidor recusa, então quem chama precisa conferir antes.
   */
  /**
   * Pede ao servidor do WhatsApp que reenvie uma mensagem.
   *
   * Existe para o caso da EDIÇÃO CIFRADA que não conseguimos abrir: o
   * servidor guarda o estado ATUAL da mensagem (é assim que um aparelho
   * novo já a vê editada), então o reenvio traz o texto novo em claro, sem
   * depender de decifrar nada. A resposta volta pelo caminho normal de
   * recebimento.
   *
   * Devolve false quando a instância não está conectada ou quando o
   * WhatsApp recusa — não lançar aqui é de propósito: isto é uma tentativa
   * extra, e falhar nela não pode derrubar o tratamento da edição.
   */
  requestMessageResend(
    instanceId: string,
    externalChatId: string,
    target: MessageTarget,
  ): Promise<boolean>;

  editMessage(
    instanceId: string,
    chatId: string,
    target: MessageTarget,
    newText: string,
    options?: EditMessageOptions,
  ): Promise<void>;

  getChats(instanceId: string): Promise<ProviderChat[]>;

  getGroups(instanceId: string): Promise<ProviderGroup[]>;

  getContacts(instanceId: string): Promise<ProviderContact[]>;

  on<E extends keyof WhatsAppProviderEvents>(event: E, listener: WhatsAppProviderEvents[E]): void;

  off<E extends keyof WhatsAppProviderEvents>(event: E, listener: WhatsAppProviderEvents[E]): void;

  /** Encerra todas as sessões de forma graciosa (shutdown do processo). */
  shutdownAll(): Promise<void>;
}

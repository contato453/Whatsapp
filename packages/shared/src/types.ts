import type {
  ConnectionStatus,
  ConversationType,
  MessageDirection,
  MessageStatus,
  MessageType,
} from "./enums.js";

/**
 * Contratos neutros de provider — nenhum tipo aqui pode referenciar
 * Baileys, whatsapp-web.js ou qualquer implementação concreta.
 */

export interface MediaPayload {
  /** Conteúdo binário do arquivo */
  data: Buffer;
  mimeType: string;
  filename?: string;
  /** Legenda opcional (imagens/vídeos/documentos) */
  caption?: string;
  /** Tipo lógico da mídia */
  type: "image" | "audio" | "video" | "document" | "sticker";
  /**
   * Enviar áudio como mensagem de voz (PTT). Só vale com bytes em OGG/Opus:
   * a flag e o mime type declarado precisam concordar, senão parte dos
   * aparelhos mostra o áudio como indisponível.
   */
  asVoiceNote?: boolean;
  /**
   * Duração do áudio em segundos. Sem ela, parte dos clientes desenha a
   * mensagem de voz como quebrada.
   */
  seconds?: number;
  /** Barrinhas do player de voz. Cosmético: ausente, o áudio toca igual. */
  waveform?: Uint8Array;
}

export interface MessageResult {
  externalMessageId: string;
  timestamp: Date;
}

/** Chat normalizado vindo do provider (individual ou grupo) */
export interface ProviderChat {
  externalChatId: string;
  type: ConversationType;
  name: string | null;
  unreadCount: number;
  lastMessageAt: Date | null;
}

/** Grupo normalizado vindo do provider */
export interface ProviderGroup {
  externalId: string;
  name: string;
  description: string | null;
  participantCount: number;
  participants: ProviderGroupParticipant[];
}

export interface ProviderGroupParticipant {
  externalContactId: string;
  phoneNumber: string;
  name: string | null;
  isAdmin: boolean;
  isSuperAdmin: boolean;
}

/** Contato normalizado vindo do provider */
export interface ProviderContact {
  externalId: string;
  phoneNumber: string;
  name: string | null;
}

/** Mensagem normalizada vinda do provider (inbound ou echo de outbound) */
export interface NormalizedMessage {
  instanceId: string;
  externalMessageId: string;
  externalChatId: string;
  chatType: ConversationType;
  chatName: string | null;
  direction: MessageDirection;
  type: MessageType;
  /** Texto ou legenda */
  content: string | null;
  /** Remetente dentro do chat (JID do participante em grupos) */
  senderExternalId: string | null;
  senderPhone: string | null;
  senderName: string | null;
  quotedExternalMessageId: string | null;
  /**
   * O que o payload do WhatsApp diz sobre a mensagem citada
   * (`contextInfo.quotedMessage`). É o que permite exibir o bloco de
   * citação mesmo quando a original nunca esteve no banco — resposta a
   * mensagem anterior à conexão do número. Nulo quando a mensagem não é
   * uma resposta.
   */
  quotedInfo?: {
    /** JID de quem escreveu a original (sem sufixo de aparelho). */
    participantExternalId: string | null;
    /** Texto ou legenda da original, quando o payload os traz. */
    content: string | null;
    type: MessageType;
  } | null;
  /**
   * Quem a mensagem marcou ("@"). Vem do `contextInfo` do WhatsApp, e não do
   * texto: é esta lista que notifica, o nome escrito na frase é só enfeite.
   * Pode conter JID de telefone ou identificador interno ("@lid").
   */
  mentionedExternalIds: string[];
  /**
   * Segredo da mensagem, em base64, quando o WhatsApp o envia.
   *
   * Guardá-lo é o que torna possível abrir a EDIÇÃO que o cliente faz
   * depois: o WhatsApp cifra o texto novo com uma chave derivada dele. Sem
   * o segredo da original não existe caminho para ler a edição dela — não é
   * limitação nossa, é o desenho do protocolo.
   */
  messageSecret?: string;
  /** Opções da enquete, quando type === "poll" */
  pollOptions?: string[];
  timestamp: Date;
  media: {
    mimeType: string | null;
    filename: string | null;
    /** Função que baixa o binário sob demanda (lazy) */
    download: () => Promise<Buffer>;
  } | null;
}

/** Reação (emoji) recebida do provider. Texto vazio = reação removida. */
export interface ReactionEvent {
  instanceId: string;
  externalChatId: string;
  /** Mensagem que recebeu a reação */
  targetExternalMessageId: string;
  emoji: string;
  senderExternalId: string;
  senderName: string | null;
  fromMe: boolean;
}

/**
 * Extras do envio de texto que não são o texto.
 *
 * `mentionedExternalIds` existe porque menção NÃO é formatação: o WhatsApp só
 * notifica quem está nesta lista, mesmo que o nome apareça escrito na
 * mensagem. Ela viaja ao lado do texto do composer até o provider, sem
 * passar por nenhuma etapa que mexa em string.
 */
export interface SendTextOptions {
  mentionedExternalIds?: string[];
}

/**
 * Extras da edição de mensagem já enviada.
 *
 * Editar a LEGENDA de uma mídia exige remandar a mídia junto: o WhatsApp
 * troca a mensagem inteira pela versão editada, e sem o arquivo a foto
 * sumiria da conversa do cliente, sobrando só o texto.
 */
export interface EditMessageOptions {
  media?: MediaPayload;
}

/** Referência a uma mensagem citada, para reply. */
export interface QuotedMessageRef {
  externalMessageId: string;
  /** JID do autor da mensagem citada (participante, em grupos) */
  participantExternalId: string | null;
  fromMe: boolean;
  /** Texto aproximado da mensagem citada (usado na pré-visualização) */
  text: string | null;
}

/** Registro de chamada (voz ou vídeo) observado na conexão. */
export interface CallEvent {
  instanceId: string;
  /** Identificador da chamada no WhatsApp (usado para deduplicar) */
  callId: string;
  externalChatId: string;
  fromExternalId: string | null;
  /** Telefone de quem ligou (E.164 sem +), quando dá para extrair do JID */
  fromPhone: string | null;
  isVideo: boolean;
  isGroup: boolean;
  /** offer/ringing = tocando; accept = atendida; reject/timeout = não atendida */
  status: "ringing" | "accepted" | "rejected" | "missed";
  timestamp: Date;
}

export interface MessageStatusUpdate {
  instanceId: string;
  externalChatId: string;
  externalMessageId: string;
  status: MessageStatus;
}

export interface InstanceStatusEvent {
  instanceId: string;
  status: ConnectionStatus;
  /** Motivo legível (ex.: "logged_out", "connection_lost") */
  reason?: string;
}

export interface QrCodeEvent {
  instanceId: string;
  /** QR code como data URL (image/png) pronto para exibir */
  qrDataUrl: string;
}

/** Referência externa opcional para integrações futuras (CRM, ERP, Azevedo OS...) */
export interface ExternalRef {
  externalReference?: string | null;
  externalSource?: string | null;
}

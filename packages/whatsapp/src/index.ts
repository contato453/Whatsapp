export type { WhatsAppProvider, WhatsAppProviderEvents } from "./provider.js";
export { QrCodeWhatsAppProvider, type QrCodeProviderOptions } from "./qrcode/qrcode-provider.js";
export {
  AstraCallsProvider,
  type AstraCallsProviderOptions,
} from "./astracalls/astracalls-provider.js";
/**
 * Conhecimento sobre o formato de áudio que o WhatsApp aceita fica aqui,
 * junto com o resto da camada de provider. A API consome estas funções e
 * continua sem importar Baileys para nada.
 */
export {
  VOICE_NOTE_MIME_TYPE,
  audioMimeTypeFromBytes,
  detectAudioContainer,
  isWhatsAppPlayableAudio,
  resolveAudioDeclaration,
  type AudioContainer,
} from "./audio/container.js";
export {
  AudioConversionError,
  normalizeAudioForWhatsApp,
  type AudioNormalizationProfile,
  type NormalizedAudio,
} from "./audio/normalize-audio.js";
/**
 * Edição CIFRADA feita pelo cliente: o WhatsApp entrega o texto novo num
 * envelope cuja chave sai do segredo da mensagem original. A API consome
 * esta função e continua sem conhecer o formato do WhatsApp.
 */
export { decryptEditedText } from "./qrcode/message-secret.js";

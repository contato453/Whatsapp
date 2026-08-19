import {
  AudioConversionError,
  normalizeAudioForWhatsApp,
  type AudioNormalizationProfile,
} from "@azvchat/whatsapp";
import type { Logger } from "pino";
import { AppError } from "./errors.js";

/**
 * Prepara o áudio que vai sair para o WhatsApp.
 *
 * O WhatsApp toca mensagem de voz em OGG/Opus mono 16 kHz, com a flag de voz
 * e a duração em segundos. O navegador grava outra coisa: Chrome e Edge
 * entregam WebM/Opus, Safari entrega MP4/AAC. WebM o WhatsApp não
 * decodifica, e o áudio chega no celular como indisponível pedindo reenvio.
 * A conversão acontece aqui, no servidor, porque cada navegador grava de um
 * jeito e converter na tela daria um resultado diferente por máquina.
 *
 * Quem decide o formato final são os bytes, e não o mime type declarado no
 * upload: o navegador manda "audio/webm;codecs=opus" e o multipart entrega
 * "audio/webm", arquivo renomeado mente na extensão, e a flag de voz é só um
 * pedido de quem chamou.
 */
export const AUDIO_PREPARE_FAILED_MESSAGE =
  "Não foi possível preparar o áudio para envio, e a mensagem não foi enviada. Grave novamente ou anexe o arquivo em outro formato.";

export interface PreparedOutboundAudio {
  data: Buffer;
  mimeType: string;
  asVoiceNote: boolean;
  seconds: number | undefined;
  waveform: Uint8Array | undefined;
  converted: boolean;
  sourceContainer: string;
}

/**
 * `asVoiceNote` diz de onde o áudio veio, e não o que ele é: o microfone do
 * composer manda true e vira mensagem de voz; arquivo anexado do computador
 * manda false e continua arquivo de áudio, convertido só quando o WhatsApp
 * não sabe tocar o container (WAV, WebM, FLAC).
 *
 * Falhar aqui interrompe o envio de propósito. Mandar assim mesmo produz o
 * defeito que esta função existe para acabar: mensagem entregue, atendente
 * tranquilo, cliente sem conseguir ouvir.
 */
export async function prepareOutboundAudio(
  buffer: Buffer,
  fallbackMimeType: string,
  asVoiceNote: boolean,
  logger: Logger,
): Promise<PreparedOutboundAudio> {
  const profile: AudioNormalizationProfile = asVoiceNote ? "voice" : "file";
  try {
    const normalized = await normalizeAudioForWhatsApp(buffer, { profile, logger });
    return {
      data: normalized.data,
      mimeType: normalized.mimeType || fallbackMimeType,
      asVoiceNote,
      seconds: normalized.seconds,
      waveform: normalized.waveform,
      converted: normalized.converted,
      sourceContainer: normalized.sourceContainer,
    };
  } catch (error) {
    if (error instanceof AudioConversionError) {
      // O motivo técnico fica no log; o atendente lê a frase em português.
      logger.error({ event: "audio_prepare_failed", reason: error.reason });
      throw new AppError(AUDIO_PREPARE_FAILED_MESSAGE, 422, "audio_conversion_failed");
    }
    throw error;
  }
}

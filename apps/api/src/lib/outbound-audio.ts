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
 * A MENSAGEM DE VOZ ESTÁ DESLIGADA, E ISSO É DECISÃO, NÃO ESQUECIMENTO.
 *
 * O que o escritório mediu, com o mesmo arquivo nos dois caminhos: bytes
 * OGG/Opus com `ptt: false` (anexado pelo clipe) tocam no celular do cliente,
 * e os MESMOS bytes com `ptt: true` chegam como "Este áudio não está mais
 * disponível. Peça para reenviá-lo". Container, codec, mime type, duração,
 * upload, sessão e `mediaKey` são idênticos nos dois: a única variável é a
 * flag. Imagem e vídeo pelo mesmo socket nunca falharam.
 *
 * Não achamos o que o WhatsApp recusa numa mensagem de voz vinda daqui.
 * Sabemos que não é o formato (o áudio já sai no OGG/Opus mono 16 kHz que ele
 * exige) nem a waveform apagada pelo Baileys (corrigida, e não resolveu). O
 * `whatsapp-web.js`, que é outra biblioteca, tem relato do mesmo sintoma, o
 * que aponta para o lado do WhatsApp e não para o nosso código.
 *
 * Entre entregar áudio que toca e entregar a bolha bonita que ninguém
 * consegue ouvir, fica o áudio que toca. A gravação do microfone continua
 * sendo normalizada como voz (mono 16 kHz, que é o certo para fala e mantém o
 * arquivo pequeno) e sai como ARQUIVO DE ÁUDIO: o cliente vê um player comum,
 * sem a onda e sem o 1.5x.
 *
 * PARA RELIGAR: ponha esta constante em `true` e mande UM áudio para um
 * celular de verdade. Se tocar, a mensagem de voz voltou. Nada mais precisa
 * mudar: o caminho de `ptt` continua inteiro e testado, inclusive o desvio de
 * `relayVoiceNote` que devolve a waveform que o Baileys apaga.
 */
export const VOICE_NOTE_ENABLED = false;

/**
 * `fromMicrophone` diz de ONDE o áudio veio, e não o que ele vira: o microfone
 * do composer manda true e é normalizado como voz; arquivo anexado do
 * computador manda false e continua arquivo, convertido só quando o WhatsApp
 * não sabe tocar o container (WAV, WebM, FLAC). Quem decide se ele sai COMO
 * mensagem de voz é `VOICE_NOTE_ENABLED`, logo acima.
 *
 * Falhar aqui interrompe o envio de propósito. Mandar assim mesmo produz o
 * defeito que esta função existe para acabar: mensagem entregue, atendente
 * tranquilo, cliente sem conseguir ouvir.
 */
export async function prepareOutboundAudio(
  buffer: Buffer,
  fallbackMimeType: string,
  fromMicrophone: boolean,
  logger: Logger,
): Promise<PreparedOutboundAudio> {
  // Com a mensagem de voz desligada, a gravação do microfone percorre
  // EXATAMENTE o caminho do arquivo anexado, que é o único comprovadamente
  // entregue neste número. Não basta desligar a flag: o perfil de voz produz
  // OGG/Opus mono 16 kHz com `-application voip`, e a waveform é campo de
  // mensagem de voz. Qualquer um dos dois deixaria a gravação diferente do
  // anexo que funciona, e a diferença é justamente o que estamos caçando.
  const asVoiceNote = fromMicrophone && VOICE_NOTE_ENABLED;
  const profile: AudioNormalizationProfile = asVoiceNote ? "voice" : "file";
  try {
    const normalized = await normalizeAudioForWhatsApp(buffer, { profile, logger });
    return {
      data: normalized.data,
      mimeType: normalized.mimeType || fallbackMimeType,
      asVoiceNote,
      seconds: normalized.seconds,
      waveform: asVoiceNote ? normalized.waveform : undefined,
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

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
 * A mensagem de voz está LIGADA, e o interruptor existe por causa do que
 * custou chegar até aqui.
 *
 * O áudio gravado no AZVCHAT chegava no celular do cliente como "Este áudio
 * não está mais disponível. Peça para reenviá-lo", com o envio reportado como
 * sucesso deste lado. Foram DUAS causas somadas, e a segunda só apareceu
 * depois da primeira ser corrigida:
 *
 * 1. o navegador grava WebM, que o WhatsApp não decodifica;
 * 2. o WebM do MediaRecorder carrega ATRASO DE CODEC, e o ffmpeg levava esse
 *    atraso para o OGG convertido (`start_pts` 336 em vez de 0). Ver
 *    `TIMELINE_LIMPA`, em packages/whatsapp/src/audio/normalize-audio.ts.
 *
 * O que NÃO era causa, e chegou a parecer: a flag `ptt`. Ela foi suspeita
 * porque o arquivo anexado pelo clipe tocava e a gravação não, mas as duas
 * coisas diferiam também na linha de tempo. Com o atraso zerado, a mensagem de
 * voz passou a ser entregue normalmente. Se um dia o sintoma voltar, o teste
 * que separa é mandar o MESMO arquivo pelo clipe e pelo microfone.
 *
 * PARA DESLIGAR, se o WhatsApp voltar a recusar mensagem de voz: ponha esta
 * constante em `false`. A gravação passa a sair como arquivo de áudio comum,
 * que toca do mesmo jeito, só sem a onda e sem o 1.5x. É uma linha, e o
 * escritório continua trabalhando enquanto se investiga.
 */
export const VOICE_NOTE_ENABLED = true;

/**
 * Bitrate da gravação do microfone. O perfil de arquivo usa 96 kbps, que é
 * generoso para música e desperdício para fala: em Opus, 32 kbps já entrega
 * voz limpa, e o arquivo cai para cerca de um terço. Num escritório que manda
 * áudio o dia inteiro isso vira transferência e disco de verdade.
 *
 * É SÓ O BITRATE, de propósito. Taxa de amostragem e canais continuam os
 * mesmos do arquivo anexado, que é a forma provada em produção, e a cadeia de
 * resampling nem é tocada: era ali que morava o atraso de codec que fazia o
 * áudio chegar quebrado.
 */
const MICROPHONE_BITRATE = "32k";

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
  // A CONVERSÃO É SEMPRE A DE ARQUIVO, mesmo na mensagem de voz.
  //
  // Essa é a forma de bytes provada em produção: OGG/Opus 48 kHz, linha de
  // tempo zerada e sem waveform. O perfil de voz (mono 16 kHz,
  // `-application voip`, com waveform) é o que o WhatsApp usa nas mensagens
  // dele e geraria arquivo menor, mas trocá-lo mexe em três coisas de uma vez
  // sobre algo que hoje funciona. Se alguém quiser esse ganho, troque UMA
  // variável por vez e mande um áudio de verdade a cada passo: foi assim que
  // este defeito acabou sendo isolado, depois de várias tentativas em que
  // mais de uma coisa mudava junto.
  const asVoiceNote = fromMicrophone && VOICE_NOTE_ENABLED;
  const profile: AudioNormalizationProfile = "file";
  try {
    const normalized = await normalizeAudioForWhatsApp(buffer, {
      profile,
      logger,
      ...(fromMicrophone ? { bitrate: MICROPHONE_BITRATE } : {}),
    });
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

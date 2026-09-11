import type { Logger } from "pino";
import { detectAudioContainer } from "./container.js";
import { AudioConversionError, runFfmpeg } from "./ffmpeg.js";

/**
 * Conversão para MP3 do áudio que a equipe BAIXA da conversa.
 *
 * POR QUE MP3 É O PADRÃO DO DOWNLOAD: o WhatsApp entrega áudio em OGG com
 * Opus, e no Windows o duplo clique nesse arquivo costuma não tocar (o player
 * padrão não traz o codec). A equipe baixa o áudio para anexar em e-mail ou em
 * processo, e um arquivo que o destinatário não abre não serve de comprovante
 * nenhum. MP3 toca em qualquer lugar: Windows, Mac, celular, sistema de
 * tribunal. O original continua disponível para quem precisa do arquivo exato
 * que o cliente mandou.
 *
 * Converter é do SERVIDOR, e não do navegador, pelo mesmo motivo do áudio que
 * sai (ver `normalize-audio.ts`): um ffmpeg só, igual para todo mundo, em vez
 * de um resultado por navegador e por versão.
 */

/** Mime type do MP3 — o que vai no Content-Type da resposta. */
export const MP3_MIME_TYPE = "audio/mpeg";

/**
 * 96 kbps: fala em MP3 fica limpa bem antes disso, e o arquivo continua leve
 * o bastante para caber num anexo de e-mail. Taxa de amostragem e canais saem
 * da origem, sem resampling — o MP3 aceita os 48 kHz que o Opus decodifica, e
 * mexer na cadeia de resampling é o tipo de ajuste que já custou caro aqui.
 */
const MP3_BITRATE = "96k";

/** Abaixo disso não há áudio nenhum: arquivo truncado ou gravação vazia. */
const MINIMO_DE_BYTES = 64;

/**
 * Converte qualquer áudio guardado para MP3.
 *
 * Entrada vazia ou truncada é recusada ANTES de abrir o ffmpeg: gastar um
 * processo para descobrir que não havia áudio só trocaria um erro claro por
 * um "ffmpeg terminou com 1".
 */
export async function convertAudioToMp3(input: Buffer, logger: Logger): Promise<Buffer> {
  if (input.length < MINIMO_DE_BYTES) {
    throw new AudioConversionError("Áudio vazio ou truncado", "empty_input");
  }
  const sourceContainer = detectAudioContainer(input);
  const data = await runFfmpeg(
    [
      "-hide_banner", "-loglevel", "error",
      "-i", "pipe:0",
      "-vn",
      "-c:a", "libmp3lame", "-b:a", MP3_BITRATE,
      "-f", "mp3",
      "pipe:1",
    ],
    input,
  );
  // Quem prova que a conversão deu certo são os BYTES, nunca o código de saída
  // do processo: é a mesma régua do áudio que sai, e o motivo é o mesmo defeito
  // (anunciar um formato e entregar outro).
  if (detectAudioContainer(data) !== "mp3") {
    throw new AudioConversionError("Saída do ffmpeg não é MP3", "unexpected_output");
  }
  logger.info({
    event: "audio_mp3_converted",
    sourceContainer,
    bytesIn: input.length,
    bytesOut: data.length,
  });
  return data;
}

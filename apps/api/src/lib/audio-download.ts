import { AudioConversionError, convertAudioToMp3 } from "@azvchat/whatsapp";
import { readAudioMp3Key, withAudioMp3Key } from "@azvchat/shared";
import type { Logger } from "pino";
import type { PrismaClient } from "@azvchat/database";
import { AppError } from "./errors.js";
import type { MediaStorage } from "./media-storage.js";

/**
 * MP3 do áudio que a equipe baixa da conversa — convertido uma vez e guardado.
 *
 * POR QUE CONVERTER: o WhatsApp entrega áudio em OGG com Opus, e no Windows o
 * duplo clique nesse arquivo costuma não tocar. Quem baixa o áudio está
 * anexando em e-mail ou em processo, e arquivo que o destinatário não abre não
 * serve de comprovante. O original continua disponível pelo menu secundário da
 * bolha, para quem precisa do arquivo exato que o cliente mandou.
 *
 * POR QUE GUARDAR: baixar o mesmo áudio de novo é o caso comum (o cliente
 * cobra, alguém reabre a conversa e anexa outra vez), e converter toda vez
 * gastaria um ffmpeg por clique. A chave do convertido mora no `metadata` da
 * mensagem, que já viaja inteiro no DTO — nada de coluna nova nem de migration.
 */

export const AUDIO_MP3_FAILED_MESSAGE =
  "Não foi possível converter este áudio para MP3. Baixe o arquivo original pelo menu do áudio.";

export interface AudioDownloadDeps {
  prisma: PrismaClient;
  storage: MediaStorage;
  logger: Logger;
}

export interface AudioMessageForDownload {
  id: string;
  mediaUrl: string;
  metadata: unknown;
}

/**
 * Devolve os bytes do MP3 desta mensagem, convertendo só na primeira vez.
 *
 * Chave guardada cujo arquivo não existe mais (storage limpo, volume trocado)
 * não é erro: vale como "não há cópia", e a conversão roda de novo por cima.
 * Desistir ali deixaria o áudio sem download para sempre por causa de um
 * arquivo de cache.
 */
export async function resolveAudioMp3(
  deps: AudioDownloadDeps,
  message: AudioMessageForDownload,
  instanceId: string,
): Promise<Buffer> {
  const cached = readAudioMp3Key(message.metadata);
  if (cached) {
    try {
      return await deps.storage.read(cached);
    } catch {
      deps.logger.warn({ event: "audio_mp3_cache_missing", messageId: message.id });
    }
  }

  const original = await deps.storage.read(message.mediaUrl);
  let mp3: Buffer;
  try {
    mp3 = await convertAudioToMp3(original, deps.logger);
  } catch (error) {
    if (error instanceof AudioConversionError) {
      // O motivo técnico fica no log; o atendente lê a frase em português e
      // ainda tem o original como saída.
      deps.logger.error({
        event: "audio_mp3_failed",
        messageId: message.id,
        reason: error.reason,
      });
      throw new AppError(AUDIO_MP3_FAILED_MESSAGE, 422, "audio_conversion_failed");
    }
    throw error;
  }

  const key = await deps.storage.save(mp3, { instanceId, extension: "mp3" });
  // Dois downloads simultâneos do mesmo áudio convertem os dois e gravam a
  // chave do último: sobra um arquivo órfão, e nunca um áudio errado. Trancar a
  // linha para economizar isso custaria mais do que o arquivo que sobra, e o
  // clique duplo já é bloqueado na tela.
  await deps.prisma.message.update({
    where: { id: message.id },
    data: { metadata: withAudioMp3Key(message.metadata, key) as object },
  });
  return mp3;
}

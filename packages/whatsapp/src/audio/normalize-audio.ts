import { spawn } from "node:child_process";
import type { Logger } from "pino";
import {
  VOICE_NOTE_MIME_TYPE,
  audioMimeTypeFromBytes,
  detectAudioContainer,
  isWhatsAppPlayableAudio,
} from "./container.js";

/**
 * Normalização do áudio que SAI para o WhatsApp.
 *
 * O QUE O WHATSAPP EXIGE: mensagem de voz é OGG/Opus, mono, 16 kHz, com a
 * flag `ptt` e a duração em segundos. O navegador não grava nada disso: o
 * MediaRecorder do Chrome e do Edge entrega WebM/Opus, o do Safari entrega
 * MP4/AAC, e só o Firefox entrega OGG/Opus. WebM o WhatsApp não decodifica,
 * e o áudio chega no celular como indisponível, pedindo para reenviar.
 *
 * POR QUE NO SERVIDOR: converter no navegador significaria um resultado por
 * navegador e por versão, com a equipe descobrindo a diferença pelo cliente
 * reclamando. Aqui é um ffmpeg só, o mesmo para todo mundo, e o formato que
 * sai é conferido nos bytes.
 *
 * O ffmpeg roda como processo separado, lendo e escrevendo por pipe: o laço
 * de eventos do Node não fica preso, e a API continua atendendo as outras
 * requisições enquanto um áudio longo é convertido.
 */

/** Perfil de conversão: o microfone vira voz, o arquivo continua arquivo. */
export type AudioNormalizationProfile = "voice" | "file";

export interface NormalizedAudio {
  data: Buffer;
  mimeType: string;
  /** Duração em segundos. Sem ela parte dos clientes mostra o áudio quebrado. */
  seconds: number | undefined;
  /** Barrinhas do player. Puramente cosmético: falhar aqui não impede o envio. */
  waveform: Uint8Array | undefined;
  /** Container de origem, só para log. */
  sourceContainer: string;
  converted: boolean;
}

/**
 * Conversão que não deu certo. O chamador NÃO envia a mensagem: é melhor o
 * atendente ver um erro do que o cliente receber um áudio que não toca.
 */
export class AudioConversionError extends Error {
  constructor(
    message: string,
    readonly reason: string,
  ) {
    super(message);
    this.name = "AudioConversionError";
  }
}

/** Teto de tempo do ffmpeg. Um arquivo dentro do limite de upload converte em
 *  poucos segundos; o teto existe para entrada corrompida não segurar a
 *  requisição para sempre. */
const FFMPEG_TIMEOUT_MS = 60_000;

/** Taxa da decodificação usada para medir duração e desenhar a waveform. */
const PCM_SAMPLE_RATE = 8_000;
const WAVEFORM_SAMPLES = 64;

function runFfmpeg(args: string[], input: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };

    const ffmpeg = spawn("ffmpeg", args);
    const out: Buffer[] = [];
    let stderr = "";

    const timer = setTimeout(() => {
      ffmpeg.kill("SIGKILL");
      finish(() => reject(new AudioConversionError("Conversão de áudio demorou demais", "timeout")));
    }, FFMPEG_TIMEOUT_MS);

    ffmpeg.stdout.on("data", (chunk: Buffer) => out.push(chunk));
    // Sem drenar o stderr o buffer do sistema enche e o ffmpeg trava.
    ffmpeg.stderr.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString("utf8")).slice(-500);
    });
    ffmpeg.on("error", (err) => {
      finish(() =>
        reject(new AudioConversionError(`ffmpeg indisponível: ${String(err)}`, "ffmpeg_unavailable")),
      );
    });
    ffmpeg.on("close", (code) => {
      if (code === 0 && out.length > 0) finish(() => resolve(Buffer.concat(out)));
      else
        finish(() =>
          reject(
            new AudioConversionError(
              `ffmpeg terminou com ${String(code)}: ${stderr}`,
              "ffmpeg_failed",
            ),
          ),
        );
    });
    // EPIPE acontece quando o ffmpeg desiste antes de ler tudo; o motivo real
    // vem no 'close', então aqui basta não derrubar o processo.
    ffmpeg.stdin.on("error", () => undefined);
    ffmpeg.stdin.end(input);
  });
}

/**
 * O WebM que o navegador grava começa com atraso de codec, e o ffmpeg carrega
 * esse atraso para a saída: o OGG sai com `start_pts` 336 em vez de 0. O mesmo
 * comando, partindo de um WAV do computador, produz `start_pts` 0. Era a única
 * diferença estrutural que sobrava entre a gravação e o arquivo anexado, e o
 * anexado é o que comprovadamente toca no celular do cliente.
 *
 * `first_pts=0` zera esse offset, e a saída passa a ser indistinguível da que
 * vem de um arquivo. Para quem já começa em zero é inócuo.
 */
const TIMELINE_LIMPA = ["-af", "aresample=async=1:first_pts=0"];

function encodeArgs(profile: AudioNormalizationProfile): string[] {
  // Voz: exatamente o que o WhatsApp usa nas próprias mensagens de voz.
  // Arquivo: o áudio pode ser música ou uma gravação de reunião, então
  // mantém a taxa e os canais da origem para não estragar o material.
  return profile === "voice"
    ? [
        ...TIMELINE_LIMPA,
        "-c:a", "libopus", "-b:a", "24k", "-ar", "16000", "-ac", "1",
        "-application", "voip",
      ]
    : [...TIMELINE_LIMPA, "-c:a", "libopus", "-b:a", "96k", "-ar", "48000"];
}

/** Duração e waveform saem da MESMA decodificação: um passe de PCM. */
async function describeAudio(
  ogg: Buffer,
  logger: Logger,
): Promise<{ seconds: number | undefined; waveform: Uint8Array | undefined }> {
  let pcm: Buffer;
  try {
    pcm = await runFfmpeg(
      [
        "-hide_banner", "-loglevel", "error",
        "-i", "pipe:0",
        "-vn",
        "-f", "s16le",
        "-acodec", "pcm_s16le",
        "-ar", String(PCM_SAMPLE_RATE),
        "-ac", "1",
        "pipe:1",
      ],
      ogg,
    );
  } catch (error) {
    // Sem isso o Baileys ainda calcula a duração sozinho a partir do OGG,
    // então a falha aqui não impede o envio.
    logger.warn({ event: "audio_describe_failed", error: String(error) });
    return { seconds: undefined, waveform: undefined };
  }

  const totalSamples = Math.floor(pcm.length / 2);
  if (totalSamples === 0) return { seconds: undefined, waveform: undefined };
  const seconds = Math.max(1, Math.round(totalSamples / PCM_SAMPLE_RATE));

  const blockSize = Math.floor(totalSamples / WAVEFORM_SAMPLES);
  if (blockSize < 1) return { seconds, waveform: undefined };
  const medias: number[] = [];
  for (let bloco = 0; bloco < WAVEFORM_SAMPLES; bloco += 1) {
    let soma = 0;
    const inicio = bloco * blockSize;
    for (let i = 0; i < blockSize; i += 1) {
      soma += Math.abs(pcm.readInt16LE((inicio + i) * 2)) / 32768;
    }
    medias.push(soma / blockSize);
  }
  const pico = Math.max(...medias);
  const waveform =
    pico > 0
      ? new Uint8Array(medias.map((valor) => Math.min(100, Math.floor((valor / pico) * 100))))
      : undefined;
  return { seconds, waveform };
}

export interface NormalizeAudioOptions {
  profile: AudioNormalizationProfile;
  logger: Logger;
}

/**
 * Devolve o áudio no formato que o WhatsApp toca.
 *
 * No perfil `voice` converte SEMPRE que os bytes não forem OGG/Opus. No
 * perfil `file` converte só o que o WhatsApp não decodifica (WebM, WAV,
 * FLAC): mp3 e m4a seguem intactos, porque recodificar um arquivo que já
 * funciona só perderia qualidade.
 */
export async function normalizeAudioForWhatsApp(
  input: Buffer,
  { profile, logger }: NormalizeAudioOptions,
): Promise<NormalizedAudio> {
  const sourceContainer = detectAudioContainer(input);
  const precisaConverter =
    profile === "voice" ? sourceContainer !== "ogg-opus" : !isWhatsAppPlayableAudio(input);

  if (!precisaConverter) {
    const { seconds, waveform } = await describeAudio(input, logger);
    logger.info({
      event: "audio_normalized",
      sourceContainer,
      targetContainer: sourceContainer,
      profile,
      seconds,
      converted: false,
    });
    return {
      data: input,
      mimeType: audioMimeTypeFromBytes(input, "audio/ogg"),
      seconds,
      waveform: profile === "voice" ? waveform : undefined,
      sourceContainer,
      converted: false,
    };
  }

  const data = await runFfmpeg(
    [
      "-hide_banner", "-loglevel", "error",
      "-i", "pipe:0",
      "-vn",
      ...encodeArgs(profile),
      "-f", "ogg",
      "pipe:1",
    ],
    input,
  );
  if (detectAudioContainer(data) !== "ogg-opus") {
    throw new AudioConversionError("Saída do ffmpeg não é OGG/Opus", "unexpected_output");
  }
  const { seconds, waveform } = await describeAudio(data, logger);
  logger.info({
    event: "audio_normalized",
    sourceContainer,
    targetContainer: "ogg-opus",
    profile,
    seconds,
    converted: true,
  });
  return {
    data,
    mimeType: VOICE_NOTE_MIME_TYPE,
    seconds,
    waveform: profile === "voice" ? waveform : undefined,
    sourceContainer,
    converted: true,
  };
}


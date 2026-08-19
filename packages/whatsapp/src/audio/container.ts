/**
 * Qual container de áudio está DENTRO do arquivo, lido nos bytes.
 *
 * Existe porque extensão e mime type declarado são palpite: o navegador
 * manda "audio/webm;codecs=opus" e o multipart entrega "audio/webm"; um
 * arquivo renomeado para .ogg continua sendo o que sempre foi. Quem decide
 * o que o WhatsApp recebe tem que olhar o conteúdo, senão o sistema anuncia
 * um formato e entrega outro, e o aparelho do cliente mostra o áudio como
 * indisponível, pedindo para reenviar.
 *
 * Mora em packages/whatsapp junto com o resto do conhecimento sobre o que o
 * WhatsApp aceita. Nada aqui importa Baileys.
 */
export type AudioContainer =
  | "ogg-opus"
  | "ogg-outro"
  | "webm"
  | "mp4"
  | "mp3"
  | "wav"
  | "amr"
  | "desconhecido";

function ascii(buffer: Buffer, start: number, end: number): string {
  return buffer.subarray(start, end).toString("latin1");
}

export function detectAudioContainer(buffer: Buffer): AudioContainer {
  if (buffer.length < 12) return "desconhecido";
  if (ascii(buffer, 0, 4) === "OggS") {
    // O primeiro pacote de um Ogg/Opus começa com "OpusHead". Ogg com Vorbis
    // (ou qualquer outro codec) não vale como mensagem de voz.
    const head = buffer.indexOf("OpusHead", 0, "latin1");
    return head >= 0 && head < 64 ? "ogg-opus" : "ogg-outro";
  }
  if (buffer[0] === 0x1a && buffer[1] === 0x45 && buffer[2] === 0xdf && buffer[3] === 0xa3) {
    return "webm";
  }
  if (ascii(buffer, 4, 8) === "ftyp") return "mp4";
  if (ascii(buffer, 0, 3) === "ID3") return "mp3";
  if (buffer[0] === 0xff && ((buffer[1] ?? 0) & 0xe0) === 0xe0) return "mp3";
  if (ascii(buffer, 0, 4) === "RIFF" && ascii(buffer, 8, 12) === "WAVE") return "wav";
  if (ascii(buffer, 0, 5) === "#!AMR") return "amr";
  return "desconhecido";
}

/**
 * Containers que os aplicativos do WhatsApp sabem tocar numa mensagem de
 * áudio. WebM está fora, e é justamente o que o MediaRecorder do Chrome
 * grava: era ele que chegava quebrado no celular.
 */
const TOCAVEIS: ReadonlySet<AudioContainer> = new Set<AudioContainer>([
  "ogg-opus",
  "mp3",
  "mp4",
  "amr",
]);

export function isWhatsAppPlayableAudio(buffer: Buffer): boolean {
  return TOCAVEIS.has(detectAudioContainer(buffer));
}

/** Mime type que corresponde AOS BYTES, nunca a uma flag de quem chamou. */
export function audioMimeTypeFromBytes(buffer: Buffer, fallback: string): string {
  switch (detectAudioContainer(buffer)) {
    case "ogg-opus":
      return VOICE_NOTE_MIME_TYPE;
    case "ogg-outro":
      return "audio/ogg";
    case "mp3":
      return "audio/mpeg";
    case "mp4":
      return "audio/mp4";
    case "wav":
      return "audio/wav";
    case "webm":
      return "audio/webm";
    case "amr":
      return "audio/amr";
    default:
      return fallback;
  }
}

/**
 * O que o WhatsApp usa nas próprias mensagens de voz. A flag `ptt` e este
 * mime type andam juntos: declarar um sem o outro quebra em parte dos
 * aparelhos.
 */
export const VOICE_NOTE_MIME_TYPE = "audio/ogg; codecs=opus";

/**
 * Decide o que o WhatsApp vai receber num áudio: o mime type e a flag de voz.
 *
 * A flag e o mime type precisam concordar. Antes, o mime era escolhido pela
 * flag ("pediu voz, então anuncie OGG"), e bastava o ffmpeg não responder
 * para o sistema anunciar OGG carregando WebM: o aparelho do cliente mostrava
 * o áudio como indisponível pedindo reenvio, e este lado registrava sucesso.
 * Agora o mime sai dos bytes, e pedir voz para bytes que não são OGG/Opus é
 * erro de programação, não algo para degradar em silêncio.
 */
export function resolveAudioDeclaration(
  data: Buffer,
  fallbackMimeType: string,
  asVoiceNote: boolean,
): { mimetype: string; ptt: boolean } {
  const mimetype = audioMimeTypeFromBytes(data, fallbackMimeType);
  if (asVoiceNote && mimetype !== VOICE_NOTE_MIME_TYPE) {
    throw new Error("Mensagem de voz exige OGG/Opus: normalize o áudio antes de enviar");
  }
  return { mimetype, ptt: asVoiceNote };
}

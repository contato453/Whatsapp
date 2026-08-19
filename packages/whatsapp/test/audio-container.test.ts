import { describe, expect, it } from "vitest";
import {
  VOICE_NOTE_MIME_TYPE,
  audioMimeTypeFromBytes,
  detectAudioContainer,
  isWhatsAppPlayableAudio,
} from "../src/audio/container.js";

/**
 * O container é lido nos BYTES porque o mime declarado mente em toda ponta:
 * o navegador manda "audio/webm;codecs=opus" e o multipart entrega
 * "audio/webm", e arquivo renomeado mente na extensão. Foi confiar no rótulo
 * que fez o áudio sair anunciado como OGG carregando WebM dentro, e chegar
 * no celular do cliente como indisponível.
 */
function ogg(): Buffer {
  const buffer = Buffer.alloc(64);
  buffer.write("OggS", 0, "latin1");
  buffer.write("OpusHead", 28, "latin1");
  return buffer;
}

describe("detectAudioContainer", () => {
  it("reconhece OGG/Opus, que é o único formato de mensagem de voz", () => {
    expect(detectAudioContainer(ogg())).toBe("ogg-opus");
  });

  it("separa OGG com outro codec do OGG/Opus", () => {
    const vorbis = Buffer.alloc(64);
    vorbis.write("OggS", 0, "latin1");
    vorbis.write("vorbis", 29, "latin1");
    expect(detectAudioContainer(vorbis)).toBe("ogg-outro");
  });

  it("reconhece o WebM que o MediaRecorder do Chrome grava", () => {
    const webm = Buffer.alloc(32);
    webm.set([0x1a, 0x45, 0xdf, 0xa3], 0);
    expect(detectAudioContainer(webm)).toBe("webm");
  });

  it("reconhece o MP4 que o MediaRecorder do Safari grava", () => {
    const mp4 = Buffer.alloc(32);
    mp4.write("ftyp", 4, "latin1");
    expect(detectAudioContainer(mp4)).toBe("mp4");
  });

  it("reconhece mp3 e wav anexados do computador", () => {
    const mp3 = Buffer.alloc(32);
    mp3.write("ID3", 0, "latin1");
    expect(detectAudioContainer(mp3)).toBe("mp3");
    const wav = Buffer.alloc(32);
    wav.write("RIFF", 0, "latin1");
    wav.write("WAVE", 8, "latin1");
    expect(detectAudioContainer(wav)).toBe("wav");
  });

  it("arquivo vazio ou irreconhecível não vira palpite", () => {
    expect(detectAudioContainer(Buffer.alloc(0))).toBe("desconhecido");
    expect(detectAudioContainer(Buffer.from("nem áudio isso é"))).toBe("desconhecido");
  });
});

describe("isWhatsAppPlayableAudio", () => {
  it("WebM e WAV NÃO tocam no WhatsApp: é o que precisa ser convertido", () => {
    const webm = Buffer.alloc(32);
    webm.set([0x1a, 0x45, 0xdf, 0xa3], 0);
    expect(isWhatsAppPlayableAudio(webm)).toBe(false);
    const wav = Buffer.alloc(32);
    wav.write("RIFF", 0, "latin1");
    wav.write("WAVE", 8, "latin1");
    expect(isWhatsAppPlayableAudio(wav)).toBe(false);
  });

  it("OGG/Opus, mp3 e mp4 tocam, então seguem intactos", () => {
    expect(isWhatsAppPlayableAudio(ogg())).toBe(true);
    const mp3 = Buffer.alloc(32);
    mp3.write("ID3", 0, "latin1");
    expect(isWhatsAppPlayableAudio(mp3)).toBe(true);
  });
});

describe("audioMimeTypeFromBytes", () => {
  it("OGG/Opus recebe o mime exato da mensagem de voz", () => {
    expect(audioMimeTypeFromBytes(ogg(), "audio/webm")).toBe(VOICE_NOTE_MIME_TYPE);
  });

  it("WebM continua sendo anunciado como WebM, e nunca como OGG", () => {
    const webm = Buffer.alloc(32);
    webm.set([0x1a, 0x45, 0xdf, 0xa3], 0);
    expect(audioMimeTypeFromBytes(webm, "audio/ogg; codecs=opus")).toBe("audio/webm");
  });

  it("sem reconhecer o container, mantém o mime que veio", () => {
    expect(audioMimeTypeFromBytes(Buffer.alloc(4), "audio/mpeg")).toBe("audio/mpeg");
  });
});

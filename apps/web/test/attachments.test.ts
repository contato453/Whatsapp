import { describe, expect, it } from "vitest";
import {
  ATTACHMENT_MAX_FILES,
  DEFAULT_MEDIA_MAX_SIZE,
  attachmentRejection,
  attachmentRejectionMessage,
  formatFileSize,
  generatedAttachmentName,
  isGenericAttachmentName,
  outboundMediaTypeFromMime,
  tooManyAttachmentsMessage,
} from "@azvchat/shared";

/**
 * As regras que decidem o que a prévia de anexo aceita. Ficam no shared
 * porque a API decide o tipo da mensagem com a mesma função, e o teste vive
 * aqui porque quem barra antes de subir byte nenhum é a tela.
 */
describe("tipo da mídia pelo mime", () => {
  it("classifica imagem, áudio e vídeo", () => {
    expect(outboundMediaTypeFromMime("image/png")).toBe("image");
    expect(outboundMediaTypeFromMime("video/mp4")).toBe("video");
    expect(outboundMediaTypeFromMime("audio/mpeg")).toBe("audio");
  });

  it("ignora os parâmetros do mime — 'audio/ogg; codecs=opus' é áudio", () => {
    expect(outboundMediaTypeFromMime("audio/ogg; codecs=opus")).toBe("audio");
  });

  it("o resto é documento, inclusive mime vazio: nenhum arquivo é recusado por tipo", () => {
    expect(outboundMediaTypeFromMime("application/pdf")).toBe("document");
    expect(outboundMediaTypeFromMime("text/xml")).toBe("document");
    expect(outboundMediaTypeFromMime("")).toBe("document");
    expect(outboundMediaTypeFromMime(null)).toBe("document");
  });
});

describe("recusa na prévia", () => {
  it("pasta é recusada sem tentar percorrer o diretório", () => {
    expect(attachmentRejection({ size: 4096, isFolder: true })).toBe("folder");
  });

  it("arquivo de tamanho zero é recusado", () => {
    expect(attachmentRejection({ size: 0 })).toBe("empty");
  });

  it("acima do limite é recusado; exatamente no limite passa", () => {
    expect(attachmentRejection({ size: DEFAULT_MEDIA_MAX_SIZE + 1 })).toBe("too_large");
    expect(attachmentRejection({ size: DEFAULT_MEDIA_MAX_SIZE })).toBeNull();
  });

  it("a mensagem diz o limite em números, senão a recusa não ensina nada", () => {
    const message = attachmentRejectionMessage("guia.pdf", "too_large", {
      size: 40 * 1024 * 1024,
      maxSize: DEFAULT_MEDIA_MAX_SIZE,
    });
    expect(message).toContain("guia.pdf");
    expect(message).toContain("40 MB");
    expect(message).toContain("25 MB");
  });

  it("avisa quantos arquivos ficaram de fora do teto", () => {
    expect(tooManyAttachmentsMessage(3)).toContain(String(ATTACHMENT_MAX_FILES));
    expect(tooManyAttachmentsMessage(3)).toContain("3 ficaram de fora");
    expect(tooManyAttachmentsMessage(1)).toContain("1 ficou de fora");
  });
});

describe("nome do arquivo colado", () => {
  it("gera nome legível com data e hora, nunca id nem aleatório", () => {
    const at = new Date(2026, 7, 17, 14, 32);
    expect(generatedAttachmentName("image/png", at)).toBe("imagem-2026-08-17-14-32.png");
    expect(generatedAttachmentName("video/mp4", at)).toBe("video-2026-08-17-14-32.mp4");
    expect(generatedAttachmentName("application/pdf", at)).toBe("arquivo-2026-08-17-14-32.pdf");
  });

  it("nome que o navegador inventa é genérico; nome de verdade é preservado", () => {
    expect(isGenericAttachmentName("image.png")).toBe(true);
    expect(isGenericAttachmentName("")).toBe(true);
    expect(isGenericAttachmentName("blob")).toBe(true);
    expect(isGenericAttachmentName("Guia DAS 08-2026.pdf")).toBe(false);
  });
});

describe("tamanho em tela", () => {
  it("usa a casa decimal só onde ela ajuda a decidir", () => {
    expect(formatFileSize(0)).toBe("0 KB");
    expect(formatFileSize(900)).toBe("900 B");
    expect(formatFileSize(2048)).toBe("2 KB");
    expect(formatFileSize(1.5 * 1024 * 1024)).toBe("1,5 MB");
    expect(formatFileSize(25 * 1024 * 1024)).toBe("25 MB");
  });
});

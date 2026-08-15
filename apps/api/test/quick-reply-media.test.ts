import { describe, expect, it } from "vitest";
import { departmentResourceAppliesTo, quickReplyMediaTypeFromMime } from "@azvchat/shared";
import type { QuickReply } from "@azvchat/database";
import { serializeQuickReply } from "../src/lib/serialize.js";

/**
 * A regra do anexo da resposta rápida mora em um lugar só
 * (`quickReplyMediaTypeFromMime`): a API recusa o upload e a tela recusa o
 * arquivo com a MESMA decisão. Estes testes fixam essa decisão.
 */
describe("quickReplyMediaTypeFromMime", () => {
  it("aceita imagem, áudio e vídeo pelos prefixos do mime", () => {
    expect(quickReplyMediaTypeFromMime("image/png")).toBe("image");
    expect(quickReplyMediaTypeFromMime("image/jpeg")).toBe("image");
    expect(quickReplyMediaTypeFromMime("audio/mpeg")).toBe("audio");
    expect(quickReplyMediaTypeFromMime("video/mp4")).toBe("video");
  });

  it("considera só a base do mime — parâmetros como codecs não atrapalham", () => {
    // É assim que o áudio de voz chega: "audio/ogg; codecs=opus".
    expect(quickReplyMediaTypeFromMime("audio/ogg; codecs=opus")).toBe("audio");
  });

  it("não diferencia caixa alta", () => {
    expect(quickReplyMediaTypeFromMime("IMAGE/PNG")).toBe("image");
  });

  it("recusa documento: resposta rápida não é repositório de arquivos", () => {
    expect(quickReplyMediaTypeFromMime("application/pdf")).toBeNull();
    expect(quickReplyMediaTypeFromMime("application/octet-stream")).toBeNull();
    expect(quickReplyMediaTypeFromMime("text/plain")).toBeNull();
  });

  it("mime ausente ou vazio não vira anexo", () => {
    expect(quickReplyMediaTypeFromMime(null)).toBeNull();
    expect(quickReplyMediaTypeFromMime(undefined)).toBeNull();
    expect(quickReplyMediaTypeFromMime("")).toBeNull();
  });
});

function buildReply(overrides: Partial<QuickReply>): QuickReply {
  return {
    id: "reply-1",
    organizationId: "org-1",
    shortcut: "videomei",
    title: "Vídeo do MEI",
    content: "Segue o vídeo explicativo.",
    isGeneral: true,
    mediaUrl: null,
    mediaMimeType: null,
    mediaFilename: null,
    lastUsedAt: null,
    createdById: null,
    createdAt: new Date("2026-08-15T12:00:00Z"),
    updatedAt: new Date("2026-08-15T12:00:00Z"),
    ...overrides,
  };
}

describe("serializeQuickReply — bloco de mídia", () => {
  it("sem mídia sai media: null", () => {
    expect(serializeQuickReply(buildReply({})).media).toBeNull();
  });

  it("com mídia sai tipo derivado do mime, sem expor a chave do arquivo", () => {
    const serialized = serializeQuickReply(
      buildReply({
        mediaUrl: "quick-replies-org-1/123-abc.mp4",
        mediaMimeType: "video/mp4",
        mediaFilename: "explicativo.mp4",
      }),
    );
    expect(serialized.media).toEqual({
      type: "video",
      mimeType: "video/mp4",
      filename: "explicativo.mp4",
    });
    // A chave do storage nunca sai para o frontend — o binário vem só pela
    // rota autenticada GET /quick-replies/:id/media.
    expect(JSON.stringify(serialized)).not.toContain("quick-replies-org-1");
  });

  it("mime que deixou de ser válido não derruba a resposta: sai media: null", () => {
    const serialized = serializeQuickReply(
      buildReply({ mediaUrl: "chave", mediaMimeType: "application/pdf" }),
    );
    expect(serialized.media).toBeNull();
  });
});

/**
 * A regra que decide se o recurso vale para uma conversa é a mesma nas duas
 * pontas: a tela oferece e a API valida o envio direto da mídia
 * (POST /conversations/:id/quick-reply-media) com ela.
 */
describe("departmentResourceAppliesTo", () => {
  it("geral vale para qualquer conversa", () => {
    expect(departmentResourceAppliesTo(true, [], "dept-1")).toBe(true);
    expect(departmentResourceAppliesTo(true, [], null)).toBe(true);
  });

  it("conversa sem departamento aceita qualquer item visível", () => {
    expect(departmentResourceAppliesTo(false, ["dept-1"], null)).toBe(true);
  });

  it("restrito exige o departamento da conversa na lista", () => {
    expect(departmentResourceAppliesTo(false, ["dept-1", "dept-2"], "dept-2")).toBe(true);
    expect(departmentResourceAppliesTo(false, ["dept-1"], "dept-3")).toBe(false);
  });

  it("órfão (restrito sem departamento) não vale para conversa com departamento", () => {
    expect(departmentResourceAppliesTo(false, [], "dept-1")).toBe(false);
  });
});

describe("serializeQuickReply — último uso", () => {
  it("nunca usada sai lastUsedAt: null — a tela mostra 'Nunca usada'", () => {
    expect(serializeQuickReply(buildReply({})).lastUsedAt).toBeNull();
  });

  it("usada sai como ISO, para a tela formatar no fuso do navegador", () => {
    const serialized = serializeQuickReply(
      buildReply({ lastUsedAt: new Date("2026-08-15T18:30:00Z") }),
    );
    expect(serialized.lastUsedAt).toBe("2026-08-15T18:30:00.000Z");
  });
});

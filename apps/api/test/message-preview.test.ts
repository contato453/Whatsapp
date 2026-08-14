import { describe, expect, it } from "vitest";
import { buildPreview } from "../src/services/message-ingest.js";

describe("buildPreview", () => {
  it("usa o texto para mensagens de texto", () => {
    expect(buildPreview({ type: "text", content: "Bom dia, segue o boleto" })).toBe(
      "Bom dia, segue o boleto",
    );
  });

  it("trunca textos longos em 120 caracteres", () => {
    const long = "a".repeat(300);
    expect(buildPreview({ type: "text", content: long })).toHaveLength(120);
  });

  it("rotula mídias sem legenda", () => {
    expect(buildPreview({ type: "image", content: null })).toBe("📷 Imagem");
    expect(buildPreview({ type: "audio", content: null })).toBe("🎤 Áudio");
    expect(buildPreview({ type: "document", content: null })).toBe("📄 Documento");
  });

  it("inclui a legenda quando existir", () => {
    expect(buildPreview({ type: "image", content: "contrato assinado" })).toBe(
      "📷 Imagem — contrato assinado",
    );
  });
});

import { describe, expect, it } from "vitest";
import { buildQualityMaterial } from "../src/lib/quality/material.js";
import { maskSensitiveData, maskText } from "../src/lib/quality/masking.js";

/**
 * A MÁSCARA É A PROTEÇÃO DO MÓDULO, e ela só funciona se agir nos DOIS textos:
 * o que o cliente digitou e o que ele DITOU num áudio, já transcrito.
 *
 * O segundo caso é o que justifica transcrever e avaliar em passos separados:
 * mandar o áudio direto para a etapa de avaliação pularia a máscara exatamente
 * onde o cliente costuma dizer CPF, CNPJ e chave Pix.
 */

function audioMessage(id: string, transcript: string, at: Date) {
  return {
    id,
    direction: "inbound" as const,
    type: "audio",
    content: null,
    sentByUserId: null,
    timestamp: at,
    metadata: {
      durationSeconds: 12,
      audioTranscript: { status: "ok", text: transcript, model: "gpt-4o-mini-transcribe", at: at.toISOString(), attempts: 1 },
    },
  };
}

describe("mascaramento antes da avaliação", () => {
  it("substitui CPF, CNPJ, telefone, e-mail e chave Pix no texto digitado", () => {
    const { text, counts } = maskSensitiveData(
      "Meu CPF é 123.456.789-09, o CNPJ da empresa é 12.345.678/0001-90, meu telefone é (11) 98765-4321, e-mail joao@exemplo.com.br e a chave Pix é 3f2504e0-4f89-41d3-9a0c-0305e82c3301.",
    );
    expect(text).not.toContain("123.456.789-09");
    expect(text).not.toContain("12.345.678/0001-90");
    expect(text).not.toContain("98765-4321");
    expect(text).not.toContain("joao@exemplo.com.br");
    expect(text).not.toContain("3f2504e0-4f89-41d3-9a0c-0305e82c3301");
    expect(text).toContain("[CPF]");
    expect(text).toContain("[CNPJ]");
    expect(text).toContain("[telefone]");
    expect(text).toContain("[e-mail]");
    expect(text).toContain("[chave Pix]");
    expect(counts.cpf).toBe(1);
    expect(counts.cnpj).toBe(1);
  });

  it("mascara CPF cru, sem pontuação", () => {
    expect(maskText("anota aí 12345678909")).toBe("anota aí [CPF]");
  });

  it("não confunde ano nem valor com telefone", () => {
    const text = maskText("o balanço de 2026 fechou em 1.500,00");
    expect(text).toContain("2026");
    expect(text).toContain("1.500,00");
    expect(text).not.toContain("[telefone]");
  });

  it("mascara o que foi DITO num áudio, depois de transcrito", () => {
    const at = new Date("2026-09-01T12:00:00Z");
    const material = buildQualityMaterial(
      [audioMessage("m1", "Oi, meu CPF é 123.456.789-09 e meu telefone é (11) 98765-4321", at)],
      "user-1",
    );
    expect(material.text).toContain("[CPF]");
    expect(material.text).toContain("[telefone]");
    expect(material.text).not.toContain("123.456.789-09");
    expect(material.text).not.toContain("98765-4321");
  });

  it("não expõe o identificador interno da mensagem, só o apelido curto", () => {
    const at = new Date("2026-09-01T12:00:00Z");
    const material = buildQualityMaterial(
      [
        {
          id: "3f2504e0-4f89-41d3-9a0c-0305e82c3301",
          direction: "inbound",
          type: "text",
          content: "bom dia",
          sentByUserId: null,
          timestamp: at,
          metadata: null,
        },
      ],
      "user-1",
    );
    expect(material.text).not.toContain("3f2504e0-4f89-41d3-9a0c-0305e82c3301");
    expect(material.text).toContain("M1");
    expect(material.references.get("M1")).toBe("3f2504e0-4f89-41d3-9a0c-0305e82c3301");
  });

  it("marca o áudio não transcrito com a duração e derruba a cobertura", () => {
    const base = new Date("2026-09-01T12:00:00Z");
    const material = buildQualityMaterial(
      [
        {
          id: "m1",
          direction: "inbound",
          type: "text",
          content: "bom dia",
          sentByUserId: null,
          timestamp: base,
          metadata: null,
        },
        {
          id: "m2",
          direction: "inbound",
          type: "audio",
          content: null,
          sentByUserId: null,
          timestamp: new Date(base.getTime() + 60_000),
          metadata: { durationSeconds: 900 },
        },
      ],
      "user-1",
    );
    expect(material.text).toContain("[áudio que não foi possível transcrever]");
    expect(material.text).toContain("15min00s");
    expect(material.coveragePercent).toBe(50);
  });

  it("identifica cada fala pelo PAPEL, nunca pelo nome", () => {
    const base = new Date("2026-09-01T12:00:00Z");
    const material = buildQualityMaterial(
      [
        { id: "m1", direction: "inbound", type: "text", content: "oi", sentByUserId: null, timestamp: base, metadata: null },
        {
          id: "m2",
          direction: "outbound",
          type: "text",
          content: "bom dia",
          sentByUserId: "user-1",
          timestamp: new Date(base.getTime() + 60_000),
          metadata: null,
        },
        {
          id: "m3",
          direction: "outbound",
          type: "text",
          content: "complementando",
          sentByUserId: "user-2",
          timestamp: new Date(base.getTime() + 120_000),
          metadata: null,
        },
      ],
      "user-1",
    );
    expect(material.text).toContain("Cliente:");
    expect(material.text).toContain("Atendente avaliado:");
    expect(material.text).toContain("Outro atendente:");
    expect(material.text).not.toContain("user-1");
  });

  it("corta a conversa longa e AVISA dentro do material", () => {
    const base = new Date("2026-09-01T12:00:00Z");
    const mensagens = Array.from({ length: 200 }, (_, index) => ({
      id: `m${index}`,
      direction: "inbound" as const,
      type: "text",
      content: "x".repeat(200),
      sentByUserId: null,
      timestamp: new Date(base.getTime() + index * 60_000),
      metadata: null,
    }));
    const material = buildQualityMaterial(mensagens, "user-1", { maxChars: 5_000 });
    expect(material.truncated).toBe(true);
    expect(material.text).toContain("AVISO");
    expect(material.messageCount).toBeLessThan(200);
  });
});

import { describe, expect, it } from "vitest";
import { applySignature } from "../src/lib/signature.js";

const on = { name: "Fernanda Oliveira", signMessages: true };
const off = { name: "Fernanda Oliveira", signMessages: false };

describe("applySignature", () => {
  it("prefixa o nome do atendente em negrito quando a assinatura está ligada", () => {
    // Asteriscos: é assim que o WhatsApp marca negrito.
    expect(applySignature("Boa tarde", on)).toBe("*Fernanda Oliveira:*\nBoa tarde");
  });

  it("não mexe no texto quando está desligada", () => {
    expect(applySignature("Boa tarde", off)).toBe("Boa tarde");
  });

  it("não assina quando não há atendente identificado", () => {
    expect(applySignature("Boa tarde", null)).toBe("Boa tarde");
  });

  it("não duplica a assinatura se o atendente já digitou o nome", () => {
    const signed = "Fernanda Oliveira:\nBoa tarde";
    expect(applySignature(signed, on)).toBe(signed);
  });

  it("reconhece assinatura já em negrito e não duplica", () => {
    const signed = "*Fernanda Oliveira:*\nBoa tarde";
    expect(applySignature(signed, on)).toBe(signed);
  });

  it("ignora diferença de caixa ao detectar assinatura repetida", () => {
    expect(applySignature("FERNANDA OLIVEIRA:\nOi", on)).toBe("FERNANDA OLIVEIRA:\nOi");
  });

  it("legenda ausente continua ausente — não cria legenda só com o nome", () => {
    expect(applySignature(null, on)).toBeNull();
  });

  it("texto em branco não vira assinatura solta", () => {
    expect(applySignature("   ", on)).toBe("   ");
  });

  it("assina texto de várias linhas mantendo o corpo intacto", () => {
    expect(applySignature("Linha 1\nLinha 2", on)).toBe("*Fernanda Oliveira:*\nLinha 1\nLinha 2");
  });
});

import { describe, expect, it } from "vitest";
import type { QuickReplyUnresolved } from "@azvchat/shared";
import { pendingUnresolved, unresolvedWarning } from "@/components/inbox/quick-reply-variables";

/**
 * O aviso de variável por preencher é conferido contra o TEXTO que está no
 * composer, e não contra o que aconteceu na inserção: preencher o
 * "[CNPJ]" na mão tem que apagar o aviso na mesma tecla.
 */

const CNPJ: QuickReplyUnresolved = {
  name: "empresa.cnpj",
  label: "CNPJ",
  placeholder: "[CNPJ]",
};
const RAZAO: QuickReplyUnresolved = {
  name: "empresa.razao_social",
  label: "Razão social",
  placeholder: "[Razão social]",
};

describe("pendingUnresolved", () => {
  it("mantém só o que continua no texto", () => {
    const draft = "Prezada [Razão social], confirme o CNPJ 12.345.678/0001-90.";
    expect(pendingUnresolved(draft, [CNPJ, RAZAO])).toEqual([RAZAO]);
  });

  it("texto sem marcador nenhum não gera aviso", () => {
    expect(pendingUnresolved("Bom dia!", [CNPJ, RAZAO])).toEqual([]);
  });
});

describe("unresolvedWarning", () => {
  it("nomeia as variáveis e oferece enviar assim mesmo", () => {
    expect(unresolvedWarning([CNPJ])).toContain("CNPJ");
    expect(unresolvedWarning([CNPJ, RAZAO])).toContain("Razão social");
    // Avisa, nunca bloqueia: o texto do aviso termina perguntando.
    expect(unresolvedWarning([CNPJ])).toContain("Enviar?");
  });
});

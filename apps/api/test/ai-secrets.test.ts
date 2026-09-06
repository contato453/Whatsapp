import { describe, expect, it } from "vitest";
import { createSecretCipher, maskApiKey } from "../src/lib/ai-secrets.js";

/**
 * A chave de API do provedor é SEGREDO: cifrada em repouso, decifrável só
 * pela chave do processo, e nunca reconstruível a partir do que a tela vê.
 */
describe("ai-secrets", () => {
  const KEY = "a".repeat(64);

  it("cifra e decifra com AI_SECRETS_KEY dedicada", () => {
    const cipher = createSecretCipher({ aiSecretsKey: KEY, jwtSecret: "x".repeat(32) });
    const sealed = cipher.encrypt("sk-proj-abcdef1234567890");
    expect(sealed).not.toContain("sk-proj");
    expect(sealed.startsWith("v1:")).toBe(true);
    expect(cipher.decrypt(sealed)).toBe("sk-proj-abcdef1234567890");
    expect(cipher.dedicatedKey).toBe(true);
  });

  it("sem AI_SECRETS_KEY deriva do JWT_SECRET e avisa pelo flag", () => {
    const cipher = createSecretCipher({ jwtSecret: "segredo-do-jwt-com-tamanho-suficiente" });
    expect(cipher.dedicatedKey).toBe(false);
    expect(cipher.decrypt(cipher.encrypt("sk-1234567890"))).toBe("sk-1234567890");
  });

  it("chave de cifra diferente NÃO abre o que a outra gravou", () => {
    const a = createSecretCipher({ aiSecretsKey: KEY, jwtSecret: "x".repeat(32) });
    const b = createSecretCipher({ aiSecretsKey: "b".repeat(64), jwtSecret: "x".repeat(32) });
    expect(() => b.decrypt(a.encrypt("sk-abcdefghijk"))).toThrow();
  });

  it("recusa chave de cifra com tamanho errado", () => {
    expect(() => createSecretCipher({ aiSecretsKey: "abc", jwtSecret: "x".repeat(32) })).toThrow();
  });

  it("máscara mostra só prefixo e os quatro últimos", () => {
    expect(maskApiKey("sk-proj-ABCDEFGHIJKLMNOP8F2A")).toBe("sk-••••••••••••8F2A");
    expect(maskApiKey("curta")).toBe("••••");
  });
});

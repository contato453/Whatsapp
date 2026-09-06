import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

/**
 * Cifra da chave de API do provedor de IA.
 *
 * A chave é um SEGREDO do escritório: cifrada em repouso (AES-256-GCM) e
 * decifrada só no processo da API, no momento de falar com o provedor.
 * Nunca vai para log, DTO, auditoria nem para o Next.js — a tela recebe
 * apenas o `hint` ("sk-••••8F2A"), calculado aqui uma vez na gravação.
 *
 * A chave de cifra sai de `AI_SECRETS_KEY` (32 bytes em hex). Sem ela, cai
 * numa derivação do `JWT_SECRET` — funciona, mas quem troca o JWT_SECRET
 * perde a chave gravada (a tela mostra "não conectado" e pede de novo).
 * O `index.ts` avisa no boot quando é esse o caso.
 */

const VERSION = "v1";

export interface SecretCipher {
  encrypt(plain: string): string;
  decrypt(sealed: string): string;
  /** Veio de `AI_SECRETS_KEY` (true) ou da derivação de reserva (false). */
  dedicatedKey: boolean;
}

export function createSecretCipher(options: { aiSecretsKey?: string; jwtSecret: string }): SecretCipher {
  const dedicated = options.aiSecretsKey?.trim();
  const key = dedicated
    ? Buffer.from(dedicated, "hex")
    : createHash("sha256").update(`azvchat-ai-secrets:${options.jwtSecret}`).digest();
  if (key.length !== 32) {
    throw new Error("AI_SECRETS_KEY precisa ter exatamente 32 bytes em hexadecimal (64 caracteres)");
  }
  return {
    dedicatedKey: Boolean(dedicated),
    encrypt(plain) {
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", key, iv);
      const encrypted = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
      const tag = cipher.getAuthTag();
      return [VERSION, iv.toString("base64"), tag.toString("base64"), encrypted.toString("base64")].join(":");
    },
    decrypt(sealed) {
      const [version, ivB64, tagB64, dataB64] = sealed.split(":");
      if (version !== VERSION || !ivB64 || !tagB64 || !dataB64) {
        throw new Error("Segredo em formato desconhecido");
      }
      const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(ivB64, "base64"));
      decipher.setAuthTag(Buffer.from(tagB64, "base64"));
      return Buffer.concat([
        decipher.update(Buffer.from(dataB64, "base64")),
        decipher.final(),
      ]).toString("utf8");
    },
  };
}

/**
 * O que a tela vê da chave: prefixo curto + os quatro últimos caracteres.
 * Suficiente para a pessoa reconhecer qual chave está gravada, insuficiente
 * para reconstruí-la.
 */
export function maskApiKey(apiKey: string): string {
  const trimmed = apiKey.trim();
  if (trimmed.length <= 8) return "••••";
  const prefix = trimmed.startsWith("sk-") ? "sk-" : trimmed.slice(0, 2);
  return `${prefix}••••••••••••${trimmed.slice(-4)}`;
}

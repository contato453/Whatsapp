import { createHash, randomBytes } from "node:crypto";

/**
 * Geração e conferência do token de integração.
 *
 * O token tem alta entropia (32 bytes aleatórios), então o hash é sha256
 * direto — não bcrypt. bcrypt existe para senha humana (baixa entropia,
 * precisa de fator de custo); aqui o segredo é grande e a autenticação é uma
 * igualdade por índice único, sem risco de força bruta. O valor em claro
 * NUNCA é gravado: só o hash e o prefixo visível.
 */
const TOKEN_BYTES = 32;
const TOKEN_PREFIX = "azv";
// "azv_" + 8 primeiros do segredo: identifica o token na tela sem revelar o
// resto. Tamanho fixo para o prefixo caber numa coluna previsível.
const VISIBLE_PREFIX_LENGTH = TOKEN_PREFIX.length + 1 + 8;

export interface GeneratedIntegrationToken {
  /** Valor em claro — mostrado UMA vez ao criar e nunca mais. */
  token: string;
  tokenHash: string;
  tokenPrefix: string;
}

export function generateIntegrationToken(): GeneratedIntegrationToken {
  const secret = randomBytes(TOKEN_BYTES).toString("base64url");
  const token = `${TOKEN_PREFIX}_${secret}`;
  return {
    token,
    tokenHash: hashIntegrationToken(token),
    tokenPrefix: token.slice(0, VISIBLE_PREFIX_LENGTH),
  };
}

export function hashIntegrationToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

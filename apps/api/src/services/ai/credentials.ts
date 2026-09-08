import type { PrismaClient } from "@azvchat/database";
import type { Logger } from "pino";
import { AI_DEFAULT_MODEL, type AiProviderKind } from "@azvchat/shared";
import type { SecretCipher } from "../../lib/ai-secrets.js";
import { OpenAiProvider } from "./openai-provider.js";
import type { AiProvider } from "./provider.js";

/**
 * Registro de provedores e leitura da credencial gravada.
 *
 * `createAiProvider` é o ÚNICO lugar que instancia um provedor concreto —
 * o mesmo desenho do `WhatsAppProvider`. Provedor novo entra aqui e em
 * `AI_PROVIDERS` do shared; o motor de atendimento não muda.
 */
export function createAiProvider(kind: AiProviderKind, logger: Logger): AiProvider {
  switch (kind) {
    case "openai":
      return new OpenAiProvider({ logger: logger.child({ module: "ai-openai" }) });
  }
}

export interface ResolvedCredentials {
  provider: AiProvider;
  kind: AiProviderKind;
  apiKey: string;
  defaultModel: string;
}

/**
 * A credencial pronta para uso, decifrada AGORA e só para esta chamada —
 * nunca fica em cache em memória por mais tempo que a requisição.
 * `null` = provedor não conectado (a IA não atende, e quem chama decide o
 * fallback).
 */
export async function resolveCredentials(
  prisma: PrismaClient,
  cipher: SecretCipher,
  logger: Logger,
  organizationId: string,
  kind: AiProviderKind = "openai",
): Promise<ResolvedCredentials | null> {
  const config = await prisma.aiProviderConfig.findUnique({
    where: { organizationId_provider: { organizationId, provider: kind } },
  });
  if (!config?.apiKeyEncrypted) return null;
  let apiKey: string;
  try {
    apiKey = cipher.decrypt(config.apiKeyEncrypted);
  } catch (err) {
    // Chave de cifra trocada (JWT_SECRET sem AI_SECRETS_KEY, por exemplo):
    // a chave gravada virou lixo. Trata como "não conectado" e avisa.
    logger.error({ event: "ai_api_key_decrypt_failed", organizationId, error: String(err) });
    return null;
  }
  return {
    provider: createAiProvider(kind, logger),
    kind,
    apiKey,
    defaultModel: config.defaultModel ?? AI_DEFAULT_MODEL,
  };
}

import type { PrismaClient } from "@azvchat/database";
import { readAiAttachmentInsightOf } from "@azvchat/shared";
import type { Logger } from "pino";
import type { Server } from "socket.io";
import type { SecretCipher } from "../lib/ai-secrets.js";
import type { MediaStorage } from "../lib/media-storage.js";
import { ensureAttachmentInsights, resolveTranscriptionModel, type ReadableMessage } from "./ai/attachments.js";
import { loadAiSettings, loadBudgetState } from "./ai/budget.js";
import { resolveCredentials } from "./ai/credentials.js";

/**
 * O ÁUDIO DA MAYA NO WHATSAPP vira texto aqui, antes de ir para o Azevedo-OS.
 *
 * Não existe uma segunda transcrição no sistema: quem faz o trabalho é
 * `ensureAttachmentInsights`, a mesma função do atendimento por IA e do Quality.
 * Ela já sabe tudo que importa e que não vale reescrever: lê o arquivo do
 * storage, respeita o teto de duração, grava o resultado (o sucesso E o
 * insucesso) em `Message.metadata.audioTranscript` — de onde a bolha da Inbox
 * mostra o que foi entendido — e cobra a linha de consumo como `transcription`.
 *
 * Sem sessão e sem agente, como no Quality: a transcrição da Maya não pertence
 * a atendimento nenhum, e o consumo entra na organização. O interruptor de
 * transcrição do escritório (`AiSettings.transcribeAudio`) é da IA de
 * ATENDIMENTO e não vale aqui, pelo mesmo motivo do Quality: quem pediu a Maya
 * ouvindo áudio foi o dono do número, para ele mesmo.
 */

export type MayaAudioResult =
  | { ok: true; text: string }
  /** A IA não está configurada no AZVCHAT (sem chave do provedor). */
  | { ok: false; motivo: "ai_not_configured" }
  /** O orçamento mensal de IA do AZVCHAT está bloqueado. */
  | { ok: false; motivo: "budget_blocked" }
  /** Sem arquivo, longo demais, sem fala ou o provedor recusou. */
  | { ok: false; motivo: "unreadable" };

export type MayaAudioTranscriber = (input: {
  organizationId: string;
  conversationId: string;
  message: ReadableMessage;
}) => Promise<MayaAudioResult>;

export function createMayaAudioTranscriber(deps: {
  prisma: PrismaClient;
  io: Server;
  logger: Logger;
  media: MediaStorage;
  cipher: SecretCipher;
}): MayaAudioTranscriber {
  return async ({ organizationId, conversationId, message }) => {
    const credentials = await resolveCredentials(deps.prisma, deps.cipher, deps.logger, organizationId);
    if (!credentials) return { ok: false, motivo: "ai_not_configured" };

    // O orçamento vale aqui como vale no atendimento: bloqueado, nada é pago.
    const aiSettings = await loadAiSettings(deps.prisma, organizationId);
    const budget = await loadBudgetState(deps.prisma, organizationId, aiSettings);
    if (budget.blocked) return { ok: false, motivo: "budget_blocked" };

    const conversation = await deps.prisma.conversation.findUnique({ where: { id: conversationId } });
    if (!conversation) return { ok: false, motivo: "unreadable" };

    const [lida] = await ensureAttachmentInsights(
      { prisma: deps.prisma, io: deps.io, logger: deps.logger, media: deps.media },
      {
        organizationId,
        conversation,
        credentials,
        timeoutMs: aiSettings.timeoutMs,
        sessionId: null,
        agent: null,
        pricingOverrides: aiSettings.pricingOverrides,
        audio: { enabled: true, model: resolveTranscriptionModel(aiSettings.transcriptionModel) },
        // A Maya só recebe áudio por aqui: imagem e documento seriam chamada
        // paga (ou leitura) sem destino.
        image: { enabled: false, model: credentials.defaultModel },
        document: { enabled: false },
      },
      [message],
    );

    const insight = readAiAttachmentInsightOf("audio", lida?.metadata);
    const text = insight?.status === "ok" ? insight.text?.trim() : null;
    return text ? { ok: true, text } : { ok: false, motivo: "unreadable" };
  };
}

import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { z } from "zod";
import { RealtimeEvents } from "@azvchat/shared";
import { AppError } from "../../lib/errors.js";
import { serializeConversation, serializeMessage } from "../../lib/serialize.js";
import { conversationAudience } from "../../realtime/socket.js";
import { buildPreview } from "../../services/message-ingest.js";
import type { AppDeps } from "../../types.js";

/**
 * Rota de entrada do Azevedo-OS (Financeiro): manda lembrete de cobrança por
 * WhatsApp. Sentido inverso de `integrations/routes.ts` — lá o AZVCHAT chama
 * PARA o Azevedo-OS; aqui é o Azevedo-OS chamando PARA CÁ.
 *
 * Escopo deliberadamente estreito, decisão do Lincoln (26/08/2026): um único
 * `FINANCEIRO_WHATSAPP_INSTANCE_ID` fixo, pré-cadastrado no `.env` — nunca
 * escolhido por parâmetro da chamada. Um token vazado manda mensagem só por
 * este número, nunca pelos outros conectados da empresa.
 *
 * Não existe conversa nem contato prévios para a maioria dos telefones que
 * chegam aqui: diferente das rotas de `messages/routes.ts` (que sempre
 * partem de uma Conversation já existente), esta cria a conversa na hora,
 * via `deps.ingest.ensureConversation` — o mesmo caminho que o restante do
 * sistema usa para número novo entrando por engano de grupo (ver
 * `conversations/routes.ts`), então não é lógica nova, é reaproveitada.
 */
export async function financeiroLembreteRoutes(app: FastifyInstance, deps: AppDeps): Promise<void> {
  /**
   * Bearer estático, não JWT de sessão — quem chama é um serviço, não uma
   * pessoa logada no navegador. Mesma ideia do `AZEVEDO_OS_API_TOKEN` (que
   * autentica o AZVCHAT no Azevedo-OS), só que na direção contrária: aqui
   * não existe nada para copiar, porque este é o primeiro caminho de
   * autenticação de serviço-para-serviço ENTRANDO no AZVCHAT.
   */
  async function autenticarServicoFinanceiro(request: FastifyRequest, _reply: FastifyReply): Promise<void> {
    const token = deps.config.FINANCEIRO_LEMBRETE_TOKEN;
    const instanceId = deps.config.FINANCEIRO_WHATSAPP_INSTANCE_ID;
    if (!token || !instanceId) {
      throw new AppError(
        "Integração de lembretes do Financeiro não está configurada nesta API.",
        503,
        "financeiro_lembrete_nao_configurado",
      );
    }
    const cabecalho = request.headers.authorization ?? "";
    const recebido = cabecalho.startsWith("Bearer ") ? cabecalho.slice(7) : "";
    if (!recebido || recebido !== token) {
      throw new AppError("Não autorizado.", 401, "unauthorized");
    }
  }

  const corpoSchema = z.object({
    telefone: z.string().min(8),
    mensagem: z.string().min(1).max(4000),
    externalReference: z.string().optional(),
  });

  app.post(
    "/integrations/financeiro/lembrete",
    { preHandler: autenticarServicoFinanceiro },
    async (request) => {
      const { telefone, mensagem, externalReference } = corpoSchema.parse(request.body);
      // Já confirmado presente pelo preHandler; o "!" é seguro aqui.
      const instanceId = deps.config.FINANCEIRO_WHATSAPP_INSTANCE_ID!;

      const instance = await deps.prisma.whatsAppInstance.findUnique({
        where: { id: instanceId },
      });
      if (!instance) {
        throw new AppError(
          "O número de WhatsApp configurado para o Financeiro não existe mais.",
          503,
          "instance_nao_encontrada",
        );
      }

      const status = await deps.provider.getConnectionStatus(instanceId);
      if (status !== "connected") {
        throw new AppError(
          `O número de WhatsApp do Financeiro não está conectado no momento (status: ${status}).`,
          503,
          "instance_offline",
        );
      }

      const telefoneDigitos = telefone.replace(/\D/g, "");
      if (!telefoneDigitos) {
        throw new AppError("Telefone inválido — nenhum dígito encontrado.", 400, "telefone_invalido");
      }
      const jid = `${telefoneDigitos}@s.whatsapp.net`;

      const conversation = await deps.ingest.ensureConversation(
        {
          instanceId,
          externalChatId: jid,
          isGroup: false,
          callerName: null,
          callerPhone: telefoneDigitos,
        },
        instance.organizationId,
      );

      let resultadoEnvio: { externalMessageId: string; timestamp: Date };
      try {
        resultadoEnvio = await deps.provider.sendText(instanceId, jid, mensagem);
      } catch (e) {
        throw new AppError(
          `Falha ao enviar a mensagem pelo WhatsApp: ${e instanceof Error ? e.message : "erro desconhecido"}`,
          502,
          "falha_envio",
        );
      }

      const message = await deps.prisma.message.create({
        data: {
          organizationId: instance.organizationId,
          conversationId: conversation.id,
          externalMessageId: resultadoEnvio.externalMessageId,
          direction: "outbound",
          type: "text",
          content: mensagem,
          senderName: "Financeiro (Azevedo OS)",
          timestamp: resultadoEnvio.timestamp,
          status: "sent",
          // Sem sentByUserId de propósito: não é uma pessoa logada mandando,
          // é a integração — o campo é opcional exatamente para este caso.
          ...(externalReference ? { metadata: { externalReference, origem: "azevedo-os" } } : {}),
        },
      });

      await deps.prisma.conversation.update({
        where: { id: conversation.id },
        data: {
          lastMessageAt: resultadoEnvio.timestamp,
          lastMessagePreview: buildPreview({ type: "text", content: mensagem }),
        },
      });

      const room = conversationAudience(instance.organizationId, conversation);
      deps.io.to(room).emit(RealtimeEvents.MessageNew, {
        conversation: serializeConversation(conversation, null),
        message: serializeMessage(message),
      });
      deps.io
        .to(room)
        .emit(RealtimeEvents.ConversationUpdated, serializeConversation(conversation, null));

      deps.audit.record({
        organizationId: instance.organizationId,
        userId: null,
        action: "message.sent.integration",
        entityType: "Conversation",
        entityId: conversation.id,
        metadata: { origem: "azevedo-os", externalReference: externalReference ?? null },
      });

      return { ok: true, conversationId: conversation.id, messageId: message.id };
    },
  );
}

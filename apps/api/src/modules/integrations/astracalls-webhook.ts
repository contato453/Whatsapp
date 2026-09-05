import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { AppError } from "../../lib/errors.js";
import type { AppDeps } from "../../types.js";

/**
 * Recebe os eventos que o AstraCalls empurra por webhook (mensagem recebida,
 * receipt, etc.) e os entrega ao provider, que os traduz nos eventos
 * normalizados que o InstanceManager já consome. É o equivalente, para o
 * AstraCalls, ao callback do socket do Baileys — só que o "socket" agora é
 * uma chamada HTTP entrando.
 *
 * Autenticação por SEGREDO, não por JWT de sessão: quem chama é o AstraCalls,
 * não uma pessoa. O AstraCalls não manda o nosso bearer, então exigimos o
 * `ASTRACALLS_WEBHOOK_SECRET` — na query (`?secret=`) ou no header
 * `x-webhook-secret`. Sem o segredo configurado, a rota fica fechada (503).
 */
export async function astracallsWebhookRoutes(app: FastifyInstance, deps: AppDeps): Promise<void> {
  async function autenticar(request: FastifyRequest): Promise<void> {
    const secret = deps.config.ASTRACALLS_WEBHOOK_SECRET;
    if (!secret) {
      throw new AppError(
        "Webhook do AstraCalls não está configurado nesta API.",
        503,
        "astracalls_webhook_nao_configurado",
      );
    }
    const query = request.query as { secret?: string };
    const headerSecret = request.headers["x-webhook-secret"];
    const recebido = query.secret ?? (typeof headerSecret === "string" ? headerSecret : "");
    if (!recebido || recebido !== secret) {
      throw new AppError("Não autorizado.", 401, "unauthorized");
    }
  }

  // Envelope validado de forma FROUXA de propósito: o AstraCalls ainda pode
  // acrescentar campos, e recusar um payload por causa de um extra derrubaria
  // o recebimento. Só garantimos o mínimo que o provider usa.
  const envelopeSchema = z
    .object({
      session: z.string(),
      event: z.string(),
      timestamp: z.number().optional(),
      data: z.unknown().optional(),
    })
    .passthrough();

  app.post(
    "/integrations/astracalls/webhook",
    { preHandler: autenticar },
    async (request, reply) => {
      const parsed = envelopeSchema.safeParse(request.body);
      if (!parsed.success) {
        // Não é erro do chamador que mereça 4xx com detalhe: só ignora e segue.
        deps.logger.warn({ event: "astracalls_webhook_invalido" });
        return reply.code(200).send({ ok: true });
      }
      // O provider concreto (AstraCalls) expõe handleWebhook; a interface
      // WhatsAppProvider não. Narrowing seguro em vez de acoplar a interface.
      const provider = deps.provider as { handleWebhook?: (payload: unknown) => void };
      if (typeof provider.handleWebhook === "function") {
        provider.handleWebhook(parsed.data);
      }
      // Responde rápido: processamento é assíncrono, o AstraCalls só quer o 200.
      return reply.code(200).send({ ok: true });
    },
  );
}

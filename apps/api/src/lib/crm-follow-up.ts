import type { PrismaClient } from "@azvchat/database";
import type { Logger } from "pino";
import type { Server } from "socket.io";
import { emitCrmOpportunityById } from "./crm-events.js";
import { recordCrmEvent } from "./crm-history.js";
import { emitScheduledPending } from "./scheduled-pending.js";

/**
 * O follow-up do CRM e o cancelamento dele.
 *
 * O follow-up NÃO tem motor próprio: a ação de etapa cria uma
 * `ScheduledMessage` normal e quem envia é `services/scheduler.ts`, o mesmo
 * das agendadas do composer. O que este arquivo faz é a outra metade — parar
 * a régua quando ela deixa de fazer sentido.
 *
 * Duas coisas param um follow-up, e as duas estão aqui:
 *
 *   a. **o cliente respondeu.** É o caso que dá sentido a tudo: mandar "ainda
 *      tem interesse?" depois de a pessoa ter respondido é o erro que faz o
 *      cliente perder a confiança no escritório. Roda na ingestão de mensagem
 *      recebida;
 *   b. **o card saiu da etapa** (ou foi ganho, perdido ou reaberto): a
 *      cobrança combinada valia para aquela situação.
 *
 * O QUE NUNCA É CANCELADO: agendamento que uma PESSOA marcou à mão. O filtro
 * é sempre `crmOpportunityId`, e agendamento manual tem essa coluna nula.
 * Cancelar o compromisso que alguém assumiu com o cliente porque um card se
 * mexeu seria o CRM desmarcando conversa alheia.
 */

export interface FollowUpDeps {
  prisma: PrismaClient;
  io: Server;
  logger: Logger;
}

/**
 * Cancela os follow-ups PENDENTES desta oportunidade. Devolve quantos foram.
 *
 * `pending` é o único status que entra: o que já saiu não volta, e o que
 * falhou de vez já saiu da fila.
 */
export async function cancelCrmFollowUps(
  deps: FollowUpDeps,
  organizationId: string,
  opportunityId: string,
  motivo: string,
): Promise<number> {
  const pendentes = await deps.prisma.scheduledMessage.findMany({
    where: { crmOpportunityId: opportunityId, status: "pending" },
    select: { id: true, conversationId: true },
  });
  if (pendentes.length === 0) return 0;

  await deps.prisma.scheduledMessage.updateMany({
    where: { id: { in: pendentes.map((item) => item.id) }, status: "pending" },
    data: { status: "canceled" },
  });

  // O badge do composer cai na hora, em cada conversa alcançada.
  const conversas = [...new Set(pendentes.map((item) => item.conversationId))];
  for (const conversationId of conversas) {
    await emitScheduledPending(deps, organizationId, conversationId);
  }

  await recordCrmEvent(deps.prisma, {
    organizationId,
    opportunityId,
    type: "follow_up_canceled",
    description: `${pendentes.length} follow-up(s) cancelado(s): ${motivo}`,
    metadata: { quantidade: pendentes.length, motivo },
  });
  deps.logger.info({
    event: "crm_follow_up_canceled",
    opportunityId,
    quantidade: pendentes.length,
  });
  return pendentes.length;
}

/**
 * O cliente escreveu numa conversa: atualiza as oportunidades ABERTAS dela e
 * cancela o follow-up que estava a caminho.
 *
 * Chamado da ingestão (`instance-manager`), depois de a mensagem já estar
 * gravada. NUNCA lança: o CRM é passageiro no caminho da mensagem, e uma
 * falha aqui não pode transformar mensagem recebida em mensagem perdida —
 * mesma regra do `ingest()`, que também engole tudo e loga.
 *
 * Só mensagem RECEBIDA (`inbound`) chega aqui. A equipe respondendo não
 * cancela follow-up: a régua existe justamente porque o cliente não respondeu.
 */
export async function handleCrmClientReply(
  deps: FollowUpDeps,
  organizationId: string,
  conversationId: string,
  when: Date,
): Promise<void> {
  try {
    const abertas = await deps.prisma.crmOpportunity.findMany({
      where: { organizationId, conversationId, status: "open" },
      select: { id: true },
    });
    if (abertas.length === 0) return;

    await deps.prisma.crmOpportunity.updateMany({
      where: { id: { in: abertas.map((item) => item.id) } },
      data: { lastInteractionAt: when },
    });

    for (const oportunidade of abertas) {
      const cancelados = await cancelCrmFollowUps(
        deps,
        organizationId,
        oportunidade.id,
        "cliente respondeu",
      );
      if (cancelados > 0) {
        await recordCrmEvent(deps.prisma, {
          organizationId,
          opportunityId: oportunidade.id,
          type: "client_replied",
          description: "Cliente respondeu — follow-up interrompido",
        });
      }
      // O card mostra "última interação" e o quadro precisa disso ao vivo:
      // é o sinal de que a negociação voltou a andar.
      await emitCrmOpportunityById(deps, organizationId, oportunidade.id);
    }
  } catch (err) {
    deps.logger.warn({
      event: "crm_client_reply_failed",
      conversationId,
      error: String(err),
    });
  }
}

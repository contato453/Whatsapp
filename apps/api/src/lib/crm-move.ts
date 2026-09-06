import type { PrismaClient } from "@azvchat/database";
import { CRM_POSITION_STEP, crmPositionBetween } from "@azvchat/shared";
import type { Logger } from "pino";
import type { Server } from "socket.io";
import { loadOpportunityForSystem, type OpportunityWithRelations } from "./crm-access.js";
import { emitCrmOpportunity } from "./crm-events.js";
import { cancelCrmFollowUps } from "./crm-follow-up.js";
import { recordCrmEvent } from "./crm-history.js";
import { runStageActions } from "./crm-stage-actions.js";
import { AppError, NotFoundError } from "./errors.js";

/**
 * Mover o card de etapa — o coração do Kanban, e o ponto onde duas pessoas
 * arrastando ao mesmo tempo se encontram.
 *
 * CONCORRÊNCIA. A tela manda de onde ela ACHA que o card está (`fromStageId`).
 * Se o banco discordar, a movimentação é recusada com 409 e a resposta já traz
 * o card como ele está de verdade — a tela corrige sozinha em vez de gravar
 * por cima do que o colega acabou de fazer. Sem essa conferência, o último
 * arrasto vence sempre, e o primeiro some sem ninguém ver: o supervisor moveu
 * para "Ganho", o atendente moveu para "Negociação" um segundo depois, e o
 * fechamento evapora.
 *
 * CARD FECHADO NÃO SE MOVE. Ganha ou perdida sai do jogo; voltar ao funil é a
 * ação explícita de REABRIR, que tem chave própria porque mexe em número já
 * contado no relatório do mês.
 *
 * ORDEM DENTRO DA COLUNA. A posição é a média entre os vizinhos (posições
 * espaçadas, ver `CRM_POSITION_STEP`): mover um card no meio da coluna é UMA
 * escrita, e não a renumeração da coluna inteira — que é o que faz dois
 * arrastos simultâneos embaralharem a ordem um do outro.
 */

export interface MoveDeps {
  prisma: PrismaClient;
  io: Server;
  logger: Logger;
}

export interface MoveInput {
  organizationId: string;
  opportunityId: string;
  toStageId: string;
  /** Etapa que a tela acredita ser a atual. Ausente = sem checagem otimista. */
  fromStageId?: string | null;
  /** Vizinhos no destino, para calcular a posição. */
  beforeId?: string | null;
  afterId?: string | null;
  performedByUserId: string | null;
  /** Obrigatório quando o destino é etapa do tipo `lost`. */
  lossReasonId?: string | null;
  lossNote?: string | null;
  /** Valor efetivamente fechado, quando o destino é `won`. */
  closedValue?: number | null;
}

export const CRM_STAGE_CONFLICT_CODE = "crm_stage_conflict";
export const CRM_CLOSED_CODE = "crm_opportunity_closed";
export const CRM_LOSS_REASON_REQUIRED_CODE = "crm_loss_reason_required";

export async function moveCrmOpportunity(
  deps: MoveDeps,
  input: MoveInput,
): Promise<OpportunityWithRelations> {
  const atual = await loadOpportunityForSystem(
    deps.prisma,
    input.organizationId,
    input.opportunityId,
  );
  if (!atual) throw new NotFoundError("Oportunidade");

  if (input.fromStageId && atual.stageId !== input.fromStageId) {
    // 409 com o estado real: a tela troca o card de lugar e a pessoa vê o que
    // o colega fez, em vez de um erro que ela não sabe interpretar.
    throw new AppError(
      "Alguém moveu este card antes de você. A tela foi atualizada.",
      409,
      CRM_STAGE_CONFLICT_CODE,
    );
  }
  if (atual.status !== "open") {
    throw new AppError(
      "Oportunidade encerrada. Reabra antes de mover.",
      409,
      CRM_CLOSED_CODE,
    );
  }

  const destino = await deps.prisma.crmStage.findFirst({
    where: {
      id: input.toStageId,
      pipelineId: atual.pipelineId,
      organizationId: input.organizationId,
    },
    include: { actions: true },
  });
  // Etapa de outro funil não é destino válido: mover entre funis é troca de
  // funil (PATCH), com o card recomeçando na primeira etapa do novo.
  if (!destino) throw new AppError("Etapa inválida para este funil", 400, "invalid_stage");

  if (destino.type === "lost" && !input.lossReasonId) {
    throw new AppError(
      "Informe o motivo da perda",
      400,
      CRM_LOSS_REASON_REQUIRED_CODE,
    );
  }
  if (input.lossReasonId) {
    const motivo = await deps.prisma.crmLossReason.findFirst({
      where: { id: input.lossReasonId, organizationId: input.organizationId },
      select: { id: true },
    });
    if (!motivo) throw new AppError("Motivo de perda inválido", 400, "invalid_loss_reason");
  }

  const mudouEtapa = atual.stageId !== destino.id;
  const position = await resolvePosition(deps.prisma, input, destino.id);

  // Sair da etapa roda as ações de saída da ANTIGA, entrar roda as de entrada
  // da NOVA. Reordenar dentro da mesma coluna não dispara nada: mexer na
  // ordem não é mudar de fase, e disparar ali faria um ajuste visual mandar
  // mensagem para o cliente.
  const contexto = {
    organizationId: input.organizationId,
    opportunityId: atual.id,
    conversationId: atual.conversationId,
    performedByUserId: input.performedByUserId,
  };

  let mudancas: { assignedUserId?: string | null; departmentId?: string | null } = {};
  if (mudouEtapa) {
    const saida = await runStageActions(deps, atual.stage.actions ?? [], contexto, "leave");

    // A ORDEM AQUI NÃO É DETALHE, e já mordeu uma vez na verificação de ponta
    // a ponta: o cancelamento tem de vir ANTES das ações de entrada. O
    // follow-up combinado valia para a etapa ANTERIOR e precisa parar (senão o
    // cliente recebe "ainda tem interesse?" depois de já ter fechado) — mas se
    // isto rodasse depois, cancelaria o follow-up que a etapa de DESTINO
    // acabou de agendar, e a régua da coluna nova nunca sairia. O sintoma é
    // silencioso: nenhum erro, e a mensagem simplesmente não chegando.
    await cancelCrmFollowUps(deps, input.organizationId, atual.id, "oportunidade mudou de etapa");

    const entrada = await runStageActions(deps, destino.actions, contexto, "enter");
    mudancas = { ...saida, ...entrada };
  }

  const fecha = destino.type === "won" || destino.type === "lost";
  const agora = new Date();

  await deps.prisma.crmOpportunity.update({
    where: { id: atual.id },
    data: {
      stageId: destino.id,
      position,
      ...(mudouEtapa ? { stageEnteredAt: agora } : {}),
      ...(mudancas.assignedUserId !== undefined
        ? { assignedUserId: mudancas.assignedUserId }
        : {}),
      ...(mudancas.departmentId !== undefined ? { departmentId: mudancas.departmentId } : {}),
      ...(fecha
        ? {
            status: destino.type === "won" ? ("won" as const) : ("lost" as const),
            closedAt: agora,
            // Valor fechado só no ganho: em perda não há o que registrar, e
            // gravar o estimado ali inflaria a receita do relatório.
            ...(destino.type === "won"
              ? { closedValue: input.closedValue ?? undefined }
              : { lossReasonId: input.lossReasonId ?? null, lossNote: input.lossNote ?? null }),
          }
        : {}),
    },
  });

  if (mudouEtapa) {
    await recordCrmEvent(deps.prisma, {
      organizationId: input.organizationId,
      opportunityId: atual.id,
      type: "stage_changed",
      performedByUserId: input.performedByUserId,
      fromStageId: atual.stageId,
      toStageId: destino.id,
      description: `Movida de ${atual.stage.name} para ${destino.name}`,
    });
    if (fecha) {
      await recordCrmEvent(deps.prisma, {
        organizationId: input.organizationId,
        opportunityId: atual.id,
        type: destino.type === "won" ? "won" : "lost",
        performedByUserId: input.performedByUserId,
        description:
          destino.type === "won" ? "Oportunidade ganha" : "Oportunidade perdida",
        metadata:
          destino.type === "won"
            ? { closedValue: input.closedValue ?? null }
            : { lossReasonId: input.lossReasonId ?? null },
      });
      // Ganhou ou perdeu: atividade pendente vira ruído na agenda de todo
      // mundo. Cancelamos as pendentes (não as concluídas, que são histórico).
      await deps.prisma.crmActivity.updateMany({
        where: { opportunityId: atual.id, status: "pending" },
        data: { status: "canceled" },
      });
      // Aqui o cancelamento DEPOIS é o certo: a oportunidade acabou, e nada
      // que a etapa de fechamento tenha agendado deve sair para o cliente.
      await cancelCrmFollowUps(
        deps,
        input.organizationId,
        atual.id,
        destino.type === "won" ? "oportunidade ganha" : "oportunidade perdida",
      );
    }
  }

  const atualizada = await loadOpportunityForSystem(
    deps.prisma,
    input.organizationId,
    atual.id,
  );
  if (!atualizada) throw new NotFoundError("Oportunidade");
  emitCrmOpportunity(deps, input.organizationId, atualizada);
  return atualizada;
}

/**
 * Posição do card no destino: a média entre os vizinhos que a tela informou.
 *
 * Sem vizinhos (soltou numa coluna vazia, ou a tela não mandou referência) o
 * card vai para o fim da coluna — que é o comportamento previsível de quem
 * arrasta para o meio do nada.
 */
async function resolvePosition(
  prisma: PrismaClient,
  input: MoveInput,
  stageId: string,
): Promise<number> {
  const ids = [input.beforeId, input.afterId].filter((id): id is string => Boolean(id));
  const vizinhos =
    ids.length > 0
      ? await prisma.crmOpportunity.findMany({
          where: { id: { in: ids }, stageId },
          select: { id: true, position: true },
        })
      : [];
  const before = vizinhos.find((item) => item.id === input.beforeId)?.position ?? null;
  const after = vizinhos.find((item) => item.id === input.afterId)?.position ?? null;
  if (before !== null || after !== null) return crmPositionBetween(before, after);

  const ultimo = await prisma.crmOpportunity.findFirst({
    where: { stageId, status: "open" },
    orderBy: { position: "desc" },
    select: { position: true },
  });
  return ultimo ? ultimo.position + CRM_POSITION_STEP : CRM_POSITION_STEP;
}

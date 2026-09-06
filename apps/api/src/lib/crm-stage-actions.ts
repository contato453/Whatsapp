import type { CrmStageAction, PrismaClient } from "@azvchat/database";
import {
  crmStageActionNeedsConversation,
  RealtimeEvents,
  type CrmStageActionTrigger,
} from "@azvchat/shared";
import type { Logger } from "pino";
import type { Server } from "socket.io";
import { conversationAssigneeWhere } from "./access.js";
import { recordCrmEvent } from "./crm-history.js";
import { emitScheduledPending } from "./scheduled-pending.js";
import { serializeUserDirectory } from "./serialize.js";
import { conversationAudience } from "../realtime/socket.js";

/**
 * As "automações" do CRM — o que acontece ao ENTRAR ou SAIR de uma etapa.
 *
 * NÃO EXISTE MOTOR NOVO AQUI, e isso é decisão, não economia. Cada ação chama
 * o mesmo caminho que uma pessoa usaria na mão: etiqueta é `ConversationTag`,
 * responsável é a coluna da oportunidade, nota interna é `InternalNote` com o
 * mesmo evento de socket, e follow-up é `ScheduledMessage` enviada pelo
 * `services/scheduler.ts` de sempre. Um agendador próprio do CRM seria o pior
 * defeito possível deste módulo: dois processos discordando sobre o que já
 * saiu, e o cliente recebendo a mesma cobrança duas vezes.
 *
 * Regras que valem para qualquer mexida aqui:
 *
 * 1. **ação que falha não impede a movimentação do card.** Arrastar é o
 *    trabalho; automação é conveniência. Uma etiqueta excluída no meio do
 *    caminho não pode travar o Kanban — o erro vira log e a fila continua;
 * 2. **ação que precisa de conversa é PULADA em oportunidade avulsa**, e não
 *    tentada e falhada: lead que ainda não escreveu não tem onde receber
 *    mensagem nem etiqueta;
 * 3. **quem recebe a atribuição precisa enxergar a conversa** — a mesma
 *    `conversationAssigneeWhere` da transferência manual. Sem essa checagem, a
 *    automação faria em silêncio o que a rota de atribuição recusa: mandar o
 *    atendimento para quem nunca vai abri-lo;
 * 4. **toda ação executada vira linha no histórico**, com autor nulo (é o
 *    sistema). Sem isso a equipe veria a etiqueta aparecer sozinha e não teria
 *    como saber de onde veio.
 */

export interface StageActionDeps {
  prisma: PrismaClient;
  io: Server;
  logger: Logger;
}

export interface StageActionContext {
  organizationId: string;
  opportunityId: string;
  conversationId: string | null;
  /** Quem disparou a movimentação; nulo quando foi o sistema. */
  performedByUserId: string | null;
}

export interface StageActionOutcome {
  /** Campos que a ação pediu para mudar NA OPORTUNIDADE. */
  assignedUserId?: string | null;
  departmentId?: string | null;
}

/**
 * Roda as ações de uma etapa e devolve o que precisa ser gravado na
 * oportunidade (responsável e departamento). O resto é aplicado aqui mesmo.
 */
export async function runStageActions(
  deps: StageActionDeps,
  actions: CrmStageAction[],
  context: StageActionContext,
  trigger: CrmStageActionTrigger,
): Promise<StageActionOutcome> {
  const outcome: StageActionOutcome = {};
  const doTrigger = actions
    .filter((action) => action.trigger === trigger)
    .sort((a, b) => a.position - b.position);

  for (const action of doTrigger) {
    if (!context.conversationId && crmStageActionNeedsConversation(action.type)) {
      // Regra 2: lead avulso não tem onde receber. Pular é o certo — tentar
      // encheria o log de falha previsível.
      continue;
    }
    try {
      await runOne(deps, action, context, outcome);
    } catch (err) {
      // Regra 1: o card já se moveu. Log com o que identifica a automação,
      // nunca com o conteúdo da mensagem.
      deps.logger.warn({
        event: "crm_stage_action_failed",
        opportunityId: context.opportunityId,
        stageActionId: action.id,
        type: action.type,
        error: String(err),
      });
    }
  }
  return outcome;
}

async function runOne(
  deps: StageActionDeps,
  action: CrmStageAction,
  context: StageActionContext,
  outcome: StageActionOutcome,
): Promise<void> {
  const { prisma } = deps;
  const conversationId = context.conversationId;

  switch (action.type) {
    case "add_tag": {
      if (!action.tagId || !conversationId) return;
      // A MESMA etiqueta da conversa (não existe etiqueta de CRM). Já
      // pendurada não é erro: `skipDuplicates` deixa a ação idempotente, e
      // ela roda de novo se o card voltar para a etapa.
      await prisma.conversationTag.createMany({
        data: [{ conversationId, tagId: action.tagId }],
        skipDuplicates: true,
      });
      await prisma.crmOpportunityTag.createMany({
        data: [{ opportunityId: context.opportunityId, tagId: action.tagId }],
        skipDuplicates: true,
      });
      await recordCrmEvent(prisma, {
        organizationId: context.organizationId,
        opportunityId: context.opportunityId,
        type: "tag_added",
        description: "Etiqueta aplicada pela automação da etapa",
        metadata: { tagId: action.tagId, automatica: true },
      });
      return;
    }

    case "remove_tag": {
      if (!action.tagId || !conversationId) return;
      await prisma.conversationTag.deleteMany({
        where: { conversationId, tagId: action.tagId },
      });
      await prisma.crmOpportunityTag.deleteMany({
        where: { opportunityId: context.opportunityId, tagId: action.tagId },
      });
      await recordCrmEvent(prisma, {
        organizationId: context.organizationId,
        opportunityId: context.opportunityId,
        type: "tag_removed",
        description: "Etiqueta removida pela automação da etapa",
        metadata: { tagId: action.tagId, automatica: true },
      });
      return;
    }

    case "assign_user": {
      if (!action.userId) return;
      // Regra 3: só recebe quem enxerga a conversa. Em oportunidade avulsa
      // não há conversa para conferir, e o recorte fica com departamento e
      // status ativo — a mesma régua, no que dela existe.
      const conversation = conversationId
        ? await prisma.conversation.findUnique({
            where: { id: conversationId },
            select: { whatsappInstanceId: true, departmentId: true },
          })
        : null;
      const candidate = await prisma.user.findFirst({
        where: conversation
          ? { ...conversationAssigneeWhere(context.organizationId, conversation), id: action.userId }
          : { id: action.userId, organizationId: context.organizationId, status: "active" },
        select: { id: true, name: true, role: true, status: true, avatarUrl: true },
      });
      if (!candidate) {
        throw new Error("usuário da automação não enxerga esta conversa");
      }
      outcome.assignedUserId = candidate.id;
      await recordCrmEvent(prisma, {
        organizationId: context.organizationId,
        opportunityId: context.opportunityId,
        type: "assignee_changed",
        toUserId: candidate.id,
        description: `Responsável definido pela automação da etapa: ${candidate.name}`,
        metadata: { automatica: true },
      });
      return;
    }

    case "change_department": {
      if (!action.departmentId) return;
      const department = await prisma.department.findFirst({
        where: { id: action.departmentId, organizationId: context.organizationId },
        select: { id: true, name: true },
      });
      if (!department) return;
      // Muda o departamento DA OPORTUNIDADE, nunca o da conversa: mexer no
      // da conversa tiraria o atendimento da tela de um time inteiro, e isso
      // é escrita de supervisão feita por gente (ver CLAUDE.md §5).
      outcome.departmentId = department.id;
      await recordCrmEvent(prisma, {
        organizationId: context.organizationId,
        opportunityId: context.opportunityId,
        type: "department_changed",
        description: `Departamento definido pela automação da etapa: ${department.name}`,
        metadata: { automatica: true },
      });
      return;
    }

    case "create_activity": {
      const due = new Date(Date.now() + Math.max(0, action.delayMinutes) * 60_000);
      const activity = await prisma.crmActivity.create({
        data: {
          organizationId: context.organizationId,
          opportunityId: context.opportunityId,
          type: "task",
          title: action.content?.trim() || "Retornar ao cliente",
          dueAt: due,
          // Sem responsável fixo: quem assume é quem estiver com a
          // oportunidade quando a tela mostrar a tarefa. Fixar aqui a pessoa
          // da automação criaria tarefa para quem saiu de férias.
          assignedUserId: action.userId ?? null,
        },
      });
      await recordCrmEvent(prisma, {
        organizationId: context.organizationId,
        opportunityId: context.opportunityId,
        type: "activity_created",
        description: `Atividade criada pela automação: ${activity.title}`,
        metadata: { activityId: activity.id, automatica: true },
      });
      return;
    }

    case "schedule_message": {
      const content = action.content?.trim();
      if (!content || !conversationId) return;
      const when = new Date(Date.now() + Math.max(1, action.delayMinutes) * 60_000);
      await prisma.scheduledMessage.create({
        data: {
          organizationId: context.organizationId,
          conversationId,
          content,
          scheduledFor: when,
          // Sem `createdById`: não foi uma pessoa que marcou. É o mesmo
          // padrão do agendamento disparado por integração.
          crmOpportunityId: context.opportunityId,
        },
      });
      // O badge do composer conta agendamento do CRM como qualquer outro: é
      // mensagem que vai sair para o cliente, e esconder isso de quem está na
      // conversa faria a equipe mandar a mesma coisa duas vezes.
      await emitScheduledPending(deps, context.organizationId, conversationId);
      await recordCrmEvent(prisma, {
        organizationId: context.organizationId,
        opportunityId: context.opportunityId,
        type: "follow_up_scheduled",
        description: `Follow-up agendado para ${when.toLocaleString("pt-BR")}`,
        metadata: { scheduledFor: when.toISOString(), automatica: true },
      });
      return;
    }

    case "internal_note": {
      const content = action.content?.trim();
      if (!content || !conversationId) return;
      const note = await prisma.internalNote.create({
        data: {
          organizationId: context.organizationId,
          conversationId,
          // Nota sem autor: foi o sistema. A tela já sabe desenhar isso (o
          // autor de nota sempre pôde ser nulo, para quando o usuário sai do
          // cadastro).
          userId: null,
          content,
        },
        include: { user: true },
      });
      const conversation = await prisma.conversation.findUnique({
        where: { id: conversationId },
        select: { whatsappInstanceId: true, departmentId: true, assignedUserId: true },
      });
      if (conversation) {
        deps.io
          .to(conversationAudience(context.organizationId, conversation))
          .emit(RealtimeEvents.InternalNote, {
            id: note.id,
            conversationId,
            content: note.content,
            user: note.user ? serializeUserDirectory(note.user) : null,
            createdAt: note.createdAt.toISOString(),
          });
      }
      await recordCrmEvent(prisma, {
        organizationId: context.organizationId,
        opportunityId: context.opportunityId,
        type: "note",
        description: "Nota interna registrada pela automação da etapa",
        metadata: { noteId: note.id, automatica: true },
      });
      return;
    }

    default:
      return;
  }
}

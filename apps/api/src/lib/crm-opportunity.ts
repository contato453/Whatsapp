import type { Prisma, PrismaClient } from "@azvchat/database";
import {
  CRM_ORIGIN_FROM_CONVERSATION,
  CRM_POSITION_STEP,
  formatPhone,
} from "@azvchat/shared";
import type { Logger } from "pino";
import type { Server } from "socket.io";
import {
  loadOpportunityForSystem,
  opportunityInclude,
  type OpportunityWithRelations,
} from "./crm-access.js";
import { emitCrmOpportunity } from "./crm-events.js";
import { recordCrmEvent } from "./crm-history.js";
import { runStageActions } from "./crm-stage-actions.js";
import { AppError, NotFoundError } from "./errors.js";

/**
 * Criação de oportunidade — o caminho ÚNICO, usado pela tela, pelo chat e
 * pela automação de etiqueta.
 *
 * Três coisas moram aqui porque não podem divergir entre esses caminhos:
 *
 * 1. **o contato vem da CONVERSA**, sempre. Nome, telefone, departamento e
 *    responsável são herdados dela; nada é digitado de novo e nada vira
 *    cadastro novo. Pedir nome e telefone de quem já está conversando com o
 *    escritório seria a definição de cadastro duplicado;
 * 2. **duplicidade é decidida pelo BANCO**, não por um `findFirst` antes do
 *    `create`. O índice parcial `crm_opportunities_open_per_conversation_pipeline`
 *    impede a mesma conversa ter duas oportunidades ABERTAS no mesmo funil, e
 *    aqui a violação (P2002) é traduzida em "já existe, toma a que existe".
 *    Conferir antes e criar depois deixa a janela entre as duas consultas
 *    aberta — e é exatamente ela que o clique duplo e o webhook repetido
 *    encontram;
 * 3. **as ações de ENTRADA da primeira etapa rodam na criação**, senão a
 *    automação valeria ao arrastar e não ao nascer, e o funil que começa com
 *    "avisar o comercial" nunca avisaria ninguém no caso mais comum.
 */

export interface CreateOpportunityDeps {
  prisma: PrismaClient;
  io: Server;
  logger: Logger;
}

export interface CreateOpportunityInput {
  organizationId: string;
  pipelineId: string;
  /** Etapa inicial; ausente = a primeira do funil. */
  stageId?: string | null;
  title?: string | null;
  conversationId?: string | null;
  contactName?: string | null;
  contactPhone?: string | null;
  assignedUserId?: string | null;
  departmentId?: string | null;
  productId?: string | null;
  value?: number | null;
  discount?: number | null;
  probability?: number | null;
  expectedCloseDate?: Date | null;
  origin?: string | null;
  notes?: string | null;
  tagIds?: string[];
  /** Nulo = criada pelo sistema (automação de etiqueta). */
  performedByUserId: string | null;
}

export interface CreateOpportunityResult {
  opportunity: OpportunityWithRelations;
  /** true = já existia uma aberta para esta conversa neste funil. */
  duplicated: boolean;
}

export async function createCrmOpportunity(
  deps: CreateOpportunityDeps,
  input: CreateOpportunityInput,
): Promise<CreateOpportunityResult> {
  const pipeline = await deps.prisma.crmPipeline.findFirst({
    where: { id: input.pipelineId, organizationId: input.organizationId },
    include: { stages: { orderBy: { position: "asc" }, include: { actions: true } } },
  });
  if (!pipeline) throw new NotFoundError("Funil");
  if (pipeline.stages.length === 0) {
    throw new AppError("Este funil ainda não tem etapas", 400, "pipeline_without_stages");
  }

  const stage = input.stageId
    ? pipeline.stages.find((item) => item.id === input.stageId)
    : pipeline.stages[0];
  if (!stage) throw new AppError("Etapa inválida para este funil", 400, "invalid_stage");

  const conversation = input.conversationId
    ? await deps.prisma.conversation.findFirst({
        where: { id: input.conversationId, organizationId: input.organizationId },
        select: {
          id: true,
          title: true,
          customTitle: true,
          externalChatId: true,
          departmentId: true,
          assignedUserId: true,
          lastMessageAt: true,
        },
      })
    : null;
  if (input.conversationId && !conversation) throw new NotFoundError("Conversa");

  const contactPhone = input.contactPhone ?? phoneFromChatId(conversation?.externalChatId ?? null);
  const title =
    input.title?.trim() ||
    (conversation ? conversation.customTitle || conversation.title : null) ||
    (contactPhone ? formatPhone(contactPhone) : null) ||
    "Nova oportunidade";

  // Card novo vai para o TOPO da coluna: quem acabou de criar precisa vê-lo
  // sem rolar. Posição menor que a menor de hoje, com o mesmo passo espaçado
  // das movimentações.
  const primeiro = await deps.prisma.crmOpportunity.findFirst({
    where: { organizationId: input.organizationId, stageId: stage.id, status: "open" },
    orderBy: { position: "asc" },
    select: { position: true },
  });
  const position = primeiro ? primeiro.position - CRM_POSITION_STEP : CRM_POSITION_STEP;

  const data: Prisma.CrmOpportunityUncheckedCreateInput = {
    organizationId: input.organizationId,
    pipelineId: pipeline.id,
    stageId: stage.id,
    title,
    conversationId: conversation?.id ?? null,
    contactName: input.contactName ?? null,
    contactPhone,
    // Herda da conversa quando ninguém escolheu: o atendimento já decidiu de
    // quem é o cliente, e repetir a escolha só cria divergência.
    assignedUserId: input.assignedUserId ?? conversation?.assignedUserId ?? null,
    departmentId: input.departmentId ?? conversation?.departmentId ?? null,
    productId: input.productId ?? null,
    value: input.value ?? 0,
    discount: input.discount ?? null,
    probability: input.probability ?? null,
    expectedCloseDate: input.expectedCloseDate ?? null,
    origin: input.origin ?? (conversation ? CRM_ORIGIN_FROM_CONVERSATION : "manual"),
    notes: input.notes ?? null,
    position,
    stageEnteredAt: new Date(),
    lastInteractionAt: conversation?.lastMessageAt ?? null,
    createdById: input.performedByUserId,
    ...(input.tagIds && input.tagIds.length > 0
      ? { tags: { create: input.tagIds.map((tagId) => ({ tagId })) } }
      : {}),
  };

  let created: { id: string };
  try {
    created = await deps.prisma.crmOpportunity.create({ data, select: { id: true } });
  } catch (err) {
    if (isUniqueViolation(err) && conversation) {
      // Regra 2: quem perdeu a corrida (ou clicou duas vezes) recebe a
      // oportunidade que já existe, em vez de um erro que faria a pessoa
      // tentar de novo e criar a terceira.
      const existente = await deps.prisma.crmOpportunity.findFirst({
        where: {
          organizationId: input.organizationId,
          conversationId: conversation.id,
          pipelineId: pipeline.id,
          status: "open",
        },
        include: opportunityInclude,
      });
      if (existente) return { opportunity: existente, duplicated: true };
    }
    throw err;
  }

  await recordCrmEvent(deps.prisma, {
    organizationId: input.organizationId,
    opportunityId: created.id,
    type: "created",
    performedByUserId: input.performedByUserId,
    toStageId: stage.id,
    description: input.performedByUserId
      ? `Oportunidade criada em ${stage.name}`
      : `Oportunidade criada automaticamente em ${stage.name}`,
    metadata: { pipelineId: pipeline.id, automatica: input.performedByUserId === null },
  });

  // Regra 3: automação de ENTRADA da primeira etapa vale na criação.
  const outcome = await runStageActions(
    deps,
    stage.actions,
    {
      organizationId: input.organizationId,
      opportunityId: created.id,
      conversationId: conversation?.id ?? null,
      performedByUserId: input.performedByUserId,
    },
    "enter",
  );
  if (outcome.assignedUserId !== undefined || outcome.departmentId !== undefined) {
    await deps.prisma.crmOpportunity.update({
      where: { id: created.id },
      data: {
        ...(outcome.assignedUserId !== undefined
          ? { assignedUserId: outcome.assignedUserId }
          : {}),
        ...(outcome.departmentId !== undefined ? { departmentId: outcome.departmentId } : {}),
      },
    });
  }

  const opportunity = await loadOpportunityForSystem(
    deps.prisma,
    input.organizationId,
    created.id,
  );
  if (!opportunity) throw new NotFoundError("Oportunidade");
  emitCrmOpportunity(deps, input.organizationId, opportunity);
  return { opportunity, duplicated: false };
}

/**
 * Criação automática por ETIQUETA: a conversa recebeu a etiqueta que um funil
 * marcou como gatilho, então abre-se o card.
 *
 * Reusa a etiqueta que o escritório já tem em vez de inventar gatilho por
 * palavra-chave: quem etiqueta como "Quer contratar" já está classificando o
 * atendimento, e classificar duas vezes (uma para a Inbox, outra para o CRM)
 * é o tipo de trabalho dobrado que ninguém mantém.
 *
 * NUNCA lança: é passageira do caminho de etiquetar, e etiquetar não pode
 * falhar porque o CRM tropeçou.
 */
export async function maybeCreateOpportunityFromTag(
  deps: CreateOpportunityDeps,
  input: { organizationId: string; conversationId: string; tagId: string; performedByUserId: string | null },
): Promise<void> {
  try {
    const funis = await deps.prisma.crmPipeline.findMany({
      where: {
        organizationId: input.organizationId,
        autoCreateTagId: input.tagId,
        isActive: true,
      },
      select: { id: true },
    });
    for (const funil of funis) {
      const { duplicated } = await createCrmOpportunity(deps, {
        organizationId: input.organizationId,
        pipelineId: funil.id,
        conversationId: input.conversationId,
        // Autor nulo: quem criou foi a regra, não a pessoa que etiquetou. O
        // histórico diz "criada automaticamente" e a equipe entende de onde
        // o card veio.
        performedByUserId: null,
      });
      deps.logger.info({
        event: "crm_opportunity_auto_created",
        conversationId: input.conversationId,
        pipelineId: funil.id,
        duplicada: duplicated,
      });
    }
  } catch (err) {
    deps.logger.warn({
      event: "crm_auto_create_failed",
      conversationId: input.conversationId,
      tagId: input.tagId,
      error: String(err),
    });
  }
}

function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { code?: string }).code === "P2002"
  );
}

/**
 * Telefone a partir do endereço do WhatsApp. `@lid` não carrega telefone — e
 * exibir os dígitos de um LID como número faria alguém tentar ligar para algo
 * que não existe (ver CLAUDE.md §13).
 */
function phoneFromChatId(externalChatId: string | null): string | null {
  if (!externalChatId) return null;
  const [numero, dominio] = externalChatId.split("@");
  if (!numero || dominio === "lid" || !/^\d{8,15}$/.test(numero)) return null;
  return numero;
}

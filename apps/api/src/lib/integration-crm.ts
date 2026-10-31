import type { PrismaClient } from "@azvchat/database";
import type { Logger } from "pino";
import type { Server } from "socket.io";
import { createCrmOpportunity } from "./crm-opportunity.js";
import { loadOrganizationFeatures } from "./organization-features.js";

/**
 * Card no CRM para quem chega pela API de integração — o caso de origem é o
 * formulário do site (workshop): a pessoa preenche, recebe a mensagem e já
 * cai na etapa do funil, sem ninguém da equipe criar o card na mão.
 *
 * É o mesmo raciocínio do bloco "Enviar para funil (CRM)" dos fluxos, e pelos
 * mesmos motivos:
 *
 * - **o card é PASSAGEIRO do envio, nunca o derruba.** Quando esta função
 *   roda a mensagem já saiu pelo WhatsApp; recusar a chamada agora faria o
 *   sistema externo achar que nada foi enviado e repetir, mandando a mesma
 *   mensagem duas vezes ao cliente. Por isso ela NÃO lança: todo motivo de não
 *   abrir o card vira um `status` na resposta e um log;
 * - **o caminho de criação é o ÚNICO** (`createCrmOpportunity`): contato vem
 *   da conversa, duplicidade é decidida pelo índice do banco (o lead que
 *   preenche o formulário duas vezes não ganha dois cards), as ações de
 *   entrada da etapa rodam e o responsável segue a distribuição do funil;
 * - **CRM desligado vale aqui também**, senão desligar o módulo seria só
 *   esconder o menu e a integração seguiria abrindo card;
 * - **etapa que saiu do funil cai na primeira**, em vez de perder o lead.
 */

export type IntegrationCrmStatus =
  /** Card novo aberto na etapa. */
  | "created"
  /** Já havia card ABERTO desta conversa neste funil: fica onde está. */
  | "existing"
  /** O módulo CRM está desligado na organização. */
  | "crm_disabled"
  /** O funil foi apagado, desativado ou não é desta organização. */
  | "pipeline_unavailable"
  /** A criação falhou por outro motivo (ver o log). */
  | "failed";

export interface IntegrationCrmResult {
  status: IntegrationCrmStatus;
  opportunityId: string | null;
}

export interface IntegrationCrmDeps {
  prisma: PrismaClient;
  io: Server;
  logger: Logger;
}

export interface IntegrationCrmInput {
  organizationId: string;
  conversationId: string;
  pipelineId: string;
  stageId: string | null;
  /** Nome que o sistema externo mandou (ex.: o campo "nome" do formulário). */
  title: string | null;
  integrationTokenId: string;
}

export async function openIntegrationOpportunity(
  deps: IntegrationCrmDeps,
  input: IntegrationCrmInput,
  create: typeof createCrmOpportunity = createCrmOpportunity,
): Promise<IntegrationCrmResult> {
  const logContext = {
    event: "integration_crm",
    integrationTokenId: input.integrationTokenId,
    conversationId: input.conversationId,
    pipelineId: input.pipelineId,
  };
  try {
    const features = await loadOrganizationFeatures(deps.prisma, input.organizationId);
    if (!features.crm) {
      deps.logger.warn({ ...logContext, reason: "crm_disabled" }, "integration_crm_skipped");
      return { status: "crm_disabled", opportunityId: null };
    }

    const pipeline = await deps.prisma.crmPipeline.findFirst({
      where: { id: input.pipelineId, organizationId: input.organizationId },
      select: { isActive: true, stages: { select: { id: true } } },
    });
    if (!pipeline || !pipeline.isActive) {
      deps.logger.warn({ ...logContext, reason: "pipeline_unavailable" }, "integration_crm_skipped");
      return { status: "pipeline_unavailable", opportunityId: null };
    }

    const stageId =
      input.stageId && pipeline.stages.some((stage) => stage.id === input.stageId) ? input.stageId : null;
    if (input.stageId && !stageId) {
      deps.logger.warn({ ...logContext, stageId: input.stageId }, "integration_crm_stage_missing");
    }

    const { opportunity, duplicated } = await create(deps, {
      organizationId: input.organizationId,
      pipelineId: input.pipelineId,
      stageId,
      conversationId: input.conversationId,
      // Sem nome, o título sai da conversa (e, faltando, do telefone) — a
      // mesma cadeia do card criado na mão.
      title: input.title,
      // Mesma origem de quem nasce de conversa: o lead do site chega pelo
      // WhatsApp, e é por ele que o atendimento vai acontecer.
      origin: "whatsapp",
      // Autor nulo: quem abriu o card foi a integração, não uma pessoa.
      performedByUserId: null,
    });
    return { status: duplicated ? "existing" : "created", opportunityId: opportunity.id };
  } catch (err) {
    deps.logger.error({ ...logContext, err }, "integration_crm_failed");
    return { status: "failed", opportunityId: null };
  }
}

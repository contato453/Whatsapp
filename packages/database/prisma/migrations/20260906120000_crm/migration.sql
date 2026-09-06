-- CRM — funil de oportunidades por cima do atendimento que já existe.
--
-- O que NÃO nasce aqui é tão importante quanto o que nasce: não há tabela de
-- contato, de cliente, de usuário, de departamento nem de etiqueta do CRM. A
-- oportunidade aponta para a "conversations" que já existe (é dela que saem
-- nome, telefone, foto e empresa do Azevedo-OS), usa "tags" para etiquetar,
-- "users" para responsável, "departments" para o recorte e
-- "scheduled_messages" para o follow-up. Cadastro paralelo aqui viraria uma
-- segunda base de clientes divergindo da primeira no dia seguinte.

-- ---------- Enums ----------

CREATE TYPE "CrmStageType" AS ENUM ('open', 'in_progress', 'won', 'lost');
CREATE TYPE "CrmStageActionTrigger" AS ENUM ('enter', 'leave');
CREATE TYPE "CrmStageActionType" AS ENUM (
    'add_tag', 'remove_tag', 'assign_user', 'change_department',
    'create_activity', 'schedule_message', 'internal_note'
);
CREATE TYPE "CrmOpportunityStatus" AS ENUM ('open', 'won', 'lost');
CREATE TYPE "CrmActivityType" AS ENUM (
    'call', 'whatsapp', 'meeting', 'proposal', 'document',
    'billing', 'followup', 'task', 'other'
);
CREATE TYPE "CrmActivityStatus" AS ENUM ('pending', 'done', 'canceled');
CREATE TYPE "CrmActivityPriority" AS ENUM ('low', 'normal', 'high');
CREATE TYPE "CrmEventType" AS ENUM (
    'created', 'stage_changed', 'assignee_changed', 'department_changed',
    'value_changed', 'tag_added', 'tag_removed', 'activity_created',
    'activity_done', 'follow_up_scheduled', 'follow_up_canceled',
    'client_replied', 'won', 'lost', 'reopened', 'updated', 'note'
);

-- ---------- Funis ----------

CREATE TABLE "crm_pipelines" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "color" TEXT NOT NULL DEFAULT '#102a4c',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "isGeneral" BOOLEAN NOT NULL DEFAULT false,
    "position" INTEGER NOT NULL DEFAULT 0,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "autoCreateTagId" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "crm_pipelines_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "crm_pipelines_organizationId_name_key"
    ON "crm_pipelines"("organizationId", "name");
CREATE INDEX "crm_pipelines_organizationId_isActive_idx"
    ON "crm_pipelines"("organizationId", "isActive");

-- Mesmo N:N de "tag_departments": um funil serve a vários departamentos sem
-- virar uma cópia por área.
CREATE TABLE "crm_pipeline_departments" (
    "pipelineId" TEXT NOT NULL,
    "departmentId" TEXT NOT NULL,

    CONSTRAINT "crm_pipeline_departments_pkey" PRIMARY KEY ("pipelineId", "departmentId")
);
CREATE INDEX "crm_pipeline_departments_departmentId_idx"
    ON "crm_pipeline_departments"("departmentId");

-- ---------- Etapas ----------

CREATE TABLE "crm_stages" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "pipelineId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "position" INTEGER NOT NULL DEFAULT 0,
    "color" TEXT NOT NULL DEFAULT '#64748b',
    "probability" INTEGER NOT NULL DEFAULT 0,
    "type" "CrmStageType" NOT NULL DEFAULT 'in_progress',
    "slaDays" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "crm_stages_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "crm_stages_pipelineId_name_key" ON "crm_stages"("pipelineId", "name");
CREATE INDEX "crm_stages_pipelineId_position_idx" ON "crm_stages"("pipelineId", "position");

-- Probabilidade é porcentagem: fora de 0..100 o valor ponderado do funil
-- passa a mentir, e a conta é feita em três telas diferentes.
ALTER TABLE "crm_stages"
    ADD CONSTRAINT "crm_stages_probability_range" CHECK ("probability" BETWEEN 0 AND 100);

CREATE TABLE "crm_stage_actions" (
    "id" TEXT NOT NULL,
    "stageId" TEXT NOT NULL,
    "trigger" "CrmStageActionTrigger" NOT NULL DEFAULT 'enter',
    "type" "CrmStageActionType" NOT NULL,
    "tagId" TEXT,
    "userId" TEXT,
    "departmentId" TEXT,
    "delayMinutes" INTEGER NOT NULL DEFAULT 0,
    "content" TEXT,
    "position" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "crm_stage_actions_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "crm_stage_actions_stageId_trigger_idx"
    ON "crm_stage_actions"("stageId", "trigger");

-- ---------- Catálogos ----------

CREATE TABLE "crm_products" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "defaultValue" DECIMAL(12,2),
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "crm_products_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "crm_products_organizationId_name_key"
    ON "crm_products"("organizationId", "name");

CREATE TABLE "crm_loss_reasons" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "position" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "crm_loss_reasons_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "crm_loss_reasons_organizationId_name_key"
    ON "crm_loss_reasons"("organizationId", "name");

-- ---------- Oportunidades ----------

CREATE TABLE "crm_opportunities" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "pipelineId" TEXT NOT NULL,
    "stageId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "conversationId" TEXT,
    "contactName" TEXT,
    "contactPhone" TEXT,
    "assignedUserId" TEXT,
    "departmentId" TEXT,
    "productId" TEXT,
    "value" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "discount" DECIMAL(12,2),
    "probability" INTEGER,
    "expectedCloseDate" TIMESTAMP(3),
    "origin" TEXT,
    "status" "CrmOpportunityStatus" NOT NULL DEFAULT 'open',
    "lossReasonId" TEXT,
    "lossNote" TEXT,
    "closedValue" DECIMAL(12,2),
    "closedAt" TIMESTAMP(3),
    "notes" TEXT,
    "position" DOUBLE PRECISION NOT NULL DEFAULT 1000,
    "stageEnteredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastInteractionAt" TIMESTAMP(3),
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "crm_opportunities_pkey" PRIMARY KEY ("id")
);

-- O Kanban: uma coluna de um funil, na ordem em que ela é desenhada.
CREATE INDEX "crm_opportunities_organizationId_pipelineId_stageId_positio_idx"
    ON "crm_opportunities"("organizationId", "pipelineId", "stageId", "position");
CREATE INDEX "crm_opportunities_organizationId_status_updatedAt_idx"
    ON "crm_opportunities"("organizationId", "status", "updatedAt");
CREATE INDEX "crm_opportunities_conversationId_idx" ON "crm_opportunities"("conversationId");
CREATE INDEX "crm_opportunities_assignedUserId_idx" ON "crm_opportunities"("assignedUserId");
CREATE INDEX "crm_opportunities_departmentId_idx" ON "crm_opportunities"("departmentId");

-- DUPLICIDADE: a mesma conversa não pode ter DUAS oportunidades ABERTAS no
-- MESMO funil. É o caso real de duplicata — dois cliques no botão, webhook
-- repetido, automação de etiqueta disparando de novo. Índice PARCIAL de
-- propósito: o cliente PODE ter várias oportunidades ao mesmo tempo em funis
-- diferentes (Comercial e Cobrança), e pode ter várias fechadas no mesmo funil
-- ao longo do tempo — o que ficaria impedido por um unique comum.
--
-- Prisma não representa índice parcial no schema, então ele vive só aqui; a
-- aplicação trata a violação (P2002) devolvendo a oportunidade que já existe.
CREATE UNIQUE INDEX "crm_opportunities_open_per_conversation_pipeline"
    ON "crm_opportunities"("conversationId", "pipelineId")
    WHERE "status" = 'open' AND "conversationId" IS NOT NULL;

-- Perda exige motivo: sem isso o relatório de motivos nasce com um buraco que
-- ninguém preenche depois. O `lossReasonId` é a linha da tabela de motivos —
-- a observação livre continua opcional.
ALTER TABLE "crm_opportunities"
    ADD CONSTRAINT "crm_opportunities_lost_requires_reason"
    CHECK ("status" <> 'lost' OR "lossReasonId" IS NOT NULL);

CREATE TABLE "crm_opportunity_tags" (
    "opportunityId" TEXT NOT NULL,
    "tagId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "crm_opportunity_tags_pkey" PRIMARY KEY ("opportunityId", "tagId")
);
CREATE INDEX "crm_opportunity_tags_tagId_idx" ON "crm_opportunity_tags"("tagId");

-- ---------- Atividades ----------

CREATE TABLE "crm_activities" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "opportunityId" TEXT NOT NULL,
    "type" "CrmActivityType" NOT NULL DEFAULT 'task',
    "title" TEXT NOT NULL,
    "description" TEXT,
    "assignedUserId" TEXT,
    "dueAt" TIMESTAMP(3) NOT NULL,
    "priority" "CrmActivityPriority" NOT NULL DEFAULT 'normal',
    "status" "CrmActivityStatus" NOT NULL DEFAULT 'pending',
    "completedAt" TIMESTAMP(3),
    "completedById" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "crm_activities_pkey" PRIMARY KEY ("id")
);

-- A agenda: pendentes por prazo, que é a pergunta da tela de Atividades.
-- "Atrasada" não é status gravado — é este índice mais o relógio.
CREATE INDEX "crm_activities_organizationId_status_dueAt_idx"
    ON "crm_activities"("organizationId", "status", "dueAt");
CREATE INDEX "crm_activities_opportunityId_status_dueAt_idx"
    ON "crm_activities"("opportunityId", "status", "dueAt");
CREATE INDEX "crm_activities_assignedUserId_status_dueAt_idx"
    ON "crm_activities"("assignedUserId", "status", "dueAt");

-- ---------- Histórico ----------

CREATE TABLE "crm_opportunity_events" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "opportunityId" TEXT NOT NULL,
    "type" "CrmEventType" NOT NULL,
    "performedByUserId" TEXT,
    "fromStageId" TEXT,
    "toStageId" TEXT,
    "fromUserId" TEXT,
    "toUserId" TEXT,
    "description" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "crm_opportunity_events_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "crm_opportunity_events_opportunityId_createdAt_idx"
    ON "crm_opportunity_events"("opportunityId", "createdAt");
CREATE INDEX "crm_opportunity_events_organizationId_type_createdAt_idx"
    ON "crm_opportunity_events"("organizationId", "type", "createdAt");

-- ---------- Follow-up: a coluna que amarra o CRM ao agendador existente ----------

-- O CRM NÃO tem agendador próprio. O follow-up de etapa cria uma linha em
-- "scheduled_messages" como qualquer mensagem agendada, e quem envia continua
-- sendo `services/scheduler.ts`. Esta coluna existe para o cancelamento
-- automático saber o que é dele: respondeu o cliente, ou o card saiu da etapa,
-- cancela só o que ESTA oportunidade agendou — o compromisso que uma pessoa
-- marcou à mão com o cliente nunca é desmarcado pelo CRM.
ALTER TABLE "scheduled_messages" ADD COLUMN "crmOpportunityId" TEXT;
CREATE INDEX "scheduled_messages_crmOpportunityId_status_idx"
    ON "scheduled_messages"("crmOpportunityId", "status");

-- ---------- Chaves estrangeiras ----------

ALTER TABLE "crm_pipelines" ADD CONSTRAINT "crm_pipelines_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- Etiqueta apagada desliga o gatilho em vez de deixar a automação apontando
-- para o nada e falhando toda vez que uma conversa é etiquetada.
ALTER TABLE "crm_pipelines" ADD CONSTRAINT "crm_pipelines_autoCreateTagId_fkey"
    FOREIGN KEY ("autoCreateTagId") REFERENCES "tags"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "crm_pipelines" ADD CONSTRAINT "crm_pipelines_createdById_fkey"
    FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "crm_pipeline_departments" ADD CONSTRAINT "crm_pipeline_departments_pipelineId_fkey"
    FOREIGN KEY ("pipelineId") REFERENCES "crm_pipelines"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "crm_pipeline_departments" ADD CONSTRAINT "crm_pipeline_departments_departmentId_fkey"
    FOREIGN KEY ("departmentId") REFERENCES "departments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "crm_stages" ADD CONSTRAINT "crm_stages_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "crm_stages" ADD CONSTRAINT "crm_stages_pipelineId_fkey"
    FOREIGN KEY ("pipelineId") REFERENCES "crm_pipelines"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "crm_stage_actions" ADD CONSTRAINT "crm_stage_actions_stageId_fkey"
    FOREIGN KEY ("stageId") REFERENCES "crm_stages"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "crm_stage_actions" ADD CONSTRAINT "crm_stage_actions_tagId_fkey"
    FOREIGN KEY ("tagId") REFERENCES "tags"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "crm_stage_actions" ADD CONSTRAINT "crm_stage_actions_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "crm_stage_actions" ADD CONSTRAINT "crm_stage_actions_departmentId_fkey"
    FOREIGN KEY ("departmentId") REFERENCES "departments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "crm_products" ADD CONSTRAINT "crm_products_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "crm_loss_reasons" ADD CONSTRAINT "crm_loss_reasons_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "crm_opportunities" ADD CONSTRAINT "crm_opportunities_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "crm_opportunities" ADD CONSTRAINT "crm_opportunities_pipelineId_fkey"
    FOREIGN KEY ("pipelineId") REFERENCES "crm_pipelines"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- RESTRICT na etapa: apagar uma coluna que ainda tem card deixaria a
-- oportunidade órfã de funil. A rota exige etapa de destino antes de excluir.
ALTER TABLE "crm_opportunities" ADD CONSTRAINT "crm_opportunities_stageId_fkey"
    FOREIGN KEY ("stageId") REFERENCES "crm_stages"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
-- Conversa apagada não apaga a oportunidade: o histórico comercial (valor,
-- ganho, motivo de perda) é do escritório e sobrevive ao chat.
ALTER TABLE "crm_opportunities" ADD CONSTRAINT "crm_opportunities_conversationId_fkey"
    FOREIGN KEY ("conversationId") REFERENCES "conversations"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "crm_opportunities" ADD CONSTRAINT "crm_opportunities_assignedUserId_fkey"
    FOREIGN KEY ("assignedUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "crm_opportunities" ADD CONSTRAINT "crm_opportunities_departmentId_fkey"
    FOREIGN KEY ("departmentId") REFERENCES "departments"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "crm_opportunities" ADD CONSTRAINT "crm_opportunities_productId_fkey"
    FOREIGN KEY ("productId") REFERENCES "crm_products"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "crm_opportunities" ADD CONSTRAINT "crm_opportunities_lossReasonId_fkey"
    FOREIGN KEY ("lossReasonId") REFERENCES "crm_loss_reasons"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "crm_opportunities" ADD CONSTRAINT "crm_opportunities_createdById_fkey"
    FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "crm_opportunity_tags" ADD CONSTRAINT "crm_opportunity_tags_opportunityId_fkey"
    FOREIGN KEY ("opportunityId") REFERENCES "crm_opportunities"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "crm_opportunity_tags" ADD CONSTRAINT "crm_opportunity_tags_tagId_fkey"
    FOREIGN KEY ("tagId") REFERENCES "tags"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "crm_activities" ADD CONSTRAINT "crm_activities_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "crm_activities" ADD CONSTRAINT "crm_activities_opportunityId_fkey"
    FOREIGN KEY ("opportunityId") REFERENCES "crm_opportunities"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "crm_activities" ADD CONSTRAINT "crm_activities_assignedUserId_fkey"
    FOREIGN KEY ("assignedUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "crm_activities" ADD CONSTRAINT "crm_activities_completedById_fkey"
    FOREIGN KEY ("completedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "crm_opportunity_events" ADD CONSTRAINT "crm_opportunity_events_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "crm_opportunity_events" ADD CONSTRAINT "crm_opportunity_events_opportunityId_fkey"
    FOREIGN KEY ("opportunityId") REFERENCES "crm_opportunities"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "crm_opportunity_events" ADD CONSTRAINT "crm_opportunity_events_performedByUserId_fkey"
    FOREIGN KEY ("performedByUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Oportunidade apagada não apaga o agendamento: a mensagem já foi combinada
-- com o cliente. O vínculo some, e ela vira um agendamento comum.
ALTER TABLE "scheduled_messages" ADD CONSTRAINT "scheduled_messages_crmOpportunityId_fkey"
    FOREIGN KEY ("crmOpportunityId") REFERENCES "crm_opportunities"("id") ON DELETE SET NULL ON UPDATE CASCADE;

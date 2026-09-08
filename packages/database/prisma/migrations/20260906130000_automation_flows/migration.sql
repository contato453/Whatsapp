-- Automações: construtor visual de fluxos + motor de execução, mais a
-- extensão dos Parâmetros de atendimento com saudação e mensagem de fora do
-- expediente. Ver o comentário do bloco "Automações" em schema.prisma para
-- as decisões de design (grafo em JSON por versão, execução sem tabela de
-- "waiting jobs" separada).

-- ============================================================
-- Parâmetros de atendimento: saudação e fora do expediente
-- ============================================================

ALTER TABLE "attendance_settings"
  ADD COLUMN "greetingEnabled" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "greetingMessage" TEXT,
  ADD COLUMN "greetingFirstContactOnly" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "greetingCooldownMinutes" INTEGER NOT NULL DEFAULT 360,
  ADD COLUMN "greetingInstanceId" TEXT,
  ADD COLUMN "outOfHoursEnabled" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "outOfHoursMessage" TEXT,
  ADD COLUMN "outOfHoursCooldownMinutes" INTEGER NOT NULL DEFAULT 180,
  ADD COLUMN "outOfHoursInstanceId" TEXT;

ALTER TABLE "attendance_settings"
  ADD CONSTRAINT "attendance_settings_greetingInstanceId_fkey"
    FOREIGN KEY ("greetingInstanceId") REFERENCES "whatsapp_instances"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT "attendance_settings_outOfHoursInstanceId_fkey"
    FOREIGN KEY ("outOfHoursInstanceId") REFERENCES "whatsapp_instances"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ============================================================
-- Automações
-- ============================================================

CREATE TYPE "AutomationFlowStatus" AS ENUM ('draft', 'active', 'inactive');

CREATE TYPE "AutomationTriggerType" AS ENUM (
  'new_message',
  'first_message',
  'keyword',
  'no_reply_timeout',
  'conversation_resolved',
  'tag_added'
);

CREATE TYPE "AutomationExecutionStatus" AS ENUM (
  'running',
  'waiting',
  'completed',
  'failed',
  'canceled',
  'handed_off'
);

-- CreateTable
CREATE TABLE "automation_flows" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "status" "AutomationFlowStatus" NOT NULL DEFAULT 'draft',
    "triggerType" "AutomationTriggerType" NOT NULL DEFAULT 'new_message',
    "triggerConfig" JSONB,
    "whatsappInstanceId" TEXT,
    "priority" INTEGER NOT NULL DEFAULT 100,
    "cooldownMinutes" INTEGER NOT NULL DEFAULT 0,
    "draftGraph" JSONB NOT NULL,
    "publishedVersionId" TEXT,
    "createdById" TEXT,
    "updatedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "automation_flows_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "automation_flow_versions" (
    "id" TEXT NOT NULL,
    "flowId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "graph" JSONB NOT NULL,
    "publishedById" TEXT,
    "publishedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "automation_flow_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "automation_executions" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "flowId" TEXT NOT NULL,
    "flowVersionId" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "whatsappInstanceId" TEXT NOT NULL,
    "status" "AutomationExecutionStatus" NOT NULL DEFAULT 'running',
    "currentNodeId" TEXT,
    "waitingReason" TEXT,
    "waitingUntil" TIMESTAMP(3),
    "context" JSONB NOT NULL DEFAULT '{}',
    "triggerType" "AutomationTriggerType" NOT NULL,
    "resultSummary" TEXT,
    "error" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "automation_executions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "automation_execution_logs" (
    "id" TEXT NOT NULL,
    "executionId" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "nodeId" TEXT,
    "nodeType" TEXT,
    "level" TEXT NOT NULL DEFAULT 'info',
    "event" TEXT NOT NULL,
    "message" TEXT,
    "data" JSONB,

    CONSTRAINT "automation_execution_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "automation_flows_organizationId_status_idx" ON "automation_flows"("organizationId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "automation_flows_publishedVersionId_key" ON "automation_flows"("publishedVersionId");

-- CreateIndex
CREATE UNIQUE INDEX "automation_flow_versions_flowId_version_key" ON "automation_flow_versions"("flowId", "version");

-- CreateIndex
CREATE INDEX "automation_executions_organizationId_startedAt_idx" ON "automation_executions"("organizationId", "startedAt");

-- CreateIndex
CREATE INDEX "automation_executions_conversationId_startedAt_idx" ON "automation_executions"("conversationId", "startedAt");

-- CreateIndex
CREATE INDEX "automation_executions_status_waitingUntil_idx" ON "automation_executions"("status", "waitingUntil");

-- CreateIndex
CREATE INDEX "automation_executions_flowId_conversationId_startedAt_idx" ON "automation_executions"("flowId", "conversationId", "startedAt");

-- CreateIndex
CREATE INDEX "automation_execution_logs_executionId_at_idx" ON "automation_execution_logs"("executionId", "at");

-- Só uma execução ATIVA (running/waiting) por conversa ao mesmo tempo. Índice
-- único PARCIAL — o Prisma não tem como declarar isto no schema.prisma (não
-- existe `WHERE` em `@@unique`), então ele fica só aqui, como já acontece com
-- `conversations_assigned_to_all_without_user`: código é o primeiro guarda
-- contra a corrida (o motor confere antes de criar), o banco é quem nunca
-- deixa passar mesmo sob concorrência.
CREATE UNIQUE INDEX "automation_executions_active_per_conversation"
  ON "automation_executions"("conversationId")
  WHERE "status" IN ('running', 'waiting');

-- AddForeignKey
ALTER TABLE "automation_flows" ADD CONSTRAINT "automation_flows_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "automation_flows" ADD CONSTRAINT "automation_flows_whatsappInstanceId_fkey" FOREIGN KEY ("whatsappInstanceId") REFERENCES "whatsapp_instances"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "automation_flows" ADD CONSTRAINT "automation_flows_publishedVersionId_fkey" FOREIGN KEY ("publishedVersionId") REFERENCES "automation_flow_versions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "automation_flow_versions" ADD CONSTRAINT "automation_flow_versions_flowId_fkey" FOREIGN KEY ("flowId") REFERENCES "automation_flows"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "automation_executions" ADD CONSTRAINT "automation_executions_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "automation_executions" ADD CONSTRAINT "automation_executions_flowId_fkey" FOREIGN KEY ("flowId") REFERENCES "automation_flows"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "automation_executions" ADD CONSTRAINT "automation_executions_flowVersionId_fkey" FOREIGN KEY ("flowVersionId") REFERENCES "automation_flow_versions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "automation_executions" ADD CONSTRAINT "automation_executions_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "automation_execution_logs" ADD CONSTRAINT "automation_execution_logs_executionId_fkey" FOREIGN KEY ("executionId") REFERENCES "automation_executions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

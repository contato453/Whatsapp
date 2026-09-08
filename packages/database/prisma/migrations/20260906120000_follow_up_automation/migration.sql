-- CreateEnum
CREATE TYPE "FollowUpRuleStatus" AS ENUM ('active', 'inactive');

-- CreateEnum
CREATE TYPE "FollowUpTimeUnit" AS ENUM ('minutes', 'hours', 'days');

-- CreateEnum
CREATE TYPE "FollowUpStepAction" AS ENUM ('send_message', 'add_tag', 'remove_tag', 'change_status');

-- CreateEnum
CREATE TYPE "FollowUpTrigger" AS ENUM ('waiting_client');

-- CreateEnum
CREATE TYPE "FollowUpExecutionStatus" AS ENUM ('active', 'paused', 'canceled', 'completed', 'failed');

-- CreateEnum
CREATE TYPE "FollowUpLogEventType" AS ENUM ('started', 'step_executed', 'step_failed', 'restarted', 'canceled', 'paused', 'resumed', 'postponed', 'completed');

-- CreateTable
CREATE TABLE "follow_up_rules" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "status" "FollowUpRuleStatus" NOT NULL DEFAULT 'active',
    "isGeneral" BOOLEAN NOT NULL DEFAULT false,
    "trigger" "FollowUpTrigger" NOT NULL DEFAULT 'waiting_client',
    "respectBusinessHours" BOOLEAN NOT NULL DEFAULT true,
    "whatsappInstanceId" TEXT,
    "finalizeOnComplete" BOOLEAN NOT NULL DEFAULT true,
    "finalizeReason" TEXT NOT NULL DEFAULT 'Sem retorno do cliente',
    "finalizeTagId" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "follow_up_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "follow_up_rule_departments" (
    "ruleId" TEXT NOT NULL,
    "departmentId" TEXT NOT NULL,

    CONSTRAINT "follow_up_rule_departments_pkey" PRIMARY KEY ("ruleId","departmentId")
);

-- CreateTable
CREATE TABLE "follow_up_rule_steps" (
    "id" TEXT NOT NULL,
    "ruleId" TEXT NOT NULL,
    "order" INTEGER NOT NULL,
    "waitAmount" INTEGER NOT NULL,
    "waitUnit" "FollowUpTimeUnit" NOT NULL,
    "action" "FollowUpStepAction" NOT NULL,
    "messageContent" TEXT,
    "tagId" TEXT,
    "newStatus" "ConversationStatus",

    CONSTRAINT "follow_up_rule_steps_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "follow_up_executions" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "ruleId" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "status" "FollowUpExecutionStatus" NOT NULL DEFAULT 'active',
    "currentStepOrder" INTEGER NOT NULL DEFAULT 1,
    "nextRunAt" TIMESTAMP(3),
    "pauseUntil" TIMESTAMP(3),
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "finishReason" TEXT,
    "messagesSentCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "follow_up_executions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "follow_up_execution_logs" (
    "id" TEXT NOT NULL,
    "executionId" TEXT NOT NULL,
    "eventType" "FollowUpLogEventType" NOT NULL,
    "stepOrder" INTEGER,
    "actorUserId" TEXT,
    "messageId" TEXT,
    "detail" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "follow_up_execution_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "follow_up_rules_organizationId_status_idx" ON "follow_up_rules"("organizationId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "follow_up_rules_organizationId_name_key" ON "follow_up_rules"("organizationId", "name");

-- CreateIndex
CREATE INDEX "follow_up_rule_departments_departmentId_idx" ON "follow_up_rule_departments"("departmentId");

-- CreateIndex
CREATE UNIQUE INDEX "follow_up_rule_steps_ruleId_order_key" ON "follow_up_rule_steps"("ruleId", "order");

-- CreateIndex
CREATE INDEX "follow_up_executions_conversationId_idx" ON "follow_up_executions"("conversationId");

-- CreateIndex
CREATE INDEX "follow_up_executions_status_nextRunAt_idx" ON "follow_up_executions"("status", "nextRunAt");

-- CreateIndex
CREATE INDEX "follow_up_executions_organizationId_ruleId_idx" ON "follow_up_executions"("organizationId", "ruleId");

-- CreateIndex
CREATE INDEX "follow_up_execution_logs_executionId_createdAt_idx" ON "follow_up_execution_logs"("executionId", "createdAt");

-- Só uma execução ATIVA ou PAUSADA por conversa ao mesmo tempo — é o que
-- impede dois timers rodando em paralelo sobre o mesmo atendimento (seção
-- 15/36 do pedido). Índice PARCIAL, como o de `tags`/`quick_replies` logo
-- abaixo: o Prisma Client não representa isso em `schema.prisma`, então ele
-- não pode ser mexido por uma migration futura gerada automaticamente sem
-- alguém notar e revisar à mão, do jeito que este comentário está fazendo.
CREATE UNIQUE INDEX "follow_up_executions_one_active_per_conversation"
    ON "follow_up_executions"("conversationId")
    WHERE "status" IN ('active', 'paused');

-- AddForeignKey
ALTER TABLE "follow_up_rules" ADD CONSTRAINT "follow_up_rules_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "follow_up_rules" ADD CONSTRAINT "follow_up_rules_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "follow_up_rules" ADD CONSTRAINT "follow_up_rules_whatsappInstanceId_fkey" FOREIGN KEY ("whatsappInstanceId") REFERENCES "whatsapp_instances"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "follow_up_rules" ADD CONSTRAINT "follow_up_rules_finalizeTagId_fkey" FOREIGN KEY ("finalizeTagId") REFERENCES "tags"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "follow_up_rule_departments" ADD CONSTRAINT "follow_up_rule_departments_ruleId_fkey" FOREIGN KEY ("ruleId") REFERENCES "follow_up_rules"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "follow_up_rule_departments" ADD CONSTRAINT "follow_up_rule_departments_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "departments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "follow_up_rule_steps" ADD CONSTRAINT "follow_up_rule_steps_ruleId_fkey" FOREIGN KEY ("ruleId") REFERENCES "follow_up_rules"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "follow_up_rule_steps" ADD CONSTRAINT "follow_up_rule_steps_tagId_fkey" FOREIGN KEY ("tagId") REFERENCES "tags"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "follow_up_executions" ADD CONSTRAINT "follow_up_executions_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "follow_up_executions" ADD CONSTRAINT "follow_up_executions_ruleId_fkey" FOREIGN KEY ("ruleId") REFERENCES "follow_up_rules"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "follow_up_executions" ADD CONSTRAINT "follow_up_executions_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "follow_up_execution_logs" ADD CONSTRAINT "follow_up_execution_logs_executionId_fkey" FOREIGN KEY ("executionId") REFERENCES "follow_up_executions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "follow_up_execution_logs" ADD CONSTRAINT "follow_up_execution_logs_actorUserId_fkey" FOREIGN KEY ("actorUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

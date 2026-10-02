-- Disparos em massa: audiência → campanha → entrega. Ver a seção 24 do
-- CLAUDE.md e o bloco "Disparos em massa" em schema.prisma.
--
-- Só ADITIVO: cinco tabelas e quatro enums novos, mais nenhuma coluna em
-- tabela existente. Sem campanha criada, nada no sistema muda de
-- comportamento — o worker acorda, não acha campanha para rodar e dorme.

-- CreateEnum
CREATE TYPE "BroadcastCampaignStatus" AS ENUM ('draft', 'scheduled', 'running', 'paused', 'completed', 'canceled');

-- CreateEnum
CREATE TYPE "BroadcastDeliveryStatus" AS ENUM ('pending', 'sent', 'failed', 'skipped');

-- CreateEnum
CREATE TYPE "BroadcastContactSource" AS ENUM ('manual', 'import');

-- CreateEnum
CREATE TYPE "BroadcastCrmMode" AS ENUM ('never', 'on_send', 'on_reply');

-- CreateTable
CREATE TABLE "broadcast_audiences" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "broadcast_audiences_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "broadcast_contacts" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "audienceId" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "name" TEXT,
    "company" TEXT,
    "fields" JSONB,
    "source" "BroadcastContactSource" NOT NULL DEFAULT 'manual',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "broadcast_contacts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "broadcast_opt_outs" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "reason" TEXT NOT NULL DEFAULT 'manual',
    "conversationId" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "broadcast_opt_outs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "broadcast_campaigns" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" "BroadcastCampaignStatus" NOT NULL DEFAULT 'draft',
    "pausedReason" TEXT,
    "audienceId" TEXT NOT NULL,
    "whatsappInstanceId" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "messageVariants" JSONB,
    "scheduledFor" TIMESTAMP(3),
    "minIntervalSeconds" INTEGER NOT NULL DEFAULT 30,
    "maxIntervalSeconds" INTEGER NOT NULL DEFAULT 90,
    "dailyLimit" INTEGER,
    "respectBusinessHours" BOOLEAN NOT NULL DEFAULT true,
    "consecutiveFailures" INTEGER NOT NULL DEFAULT 0,
    "crmMode" "BroadcastCrmMode" NOT NULL DEFAULT 'on_reply',
    "crmPipelineId" TEXT,
    "crmStageId" TEXT,
    "tagId" TEXT,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "nextSendAt" TIMESTAMP(3),
    "sentToday" INTEGER NOT NULL DEFAULT 0,
    "sentTodayDate" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "broadcast_campaigns_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "broadcast_deliveries" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "contactId" TEXT,
    "phone" TEXT NOT NULL,
    "contactName" TEXT,
    "contactCompany" TEXT,
    "status" "BroadcastDeliveryStatus" NOT NULL DEFAULT 'pending',
    "skipReason" TEXT,
    "failureReason" TEXT,
    "content" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "sentAt" TIMESTAMP(3),
    "repliedAt" TIMESTAMP(3),
    "conversationId" TEXT,
    "messageId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "broadcast_deliveries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "broadcast_audiences_organizationId_name_key" ON "broadcast_audiences"("organizationId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "broadcast_contacts_audienceId_phone_key" ON "broadcast_contacts"("audienceId", "phone");

-- CreateIndex
CREATE INDEX "broadcast_contacts_organizationId_phone_idx" ON "broadcast_contacts"("organizationId", "phone");

-- CreateIndex
CREATE UNIQUE INDEX "broadcast_opt_outs_organizationId_phone_key" ON "broadcast_opt_outs"("organizationId", "phone");

-- CreateIndex
CREATE INDEX "broadcast_campaigns_organizationId_status_idx" ON "broadcast_campaigns"("organizationId", "status");

-- CreateIndex
CREATE INDEX "broadcast_campaigns_status_nextSendAt_idx" ON "broadcast_campaigns"("status", "nextSendAt");

-- CreateIndex
CREATE UNIQUE INDEX "broadcast_deliveries_campaignId_contactId_key" ON "broadcast_deliveries"("campaignId", "contactId");

-- CreateIndex
CREATE INDEX "broadcast_deliveries_campaignId_status_idx" ON "broadcast_deliveries"("campaignId", "status");

-- CreateIndex
CREATE INDEX "broadcast_deliveries_conversationId_repliedAt_idx" ON "broadcast_deliveries"("conversationId", "repliedAt");

-- AddForeignKey
ALTER TABLE "broadcast_audiences" ADD CONSTRAINT "broadcast_audiences_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "broadcast_audiences" ADD CONSTRAINT "broadcast_audiences_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "broadcast_contacts" ADD CONSTRAINT "broadcast_contacts_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "broadcast_contacts" ADD CONSTRAINT "broadcast_contacts_audienceId_fkey" FOREIGN KEY ("audienceId") REFERENCES "broadcast_audiences"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "broadcast_opt_outs" ADD CONSTRAINT "broadcast_opt_outs_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "broadcast_opt_outs" ADD CONSTRAINT "broadcast_opt_outs_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "broadcast_campaigns" ADD CONSTRAINT "broadcast_campaigns_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "broadcast_campaigns" ADD CONSTRAINT "broadcast_campaigns_audienceId_fkey" FOREIGN KEY ("audienceId") REFERENCES "broadcast_audiences"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "broadcast_campaigns" ADD CONSTRAINT "broadcast_campaigns_whatsappInstanceId_fkey" FOREIGN KEY ("whatsappInstanceId") REFERENCES "whatsapp_instances"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "broadcast_campaigns" ADD CONSTRAINT "broadcast_campaigns_crmPipelineId_fkey" FOREIGN KEY ("crmPipelineId") REFERENCES "crm_pipelines"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "broadcast_campaigns" ADD CONSTRAINT "broadcast_campaigns_crmStageId_fkey" FOREIGN KEY ("crmStageId") REFERENCES "crm_stages"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "broadcast_campaigns" ADD CONSTRAINT "broadcast_campaigns_tagId_fkey" FOREIGN KEY ("tagId") REFERENCES "tags"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "broadcast_campaigns" ADD CONSTRAINT "broadcast_campaigns_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "broadcast_deliveries" ADD CONSTRAINT "broadcast_deliveries_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "broadcast_deliveries" ADD CONSTRAINT "broadcast_deliveries_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "broadcast_campaigns"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "broadcast_deliveries" ADD CONSTRAINT "broadcast_deliveries_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "broadcast_contacts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "broadcast_deliveries" ADD CONSTRAINT "broadcast_deliveries_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "conversations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "broadcast_deliveries" ADD CONSTRAINT "broadcast_deliveries_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "messages"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- UM DISPARO POR NÚMERO DE CADA VEZ.
--
-- Índice PARCIAL, criado à mão porque o Prisma não o declara no schema (mesmo
-- caso de `conversations_assigned_to_all_without_user` e do índice parcial do
-- follow-up). Sem ele, duas campanhas no MESMO chip rodam em paralelo e o
-- ritmo combinado é o dobro do configurado — o operador acha que está
-- mandando uma a cada 60s e o WhatsApp vê uma a cada 30s. A trava mora no
-- banco, e não só na rota, porque dois cliques simultâneos em "Iniciar"
-- passariam por qualquer checagem feita em memória.
CREATE UNIQUE INDEX "broadcast_campaigns_one_running_per_instance"
  ON "broadcast_campaigns"("whatsappInstanceId")
  WHERE "status" = 'running';

-- Só `running` entra no índice, e NÃO `scheduled`: agendar duas campanhas no
-- mesmo chip para dias diferentes é legítimo, e barrá-las obrigaria o
-- escritório a lembrar de voltar no sistema para marcar a segunda. Quem
-- impede as duas de RODAREM juntas é este índice, na hora em que a segunda
-- tentaria virar `running` — o worker então a deixa esperando a primeira
-- terminar, em vez de recusar o agendamento semanas antes.

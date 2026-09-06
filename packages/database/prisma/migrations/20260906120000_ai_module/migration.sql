-- Módulo de INTELIGÊNCIA ARTIFICIAL (ver CLAUDE.md §19).
--
-- Três peças, separadas de propósito: o AGENTE é a configuração reutilizável
-- (objetivo, limites, conhecimento, permissões), a AUTOMAÇÃO é o gatilho que
-- o põe para atender numa conversa (o "bloco de IA"), e a SESSÃO é um
-- atendimento concreto — uma conversa, um agente numa versão, do começo ao
-- fim. A mesma "IA Comercial" serve a quantas automações forem precisas.

CREATE TYPE "AiProviderStatus" AS ENUM ('not_connected', 'connected', 'error');
CREATE TYPE "AiAgentStatus" AS ENUM ('draft', 'active', 'inactive');
CREATE TYPE "AiSessionStatus" AS ENUM ('active', 'resolved', 'transferred', 'stopped', 'limit_reached', 'error', 'expired');
CREATE TYPE "AiKnowledgeKind" AS ENUM ('text', 'faq');
CREATE TYPE "AiBudgetPolicy" AS ENUM ('alert_only', 'block_new', 'transfer_human');
CREATE TYPE "AiUsageKind" AS ENUM ('chat', 'test', 'connection_test', 'models');
CREATE TYPE "AiUsageOutcome" AS ENUM ('ok', 'error', 'timeout', 'blocked');

-- Credencial do provedor. A chave fica CIFRADA (AES-256-GCM, chave só no
-- processo da API) e nunca sai da API: para a tela vai só "apiKeyHint".
CREATE TABLE "ai_provider_configs" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "apiKeyEncrypted" TEXT,
    "apiKeyHint" TEXT,
    "defaultModel" TEXT,
    "status" "AiProviderStatus" NOT NULL DEFAULT 'not_connected',
    "lastTestedAt" TIMESTAMP(3),
    "lastTestError" TEXT,
    "modelsCache" JSONB,
    "modelsFetchedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ai_provider_configs_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "ai_provider_configs_organizationId_provider_key" ON "ai_provider_configs"("organizationId", "provider");
ALTER TABLE "ai_provider_configs" ADD CONSTRAINT "ai_provider_configs_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Orçamento, política ao estourar e timeout. Uma linha por organização.
CREATE TABLE "ai_settings" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "monthlyBudgetCents" INTEGER,
    "alertThresholds" INTEGER[] DEFAULT ARRAY[50, 80, 90, 100]::INTEGER[],
    "budgetPolicy" "AiBudgetPolicy" NOT NULL DEFAULT 'alert_only',
    "timeoutMs" INTEGER NOT NULL DEFAULT 30000,
    "contextMessageLimit" INTEGER NOT NULL DEFAULT 20,
    "pricingOverrides" JSONB,
    "alertedMonth" TEXT,
    "alertedThresholds" INTEGER[] DEFAULT ARRAY[]::INTEGER[],
    "updatedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ai_settings_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "ai_settings_organizationId_key" ON "ai_settings"("organizationId");
ALTER TABLE "ai_settings" ADD CONSTRAINT "ai_settings_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ai_settings" ADD CONSTRAINT "ai_settings_updatedById_fkey"
    FOREIGN KEY ("updatedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Agente: a configuração reutilizável. "config" é o JSON estruturado
-- (dezenas de campos que só a IA lê); o que é consultado por SQL tem coluna.
CREATE TABLE "ai_agents" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "status" "AiAgentStatus" NOT NULL DEFAULT 'draft',
    "isGeneral" BOOLEAN NOT NULL DEFAULT false,
    "model" TEXT,
    "config" JSONB NOT NULL,
    "currentVersion" INTEGER NOT NULL DEFAULT 1,
    "handoffDepartmentId" TEXT,
    "handoffAssigneeId" TEXT,
    "createdById" TEXT,
    "updatedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ai_agents_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "ai_agents_organizationId_name_key" ON "ai_agents"("organizationId", "name");
CREATE INDEX "ai_agents_organizationId_status_idx" ON "ai_agents"("organizationId", "status");
ALTER TABLE "ai_agents" ADD CONSTRAINT "ai_agents_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ai_agents" ADD CONSTRAINT "ai_agents_createdById_fkey"
    FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ai_agents" ADD CONSTRAINT "ai_agents_updatedById_fkey"
    FOREIGN KEY ("updatedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
-- Alvo da transferência some do cadastro: a referência cai para nulo e a
-- transferência passa a valer "pela regra" (sem departamento / responsável
-- padrão), em vez de apontar para quem não existe.
ALTER TABLE "ai_agents" ADD CONSTRAINT "ai_agents_handoffDepartmentId_fkey"
    FOREIGN KEY ("handoffDepartmentId") REFERENCES "departments"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ai_agents" ADD CONSTRAINT "ai_agents_handoffAssigneeId_fkey"
    FOREIGN KEY ("handoffAssigneeId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Agente ↔ departamentos (N:N), mesma forma de etiqueta e resposta rápida.
CREATE TABLE "ai_agent_departments" (
    "agentId" TEXT NOT NULL,
    "departmentId" TEXT NOT NULL,

    CONSTRAINT "ai_agent_departments_pkey" PRIMARY KEY ("agentId", "departmentId")
);
CREATE INDEX "ai_agent_departments_departmentId_idx" ON "ai_agent_departments"("departmentId");
ALTER TABLE "ai_agent_departments" ADD CONSTRAINT "ai_agent_departments_agentId_fkey"
    FOREIGN KEY ("agentId") REFERENCES "ai_agents"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ai_agent_departments" ADD CONSTRAINT "ai_agent_departments_departmentId_fkey"
    FOREIGN KEY ("departmentId") REFERENCES "departments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Foto da configuração a cada gravação. A sessão aponta para a versão com
-- que começou: alterar o agente não muda as regras no meio da conversa.
CREATE TABLE "ai_agent_versions" (
    "id" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "model" TEXT,
    "config" JSONB NOT NULL,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_agent_versions_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "ai_agent_versions_agentId_version_key" ON "ai_agent_versions"("agentId", "version");
ALTER TABLE "ai_agent_versions" ADD CONSTRAINT "ai_agent_versions_agentId_fkey"
    FOREIGN KEY ("agentId") REFERENCES "ai_agents"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ai_agent_versions" ADD CONSTRAINT "ai_agent_versions_createdById_fkey"
    FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Base de conhecimento: texto livre ou perguntas e respostas. A busca é
-- lexical, por trechos — só os trechos relevantes vão ao modelo.
CREATE TABLE "ai_knowledge_sources" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "kind" "AiKnowledgeKind" NOT NULL DEFAULT 'text',
    "content" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ai_knowledge_sources_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "ai_knowledge_sources_organizationId_active_idx" ON "ai_knowledge_sources"("organizationId", "active");
ALTER TABLE "ai_knowledge_sources" ADD CONSTRAINT "ai_knowledge_sources_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ai_knowledge_sources" ADD CONSTRAINT "ai_knowledge_sources_createdById_fkey"
    FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "ai_agent_knowledge_sources" (
    "agentId" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,

    CONSTRAINT "ai_agent_knowledge_sources_pkey" PRIMARY KEY ("agentId", "sourceId")
);
CREATE INDEX "ai_agent_knowledge_sources_sourceId_idx" ON "ai_agent_knowledge_sources"("sourceId");
ALTER TABLE "ai_agent_knowledge_sources" ADD CONSTRAINT "ai_agent_knowledge_sources_agentId_fkey"
    FOREIGN KEY ("agentId") REFERENCES "ai_agents"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ai_agent_knowledge_sources" ADD CONSTRAINT "ai_agent_knowledge_sources_sourceId_fkey"
    FOREIGN KEY ("sourceId") REFERENCES "ai_knowledge_sources"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Automação: o gatilho que põe o agente para atender (o "bloco de IA").
CREATE TABLE "ai_automations" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "agentId" TEXT NOT NULL,
    "whatsappInstanceId" TEXT,
    "departmentId" TEXT,
    "onlyWithoutDepartment" BOOLEAN NOT NULL DEFAULT false,
    "conversationType" TEXT NOT NULL DEFAULT 'any',
    "onlyUnassigned" BOOLEAN NOT NULL DEFAULT true,
    "onlyNewConversations" BOOLEAN NOT NULL DEFAULT false,
    "resolvedTagId" TEXT,
    "priority" INTEGER NOT NULL DEFAULT 100,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ai_automations_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "ai_automations_organizationId_active_priority_idx" ON "ai_automations"("organizationId", "active", "priority");
ALTER TABLE "ai_automations" ADD CONSTRAINT "ai_automations_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- Agente excluído leva as automações dele: automação sem agente não tem o
-- que disparar.
ALTER TABLE "ai_automations" ADD CONSTRAINT "ai_automations_agentId_fkey"
    FOREIGN KEY ("agentId") REFERENCES "ai_agents"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ai_automations" ADD CONSTRAINT "ai_automations_whatsappInstanceId_fkey"
    FOREIGN KEY ("whatsappInstanceId") REFERENCES "whatsapp_instances"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ai_automations" ADD CONSTRAINT "ai_automations_departmentId_fkey"
    FOREIGN KEY ("departmentId") REFERENCES "departments"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ai_automations" ADD CONSTRAINT "ai_automations_resolvedTagId_fkey"
    FOREIGN KEY ("resolvedTagId") REFERENCES "tags"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Sessão: um atendimento por IA. "state" é a memória do atendimento.
CREATE TABLE "ai_sessions" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "agentVersionId" TEXT,
    "automationId" TEXT,
    "status" "AiSessionStatus" NOT NULL DEFAULT 'active',
    "state" JSONB,
    "aiMessageCount" INTEGER NOT NULL DEFAULT 0,
    "customerMessageCount" INTEGER NOT NULL DEFAULT 0,
    "failedAttempts" INTEGER NOT NULL DEFAULT 0,
    "inputTokens" INTEGER NOT NULL DEFAULT 0,
    "outputTokens" INTEGER NOT NULL DEFAULT 0,
    "costMicros" INTEGER NOT NULL DEFAULT 0,
    "lastProcessedMessageId" TEXT,
    "summary" TEXT,
    "endReason" TEXT,
    "endedByUserId" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastActivityAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt" TIMESTAMP(3),

    CONSTRAINT "ai_sessions_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "ai_sessions_conversationId_status_idx" ON "ai_sessions"("conversationId", "status");
CREATE INDEX "ai_sessions_organizationId_status_startedAt_idx" ON "ai_sessions"("organizationId", "status", "startedAt");
CREATE INDEX "ai_sessions_agentId_startedAt_idx" ON "ai_sessions"("agentId", "startedAt");
-- NO MÁXIMO UMA sessão ativa por conversa. É a trava de concorrência de
-- verdade: duas mensagens rápidas de um contato novo poderiam tentar abrir
-- duas sessões, e a segunda perde no índice em vez de duplicar a IA.
CREATE UNIQUE INDEX "ai_sessions_one_active_per_conversation"
    ON "ai_sessions"("conversationId") WHERE "status" = 'active';
ALTER TABLE "ai_sessions" ADD CONSTRAINT "ai_sessions_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ai_sessions" ADD CONSTRAINT "ai_sessions_conversationId_fkey"
    FOREIGN KEY ("conversationId") REFERENCES "conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ai_sessions" ADD CONSTRAINT "ai_sessions_agentId_fkey"
    FOREIGN KEY ("agentId") REFERENCES "ai_agents"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ai_sessions" ADD CONSTRAINT "ai_sessions_agentVersionId_fkey"
    FOREIGN KEY ("agentVersionId") REFERENCES "ai_agent_versions"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ai_sessions" ADD CONSTRAINT "ai_sessions_automationId_fkey"
    FOREIGN KEY ("automationId") REFERENCES "ai_automations"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ai_sessions" ADD CONSTRAINT "ai_sessions_endedByUserId_fkey"
    FOREIGN KEY ("endedByUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Uma chamada ao provedor: tokens, custo estimado, duração e ferramentas.
-- Nunca o conteúdo da conversa nem a chave.
CREATE TABLE "ai_usage_logs" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "sessionId" TEXT,
    "agentId" TEXT,
    "agentName" TEXT,
    "conversationId" TEXT,
    "departmentId" TEXT,
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "kind" "AiUsageKind" NOT NULL DEFAULT 'chat',
    "outcome" "AiUsageOutcome" NOT NULL DEFAULT 'ok',
    "inputTokens" INTEGER NOT NULL DEFAULT 0,
    "outputTokens" INTEGER NOT NULL DEFAULT 0,
    "costMicros" INTEGER,
    "durationMs" INTEGER NOT NULL DEFAULT 0,
    "errorCode" TEXT,
    "toolsRequested" JSONB,
    "toolsExecuted" JSONB,
    "toolsBlocked" JSONB,
    "handoffReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_usage_logs_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "ai_usage_logs_organizationId_createdAt_idx" ON "ai_usage_logs"("organizationId", "createdAt");
CREATE INDEX "ai_usage_logs_agentId_createdAt_idx" ON "ai_usage_logs"("agentId", "createdAt");
ALTER TABLE "ai_usage_logs" ADD CONSTRAINT "ai_usage_logs_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- Referências FROUXAS: apagar sessão, agente, conversa ou departamento não
-- apaga o registro de consumo — o custo já aconteceu.
ALTER TABLE "ai_usage_logs" ADD CONSTRAINT "ai_usage_logs_sessionId_fkey"
    FOREIGN KEY ("sessionId") REFERENCES "ai_sessions"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ai_usage_logs" ADD CONSTRAINT "ai_usage_logs_agentId_fkey"
    FOREIGN KEY ("agentId") REFERENCES "ai_agents"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ai_usage_logs" ADD CONSTRAINT "ai_usage_logs_conversationId_fkey"
    FOREIGN KEY ("conversationId") REFERENCES "conversations"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ai_usage_logs" ADD CONSTRAINT "ai_usage_logs_departmentId_fkey"
    FOREIGN KEY ("departmentId") REFERENCES "departments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

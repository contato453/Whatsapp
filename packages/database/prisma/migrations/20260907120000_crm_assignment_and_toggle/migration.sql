-- Duas coisas que o escritório pediu depois de ver o CRM de pé:
--
--   1. DISTRIBUIÇÃO AUTOMÁTICA das oportunidades novas (rodízio e afins),
--      porque lead que chega sem dono e fica na fila é venda perdida;
--   2. o INTERRUPTOR do módulo, para ligar e desligar o Kanban sem deploy.

-- ---------- Interruptor do módulo ----------

-- Nasce LIGADO: quem já montou funil não pode perder a tela num deploy.
-- Desligar NUNCA apaga dado — é interruptor, não exclusão. Fica no
-- `organizations` (e não em `attendance_settings`) porque não é parâmetro de
-- atendimento: é a existência do módulo para o tenant.
ALTER TABLE "organizations" ADD COLUMN "crmEnabled" BOOLEAN NOT NULL DEFAULT true;

-- ---------- Distribuição automática ----------

CREATE TYPE "CrmAssignmentMode" AS ENUM (
    'none', 'inherit_conversation', 'fixed', 'round_robin', 'least_open'
);

-- O padrão é o comportamento que já existia (herdar de quem atende a
-- conversa): um valor diferente aqui mudaria, no deploy, quem recebe os leads
-- de quem já usa o CRM.
ALTER TABLE "crm_pipelines"
    ADD COLUMN "assignmentMode" "CrmAssignmentMode" NOT NULL DEFAULT 'inherit_conversation',
    ADD COLUMN "assignmentFixedUserId" TEXT,
    -- Contador do rodízio, incrementado ATOMICAMENTE no banco. Guardar "o
    -- último que recebeu" e calcular o próximo em memória perderia a corrida
    -- entre duas criações simultâneas, e o rodízio entregaria dois leads
    -- seguidos para a mesma pessoa sem ninguém entender por quê.
    ADD COLUMN "assignmentCursor" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "crm_pipelines" ADD CONSTRAINT "crm_pipelines_assignmentFixedUserId_fkey"
    FOREIGN KEY ("assignmentFixedUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Quem participa do rodízio. Lista VAZIA significa "todo mundo que enxerga a
-- conversa" — e não "ninguém": vazio bloqueando a distribuição faria o funil
-- parar de distribuir no dia em que alguém saísse do cadastro.
CREATE TABLE "crm_pipeline_assignees" (
    "pipelineId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "crm_pipeline_assignees_pkey" PRIMARY KEY ("pipelineId", "userId")
);
CREATE INDEX "crm_pipeline_assignees_userId_idx" ON "crm_pipeline_assignees"("userId");

ALTER TABLE "crm_pipeline_assignees" ADD CONSTRAINT "crm_pipeline_assignees_pipelineId_fkey"
    FOREIGN KEY ("pipelineId") REFERENCES "crm_pipelines"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "crm_pipeline_assignees" ADD CONSTRAINT "crm_pipeline_assignees_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- MÓDULO QUALITY — avaliação do atendimento pela IA, só para o administrador.
--
-- Por que existe: hoje não há avaliação sistemática de como cada atendente
-- trata o cliente no WhatsApp, e ler conversa por conversa não escala. O
-- administrador seleciona conversas e um período, dispara, e a IA que o
-- sistema já usa dá nota, classifica o assunto e sugere plano de ação.
--
-- Por que NÃO há tabela de transcrição aqui: transcrever e avaliar são DOIS
-- passos, e a transcrição já mora em `messages.metadata.audioTranscript`
-- (migration 20260922120000_ai_audio_transcription). Um segundo lugar para a
-- mesma coisa faria o Quality pagar de novo a transcrição que o atendimento
-- por IA já comprou — e divergir sobre qual das duas é a verdadeira.
--
-- Por que o passo separado importa: o mascaramento (CPF, CNPJ, telefone, chave
-- Pix) age sobre TEXTO, e é justamente no ÁUDIO que o cliente dita esses dados.
-- Mandar o áudio direto para a avaliação pularia a proteção onde ela mais vale.

-- A avaliação é uma chamada PAGA ao provedor e entra no consumo como tipo
-- próprio. Somá-la ao "Atendimento" faria o custo por turno de conversa deixar
-- de fechar, que é o defeito que a separação de transcrição e visão já evitou.
ALTER TYPE "AiUsageKind" ADD VALUE 'quality';

CREATE TYPE "QualityRunStatus"  AS ENUM ('queued','transcribing','analyzing','completed','failed');
CREATE TYPE "QualityItemStatus" AS ENUM ('queued','transcribing','analyzing','completed','skipped','failed');

-- Tetos do módulo, por organização. Configuráveis porque o custo é do
-- escritório: conversas por disparo, duração máxima de áudio transcrito e a
-- cobertura mínima para a avaliação não sair marcada como PARCIAL.
CREATE TABLE "quality_settings" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "maxConversationsPerRun" INTEGER NOT NULL DEFAULT 20,
    "maxAudioSeconds" INTEGER NOT NULL DEFAULT 600,
    "minCoveragePercent" INTEGER NOT NULL DEFAULT 60,
    "model" TEXT,
    "updatedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "quality_settings_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "quality_settings_organizationId_key" ON "quality_settings"("organizationId");

-- UM disparo: as conversas escolhidas mais o período. Nada roda sozinho.
CREATE TABLE "quality_runs" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "status" "QualityRunStatus" NOT NULL DEFAULT 'queued',
    "periodFrom" TIMESTAMP(3) NOT NULL,
    "periodTo" TIMESTAMP(3) NOT NULL,
    "requestedById" TEXT,
    -- Nome copiado na hora: administrador removido do cadastro não apaga a
    -- autoria do disparo, que é o que a auditoria precisa responder.
    "requestedByName" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "conversationCount" INTEGER NOT NULL DEFAULT 0,
    "failureReason" TEXT,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "quality_runs_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "quality_runs_organizationId_createdAt_idx" ON "quality_runs"("organizationId","createdAt");

-- Uma conversa dentro de um disparo. Guarda o estado visível na tela (na fila,
-- transcrevendo, analisando, concluída, falhou) e a COBERTURA — quanto da
-- conversa chegou legível à avaliação.
CREATE TABLE "quality_run_items" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "status" "QualityItemStatus" NOT NULL DEFAULT 'queued',
    -- Código do motivo (nunca frase montada no banco): a tela traduz.
    "skipReason" TEXT,
    "failureReason" TEXT,
    "coveragePercent" INTEGER,
    "partial" BOOLEAN NOT NULL DEFAULT false,
    "truncated" BOOLEAN NOT NULL DEFAULT false,
    "messageCount" INTEGER NOT NULL DEFAULT 0,
    "audioCount" INTEGER NOT NULL DEFAULT 0,
    "audioTranscribedCount" INTEGER NOT NULL DEFAULT 0,
    -- Tamanho do material que saiu para a avaliação, em caracteres. Só o
    -- tamanho: o material em si nunca é gravado nem logado.
    "promptChars" INTEGER NOT NULL DEFAULT 0,
    "model" TEXT,
    "inputTokens" INTEGER NOT NULL DEFAULT 0,
    "outputTokens" INTEGER NOT NULL DEFAULT 0,
    "costMicros" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "quality_run_items_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "quality_run_items_runId_conversationId_key" ON "quality_run_items"("runId","conversationId");
CREATE INDEX "quality_run_items_organizationId_status_idx" ON "quality_run_items"("organizationId","status");

-- A avaliação de UM atendente numa conversa e período. Mais de um atendente no
-- período rende uma linha por pessoa, cada uma com o contexto da conversa
-- inteira. As métricas objetivas ficam em COLUNA (o relatório filtra e soma por
-- elas); notas por critério e plano de ação ficam em JSON, porque só são lidos
-- inteiros, no detalhe.
CREATE TABLE "quality_evaluations" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "userId" TEXT,
    -- Nome copiado: atendente desativado (ou removido) continua legível para o
    -- administrador, que é a borda pedida.
    "userName" TEXT NOT NULL,
    "overallScore" DOUBLE PRECISION NOT NULL,
    "criteria" JSONB NOT NULL,
    -- Catálogo FECHADO declarado em @azvchat/shared. Texto, e não enum, pelo
    -- mesmo motivo de `role_permissions.action`: assunto novo não exige
    -- migration, e assunto que sair do catálogo é ignorado pela leitura.
    "subject" TEXT NOT NULL,
    "actionPlan" JSONB NOT NULL,
    "confidence" TEXT NOT NULL,
    "coveragePercent" INTEGER NOT NULL DEFAULT 100,
    "partial" BOOLEAN NOT NULL DEFAULT false,
    -- Métricas objetivas, medidas pelo sistema ANTES da IA, em minutos de
    -- expediente (a mesma régua do card de atraso).
    "firstResponseMinutes" INTEGER,
    "avgResponseMinutes" INTEGER,
    "responsesMeasured" INTEGER NOT NULL DEFAULT 0,
    "limitBreaches" INTEGER NOT NULL DEFAULT 0,
    "messagesSent" INTEGER NOT NULL DEFAULT 0,
    "conversationOutcome" TEXT NOT NULL,
    -- Descarte é do administrador e não apaga a linha; o comentário dele NUNCA
    -- altera a nota, que é da IA por decisão do desenho.
    "discardedAt" TIMESTAMP(3),
    "discardedByUserId" TEXT,
    "adminComment" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "quality_evaluations_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "quality_evaluations_organizationId_userId_createdAt_idx" ON "quality_evaluations"("organizationId","userId","createdAt");
CREATE INDEX "quality_evaluations_organizationId_subject_idx" ON "quality_evaluations"("organizationId","subject");
CREATE INDEX "quality_evaluations_itemId_idx" ON "quality_evaluations"("itemId");

-- Organização em CASCADE; pessoa em SET NULL, porque a análise sobrevive a
-- quem a disparou e a quem foi avaliado.
ALTER TABLE "quality_settings"    ADD CONSTRAINT "quality_settings_organizationId_fkey"       FOREIGN KEY ("organizationId")    REFERENCES "organizations"("id")      ON DELETE CASCADE  ON UPDATE CASCADE;
ALTER TABLE "quality_settings"    ADD CONSTRAINT "quality_settings_updatedById_fkey"          FOREIGN KEY ("updatedById")       REFERENCES "users"("id")              ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "quality_runs"        ADD CONSTRAINT "quality_runs_organizationId_fkey"           FOREIGN KEY ("organizationId")    REFERENCES "organizations"("id")      ON DELETE CASCADE  ON UPDATE CASCADE;
ALTER TABLE "quality_runs"        ADD CONSTRAINT "quality_runs_requestedById_fkey"            FOREIGN KEY ("requestedById")     REFERENCES "users"("id")              ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "quality_run_items"   ADD CONSTRAINT "quality_run_items_organizationId_fkey"      FOREIGN KEY ("organizationId")    REFERENCES "organizations"("id")      ON DELETE CASCADE  ON UPDATE CASCADE;
ALTER TABLE "quality_run_items"   ADD CONSTRAINT "quality_run_items_runId_fkey"               FOREIGN KEY ("runId")             REFERENCES "quality_runs"("id")       ON DELETE CASCADE  ON UPDATE CASCADE;
ALTER TABLE "quality_run_items"   ADD CONSTRAINT "quality_run_items_conversationId_fkey"      FOREIGN KEY ("conversationId")    REFERENCES "conversations"("id")      ON DELETE CASCADE  ON UPDATE CASCADE;
ALTER TABLE "quality_evaluations" ADD CONSTRAINT "quality_evaluations_organizationId_fkey"    FOREIGN KEY ("organizationId")    REFERENCES "organizations"("id")      ON DELETE CASCADE  ON UPDATE CASCADE;
ALTER TABLE "quality_evaluations" ADD CONSTRAINT "quality_evaluations_runId_fkey"             FOREIGN KEY ("runId")             REFERENCES "quality_runs"("id")       ON DELETE CASCADE  ON UPDATE CASCADE;
ALTER TABLE "quality_evaluations" ADD CONSTRAINT "quality_evaluations_itemId_fkey"            FOREIGN KEY ("itemId")            REFERENCES "quality_run_items"("id")  ON DELETE CASCADE  ON UPDATE CASCADE;
ALTER TABLE "quality_evaluations" ADD CONSTRAINT "quality_evaluations_conversationId_fkey"    FOREIGN KEY ("conversationId")    REFERENCES "conversations"("id")      ON DELETE CASCADE  ON UPDATE CASCADE;
ALTER TABLE "quality_evaluations" ADD CONSTRAINT "quality_evaluations_userId_fkey"            FOREIGN KEY ("userId")            REFERENCES "users"("id")              ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "quality_evaluations" ADD CONSTRAINT "quality_evaluations_discardedByUserId_fkey" FOREIGN KEY ("discardedByUserId") REFERENCES "users"("id")              ON DELETE SET NULL ON UPDATE CASCADE;

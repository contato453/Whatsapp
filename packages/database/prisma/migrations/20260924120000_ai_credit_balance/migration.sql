-- SALDO ESTIMADO DO CRÉDITO DA IA.
--
-- A OpenAI não informa saldo pré-pago pela API: o máximo é o custo faturado
-- do mês, e só para uma chave de administrador. O escritório queria saber
-- "quanto ainda tem" sem abrir o painel da OpenAI, então o saldo passa a ser
-- estimado aqui: quem administra lança o saldo que vê na OpenAI e cada
-- recarga, e o AZVCHAT desconta o consumo que já registra por chamada
-- (atendimento, fluxos, Quality, transcrição, imagem). A chave é usada só
-- pelo AZVCHAT, então o consumo registrado é todo o consumo da conta.

CREATE TYPE "AiCreditEntryKind" AS ENUM ('balance', 'top_up');

CREATE TABLE "ai_credit_entries" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "kind" "AiCreditEntryKind" NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "effectiveAt" TIMESTAMP(3) NOT NULL,
    "note" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_credit_entries_pkey" PRIMARY KEY ("id"),
    -- Saldo zero pode ser informado (conta zerada); recarga negativa não existe.
    CONSTRAINT "ai_credit_entries_amount_not_negative" CHECK ("amountCents" >= 0)
);

CREATE INDEX "ai_credit_entries_organizationId_effectiveAt_idx" ON "ai_credit_entries"("organizationId", "effectiveAt");

ALTER TABLE "ai_credit_entries" ADD CONSTRAINT "ai_credit_entries_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ai_credit_entries" ADD CONSTRAINT "ai_credit_entries_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Aviso de saldo baixo: só pinta o card, não bloqueia nada.
ALTER TABLE "ai_settings" ADD COLUMN "lowBalanceAlertCents" INTEGER;

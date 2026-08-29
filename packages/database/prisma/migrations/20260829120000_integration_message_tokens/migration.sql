-- Token de integração: credencial de MÁQUINA (não de sessão de usuário) para
-- outro sistema do escritório disparar UMA mensagem de WhatsApp. Guardamos só
-- o HASH (sha256) do token — o valor em claro é mostrado uma única vez na
-- criação e nunca mais. Cada token é amarrado a EXATAMENTE uma instância:
-- um token vazado manda mensagem só por aquele número, nunca pelos outros.
CREATE TABLE "integration_tokens" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    -- Prefixo VISÍVEL do token (ex.: "azv_a1b2c3d4"), para a tela identificar
    -- qual token é qual sem nunca guardar o segredo.
    "tokenPrefix" TEXT NOT NULL,
    -- sha256 do token inteiro. A busca da autenticação é por igualdade neste
    -- índice único: token errado gera hash que não casa com nada.
    "tokenHash" TEXT NOT NULL,
    "whatsappInstanceId" TEXT NOT NULL,
    -- Revogar é DESATIVAR, nunca apagar: o histórico de uso fica de pé.
    "active" BOOLEAN NOT NULL DEFAULT true,
    -- Quem criou. SET NULL: o token pertence à integração, não à pessoa —
    -- desativar/rebaixar/excluir quem criou não invalida o token.
    "createdById" TEXT,
    "lastUsedAt" TIMESTAMP(3),
    "usageCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "integration_tokens_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "integration_tokens_tokenHash_key" ON "integration_tokens"("tokenHash");
CREATE INDEX "integration_tokens_organizationId_idx" ON "integration_tokens"("organizationId");
CREATE INDEX "integration_tokens_whatsappInstanceId_idx" ON "integration_tokens"("whatsappInstanceId");

ALTER TABLE "integration_tokens" ADD CONSTRAINT "integration_tokens_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- Instância excluída leva o token junto: um token apontando para número que
-- não existe mais nunca deve ficar de pé.
ALTER TABLE "integration_tokens" ADD CONSTRAINT "integration_tokens_whatsappInstanceId_fkey"
    FOREIGN KEY ("whatsappInstanceId") REFERENCES "whatsapp_instances"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "integration_tokens" ADD CONSTRAINT "integration_tokens_createdById_fkey"
    FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Registro de envio por chave de idempotência: quando o sistema externo tenta
-- de novo por timeout, a MESMA chave dentro de 24h não reenvia — devolve o
-- resultado do envio original. Uma linha por (token, chave); reuso após 24h
-- sobrescreve a linha (createdAt volta para agora), então a janela é móvel.
CREATE TABLE "integration_message_logs" (
    "id" TEXT NOT NULL,
    "integrationTokenId" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "conversationId" TEXT,
    "messageId" TEXT,
    "normalizedPhone" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "integration_message_logs_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "integration_message_logs_integrationTokenId_idempotencyKey_key"
    ON "integration_message_logs"("integrationTokenId", "idempotencyKey");
CREATE INDEX "integration_message_logs_integrationTokenId_createdAt_idx"
    ON "integration_message_logs"("integrationTokenId", "createdAt");

ALTER TABLE "integration_message_logs" ADD CONSTRAINT "integration_message_logs_integrationTokenId_fkey"
    FOREIGN KEY ("integrationTokenId") REFERENCES "integration_tokens"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- Conversa/mensagem são referência FROUXA (podem ser apagadas sem apagar o
-- registro de idempotência): SET NULL, não CASCADE.
ALTER TABLE "integration_message_logs" ADD CONSTRAINT "integration_message_logs_conversationId_fkey"
    FOREIGN KEY ("conversationId") REFERENCES "conversations"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "integration_message_logs" ADD CONSTRAINT "integration_message_logs_messageId_fkey"
    FOREIGN KEY ("messageId") REFERENCES "messages"("id") ON DELETE SET NULL ON UPDATE CASCADE;

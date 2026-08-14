-- Assinatura do atendente nas mensagens enviadas.
-- Desligada por padrão: ativar é decisão de cada organização.
ALTER TABLE "users" ADD COLUMN "signMessages" BOOLEAN NOT NULL DEFAULT false;

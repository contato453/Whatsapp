-- Data do último uso da resposta rápida.
--
-- A tela de Respostas rápidas passa a mostrar quando cada atalho foi
-- enviado pela última vez — é como a equipe descobre resposta parada que
-- ninguém usa mais. Marcada no ENVIO pelo composer, não na edição do
-- cadastro. Null = nunca usada desde que a coluna existe (sem backfill:
-- não há de onde reconstruir o histórico).

ALTER TABLE "quick_replies" ADD COLUMN "lastUsedAt" TIMESTAMP(3);

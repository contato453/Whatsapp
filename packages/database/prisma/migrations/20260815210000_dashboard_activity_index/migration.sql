-- O dashboard faz duas varreduras que hoje não têm índice bom:
--   1. cards de status: conversas com atividade no período
--      (`lastMessageAt >= corte`) agrupadas por status;
--   2. card de atraso: conversas não resolvidas cuja última atividade já
--      passou do limite de resposta.
-- Os índices existentes são `(organizationId, status)` e
-- `(organizationId, lastMessageAt)`, e nenhum dos dois cobre as duas colunas
-- juntas — o planner escolhe um e filtra o resto linha a linha.
--
-- As contagens de mensagem e o ranking não precisam de índice novo:
-- `messages(organizationId, timestamp)` já cobre o recorte de período, e o
-- `DISTINCT ON` que acha a última mensagem de cada conversa usa o
-- `messages(conversationId, timestamp)` que já existe.

-- CreateIndex
CREATE INDEX "conversations_organizationId_status_lastMessageAt_idx"
    ON "conversations"("organizationId", "status", "lastMessageAt");

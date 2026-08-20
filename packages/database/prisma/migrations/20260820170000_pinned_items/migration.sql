-- Fixação de mensagem ("pin") — INTERNA ao AZVCHAT, nunca propagada ao
-- WhatsApp. É uma faixa no topo da conversa, só para a equipe: nada aqui
-- chama o provider nem usa o recurso de pin do próprio Baileys, porque o pin
-- do WhatsApp fixa para todos os participantes do grupo, e o cliente veria o
-- escritório fixando coisas no chat dele.
--
-- O alvo é polimórfico (mensagem OU nota interna, nunca as duas) porque nota
-- interna também pode ser fixada e ela não é "messages": é outra tabela.
CREATE TABLE "pinned_items" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "messageId" TEXT,
    "noteId" TEXT,
    "pinnedByUserId" TEXT,
    "pinnedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pinned_items_pkey" PRIMARY KEY ("id")
);

-- Exatamente um alvo por linha. Sem isso, uma linha com os dois nulos (ou os
-- dois preenchidos) ficaria fixada sem ninguém saber fixada em quê.
ALTER TABLE "pinned_items"
    ADD CONSTRAINT "pinned_items_one_target"
    CHECK (
        ("messageId" IS NOT NULL AND "noteId" IS NULL)
        OR ("messageId" IS NULL AND "noteId" IS NOT NULL)
    );

-- NULL não colide em índice único do Postgres: várias fixações de nota
-- (messageId nulo) e várias de mensagem (noteId nulo) convivem na mesma
-- conversa. Cada unique só impede fixar o MESMO alvo duas vezes.
CREATE UNIQUE INDEX "pinned_items_conversationId_messageId_key"
    ON "pinned_items"("conversationId", "messageId");
CREATE UNIQUE INDEX "pinned_items_conversationId_noteId_key"
    ON "pinned_items"("conversationId", "noteId");

-- Ordena a faixa ("1 de 3") e sustenta a contagem do limite de 3 por
-- conversa, sem varrer a tabela inteira.
CREATE INDEX "pinned_items_conversationId_pinnedAt_idx"
    ON "pinned_items"("conversationId", "pinnedAt");

ALTER TABLE "pinned_items" ADD CONSTRAINT "pinned_items_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "pinned_items" ADD CONSTRAINT "pinned_items_conversationId_fkey"
    FOREIGN KEY ("conversationId") REFERENCES "conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- Mensagem nunca é apagada fisicamente (só `deletedAt`), então este cascade
-- não dispara sozinho por exclusão de mensagem; quem tira o pin de uma
-- mensagem apagada é a aplicação, no mesmo instante em que grava `deletedAt`.
ALTER TABLE "pinned_items" ADD CONSTRAINT "pinned_items_messageId_fkey"
    FOREIGN KEY ("messageId") REFERENCES "messages"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- Nota interna, ao contrário de mensagem, É apagada fisicamente
-- (DELETE /conversations/:id/notes/:noteId) — este cascade é quem garante
-- que a fixação some sozinha nesse caso, sem precisar de código a mais.
ALTER TABLE "pinned_items" ADD CONSTRAINT "pinned_items_noteId_fkey"
    FOREIGN KEY ("noteId") REFERENCES "internal_notes"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "pinned_items" ADD CONSTRAINT "pinned_items_pinnedByUserId_fkey"
    FOREIGN KEY ("pinnedByUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

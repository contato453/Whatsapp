-- Arquivamento de conversa: a data responde "está arquivada?" (nulo = não) e
-- quem arquivou fica para a visão de arquivadas. Ortogonal ao status: a
-- conversa volta com o status que tinha ao ser desarquivada.
ALTER TABLE "conversations" ADD COLUMN "archivedAt" TIMESTAMP(3);
ALTER TABLE "conversations" ADD COLUMN "archivedByUserId" TEXT;

ALTER TABLE "conversations" ADD CONSTRAINT "conversations_archivedByUserId_fkey"
  FOREIGN KEY ("archivedByUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- A consulta mais comum da Inbox: não arquivadas de um recorte, ordenadas por
-- última mensagem. archivedAt entra antes de lastMessageAt para o filtro
-- "archivedAt IS NULL" aproveitar o índice junto da ordenação.
CREATE INDEX "conversations_organizationId_archivedAt_lastMessageAt_idx"
  ON "conversations"("organizationId", "archivedAt", "lastMessageAt");

-- Número de backup: conversa nova nele já nasce arquivada. Nasce desligado.
ALTER TABLE "whatsapp_instances" ADD COLUMN "isBackup" BOOLEAN NOT NULL DEFAULT false;

-- Reduz ConversationStatus para os quatro status de atendimento:
-- open (Aberto), waiting_client (AG. Cliente), waiting_internal (AG. Operacional)
-- e resolved (Concluído).
--
-- O Postgres não remove valores de um enum existente, então o caminho é criar
-- o tipo novo, converter a coluna com o mapeamento e trocar os nomes.
--
-- Mapeamento das conversas que já existem:
--   new      -> open            (conversa nova ainda é atendimento aberto)
--   open     -> open
--   waiting  -> waiting_client  (o "aguardando" antigo era espera pelo cliente)
--   resolved -> resolved
--   archived -> resolved        (arquivada deixa de existir; vira concluída)

CREATE TYPE "ConversationStatus_new" AS ENUM ('open', 'waiting_client', 'waiting_internal', 'resolved');

ALTER TABLE "conversations" ALTER COLUMN "status" DROP DEFAULT;

ALTER TABLE "conversations"
  ALTER COLUMN "status" TYPE "ConversationStatus_new"
  USING (
    CASE "status"::text
      WHEN 'new' THEN 'open'
      WHEN 'open' THEN 'open'
      WHEN 'waiting' THEN 'waiting_client'
      WHEN 'resolved' THEN 'resolved'
      WHEN 'archived' THEN 'resolved'
    END
  )::"ConversationStatus_new";

DROP TYPE "ConversationStatus";

ALTER TYPE "ConversationStatus_new" RENAME TO "ConversationStatus";

ALTER TABLE "conversations" ALTER COLUMN "status" SET DEFAULT 'open';

-- Nome próprio, definido pela equipe, com prioridade sobre o que vem do
-- WhatsApp. O nome do WhatsApp continua guardado e visível como referência,
-- e a sincronização nunca toca nos campos novos.
--
-- Também adiciona o sócio representante perante a Receita Federal, no mesmo
-- padrão do código do cadastro da empresa que já existia na conversa.

ALTER TABLE "conversations" ADD COLUMN "customTitle" TEXT;
ALTER TABLE "conversations" ADD COLUMN "partnerName" TEXT;

ALTER TABLE "group_participants" ADD COLUMN "customName" TEXT;

-- Departamento da conversa NO MOMENTO DA AVALIACAO, copiado.
--
-- Cruzar ao vivo com conversations.departmentId faria a conversa do CS
-- transferida para o Fiscal em outubro levar consigo a nota de setembro, e o
-- relatorio do mes passado mudaria sozinho. Mesma razao de userName e de
-- quality_runs.requestedByName serem copia.
--
-- Nulo e ESTADO VALIDO (conversa sem departamento existe e precisa continuar
-- contando), e ON DELETE SET NULL mantem o historico quando o departamento sai
-- do cadastro: o nome fica na coluna copiada.
--
-- As avaliacoes que ja existem ficam sem departamento de proposito: ninguem
-- sabe em que setor a conversa estava quando foram feitas, e chutar o setor de
-- HOJE e exatamente o erro que a coluna copiada veio evitar.
ALTER TABLE "quality_evaluations"
  ADD COLUMN "departmentId" TEXT,
  ADD COLUMN "departmentName" TEXT;

ALTER TABLE "quality_evaluations"
  ADD CONSTRAINT "quality_evaluations_departmentId_fkey"
  FOREIGN KEY ("departmentId") REFERENCES "departments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "quality_evaluations_organizationId_departmentId_idx"
  ON "quality_evaluations"("organizationId", "departmentId");

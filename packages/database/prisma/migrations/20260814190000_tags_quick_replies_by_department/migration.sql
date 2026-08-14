-- Etiquetas e respostas rápidas passam a pertencer a um departamento.
-- NULL = geral: visível a todos, como eram antes desta mudança. As que já
-- existem ficam gerais para ninguém perder acesso ao que usa hoje.
ALTER TABLE "tags" ADD COLUMN "departmentId" TEXT;
ALTER TABLE "quick_replies" ADD COLUMN "departmentId" TEXT;

-- SET NULL ao excluir o departamento: perder a etiqueta apagaria também a
-- marcação dela nas conversas. Ela volta a ser geral e o admin decide.
ALTER TABLE "tags"
  ADD CONSTRAINT "tags_departmentId_fkey"
  FOREIGN KEY ("departmentId") REFERENCES "departments"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "quick_replies"
  ADD CONSTRAINT "quick_replies_departmentId_fkey"
  FOREIGN KEY ("departmentId") REFERENCES "departments"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "tags_departmentId_idx" ON "tags"("departmentId");
CREATE INDEX "quick_replies_departmentId_idx" ON "quick_replies"("departmentId");

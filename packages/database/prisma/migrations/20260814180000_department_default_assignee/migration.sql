-- Responsável padrão do departamento: assume as conversas que chegam nele
-- sem ninguém atribuído.
ALTER TABLE "departments" ADD COLUMN "defaultAssigneeId" TEXT;

-- SET NULL: excluir o usuário não pode derrubar o departamento; o
-- departamento apenas volta a não ter responsável padrão.
ALTER TABLE "departments"
  ADD CONSTRAINT "departments_defaultAssigneeId_fkey"
  FOREIGN KEY ("defaultAssigneeId") REFERENCES "users"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "departments_defaultAssigneeId_idx" ON "departments"("defaultAssigneeId");

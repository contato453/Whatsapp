-- Responsável padrão do número. O responsável padrão do departamento não
-- cobre o número dedicado a uma pessoa: sem departamento configurado, a
-- conversa nasce com "departmentId" nulo e nunca encontrava um dono, ficando
-- "Sem responsável" para sempre.
ALTER TABLE "whatsapp_instances" ADD COLUMN "defaultAssigneeId" TEXT;

-- SET NULL: excluir o usuário não pode derrubar o número; ele apenas volta a
-- não ter responsável padrão.
ALTER TABLE "whatsapp_instances"
  ADD CONSTRAINT "whatsapp_instances_defaultAssigneeId_fkey"
  FOREIGN KEY ("defaultAssigneeId") REFERENCES "users"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "whatsapp_instances_defaultAssigneeId_idx"
  ON "whatsapp_instances"("defaultAssigneeId");

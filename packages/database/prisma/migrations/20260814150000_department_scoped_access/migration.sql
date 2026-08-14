-- Acesso por departamento, além do acesso por número de WhatsApp.
--
-- Duas adições:
--   1. whatsapp_instances.departmentId — departamento padrão do número, para
--      a conversa já nascer classificada.
--   2. user_departments — em quais departamentos cada usuário atua.
--
-- E uma inversão de regra: até aqui, usuário sem nenhum número marcado
-- enxergava TODOS os números. Passa a enxergar nenhum. Por isso o backfill
-- no fim: quem hoje está sem marcação recebe todos os números e todos os
-- departamentos, preservando exatamente o acesso que já tinha. Sem isso,
-- todo mundo ficaria sem ver conversa alguma no primeiro deploy.

-- 1. Departamento padrão do número
ALTER TABLE "whatsapp_instances" ADD COLUMN "departmentId" TEXT;

ALTER TABLE "whatsapp_instances"
  ADD CONSTRAINT "whatsapp_instances_departmentId_fkey"
  FOREIGN KEY ("departmentId") REFERENCES "departments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "whatsapp_instances_departmentId_idx" ON "whatsapp_instances"("departmentId");

-- 2. Departamentos de cada usuário
CREATE TABLE "user_departments" (
    "userId" TEXT NOT NULL,
    "departmentId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_departments_pkey" PRIMARY KEY ("userId","departmentId")
);

CREATE INDEX "user_departments_departmentId_idx" ON "user_departments"("departmentId");

ALTER TABLE "user_departments"
  ADD CONSTRAINT "user_departments_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "user_departments"
  ADD CONSTRAINT "user_departments_departmentId_fkey"
  FOREIGN KEY ("departmentId") REFERENCES "departments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- 3. Backfill: preserva o acesso de quem já existe
--    3a. Quem não tem nenhum número marcado recebe todos os da organização
INSERT INTO "user_whatsapp_instances" ("userId", "whatsappInstanceId")
SELECT u."id", i."id"
FROM "users" u
JOIN "whatsapp_instances" i ON i."organizationId" = u."organizationId"
WHERE NOT EXISTS (
  SELECT 1 FROM "user_whatsapp_instances" ua WHERE ua."userId" = u."id"
)
ON CONFLICT DO NOTHING;

--    3b. Todo usuário recebe todos os departamentos da organização
--        (a tabela acabou de nascer, então ninguém tem marcação ainda)
INSERT INTO "user_departments" ("userId", "departmentId")
SELECT u."id", d."id"
FROM "users" u
JOIN "departments" d ON d."organizationId" = u."organizationId"
ON CONFLICT DO NOTHING;

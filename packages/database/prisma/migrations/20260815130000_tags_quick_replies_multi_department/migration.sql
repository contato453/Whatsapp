-- Etiquetas e respostas rápidas passam a valer para VÁRIOS departamentos.
--
-- O mesmo "Urgente" e o mesmo texto padrão servem para Contábil, Fiscal e
-- DP ao mesmo tempo, e o nome continua único na organização inteira — hoje
-- a equipe é obrigada a cadastrar o item três vezes com nomes diferentes.
--
-- "Geral" deixa de ser o departamento nulo e vira a flag "isGeneral". Se
-- lista vazia significasse geral, excluir um departamento esvaziaria a
-- lista de um item restrito e ele passaria a valer para a organização
-- inteira sem ninguém perceber. Com a flag, o item fica sem departamento e
-- some para quem não é admin — o lado seguro do erro.

-- 1) Tabelas de junção -----------------------------------------------------

CREATE TABLE "tag_departments" (
    "tagId" TEXT NOT NULL,
    "departmentId" TEXT NOT NULL,

    CONSTRAINT "tag_departments_pkey" PRIMARY KEY ("tagId","departmentId")
);

CREATE TABLE "quick_reply_departments" (
    "quickReplyId" TEXT NOT NULL,
    "departmentId" TEXT NOT NULL,

    CONSTRAINT "quick_reply_departments_pkey" PRIMARY KEY ("quickReplyId","departmentId")
);

CREATE INDEX "tag_departments_departmentId_idx" ON "tag_departments"("departmentId");
CREATE INDEX "quick_reply_departments_departmentId_idx" ON "quick_reply_departments"("departmentId");

-- Cascade nas duas pontas: o vínculo não sobrevive ao dono nem ao
-- departamento. Excluir o departamento apaga só a linha da junção — o
-- registro da etiqueta continua existindo, para o admin arrumar.
ALTER TABLE "tag_departments"
  ADD CONSTRAINT "tag_departments_tagId_fkey"
  FOREIGN KEY ("tagId") REFERENCES "tags"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "tag_departments"
  ADD CONSTRAINT "tag_departments_departmentId_fkey"
  FOREIGN KEY ("departmentId") REFERENCES "departments"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "quick_reply_departments"
  ADD CONSTRAINT "quick_reply_departments_quickReplyId_fkey"
  FOREIGN KEY ("quickReplyId") REFERENCES "quick_replies"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "quick_reply_departments"
  ADD CONSTRAINT "quick_reply_departments_departmentId_fkey"
  FOREIGN KEY ("departmentId") REFERENCES "departments"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- 2) Flag de "geral" -------------------------------------------------------

ALTER TABLE "tags" ADD COLUMN "isGeneral" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "quick_replies" ADD COLUMN "isGeneral" BOOLEAN NOT NULL DEFAULT false;

-- 3) Backfill: o departamento único vira o primeiro vínculo ----------------

INSERT INTO "tag_departments" ("tagId", "departmentId")
SELECT "id", "departmentId" FROM "tags" WHERE "departmentId" IS NOT NULL;

INSERT INTO "quick_reply_departments" ("quickReplyId", "departmentId")
SELECT "id", "departmentId" FROM "quick_replies" WHERE "departmentId" IS NOT NULL;

-- 4) Backfill: o que era nulo era geral ------------------------------------

UPDATE "tags" SET "isGeneral" = true WHERE "departmentId" IS NULL;
UPDATE "quick_replies" SET "isGeneral" = true WHERE "departmentId" IS NULL;

-- 5) Só agora a coluna antiga sai ------------------------------------------

DROP INDEX "tags_departmentId_idx";
DROP INDEX "quick_replies_departmentId_idx";

ALTER TABLE "tags" DROP CONSTRAINT "tags_departmentId_fkey";
ALTER TABLE "quick_replies" DROP CONSTRAINT "quick_replies_departmentId_fkey";

ALTER TABLE "tags" DROP COLUMN "departmentId";
ALTER TABLE "quick_replies" DROP COLUMN "departmentId";

-- Índice parcial: a listagem sempre pergunta "é geral OU é de um destes
-- departamentos", e o ramo do geral é o que varre a tabela toda.
CREATE INDEX "tags_isGeneral_idx" ON "tags"("isGeneral") WHERE "isGeneral" = true;
CREATE INDEX "quick_replies_isGeneral_idx" ON "quick_replies"("isGeneral") WHERE "isGeneral" = true;

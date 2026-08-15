-- Horário permitido de login: em quais dias e faixas quem **não é
-- supervisor** consegue entrar no sistema.
--
-- Tabela filha própria, e não reuso de `attendance_business_hours`, porque
-- as duas faixas respondem perguntas diferentes: o expediente mede o atraso
-- do dashboard, esta aqui decide quem entra. Amarrar as duas obrigaria o
-- escritório a mentir no expediente (esticá-lo até as 19:00) só para liberar
-- quem chega mais cedo, e o número de atraso passaria a mentir junto.
--
-- A restrição nasce **desligada** e a semeadura repete isso: ligada de
-- saída, esta migration trancaria do lado de fora, no meio do dia, quem
-- estivesse trabalhando fora da faixa padrão.

-- AlterTable
ALTER TABLE "attendance_settings"
    ADD COLUMN "loginRestrictionEnabled" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "attendance_login_hours" (
    "id" TEXT NOT NULL,
    "settingsId" TEXT NOT NULL,
    -- 0 = domingo ... 6 = sábado, igual ao expediente.
    "weekday" INTEGER NOT NULL,
    -- Dia desligado é dia sem login nenhum para quem não é supervisor.
    "active" BOOLEAN NOT NULL DEFAULT true,
    -- "HH:MM" no fuso da configuração, mesmo formato do expediente.
    "startTime" TEXT NOT NULL DEFAULT '07:00',
    "endTime" TEXT NOT NULL DEFAULT '19:00',

    CONSTRAINT "attendance_login_hours_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "attendance_login_hours_weekday_check" CHECK ("weekday" BETWEEN 0 AND 6),
    CONSTRAINT "attendance_login_hours_start_format_check" CHECK ("startTime" ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
    CONSTRAINT "attendance_login_hours_end_format_check" CHECK ("endTime" ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$')
);

-- CreateIndex
CREATE UNIQUE INDEX "attendance_login_hours_settingsId_weekday_key" ON "attendance_login_hours"("settingsId", "weekday");

-- AddForeignKey
ALTER TABLE "attendance_login_hours" ADD CONSTRAINT "attendance_login_hours_settingsId_fkey" FOREIGN KEY ("settingsId") REFERENCES "attendance_settings"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Semeia os sete dias de quem já tem configuração: segunda a sexta das
-- 07:00 às 19:00, uma hora de folga de cada lado do expediente padrão.
-- A faixa só passa a valer quando a supervisão ligar `loginRestrictionEnabled`.
INSERT INTO "attendance_login_hours" ("id", "settingsId", "weekday", "active", "startTime", "endTime")
SELECT gen_random_uuid()::text, s."id", d."weekday", d."weekday" BETWEEN 1 AND 5, '07:00', '19:00'
FROM "attendance_settings" s
CROSS JOIN (SELECT generate_series(0, 6) AS "weekday") d;

-- Feriados: dias em que o relógio do atraso para, mesmo caindo num dia da
-- semana que o expediente marca como ativo.
--
-- Sem isto, a mensagem que chegava na véspera de um feriado em dia útil
-- virava "Atrasados agora" no próprio feriado, e o Quality cobrava do
-- atendente a espera de um dia em que ninguém trabalhava.
--
-- Os feriados NACIONAIS não são gravados aqui: eles são calculados no código
-- (`packages/shared/src/holidays.ts`), inclusive os móveis que dependem da
-- Páscoa, e valem para qualquer ano sem ninguém precisar cadastrar o ano
-- seguinte. O banco guarda só as duas chaves e as datas PRÓPRIAS do
-- escritório (feriado estadual, municipal, recesso).
--
-- Nacionais nascem LIGADOS: é o que o escritório pediu, e nenhum feriado
-- nacional é dia de expediente normal. Pontos facultativos (Carnaval e
-- Corpus Christi) nascem desligados: nem todo escritório fecha neles.

-- AlterTable
ALTER TABLE "attendance_settings"
    ADD COLUMN "nationalHolidaysEnabled" BOOLEAN NOT NULL DEFAULT true,
    ADD COLUMN "optionalHolidaysEnabled" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "attendance_holidays" (
    "id" TEXT NOT NULL,
    "settingsId" TEXT NOT NULL,
    -- "AAAA-MM-DD", no fuso da configuração. Texto, e não DATE, pelo mesmo
    -- motivo do "HH:MM" do expediente: é o formato que a tela envia e que o
    -- cálculo consome, sem conversão de fuso no meio do caminho.
    "date" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    -- Repete todo ano no mesmo dia e mês (aniversário da cidade, por exemplo).
    "recurring" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "attendance_holidays_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "attendance_holidays_date_format_check" CHECK ("date" ~ '^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$')
);

-- CreateIndex
CREATE UNIQUE INDEX "attendance_holidays_settingsId_date_key" ON "attendance_holidays"("settingsId", "date");

-- AddForeignKey
ALTER TABLE "attendance_holidays" ADD CONSTRAINT "attendance_holidays_settingsId_fkey" FOREIGN KEY ("settingsId") REFERENCES "attendance_settings"("id") ON DELETE CASCADE ON UPDATE CASCADE;

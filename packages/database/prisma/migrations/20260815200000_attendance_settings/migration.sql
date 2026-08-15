-- Parâmetros de atendimento da organização: limite de resposta (SLA) e
-- expediente. Vivem no banco, e não no código, porque são política do
-- escritório e mudam sem deploy.
--
-- Uma linha por organização. O expediente fica em tabela filha, uma linha
-- por dia da semana, para o escritório poder ligar sábado de manhã sem
-- mexer nos outros dias — faixa única aplicada a todos não permitiria isso.
--
-- A filha aponta para `attendance_settings`, e não para a organização: no
-- dia em que existir parâmetro por departamento, basta uma nova linha de
-- settings apontando para o departamento. Nada aqui impede, e nenhuma
-- coluna de departamento é criada agora.
--
-- Feriado não é tratado nesta entrega: conta como dia normal.

-- CreateTable
CREATE TABLE "attendance_settings" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    -- Minutos sem resposta, contados só dentro do expediente, para o
    -- atendimento entrar como atrasado.
    "responseLimitMinutes" INTEGER NOT NULL DEFAULT 30,
    -- Fuso do escritório: todo corte de data do dashboard usa este, nunca
    -- o UTC do servidor.
    "timezone" TEXT NOT NULL DEFAULT 'America/Sao_Paulo',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "attendance_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "attendance_business_hours" (
    "id" TEXT NOT NULL,
    "settingsId" TEXT NOT NULL,
    -- 0 = domingo ... 6 = sábado: mesma convenção de Date#getDay e de
    -- EXTRACT(DOW) do Postgres, para não existir tradução no meio.
    "weekday" INTEGER NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    -- "HH:MM" no fuso acima. Texto, e não `time`, porque é exatamente o
    -- formato que a tela envia e que o cálculo de tempo útil consome.
    "startTime" TEXT NOT NULL DEFAULT '08:00',
    "endTime" TEXT NOT NULL DEFAULT '18:00',

    CONSTRAINT "attendance_business_hours_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "attendance_business_hours_weekday_check" CHECK ("weekday" BETWEEN 0 AND 6),
    CONSTRAINT "attendance_business_hours_start_format_check" CHECK ("startTime" ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
    CONSTRAINT "attendance_business_hours_end_format_check" CHECK ("endTime" ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$')
);

-- CreateIndex
CREATE UNIQUE INDEX "attendance_settings_organizationId_key" ON "attendance_settings"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "attendance_business_hours_settingsId_weekday_key" ON "attendance_business_hours"("settingsId", "weekday");

-- AddForeignKey
ALTER TABLE "attendance_settings" ADD CONSTRAINT "attendance_settings_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attendance_business_hours" ADD CONSTRAINT "attendance_business_hours_settingsId_fkey" FOREIGN KEY ("settingsId") REFERENCES "attendance_settings"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Semeia as organizações que já existem com os padrões da casa: 30 minutos,
-- America/Sao_Paulo, segunda a sexta das 08:00 às 18:00, sábado e domingo
-- desligados. Sem isso a primeira abertura do dashboard cairia no fallback
-- de `@azvchat/shared` e a tela de Parâmetros abriria sem linha para editar.
INSERT INTO "attendance_settings" ("id", "organizationId", "createdAt", "updatedAt")
SELECT gen_random_uuid()::text, "id", CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "organizations";

INSERT INTO "attendance_business_hours" ("id", "settingsId", "weekday", "active", "startTime", "endTime")
SELECT gen_random_uuid()::text, s."id", d."weekday", d."weekday" BETWEEN 1 AND 5, '08:00', '18:00'
FROM "attendance_settings" s
CROSS JOIN (SELECT generate_series(0, 6) AS "weekday") d;

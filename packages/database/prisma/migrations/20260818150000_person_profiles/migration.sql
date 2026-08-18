-- Identidade da pessoa, única na organização.
--
-- A mesma pessoa participa de vários grupos do mesmo cliente (Geral,
-- Contábil, Fiscal, DP), e o nome dado pela equipe vivia na linha de CADA
-- grupo (`group_participants.customName` / `clientRole`): corrigir exigia
-- repetir grupo a grupo, e na prática ninguém repetia. A partir daqui o que
-- é da PESSOA mora em `person_profiles`, chaveado pelo identificador dela no
-- WhatsApp (`externalId`, que pode ser "@s.whatsapp.net" ou "@lid" — o LID é
-- estável, então também unifica). O que é do GRUPO (participação, isAdmin,
-- foto) continua em `group_participants`.
--
-- LINHA EXISTENTE = a equipe decidiu no nível da pessoa e os valores valem
-- mesmo quando nulos. Linha AUSENTE = vale o legado por grupo, que fica nas
-- colunas antigas de propósito (ver o bloco de backfill abaixo).
CREATE TABLE "person_profiles" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    -- Telefone conhecido (dígitos), copiado da participação. É ponte de
    -- EXIBIÇÃO para a conversa individual quando ela usa outro endereçamento
    -- do mesmo número — nunca chave de fusão de registros.
    "phoneNumber" TEXT,
    "customName" TEXT,
    "clientRole" "ParticipantClientRole",
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "person_profiles_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "person_profiles_organizationId_externalId_key"
    ON "person_profiles"("organizationId", "externalId");
-- A ponte por telefone da conversa individual procura por (org, telefone).
CREATE INDEX "person_profiles_organizationId_phoneNumber_idx"
    ON "person_profiles"("organizationId", "phoneNumber");

ALTER TABLE "person_profiles" ADD CONSTRAINT "person_profiles_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ============================================================
-- Backfill: unifica SÓ quem não tem conflito.
--
-- Para cada pessoa (organização + externalId) que tem algum dado da equipe
-- nos grupos, cria o registro único QUANDO os valores concordam entre os
-- grupos: no máximo um customName distinto E no máximo um clientRole
-- distinto (nulos não contam como divergência). Pessoa com valores
-- DIFERENTES em grupos diferentes fica SEM registro de propósito: escolher
-- um valor aqui apagaria o outro em silêncio, e essa decisão é humana — o
-- relatório de conflitos (packages/database/scripts/
-- relatorio-conflitos-participantes.sql) lista os casos, e a primeira edição
-- pelo lápis resolve a pessoa explicitamente. Enquanto o registro não
-- existe, a exibição cai no valor antigo de cada grupo — nada some.
--
-- As colunas antigas (group_participants."customName" / "clientRole") NÃO
-- são apagadas nesta migration: além de serem o fallback dos conflitados,
-- são o caminho de volta se algo der errado. A limpeza é outro momento.
-- ============================================================
INSERT INTO "person_profiles"
    ("id", "organizationId", "externalId", "phoneNumber", "customName", "clientRole", "createdAt", "updatedAt")
SELECT
    gen_random_uuid()::text,
    g."organizationId",
    p."externalContactId",
    -- Telefone: o maior valor não vazio entre as participações. É só ponte
    -- de exibição; divergência aqui não é conflito de identidade.
    NULLIF(MAX(NULLIF(p."phoneNumber", '')), ''),
    MAX(p."customName"),
    -- MAX de enum não existe; o cast para text preserva o único valor
    -- distinto que o HAVING garante.
    MAX(p."clientRole"::text)::"ParticipantClientRole",
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
FROM "group_participants" p
JOIN "whatsapp_groups" g ON g."id" = p."groupId"
GROUP BY g."organizationId", p."externalContactId"
HAVING
    -- Tem algum dado da equipe para carregar...
    (COUNT(p."customName") > 0 OR COUNT(p."clientRole") > 0)
    -- ...e nenhum campo diverge entre os grupos.
    AND COUNT(DISTINCT p."customName") <= 1
    AND COUNT(DISTINCT p."clientRole") <= 1;

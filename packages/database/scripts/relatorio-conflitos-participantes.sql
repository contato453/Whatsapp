-- ============================================================
-- RELATÓRIO DE CONFLITOS — unificação da identidade de participantes
--
-- Roda ANTES (ou depois, para conferência) da migration
-- 20260818150000_person_profiles. Nada aqui escreve no banco.
--
-- Como rodar na VPS:
--   docker compose -f docker-compose.prod.yml exec -T db \
--     psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
--     -f - < packages/database/scripts/relatorio-conflitos-participantes.sql
-- ============================================================

-- 1) Volumetria: total de participações x pessoas distintas (taxa de repetição)
SELECT
  COUNT(*)                                                        AS participacoes,
  COUNT(DISTINCT (g."organizationId", p."externalContactId"))     AS pessoas_distintas,
  ROUND(COUNT(*)::numeric
    / NULLIF(COUNT(DISTINCT (g."organizationId", p."externalContactId")), 0), 2)
                                                                  AS grupos_por_pessoa
FROM "group_participants" p
JOIN "whatsapp_groups" g ON g."id" = p."groupId";

-- 2) Endereçamento: quantos chegam por @lid x @s.whatsapp.net
SELECT
  CASE
    WHEN p."externalContactId" LIKE '%@lid' THEN '@lid'
    WHEN p."externalContactId" LIKE '%@s.whatsapp.net' THEN '@s.whatsapp.net'
    ELSE 'outro'
  END AS enderecamento,
  COUNT(*) AS participacoes,
  COUNT(DISTINCT p."externalContactId") AS pessoas
FROM "group_participants" p
GROUP BY 1 ORDER BY 2 DESC;

-- 3) CONFLITOS: pessoas com valores DIFERENTES editados em grupos diferentes.
--    Estas ficam FORA do backfill da migration (nenhum valor é perdido):
--    continuam exibindo o valor antigo de cada grupo até alguém editar pelo
--    lápis (a primeira edição vira o valor global) ou até uma decisão em lote.
SELECT
  g."organizationId",
  p."externalContactId"                                   AS pessoa,
  NULLIF(MAX(NULLIF(p."phoneNumber", '')), '')            AS telefone,
  COUNT(*)                                                AS grupos,
  COUNT(DISTINCT p."customName")                          AS nomes_distintos,
  COUNT(DISTINCT p."clientRole")                          AS papeis_distintos,
  -- Cada valor com o grupo onde está e a data da última alteração da linha:
  -- é o que responde "qual valor cada um vai perder" no desempate.
  STRING_AGG(
    format('[%s] nome=%s papel=%s (alterado %s)',
           g."name",
           COALESCE(p."customName", '—'),
           COALESCE(p."clientRole"::text, '—'),
           to_char(p."updatedAt", 'DD/MM/YYYY HH24:MI')),
    E'\n' ORDER BY p."updatedAt" DESC
  )                                                       AS valores_por_grupo
FROM "group_participants" p
JOIN "whatsapp_groups" g ON g."id" = p."groupId"
GROUP BY g."organizationId", p."externalContactId"
HAVING COUNT(DISTINCT p."customName") > 1 OR COUNT(DISTINCT p."clientRole") > 1
ORDER BY COUNT(*) DESC;

-- 4) Contagem total de conflitos (o resumo do bloco 3)
SELECT COUNT(*) AS pessoas_em_conflito FROM (
  SELECT 1
  FROM "group_participants" p
  JOIN "whatsapp_groups" g ON g."id" = p."groupId"
  GROUP BY g."organizationId", p."externalContactId"
  HAVING COUNT(DISTINCT p."customName") > 1 OR COUNT(DISTINCT p."clientRole") > 1
) c;

-- 5) POSSÍVEIS DUPLICATAS POR TELEFONE: o mesmo telefone sob identificadores
--    diferentes (ex.: a pessoa em um grupo por @lid e em outro por
--    @s.whatsapp.net, ou alguém que trocou de número). A migration NÃO funde
--    esses registros — fusão por telefone sem certeza é proibida; a lista
--    existe para decisão humana caso a caso.
SELECT
  g."organizationId",
  p."phoneNumber"                                    AS telefone,
  COUNT(DISTINCT p."externalContactId")              AS identificadores,
  STRING_AGG(DISTINCT p."externalContactId", ', ')   AS quais
FROM "group_participants" p
JOIN "whatsapp_groups" g ON g."id" = p."groupId"
WHERE COALESCE(p."phoneNumber", '') <> ''
GROUP BY g."organizationId", p."phoneNumber"
HAVING COUNT(DISTINCT p."externalContactId") > 1
ORDER BY 3 DESC;

-- 6) Depois da migration: quantas pessoas com dado da equipe ficaram SEM
--    registro unificado (= os conflitos do bloco 3; participante @lid sem
--    telefone unifica normalmente pelo próprio LID, então não entra aqui
--    por ser LID — só se estiver em conflito).
SELECT COUNT(*) AS pessoas_com_dado_sem_unificar FROM (
  SELECT g."organizationId" AS org, p."externalContactId" AS ext
  FROM "group_participants" p
  JOIN "whatsapp_groups" g ON g."id" = p."groupId"
  GROUP BY 1, 2
  HAVING (COUNT(p."customName") > 0 OR COUNT(p."clientRole") > 0)
     AND NOT EXISTS (
       SELECT 1 FROM "person_profiles" pp
       WHERE pp."organizationId" = g."organizationId"
         AND pp."externalId" = p."externalContactId"
     )
) s;

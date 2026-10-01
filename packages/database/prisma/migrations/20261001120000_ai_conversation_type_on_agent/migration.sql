-- O "tipo de conversa" (individual/grupo) sai da automação de IA e vai para o
-- AGENTE (`config.advanced.conversationType`). Na automação, o bloco
-- "Atendimento por IA" dos fluxos não o enxergava, e "a IA não responde
-- grupo" deixava de valer na hora em que a conversa vinha por um fluxo.
--
-- Migração do dado: o agente herda o tipo quando as automações dele concordam
-- num tipo restrito. Contam as ATIVAS; agente sem automação ativa usa todas.
-- Divergência (uma "só individual", outra "qualquer" ou "só grupo") fica
-- "qualquer": somadas, era o que o agente fazia antes, e restringir aqui
-- tiraria atendimento que hoje acontece sem ninguém ter pedido.
WITH base AS (
  SELECT
    "agentId",
    "conversationType",
    "active",
    bool_or("active") OVER (PARTITION BY "agentId") AS tem_ativa
  FROM "ai_automations"
),
tipos AS (
  SELECT "agentId", array_agg(DISTINCT "conversationType") AS t
  FROM base
  WHERE "active" OR NOT tem_ativa
  GROUP BY "agentId"
)
UPDATE "ai_agents" AS a
SET "config" = jsonb_set(
  a."config",
  '{advanced}',
  COALESCE(a."config" -> 'advanced', '{}'::jsonb) || jsonb_build_object('conversationType', tipos.t[1])
)
FROM tipos
WHERE a."id" = tipos."agentId"
  AND array_length(tipos.t, 1) = 1
  AND tipos.t[1] IN ('individual', 'group');

ALTER TABLE "ai_automations" DROP COLUMN "conversationType";

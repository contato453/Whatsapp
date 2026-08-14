-- O WhatsApp passou a identificar participantes de grupo por JIDs "@lid"
-- (identificadores internos anônimos). Versões anteriores gravaram os
-- dígitos desses identificadores como se fossem telefone. Esta migration
-- limpa esses valores; os telefones reais voltam a ser preenchidos pela
-- sincronização de participantes e pelas próximas mensagens.

UPDATE "messages"
SET "senderPhone" = NULL
WHERE "senderExternalId" LIKE '%@lid';

UPDATE "group_participants"
SET "phoneNumber" = ''
WHERE "externalContactId" LIKE '%@lid'
  AND "phoneNumber" = split_part("externalContactId", '@', 1);

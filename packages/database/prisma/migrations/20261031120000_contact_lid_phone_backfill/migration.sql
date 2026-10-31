-- Telefone do `@lid` anotado no `Contact` a partir das mensagens já recebidas.
--
-- O envio pelo telefone digitado (formulário do site, disparo, lembrete) acha a
-- conversa `@lid` da pessoa pelo `Contact` do número conectado. Conversas `@lid`
-- que nasceram antes do `rememberLidPhone` só tinham o telefone nas mensagens,
-- e o envio abria uma segunda conversa para a mesma pessoa. Daqui em diante a
-- ingestão anota o telefone a cada resposta; isto cobre as que já existiam.
--
-- Só mensagem RECEBIDA (na enviada, `senderPhone` é o nosso número) e só
-- telefone com 8 a 15 dígitos, a mesma regra do `cleanPhone`. Contato que já
-- tem telefone não é tocado.
INSERT INTO "contacts" ("id", "organizationId", "whatsappInstanceId", "externalId", "phoneNumber", "createdAt", "updatedAt")
SELECT DISTINCT ON (c."whatsappInstanceId", c."externalChatId")
  gen_random_uuid()::text,
  c."organizationId",
  c."whatsappInstanceId",
  c."externalChatId",
  m."senderPhone",
  NOW(),
  NOW()
FROM "conversations" c
JOIN "messages" m ON m."conversationId" = c."id"
WHERE c."type" = 'individual'
  AND c."externalChatId" LIKE '%@lid'
  AND m."direction" = 'inbound'
  AND m."senderPhone" ~ '^[0-9]{8,15}$'
ORDER BY c."whatsappInstanceId", c."externalChatId", m."timestamp" DESC
ON CONFLICT ("whatsappInstanceId", "externalId") DO UPDATE
  SET "phoneNumber" = EXCLUDED."phoneNumber", "updatedAt" = NOW()
  WHERE "contacts"."phoneNumber" IS NULL;

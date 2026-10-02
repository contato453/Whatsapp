-- Conversa fixada no topo da lista, POR USUÁRIO (como no WhatsApp Web, onde
-- cada conta fixa as suas). Uma linha por (pessoa, conversa): fixar não muda
-- nada para quem não fixou, e uma pessoa não desafixa a conversa da outra.
-- O teto de 3 por pessoa é regra de aplicação (lib/conversation-pins.ts).
CREATE TABLE "conversation_pins" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "pinnedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "conversation_pins_pkey" PRIMARY KEY ("id")
);

-- A consulta da lista: as fixadas de UM usuário — e o par é único.
CREATE UNIQUE INDEX "conversation_pins_userId_conversationId_key"
    ON "conversation_pins"("userId", "conversationId");
-- Caminho inverso: arquivar a conversa desafixa para todo mundo.
CREATE INDEX "conversation_pins_conversationId_idx"
    ON "conversation_pins"("conversationId");

ALTER TABLE "conversation_pins" ADD CONSTRAINT "conversation_pins_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "conversation_pins" ADD CONSTRAINT "conversation_pins_conversationId_fkey"
    FOREIGN KEY ("conversationId") REFERENCES "conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "conversation_pins" ADD CONSTRAINT "conversation_pins_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

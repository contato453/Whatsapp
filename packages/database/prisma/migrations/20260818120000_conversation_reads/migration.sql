-- Leitura por usuário. Guardamos ATÉ ONDE cada pessoa leu (um instante, mais
-- o id da mensagem como referência), e NUNCA um contador por pessoa: contador
-- obrigaria a escrever N linhas a cada mensagem recebida num grupo com N
-- pessoas enxergando, e é justamente o que não escala. O número de não lidas
-- é DERIVADO na consulta: mensagens recebidas depois da marca.
--
-- Ausência de linha significa "nunca leu" — nada é semeado. É por isso que as
-- conversas de hoje, sem linha nenhuma, nascem como não lidas para todo mundo:
-- é o estado seguro (marcar tudo como lido sumiria com aviso de verdade).
CREATE TABLE "conversation_reads" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    -- Instante da última mensagem que a pessoa leu. Só avança sozinho; recuar
    -- é ação explícita ("marcar como não lida").
    "lastReadAt" TIMESTAMP(3) NOT NULL,
    -- Referência da mensagem onde a marca parou. Opcional de propósito: quem
    -- decide a contagem é o instante, e a mensagem pode ser apagada depois.
    "lastReadMessageId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "conversation_reads_pkey" PRIMARY KEY ("id")
);

-- A consulta da lista: a leitura de UM usuário para o conjunto de conversas da
-- página (userId em igualdade, conversationId em IN) — e o par é único.
CREATE UNIQUE INDEX "conversation_reads_userId_conversationId_key"
    ON "conversation_reads"("userId", "conversationId");
-- Caminho inverso, usado pelo filtro "Não lidas".
CREATE INDEX "conversation_reads_conversationId_idx"
    ON "conversation_reads"("conversationId");

ALTER TABLE "conversation_reads" ADD CONSTRAINT "conversation_reads_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "conversation_reads" ADD CONSTRAINT "conversation_reads_conversationId_fkey"
    FOREIGN KEY ("conversationId") REFERENCES "conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "conversation_reads" ADD CONSTRAINT "conversation_reads_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "conversation_reads" ADD CONSTRAINT "conversation_reads_lastReadMessageId_fkey"
    FOREIGN KEY ("lastReadMessageId") REFERENCES "messages"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Contagem de não lidas: por conversa, mensagens RECEBIDAS acima de um
-- instante. O índice atual (conversationId, timestamp) obrigaria a ler
-- também o que a equipe enviou; com a direção na chave, a varredura já
-- começa filtrada.
CREATE INDEX "messages_conversationId_direction_timestamp_idx"
    ON "messages"("conversationId", "direction", "timestamp");

-- A coluna "conversations"."unreadCount" NÃO é removida nesta entrega: ela
-- deixa de ser lida e escrita, mas o dado fica no banco até a leitura por
-- usuário provar que está de pé. A remoção é uma migration futura.

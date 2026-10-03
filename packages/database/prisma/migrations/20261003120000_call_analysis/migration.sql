-- Resumo de ligação: tipo de consumo próprio, nunca somado ao `chat`.
ALTER TYPE "AiUsageKind" ADD VALUE 'call_summary';

-- Transcrição e resumo da gravação de uma ligação (ver o comentário do model).
CREATE TABLE "call_analyses" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "transcript" TEXT,
    "transcriptTruncated" BOOLEAN NOT NULL DEFAULT false,
    "transcriptModel" TEXT,
    "transcribedAt" TIMESTAMP(3),
    "summary" JSONB,
    "summaryModel" TEXT,
    "summarizedAt" TIMESTAMP(3),
    "requestedById" TEXT,
    "requestedByName" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "call_analyses_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "call_analyses_messageId_key" ON "call_analyses"("messageId");
CREATE INDEX "call_analyses_organizationId_idx" ON "call_analyses"("organizationId");

ALTER TABLE "call_analyses" ADD CONSTRAINT "call_analyses_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "call_analyses" ADD CONSTRAINT "call_analyses_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "messages"("id") ON DELETE CASCADE ON UPDATE CASCADE;

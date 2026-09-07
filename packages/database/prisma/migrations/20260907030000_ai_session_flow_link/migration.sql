-- Liga uma sessão de IA à execução de fluxo (construtor de automações) que
-- a abriu, quando ela nasce de um bloco "Atendimento por IA" em vez do
-- gatilho de AiAutomation. Os dois caminhos de início nunca coexistem numa
-- mesma sessão (ver comentário no schema.prisma). SetNull dos dois lados:
-- excluir uma ponta não pode apagar o histórico da outra.
ALTER TABLE "ai_sessions" ADD COLUMN "automationExecutionId" TEXT;
CREATE INDEX "ai_sessions_automationExecutionId_idx" ON "ai_sessions"("automationExecutionId");
ALTER TABLE "ai_sessions" ADD CONSTRAINT "ai_sessions_automationExecutionId_fkey"
    FOREIGN KEY ("automationExecutionId") REFERENCES "automation_executions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- O worker de automações passa a varrer também execuções paradas esperando
-- uma sessão de IA terminar (`waitingReason = 'ai_session'`), mesmo padrão
-- de consulta do polling de timer que já existia.
CREATE INDEX "automation_executions_status_waitingReason_idx" ON "automation_executions"("status", "waitingReason");

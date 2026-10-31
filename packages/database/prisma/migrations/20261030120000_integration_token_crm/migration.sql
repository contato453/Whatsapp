-- Destino no CRM do token de integração: quem chega por este token (ex.: o
-- formulário do site) também vira card no funil. As duas colunas nascem nulas,
-- então todo token existente continua só enviando mensagem, como antes.
ALTER TABLE "integration_tokens" ADD COLUMN "crmPipelineId" TEXT;
ALTER TABLE "integration_tokens" ADD COLUMN "crmStageId" TEXT;

-- SET NULL: funil ou etapa apagados fazem o token voltar a só enviar (ou cair
-- na primeira etapa), em vez de impedir a exclusão ou quebrar o envio.
ALTER TABLE "integration_tokens" ADD CONSTRAINT "integration_tokens_crmPipelineId_fkey" FOREIGN KEY ("crmPipelineId") REFERENCES "crm_pipelines"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "integration_tokens" ADD CONSTRAINT "integration_tokens_crmStageId_fkey" FOREIGN KEY ("crmStageId") REFERENCES "crm_stages"("id") ON DELETE SET NULL ON UPDATE CASCADE;

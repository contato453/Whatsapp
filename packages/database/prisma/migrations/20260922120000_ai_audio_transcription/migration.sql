-- A IA PASSA A OUVIR O ÁUDIO DO CLIENTE.
--
-- Até aqui o áudio recebido chegava ao modelo como o rótulo "[áudio]": a IA
-- respondia sem saber o que o cliente havia dito, e o caso mais comum do
-- WhatsApp — o cliente que grava em vez de escrever — era justamente o que o
-- atendimento por IA não atendia. Agora o áudio é transcrito antes do turno
-- (apps/api/src/services/ai/transcription.ts) e entra como texto; a
-- transcrição é guardada no `metadata` da própria mensagem, então cada áudio
-- é transcrito UMA vez e a equipe vê na bolha exatamente o que a IA ouviu.
--
-- Nenhuma tabela nova: a transcrição é do áudio, e áudio é `Message`. Guardá-la
-- em tabela própria criaria uma segunda verdade sobre o conteúdo da mensagem,
-- que é o que `metadata` já resolve (mesmo desenho do MP3 do download e do
-- histórico de versões).

-- Transcrever é chamada PAGA ao provedor, cobrada por minuto de áudio: entra
-- no consumo como tipo próprio, e não misturada no "Atendimento", senão o
-- custo por turno de chat deixaria de fechar e ninguém saberia quanto o áudio
-- custou.
ALTER TYPE "AiUsageKind" ADD VALUE 'transcription';

-- Interruptor do escritório, ligado por padrão (é o comportamento útil;
-- desligado, a IA volta a não ouvir e avisa o cliente para escrever). Existe
-- porque o custo é por minuto: quem administra precisa poder cortá-lo de uma
-- vez, sem editar agente por agente.
ALTER TABLE "ai_settings" ADD COLUMN "transcribeAudio" BOOLEAN NOT NULL DEFAULT true;

-- Modelo que transcreve. Nulo = o padrão do sistema. Coluna separada do
-- modelo de chat de propósito: são catálogos diferentes, e modelo de chat não
-- transcreve.
ALTER TABLE "ai_settings" ADD COLUMN "transcriptionModel" TEXT;

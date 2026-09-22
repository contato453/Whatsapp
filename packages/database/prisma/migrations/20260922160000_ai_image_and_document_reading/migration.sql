-- A IA PASSA A VER IMAGEM E A LER DOCUMENTO.
--
-- O áudio já virava texto antes do turno (migration
-- 20260922120000_ai_audio_transcription). Faltavam os outros dois anexos que o
-- cliente manda todo dia: a FOTO (comprovante, print de erro, documento
-- fotografado) e o ARQUIVO (PDF do contrato, DOCX, TXT). Os dois chegavam ao
-- modelo como o rótulo "[imagem]"/"[documento]", então a IA respondia sem saber
-- o que tinha recebido.
--
-- Agora, antes do turno: a imagem é DESCRITA por um modelo de visão (o mesmo
-- modelo de chat do agente, que já enxerga imagem) e o documento tem o texto
-- EXTRAÍDO aqui dentro, pelo mesmo extrator da base de conhecimento
-- (pdf-parse/mammoth/texto puro). O resultado fica no `metadata` da própria
-- mensagem, como a transcrição do áudio — cada anexo é lido UMA vez, e a equipe
-- vê na bolha o que a IA entendeu.

-- Ler imagem é chamada PAGA (token de visão) e entra no consumo como tipo
-- próprio: misturá-la no "Atendimento" faria o custo por turno de chat deixar de
-- fechar, o mesmo defeito que a separação da transcrição já evitou. Documento
-- NÃO ganha tipo porque não gera chamada nenhuma — é leitura local.
ALTER TYPE "AiUsageKind" ADD VALUE 'vision';

-- Interruptor do escritório para a leitura de imagem, ligado por padrão (é o
-- comportamento útil). Existe pelo mesmo motivo do áudio: o custo é por chamada,
-- e quem administra precisa poder cortá-lo de uma vez, sem editar agente por
-- agente. Documento não tem coluna: sem custo, sem interruptor — a capacidade
-- do agente basta.
ALTER TABLE "ai_settings" ADD COLUMN "describeImages" BOOLEAN NOT NULL DEFAULT true;

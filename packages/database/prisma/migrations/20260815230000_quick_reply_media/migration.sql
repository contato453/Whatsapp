-- Resposta rápida com mídia anexada (imagem, áudio ou vídeo).
--
-- O texto padrão muitas vezes acompanha um material pronto — o vídeo
-- explicativo do MEI, um áudio de orientação, o print de um procedimento.
-- Sem o anexo, o arquivo fica solto no computador de cada atendente e o
-- padrão se perde. `mediaUrl` é a chave no armazenamento de mídia, o mesmo
-- esquema da mensagem: o arquivo nunca sai por URL pública.

ALTER TABLE "quick_replies" ADD COLUMN "mediaUrl" TEXT;
ALTER TABLE "quick_replies" ADD COLUMN "mediaMimeType" TEXT;
ALTER TABLE "quick_replies" ADD COLUMN "mediaFilename" TEXT;

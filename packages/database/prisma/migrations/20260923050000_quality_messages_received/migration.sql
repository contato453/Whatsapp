-- QUALITY: mensagens RECEBIDAS ao lado das enviadas no diagnóstico.
--
-- O painel já mostrava quantas mensagens o atendente mandou no período, e esse
-- número sozinho não diz nada: 43 envios podem ser um cliente difícil com muita
-- pergunta ou um atendente que escreve demais. A contrapartida é o volume que
-- CHEGOU, e é ela que dá escala ao resto.
--
-- Mensagem de entrada não tem autor do nosso lado, então o valor é o mesmo para
-- todos os atendentes avaliados naquela conversa — de propósito: ele mede a
-- conversa, não a pessoa. Mesma leitura do `received` do relatório por
-- atendente no Dashboard.
--
-- `DEFAULT 0` e não nulo: avaliação antiga não tem como saber quantas chegaram,
-- e zero é o que a tela já sabe mostrar. Ligação não conta, aqui como no resto
-- do sistema.
ALTER TABLE "quality_evaluations"
  ADD COLUMN "messagesReceived" INTEGER NOT NULL DEFAULT 0;

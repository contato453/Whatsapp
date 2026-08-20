-- Departamento INTERNO: as conversas dele não entram nos números.
--
-- Os grupos internos da equipe (avisos, coordenação, TI) viviam contados
-- junto do atendimento a cliente. O estrago maior era no card "Atrasados
-- agora": a última mensagem de um grupo interno é sempre "de entrada" aos
-- olhos do sistema, ninguém "responde" a ela, e a conversa acumulava atraso
-- para sempre — o número do painel media conversa interna, não cliente
-- esperando.
--
-- A marca fica no DEPARTAMENTO, e não na conversa: o escritório pensa em
-- "os departamentos internos", e uma caixa por conversa exigiria repetir
-- grupo a grupo (o mesmo motivo que tirou o nome do participante da linha
-- do grupo). Como o recorte é feito por junção, e não por marca copiada na
-- conversa, ligar já vale para os grupos que existem e desligar devolve
-- tudo — sem backfill e sem varredura.
--
-- NÃO É ARQUIVAMENTO, e o padrão é `false` de propósito: a conversa
-- continua na lista, continua contando não lidas, tocando o som e piscando
-- o título da aba. Só a CONTAGEM muda. Nada aqui encosta em visibilidade.
ALTER TABLE "departments" ADD COLUMN "isInternal" BOOLEAN NOT NULL DEFAULT false;

-- A pergunta que o sistema faz o tempo todo é "quais departamentos são
-- internos?", e a resposta é um punhado de linhas dentro da organização.
CREATE INDEX "departments_organizationId_isInternal_idx"
    ON "departments"("organizationId", "isInternal");

-- DISTRIBUIR AO ENTRAR NUMA ETAPA.
--
-- O gatilho "ao entrar na etapa" já existia e já disparava etiqueta,
-- responsável fixo, departamento, atividade, nota interna e follow-up. O que
-- faltava era a DISTRIBUIÇÃO automática (rodízio, menor carga) amarrada a esse
-- gatilho: até aqui ela só acontecia na criação da oportunidade.
--
-- É o fluxo que o escritório descreve: o lead entra sem dono, alguém qualifica,
-- e é ao chegar em "Qualificado" que ele deve cair na fila dos vendedores — e
-- não no primeiro contato, quando ainda não se sabe se é oportunidade.
ALTER TYPE "CrmStageActionType" ADD VALUE 'auto_assign';

-- Regra desta ação. Nulo = usa a regra configurada no funil, para o caso comum
-- (uma regra só, aplicada onde o escritório mandar). Coluna própria, e não o
-- `content` reaproveitado: assim o banco recusa valor inventado e a tela monta
-- o seletor a partir do mesmo enum.
ALTER TABLE "crm_stage_actions" ADD COLUMN "assignmentMode" "CrmAssignmentMode";

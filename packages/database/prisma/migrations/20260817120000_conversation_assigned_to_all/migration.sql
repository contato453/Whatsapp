-- Atribuição coletiva ("@todos"): a conversa aparece para todo o departamento
-- em vez de ficar com uma pessoa. Continua com `assignedUserId` NULO de
-- propósito — a visibilidade sai da regra que já existe (o atendente enxerga o
-- que é dele MAIS o que está sem responsável), então nada em lib/access.ts
-- muda e não existe usuário fictício "@todos" no banco. A coluna só distingue
-- o coletivo POR DECISÃO da conversa órfã esperando alguém pegar.
ALTER TABLE "conversations"
  ADD COLUMN "assignedToAll" BOOLEAN NOT NULL DEFAULT false;

-- Marcação e responsável nunca coexistem, e isso é garantido no banco, não só
-- na tela: um caminho de atribuição que esquecesse de desligar a marcação
-- deixaria a conversa "coletiva com dono" — estado que nenhuma contagem de
-- "sem responsável" sabe ler, e que só apareceria como número errado meses
-- depois.
ALTER TABLE "conversations"
  ADD CONSTRAINT "conversations_assigned_to_all_without_user"
  CHECK (NOT ("assignedToAll" AND "assignedUserId" IS NOT NULL));

-- Histórico legível: entrar e sair do coletivo têm ação própria. Reaproveitar
-- `assigned`/`unassigned` faria o painel dizer "assumiu o atendimento" para
-- uma marcação que justamente não tem dono.
ALTER TYPE "AssignmentAction" ADD VALUE 'assigned_to_all';
ALTER TYPE "AssignmentAction" ADD VALUE 'unassigned_from_all';

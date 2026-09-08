-- Quando um fluxo de automação (e, do lado da IA, um agente — em
-- AiAgent.config, JSON, sem migration) pode agir, em relação ao MESMO
-- expediente de AttendanceSettings. "outside_business_hours" cobre o caso
-- real: um fluxo/agente de plantão noturno ou de fim de semana, enquanto de
-- dia quem atende é outro fluxo ou a própria equipe.
CREATE TYPE "AutomationScheduleMode" AS ENUM ('always', 'business_hours', 'outside_business_hours');

-- Padrão "always" preserva o comportamento de todo fluxo já publicado —
-- ninguém que não pedir essa restrição é afetado pela migration.
ALTER TABLE "automation_flows" ADD COLUMN "scheduleMode" "AutomationScheduleMode" NOT NULL DEFAULT 'always';

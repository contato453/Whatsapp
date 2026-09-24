-- Departamento DONO do fluxo de automação. Governa quem VÊ e quem EDITA a
-- configuração, nunca se o fluxo roda (o motor escolhe sem usuário logado).
--
-- Nenhum fluxo existente é classificado aqui: todos ficam como GERAL (nulo)
-- e a tela avisa quantos estão sem classificação, para a equipe decidir.
-- Adivinhar o departamento pelo número ou pelo nome gravaria uma decisão de
-- acesso que ninguém tomou.
ALTER TABLE "automation_flows" ADD COLUMN "departmentId" TEXT;

-- Excluir o departamento devolve o fluxo a geral, em vez de apagá-lo ou
-- quebrar a tela: ele volta ao aviso de não classificados.
ALTER TABLE "automation_flows"
  ADD CONSTRAINT "automation_flows_departmentId_fkey"
  FOREIGN KEY ("departmentId") REFERENCES "departments"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- A listagem recorta por departamento e por número, dentro da organização.
CREATE INDEX "automation_flows_organizationId_departmentId_idx"
  ON "automation_flows"("organizationId", "departmentId");
CREATE INDEX "automation_flows_organizationId_whatsappInstanceId_idx"
  ON "automation_flows"("organizationId", "whatsappInstanceId");

-- Menu de Permissões: o que cada perfil PODE FAZER passa a ser configuração
-- do escritório, e não linha de código. Hoje o limite de Usuário e Supervisor
-- está escrito em `requireRole()`, e mudar a política da operação exige
-- alteração e deploy — decisão que é do dono do escritório, não do
-- desenvolvedor.
--
-- Uma linha por par (papel, ação), e SÓ para o que difere do catálogo:
-- ausência de linha significa o padrão de PERMISSION_ACTIONS
-- (@azvchat/shared). Semear as ~25 ações por papel em cada organização
-- congelaria os padrões no banco: mudar um padrão no código deixaria de
-- valer para quem já existe, e o catálogo perderia o sentido de ser a
-- fonte única.
--
-- `action` é TEXTO, e não enum: ação removida do código não exige migration,
-- e a linha órfã que sobra é ignorada em silêncio pela leitura — em vez de
-- quebrar a tela de Permissões.
--
-- PERMISSÃO É AÇÃO, VISIBILIDADE É ALCANCE. Nada nesta tabela decide QUAIS
-- conversas alguém enxerga: isso continua saindo inteiro de lib/access.ts,
-- pelos vínculos de número (user_whatsapp_instances) e de departamento
-- (user_departments). Nenhuma chave aqui amplia o recorte de ninguém.

-- CreateTable
CREATE TABLE "role_permissions" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "role" "UserRole" NOT NULL,
    -- Nome técnico da ação no catálogo de @azvchat/shared.
    "action" TEXT NOT NULL,
    "allowed" BOOLEAN NOT NULL,
    -- Quem mudou por último: a tela mostra nome e data ao lado da chave que
    -- está diferente do padrão. É o registro mais sensível do sistema.
    "updatedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "role_permissions_pkey" PRIMARY KEY ("id"),
    -- Administrador não é configurável e não tem chave: ele passa por cima de
    -- tudo. Sem esta trava, desligar as chaves de admin trancaria a
    -- organização do lado de fora sem ninguém para religar.
    CONSTRAINT "role_permissions_role_not_admin" CHECK ("role" <> 'admin'),
    CONSTRAINT "role_permissions_action_not_blank" CHECK (length(btrim("action")) > 0)
);

-- CreateIndex
CREATE UNIQUE INDEX "role_permissions_organizationId_role_action_key" ON "role_permissions"("organizationId", "role", "action");

-- CreateIndex
CREATE INDEX "role_permissions_organizationId_idx" ON "role_permissions"("organizationId");

-- AddForeignKey
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_updatedById_fkey" FOREIGN KEY ("updatedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

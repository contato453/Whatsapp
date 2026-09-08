import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { authenticate, requireRole } from "../../lib/auth.js";
import { NotFoundError } from "../../lib/errors.js";
import {
  invalidateOrganizationFeatures,
  loadOrganizationFeatures,
} from "../../lib/organization-features.js";
import type { AppDeps } from "../../types.js";

/**
 * Os MÓDULOS do escritório: hoje, ligar e desligar o CRM (Kanban).
 *
 * POR QUE NÃO É UMA CHAVE DE PERMISSÃO: permissão diz o que cada PERFIL pode
 * fazer com um recurso que existe; isto diz se o recurso existe. Uma chave
 * "usar o CRM" por papel deixaria metade da equipe com o menu e a outra
 * metade sem — isso é configuração, não é desligar o módulo. Por isso a
 * gravação é fixa em `admin`, como excluir número e excluir departamento:
 * quem desliga o módulo mexe no sistema do escritório inteiro.
 *
 * DESLIGAR NUNCA APAGA NADA. Funis, oportunidades, atividades e histórico
 * continuam no banco; o que muda é a porta. Religar devolve tudo como estava
 * — e é por isso que não existe confirmação destrutiva aqui.
 */
export async function organizationRoutes(app: FastifyInstance, deps: AppDeps): Promise<void> {
  /**
   * Leitura liberada para qualquer sessão: é ela que diz à TELA se o menu do
   * CRM aparece. Esconder o estado do módulo de quem não é admin faria o menu
   * ficar visível para o atendente depois de o dono desligar.
   */
  app.get("/organization/features", { preHandler: authenticate }, async (request) => {
    const features = await loadOrganizationFeatures(deps.prisma, request.user.organizationId);
    return { features };
  });

  app.patch(
    "/organization/features",
    { preHandler: requireRole("admin") },
    async (request) => {
      const body = z.object({ crm: z.boolean() }).parse(request.body);
      const organization = await deps.prisma.organization.findUnique({
        where: { id: request.user.organizationId },
        select: { id: true, crmEnabled: true },
      });
      if (!organization) throw new NotFoundError("Organização");

      const desligando = organization.crmEnabled && !body.crm;
      let followUpsCancelados = 0;

      if (desligando) {
        /**
         * DESLIGAR O CRM PARA OS FOLLOW-UPS PENDENTES.
         *
         * Sem isto, o escritório desligaria o Kanban e o agendador continuaria
         * mandando "conseguiu ver a proposta?" para os clientes nos dias
         * seguintes — mensagens de um módulo que ninguém mais enxerga, e que
         * ninguém teria como cancelar, porque a tela sumiu junto. Falha
         * silenciosa do pior tipo: o efeito aparece no celular do cliente.
         *
         * O filtro é `crmOpportunityId`, então só o que o CRM agendou é
         * alcançado: compromisso que uma PESSOA marcou pelo composer continua
         * de pé, porque ele foi combinado com o cliente e não depende do
         * módulo.
         */
        const resultado = await deps.prisma.scheduledMessage.updateMany({
          where: {
            organizationId: request.user.organizationId,
            crmOpportunityId: { not: null },
            status: "pending",
          },
          data: { status: "canceled" },
        });
        followUpsCancelados = resultado.count;
      }

      await deps.prisma.organization.update({
        where: { id: organization.id },
        data: { crmEnabled: body.crm },
      });
      // A mudança vale na ação seguinte, sem esperar o TTL do cache nem
      // reiniciar o container — o mesmo desenho das permissões.
      invalidateOrganizationFeatures(organization.id);

      deps.audit.record({
        organizationId: request.user.organizationId,
        userId: request.user.sub,
        action: body.crm ? "organization.crm_enabled" : "organization.crm_disabled",
        entityType: "Organization",
        entityId: organization.id,
        metadata: { followUpsCancelados },
      });
      deps.logger.info({
        event: body.crm ? "crm_module_enabled" : "crm_module_disabled",
        organizationId: organization.id,
        followUpsCancelados,
      });

      return {
        features: await loadOrganizationFeatures(deps.prisma, organization.id),
        // A tela avisa quantos compromissos automáticos foram desmarcados: o
        // número é a diferença entre "desliguei o menu" e "parei de mandar
        // mensagem para cliente".
        followUpsCancelados,
      };
    },
  );

  /**
   * Quantos follow-ups o desligamento cancelaria AGORA — a tela pergunta antes
   * de mostrar a confirmação, para o aviso trazer número em vez de "alguns".
   */
  app.get(
    "/organization/features/crm-impact",
    { preHandler: requireRole("admin") },
    async (request) => {
      const pendingFollowUps = await deps.prisma.scheduledMessage.count({
        where: {
          organizationId: request.user.organizationId,
          crmOpportunityId: { not: null },
          status: "pending",
        },
      });
      const openOpportunities = await deps.prisma.crmOpportunity.count({
        where: { organizationId: request.user.organizationId, status: "open" },
      });
      return { pendingFollowUps, openOpportunities };
    },
  );
}

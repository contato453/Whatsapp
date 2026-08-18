import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { AZEVEDO_OS_SOURCE, azevedoOsSearchIsValid } from "@azvchat/shared";
import { authenticate, requireRole } from "../../lib/auth.js";
import { findAccessibleConversation } from "../../lib/conversation-access.js";
import type { AppDeps } from "../../types.js";
import { loadCompanyFacets } from "../../lib/azevedo-os-company-filter.js";
import { AzevedoOsError } from "../../services/azevedo-os-client.js";
import { serializeAzevedoOsCompany, serializeAzevedoOsFacets } from "./serialize.js";

/**
 * Ponte do AZVCHAT com o Azevedo-OS. O frontend nunca fala com o Azevedo-OS:
 * ele chama estas rotas, que falam com o client (onde mora o token).
 *
 * Toda rota daqui parte de uma conversa e valida o acesso a ela por
 * `access.ts`. Não existe consulta ao cadastro empresarial "solta": a
 * pesquisa também exige a conversa que vai receber o vínculo, senão a
 * integração viraria um diretório de empresas aberto a quem tem login.
 */

const SEARCH_LIMIT = 20;

export async function integrationRoutes(app: FastifyInstance, deps: AppDeps): Promise<void> {
  /**
   * Empresa vinculada à conversa. Papel mínimo `agent` — ver o cliente com
   * quem se está falando é justamente o objetivo do card.
   *
   * Conversa sem vínculo (ou com o código de cadastro manual) responde
   * `company: null`, e não erro: "nenhuma empresa vinculada" é estado
   * normal, não falha.
   */
  app.get(
    "/conversations/:id/external-company",
    { preHandler: authenticate },
    async (request) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
      const conversation = await findAccessibleConversation(deps.prisma, request.user, id);
      if (conversation.externalSource !== AZEVEDO_OS_SOURCE || !conversation.externalReference) {
        return { company: null };
      }
      const company = await deps.azevedoOs.getCompany(conversation.externalReference);
      return { company: serializeAzevedoOsCompany(company, deps.azevedoOs.companyWebUrl(company.id)) };
    },
  );

  /**
   * Pesquisa de empresas para o modal de vinculação. Supervisor para cima
   * (mesma régua de quem pode gravar o vínculo) E com acesso à conversa:
   * o supervisor pesquisa enquanto vincula, nunca por curiosidade.
   *
   * Termo curto devolve lista vazia em vez de erro — o modal ainda está no
   * estado inicial, e um 400 a cada tecla seria ruído.
   */
  app.get(
    "/integrations/azevedo-os/companies",
    { preHandler: requireRole("supervisor") },
    async (request) => {
      const query = z
        .object({
          conversationId: z.string().uuid(),
          search: z.string().trim().min(1).max(120),
        })
        .parse(request.query);
      await findAccessibleConversation(deps.prisma, request.user, query.conversationId);
      if (!azevedoOsSearchIsValid(query.search)) return { companies: [] };

      const companies = await deps.azevedoOs.searchCompanies(query.search.trim(), SEARCH_LIMIT);
      return {
        companies: companies.map((company) =>
          serializeAzevedoOsCompany(company, deps.azevedoOs.companyWebUrl(company.id)),
        ),
      };
    },
  );

  /**
   * Valores possíveis de regime tributário e folha, para os dois seletores
   * da Inbox. Papel mínimo `agent`: quem atende é quem filtra.
   *
   * Esta é a única rota da integração que **não** parte de uma conversa, e
   * pode ser: ela não devolve empresa nenhuma, só os valores dos dois campos
   * com o rótulo escrito no Azevedo-OS. Exigir uma conversa aqui seria
   * formalidade sem proteção, e ainda quebraria o seletor, que precisa estar
   * pronto antes de qualquer conversa ser aberta.
   *
   * Falha nunca vira erro HTTP: a Inbox tem que abrir com o Azevedo-OS fora
   * do ar. `facets: null` com `unavailable: false` é integração desligada (a
   * tela simplesmente não desenha os seletores); com `unavailable: true` é
   * portal mudo (a tela desenha e avisa que estão indisponíveis).
   */
  app.get(
    "/integrations/azevedo-os/company-facets",
    { preHandler: authenticate },
    async () => {
      if (!deps.azevedoOs.enabled) return { facets: null, unavailable: false };
      try {
        return { facets: serializeAzevedoOsFacets(await loadCompanyFacets(deps.azevedoOs)), unavailable: false };
      } catch (err) {
        if (!(err instanceof AzevedoOsError)) throw err;
        return { facets: null, unavailable: true };
      }
    },
  );
}

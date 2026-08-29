import type {
  AzevedoOsCompany,
  AzevedoOsCompanyDto,
  AzevedoOsFacetsDto,
  AzevedoOsFieldFacets,
} from "@azvchat/shared";
import type { IntegrationToken } from "@azvchat/database";
import type { AzevedoOsCompanyFacets } from "../../services/azevedo-os-client.js";

/** DTO do token de integração para a tela de administração. */
export interface IntegrationTokenDto {
  id: string;
  name: string;
  /** Prefixo visível — o token em claro NUNCA sai daqui depois da criação. */
  tokenPrefix: string;
  whatsappInstanceId: string;
  /** Nome do número autorizado, quando ele ainda existe. */
  instanceName: string | null;
  active: boolean;
  lastUsedAt: string | null;
  usageCount: number;
  createdAt: string;
}

/**
 * Serializa o token para a tela. NUNCA inclui `tokenHash` — o segredo (e o
 * hash dele) fica no banco e só o valor em claro, mostrado uma vez na criação,
 * volta pela rota de criação.
 */
export function serializeIntegrationToken(
  token: IntegrationToken & { instance?: { name: string } | null },
): IntegrationTokenDto {
  return {
    id: token.id,
    name: token.name,
    tokenPrefix: token.tokenPrefix,
    whatsappInstanceId: token.whatsappInstanceId,
    instanceName: token.instance?.name ?? null,
    active: token.active,
    lastUsedAt: token.lastUsedAt ? token.lastUsedAt.toISOString() : null,
    usageCount: token.usageCount,
    createdAt: token.createdAt.toISOString(),
  };
}

/**
 * DTO da empresa do Azevedo-OS.
 *
 * A empresa não é entidade do Prisma daqui, mas a regra da casa vale igual:
 * a resposta é montada campo a campo, nunca repassando o objeto recebido de
 * fora. Assim, campo novo (ou inesperado) do Azevedo-OS não atravessa a API
 * até o navegador sem alguém decidir que ele deve aparecer.
 *
 * `webUrl` é decidido no servidor porque depende de `AZEVEDO_OS_WEB_URL`,
 * configuração que o frontend não conhece — e vem nulo quando o endereço
 * real do Azevedo-OS não foi configurado.
 */
export function serializeAzevedoOsCompany(
  company: AzevedoOsCompany,
  webUrl: string | null,
): AzevedoOsCompanyDto {
  return {
    id: company.id,
    companyNumber: company.companyNumber,
    legalName: company.legalName,
    tradeName: company.tradeName,
    cnpj: company.cnpj,
    status: company.status,
    statusLabel: company.statusLabel,
    taxRegime: company.taxRegime,
    payrollInfo: company.payrollInfo,
    contacts: company.contacts.map((contact) => ({
      name: contact.name,
      role: contact.role,
      phone: contact.phone,
      email: contact.email,
    })),
    webUrl,
  };
}

/**
 * DTO das facetas que alimentam os dois seletores da Inbox.
 *
 * **A contagem do Azevedo-OS não atravessa.** Ele manda quantas empresas há
 * em cada valor, e é útil — mas do lado de cá o número seria lido como
 * quantidade de conversas, e "Simples (191)" ao lado de uma lista com doze
 * linhas faria a equipe achar que o filtro está quebrado. A contagem é usada
 * aqui mesmo, e só para uma decisão: oferecer ou não o "Sem informação".
 */
export function serializeAzevedoOsFacets(facets: AzevedoOsCompanyFacets): AzevedoOsFacetsDto {
  const field = (raw: AzevedoOsCompanyFacets["taxRegime"]): AzevedoOsFieldFacets => ({
    options: raw.options.map((option) => ({ value: option.value, label: option.label })),
    hasNone: raw.noneCount > 0,
  });
  return { taxRegime: field(facets.taxRegime), payroll: field(facets.payroll) };
}

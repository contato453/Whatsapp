import type { AzevedoOsCompany, AzevedoOsCompanyDto } from "@azvchat/shared";

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

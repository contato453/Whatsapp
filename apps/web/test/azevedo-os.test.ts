import { describe, expect, it } from "vitest";
import {
  azevedoOsCompanyDisplayName,
  azevedoOsSearchIsValid,
  defaultPermission,
  permissionActionDefinition,
  normalizeAzevedoOsStatus,
  type AzevedoOsCompany,
} from "@azvchat/shared";
import { azevedoOsErrorMessage, azevedoOsStatusDotClass } from "@/lib/azevedo-os";

/**
 * As decisões do card de cliente que não dependem de React. O frontend não
 * tem biblioteca de teste de UI, e esta entrega não introduz uma — então o
 * que precisa de garantia mora em função pura e é testado aqui.
 */

function empresa(overrides: Partial<AzevedoOsCompany> = {}): AzevedoOsCompany {
  return {
    id: "empresa-1",
    companyNumber: "000123",
    legalName: "Azevedo Comércio Ltda",
    tradeName: "Azevedo Comércio",
    cnpj: "00.000.000/0001-00",
    status: "active",
    statusLabel: "Ativo",
    taxRegime: "Imune/Isenta",
    payrollInfo: "Só Pró-labore",
    contacts: [],
    ...overrides,
  };
}

describe("nome exibido da empresa", () => {
  it("nome fantasia em destaque, razão social como referência", () => {
    expect(azevedoOsCompanyDisplayName(empresa())).toEqual({
      primary: "Azevedo Comércio",
      secondary: "Azevedo Comércio Ltda",
    });
  });

  it("sem fantasia, a razão social sobe e não se repete embaixo", () => {
    expect(azevedoOsCompanyDisplayName(empresa({ tradeName: null }))).toEqual({
      primary: "Azevedo Comércio Ltda",
      secondary: null,
    });
  });

  it("fantasia igual à razão social não vira duas linhas iguais", () => {
    const nome = azevedoOsCompanyDisplayName(
      empresa({ tradeName: "Azevedo Comércio Ltda", legalName: "Azevedo Comércio Ltda" }),
    );
    expect(nome).toEqual({ primary: "Azevedo Comércio Ltda", secondary: null });
  });

  it("empresa sem nome nenhum cai no número, e nunca fica em branco", () => {
    expect(
      azevedoOsCompanyDisplayName(empresa({ tradeName: null, legalName: null })).primary,
    ).toBe("Empresa nº 000123");
    expect(
      azevedoOsCompanyDisplayName(
        empresa({ tradeName: null, legalName: null, companyNumber: null }),
      ).primary,
    ).toBe("Empresa");
  });
});

describe("status da empresa", () => {
  it("traduz os conhecidos, em português e em inglês", () => {
    expect(normalizeAzevedoOsStatus("active")).toEqual({ tone: "active", label: "Ativo" });
    expect(normalizeAzevedoOsStatus("ATIVA")).toEqual({ tone: "active", label: "Ativo" });
    expect(normalizeAzevedoOsStatus("suspenso")).toEqual({ tone: "inactive", label: "Suspenso" });
  });

  it("status desconhecido aparece como veio, em tom neutro — não some do card", () => {
    expect(normalizeAzevedoOsStatus("em análise")).toEqual({
      tone: "neutral",
      label: "Em análise",
    });
  });

  it("sem status não há linha de status", () => {
    expect(normalizeAzevedoOsStatus(null)).toBeNull();
    expect(normalizeAzevedoOsStatus("   ")).toBeNull();
    // Rótulo sem código não é status: a tela não teria como classificá-lo.
    expect(normalizeAzevedoOsStatus(null, "Ativo")).toBeNull();
  });

  /**
   * O rótulo é do Azevedo-OS; a cor é daqui. Um segundo dicionário de status
   * deste lado já divergiu uma vez — `onboarding` chegou, a tabela local não
   * conhecia, e o card escreveu "Onboarding" num painel em português.
   */
  it("o rótulo do Azevedo-OS vence o da tabela local", () => {
    expect(normalizeAzevedoOsStatus("active", "Ativo desde 2019")).toEqual({
      tone: "active",
      label: "Ativo desde 2019",
    });
  });

  it("status que a tabela local não conhece usa o rótulo da origem, sem inglês vazando", () => {
    expect(normalizeAzevedoOsStatus("em_homologacao", "Em homologação")).toEqual({
      tone: "neutral",
      label: "Em homologação",
    });
  });

  it("empresa em implantação não vira 'Onboarding' nem quando o rótulo falta", () => {
    expect(normalizeAzevedoOsStatus("onboarding")).toEqual({
      tone: "neutral",
      label: "Implantação",
    });
    expect(normalizeAzevedoOsStatus("onboarding", "Implantação")).toEqual({
      tone: "neutral",
      label: "Implantação",
    });
  });

  it("cliente desativado no Azevedo-OS aparece em tom de saída", () => {
    expect(normalizeAzevedoOsStatus("inactive", "Desativado")).toEqual({
      tone: "inactive",
      label: "Desativado",
    });
  });

  it("cada tom tem a sua cor de ponto", () => {
    expect(azevedoOsStatusDotClass("active")).toContain("emerald");
    expect(azevedoOsStatusDotClass("inactive")).toContain("rose");
    expect(azevedoOsStatusDotClass("neutral")).toContain("slate");
  });
});

describe("busca no modal", () => {
  it("uma letra não dispara consulta; duas já servem", () => {
    expect(azevedoOsSearchIsValid("a")).toBe(false);
    expect(azevedoOsSearchIsValid("  a  ")).toBe(false);
    expect(azevedoOsSearchIsValid("az")).toBe(true);
  });

  it("busca exata por número da empresa e por CNPJ continua valendo", () => {
    expect(azevedoOsSearchIsValid("000123")).toBe(true);
    expect(azevedoOsSearchIsValid("00.000.000/0001-00")).toBe(true);
  });
});

describe("mensagens de falha do card", () => {
  it("Azevedo-OS fora do ar avisa no card — e só no card", () => {
    expect(azevedoOsErrorMessage("azevedo_os_unavailable")).toBe(
      "Azevedo-OS temporariamente indisponível.",
    );
    expect(azevedoOsErrorMessage("azevedo_os_timeout")).toBe(
      "Azevedo-OS temporariamente indisponível.",
    );
    // 401 do Azevedo-OS é problema de configuração da casa: para quem atende
    // é indisponibilidade, e nada nesse texto revela credencial.
    expect(azevedoOsErrorMessage("azevedo_os_unauthorized")).toBe(
      "Azevedo-OS temporariamente indisponível.",
    );
    expect(azevedoOsErrorMessage(undefined)).toBe("Azevedo-OS temporariamente indisponível.");
  });

  it("empresa apagada lá e integração não configurada têm texto próprio", () => {
    expect(azevedoOsErrorMessage("azevedo_os_company_not_found")).toContain("não encontrada");
    expect(azevedoOsErrorMessage("azevedo_os_disabled")).toContain("não configurada");
  });

  /**
   * Item C da correção do incidente de 03/09/2026: quem atende só precisa
   * saber que não é problema dele; quem administra precisa do nome da
   * variável, senão vai abrir o `.env` para adivinhar.
   */
  it("integração não configurada: mensagem genérica para quem atende", () => {
    const texto = azevedoOsErrorMessage("azevedo_os_disabled", {
      isAdmin: false,
      details: { missingVars: ["AZEVEDO_OS_API_URL", "AZEVEDO_OS_API_TOKEN"] },
    });
    expect(texto).toContain("não configurada");
    expect(texto).not.toContain("AZEVEDO_OS_API_URL");
    expect(texto.toLowerCase()).toContain("administrador");
  });

  it("integração não configurada: admin vê o nome da variável que falta", () => {
    const texto = azevedoOsErrorMessage("azevedo_os_disabled", {
      isAdmin: true,
      details: { missingVars: ["AZEVEDO_OS_API_TOKEN"] },
    });
    expect(texto).toContain("AZEVEDO_OS_API_TOKEN");
  });

  it("admin sem `missingVars` no corpo (outro tipo de erro) cai na mensagem genérica", () => {
    const texto = azevedoOsErrorMessage("azevedo_os_disabled", {
      isAdmin: true,
      details: { outraCoisa: 1 },
    });
    expect(texto).not.toContain("AZEVEDO_OS");
  });
});

/**
 * Os botões do card seguem DUAS chaves do catálogo, e não uma régua de
 * papel: preencher conversa vazia é rotina de quem atende, trocar vínculo
 * já feito por outra pessoa é o que anexa a conversa ao cliente errado.
 */
describe("botões de vínculo na tela", () => {
  it("vincular e trocar são chaves separadas, com padrões diferentes", () => {
    // Preencher conversa VAZIA é rotina de quem atende: padrão sim/sim.
    expect(defaultPermission("azevedo_os.link", "agent")).toBe(true);
    expect(defaultPermission("azevedo_os.link", "supervisor")).toBe(true);
    // Trocar vínculo já feito por outra pessoa é o que anexa a conversa ao
    // cliente errado: padrão não/sim.
    expect(defaultPermission("azevedo_os.relink", "agent")).toBe(false);
    expect(defaultPermission("azevedo_os.relink", "supervisor")).toBe(true);
  });

  it("as duas chaves existem no catálogo, com rótulo e explicação", () => {
    for (const chave of ["azevedo_os.link", "azevedo_os.relink"] as const) {
      const definicao = permissionActionDefinition(chave);
      expect(definicao).not.toBeNull();
      expect(definicao?.area).toBe("atendimento");
    }
  });
});

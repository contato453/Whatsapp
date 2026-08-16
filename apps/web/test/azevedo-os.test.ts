import { describe, expect, it } from "vitest";
import {
  azevedoOsCompanyDisplayName,
  azevedoOsSearchIsValid,
  canManageAzevedoOsLink,
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
});

describe("botões de vínculo na tela", () => {
  it("só supervisor e admin veem vincular, trocar e desvincular", () => {
    expect(canManageAzevedoOsLink("admin")).toBe(true);
    expect(canManageAzevedoOsLink("supervisor")).toBe(true);
    expect(canManageAzevedoOsLink("agent")).toBe(false);
  });
});

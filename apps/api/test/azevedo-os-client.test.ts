import { describe, expect, it, vi } from "vitest";
import type { Logger } from "pino";
import {
  AzevedoOsError,
  createAzevedoOsClient,
  type AzevedoOsClientOptions,
} from "../src/services/azevedo-os-client.js";

/**
 * O que estes testes fixam:
 *
 * 1. o token sai no cabeçalho e em lugar nenhum mais — nem em erro, nem no
 *    objeto devolvido ao resto do sistema;
 * 2. toda falha do Azevedo-OS (401, 404, 500, timeout, resposta estranha)
 *    vira `AzevedoOsError`, que a rota transforma em erro do card. Nada
 *    disso pode escapar como exceção crua e derrubar a requisição da Inbox;
 * 3. o contrato é lido com tolerância: campo ausente vira `null`, e o card
 *    esconde o item em vez de quebrar.
 */

const TOKEN = "token-secreto-do-azevedo-os";
const BASE = "https://azevedo-os.exemplo/integracao";

function silentLogger(): Logger {
  return { warn: vi.fn(), info: vi.fn(), error: vi.fn(), child: vi.fn() } as unknown as Logger;
}

function build(
  fetchImpl: typeof fetch,
  overrides: Partial<AzevedoOsClientOptions> = {},
) {
  return createAzevedoOsClient({
    baseUrl: BASE,
    token: TOKEN,
    timeoutMs: 5000,
    logger: silentLogger(),
    fetchImpl,
    ...overrides,
  });
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const EMPRESA = {
  id: "11111111-1111-4111-8111-111111111111",
  companyNumber: "000123",
  legalName: "Azevedo Comércio Ltda",
  tradeName: "Azevedo Comércio",
  cnpj: "00.000.000/0001-00",
  status: "active",
  taxRegime: "Imune/Isenta",
  payrollInfo: "Só Pró-labore",
  contacts: [{ name: "Lincoln Azevedo", type: "Sócio", phone: null, email: null }],
};

describe("client do Azevedo-OS — autenticação servidor-a-servidor", () => {
  it("manda o token como Bearer e não o repete em nenhum outro lugar", async () => {
    const fetchSpy = vi.fn(async () => jsonResponse(EMPRESA));
    const client = build(fetchSpy as unknown as typeof fetch);

    const company = await client.getCompany(EMPRESA.id);

    const [url, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`${BASE}/companies/${EMPRESA.id}`);
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${TOKEN}`);
    // O DTO que segue para a rota (e daí para o navegador) não carrega segredo.
    expect(JSON.stringify(company)).not.toContain(TOKEN);
  });

  it("sem URL ou sem token a integração fica desligada e nem tenta a chamada", async () => {
    const fetchSpy = vi.fn(async () => jsonResponse(EMPRESA));
    const semToken = build(fetchSpy as unknown as typeof fetch, { token: null });

    expect(semToken.enabled).toBe(false);
    await expect(semToken.getCompany(EMPRESA.id)).rejects.toMatchObject({
      failure: "disabled",
      statusCode: 503,
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("client do Azevedo-OS — falhas nunca derrubam a Inbox", () => {
  const casos: Array<[number, string, number]> = [
    [401, "unauthorized", 502],
    [403, "unauthorized", 502],
    [404, "not_found", 404],
    [500, "unavailable", 502],
  ];

  for (const [status, failure, esperado] of casos) {
    it(`${status} do Azevedo-OS vira ${failure} (HTTP ${esperado} do AZVCHAT)`, async () => {
      const client = build((async () =>
        jsonResponse({ message: `Bearer ${TOKEN} rejeitado` }, status)) as unknown as typeof fetch);

      const erro = await client.getCompany(EMPRESA.id).catch((err: unknown) => err);

      expect(erro).toBeInstanceOf(AzevedoOsError);
      expect(erro).toMatchObject({ failure, statusCode: esperado });
      // O corpo do erro externo pode ecoar o cabeçalho enviado: nada dele
      // atravessa para a mensagem que o AZVCHAT devolve.
      expect((erro as Error).message).not.toContain(TOKEN);
    });
  }

  it("timeout vira 504, sem exceção crua", async () => {
    const client = build((async () => {
      const err = new Error("The operation was aborted due to timeout");
      err.name = "TimeoutError";
      throw err;
    }) as unknown as typeof fetch);

    await expect(client.getCompany(EMPRESA.id)).rejects.toMatchObject({
      failure: "timeout",
      statusCode: 504,
    });
  });

  it("rede fora do ar vira indisponibilidade", async () => {
    const client = build((async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch);

    await expect(client.getCompany(EMPRESA.id)).rejects.toMatchObject({ failure: "unavailable" });
  });

  it("resposta sem `id` não vira empresa fantasma", async () => {
    const client = build((async () => jsonResponse({ nome: "sem id" })) as unknown as typeof fetch);

    await expect(client.getCompany(EMPRESA.id)).rejects.toMatchObject({
      failure: "invalid_response",
    });
  });
});

describe("client do Azevedo-OS — leitura do contrato", () => {
  it("traz os campos do card: número, CNPJ, status, regime, folha e contatos", async () => {
    const client = build((async () => jsonResponse({ data: EMPRESA })) as unknown as typeof fetch);

    const company = await client.getCompany(EMPRESA.id);

    expect(company).toMatchObject({
      id: EMPRESA.id,
      companyNumber: "000123",
      legalName: "Azevedo Comércio Ltda",
      tradeName: "Azevedo Comércio",
      cnpj: "00.000.000/0001-00",
      status: "active",
      taxRegime: "Imune/Isenta",
      payrollInfo: "Só Pró-labore",
    });
    expect(company.contacts).toEqual([
      { name: "Lincoln Azevedo", role: "Sócio", phone: null, email: null },
    ]);
  });

  it("aceita snake_case: rename do outro lado não esvazia o card", async () => {
    const client = build((async () =>
      jsonResponse({
        id: 42,
        company_number: "000999",
        razao_social: "Empresa Teste Ltda",
        regime_tributario: "Simples Nacional",
        folha_pagamento: "Com folha",
        contatos: [{ nome: "Ana", cargo: "Administrativo" }],
      })) as unknown as typeof fetch);

    const company = await client.getCompany("42");

    expect(company.id).toBe("42");
    expect(company.companyNumber).toBe("000999");
    expect(company.legalName).toBe("Empresa Teste Ltda");
    expect(company.taxRegime).toBe("Simples Nacional");
    expect(company.payrollInfo).toBe("Com folha");
    expect(company.contacts).toEqual([
      { name: "Ana", role: "Administrativo", phone: null, email: null },
    ]);
  });

  it("campo ausente vira null (o card esconde o item, não quebra)", async () => {
    const client = build((async () =>
      jsonResponse({ id: "só-o-id" })) as unknown as typeof fetch);

    const company = await client.getCompany("só-o-id");

    expect(company).toEqual({
      id: "só-o-id",
      companyNumber: null,
      legalName: null,
      tradeName: null,
      cnpj: null,
      status: null,
      statusLabel: null,
      taxRegime: null,
      payrollInfo: null,
      contacts: [],
    });
  });

  /**
   * O Azevedo-OS manda `status` (código, para comparar) e `statusLabel`
   * (rótulo em português, para exibir). Descartar o segundo obrigaria o
   * AZVCHAT a manter o próprio dicionário — e ele já divergiu: `onboarding`
   * chegava, a tabela local não conhecia a chave, e o card escrevia
   * "Onboarding" num painel em português em vez de "Implantação".
   */
  it("lê o rótulo do status ao lado do código", async () => {
    const client = build((async () =>
      jsonResponse({
        id: "empresa-implantacao",
        status: "onboarding",
        statusLabel: "Implantação",
      })) as unknown as typeof fetch);

    const company = await client.getCompany("empresa-implantacao");

    expect(company.status).toBe("onboarding");
    expect(company.statusLabel).toBe("Implantação");
  });

  it("busca aceita lista crua ou envelopada e respeita o limite", async () => {
    const nuas = build((async () =>
      jsonResponse([EMPRESA, { id: "b" }, { id: "c" }])) as unknown as typeof fetch);
    expect(await nuas.searchCompanies("azevedo", 2)).toHaveLength(2);

    const envelopadas = build((async () =>
      jsonResponse({ companies: [EMPRESA] })) as unknown as typeof fetch);
    expect((await envelopadas.searchCompanies("azevedo", 20))[0]?.id).toBe(EMPRESA.id);
  });

  it("o termo da busca vai na query, escapado", async () => {
    const fetchSpy = vi.fn(async () => jsonResponse([]));
    await build(fetchSpy as unknown as typeof fetch).searchCompanies("comércio & cia", 20);

    const [url] = fetchSpy.mock.calls[0] as unknown as [string];
    expect(url).toContain("search=com%C3%A9rcio+%26+cia");
  });
});

describe("client do Azevedo-OS — link de abertura", () => {
  it("sem endereço configurado não inventa link", () => {
    expect(build((async () => jsonResponse({})) as unknown as typeof fetch).companyWebUrl("x")).toBeNull();
  });

  it("usa o endereço real configurado, com o id no lugar de {id}", () => {
    const client = build((async () => jsonResponse({})) as unknown as typeof fetch, {
      webUrlTemplate: "https://gestao.exemplo/empresas/{id}",
    });
    expect(client.companyWebUrl("abc 1")).toBe("https://gestao.exemplo/empresas/abc%201");
  });
});

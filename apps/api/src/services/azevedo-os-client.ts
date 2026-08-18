import { z } from "zod";
import type { Logger } from "pino";
import type { AzevedoOsCompany, AzevedoOsContact } from "@azvchat/shared";
import { AppError } from "../lib/errors.js";

/**
 * Único ponto do AZVCHAT que fala com o Azevedo-OS.
 *
 * A comunicação é servidor-a-servidor: o token vive só aqui, e nenhuma rota
 * monta `fetch` para o Azevedo-OS por conta própria — do contrário, o
 * cabeçalho de autenticação apareceria em cinco lugares e um deles acabaria
 * vazando o segredo em log ou em resposta.
 *
 * Duas garantias que valem mais que a integração em si:
 *
 * 1. **O AZVCHAT não depende do Azevedo-OS para funcionar.** Toda falha vira
 *    `AzevedoOsError`, que a rota transforma em erro do card — a Inbox, as
 *    mensagens e o atendimento seguem inteiros.
 * 2. **O contrato externo pode mudar sem derrubar nada.** A resposta é
 *    validada com Zod só no que é indispensável (a empresa precisa ter um
 *    `id`), e cada campo é lido por uma lista de nomes aceitos. Campo que
 *    sumiu vira `null` e some do card.
 */

/** Motivo da falha — a rota decide o HTTP e a tela decide o texto. */
export type AzevedoOsFailure =
  | "disabled"
  | "unauthorized"
  | "not_found"
  | "timeout"
  | "unavailable"
  | "invalid_response";

const FAILURES: Record<AzevedoOsFailure, { status: number; code: string; message: string }> = {
  disabled: {
    status: 503,
    code: "azevedo_os_disabled",
    message: "Integração com o Azevedo-OS não configurada.",
  },
  // 401 do Azevedo-OS é problema de configuração da casa, não do usuário:
  // devolver 401 aqui derrubaria a sessão de quem está atendendo.
  unauthorized: {
    status: 502,
    code: "azevedo_os_unauthorized",
    message: "Não foi possível consultar o Azevedo-OS.",
  },
  not_found: {
    status: 404,
    code: "azevedo_os_company_not_found",
    message: "Empresa não encontrada no Azevedo-OS.",
  },
  timeout: {
    status: 504,
    code: "azevedo_os_timeout",
    message: "O Azevedo-OS não respondeu a tempo.",
  },
  unavailable: {
    status: 502,
    code: "azevedo_os_unavailable",
    message: "Não foi possível consultar o Azevedo-OS.",
  },
  invalid_response: {
    status: 502,
    code: "azevedo_os_unavailable",
    message: "Não foi possível consultar o Azevedo-OS.",
  },
};

/**
 * Erro da integração. A mensagem é sempre uma das fixas acima — nada do
 * corpo da resposta externa é repassado, porque resposta de erro de API
 * costuma ecoar o cabeçalho enviado, e o cabeçalho carrega o token.
 */
export class AzevedoOsError extends AppError {
  constructor(public readonly failure: AzevedoOsFailure) {
    const { status, code, message } = FAILURES[failure];
    super(message, status, code);
    this.name = "AzevedoOsError";
  }
}

/**
 * Só o `id` é obrigatório: sem ele não há vínculo possível. Número inteiro
 * também serve — há sistema que devolve id numérico —, e vira string aqui
 * para o resto do AZVCHAT tratar o ponteiro sempre do mesmo jeito.
 */
const idSchema = z.union([z.string(), z.number()]).transform((value) => String(value).trim());
const rawCompanySchema = z.object({ id: idSchema.refine((value) => value.length > 0) }).passthrough();
const rawListSchema = z.union([
  z.array(rawCompanySchema),
  z.object({ data: z.array(rawCompanySchema) }),
  z.object({ companies: z.array(rawCompanySchema) }),
  z.object({ results: z.array(rawCompanySchema) }),
]);
const rawSingleSchema = z.union([
  rawCompanySchema,
  z.object({ data: rawCompanySchema }),
  z.object({ company: rawCompanySchema }),
]);

type RawCompany = z.infer<typeof rawCompanySchema>;

/**
 * Nomes aceitos para cada campo, do mais provável para o menos. O contrato
 * publicado é camelCase; snake_case e os nomes em português entram porque
 * a mesma informação costuma trocar de roupa entre a API e o banco de
 * origem, e um rename lá não pode esvaziar o card aqui.
 */
const FIELD_ALIASES = {
  companyNumber: ["companyNumber", "company_number", "numero", "numeroEmpresa"],
  legalName: ["legalName", "legal_name", "razaoSocial", "razao_social"],
  tradeName: ["tradeName", "trade_name", "nomeFantasia", "nome_fantasia"],
  cnpj: ["cnpj", "document", "documento"],
  status: ["status", "situacao"],
  // O Azevedo-OS manda o rótulo pronto ao lado do código, de propósito, para
  // não existir um segundo dicionário de status deste lado do muro.
  statusLabel: ["statusLabel", "status_label", "situacaoRotulo"],
  taxRegime: ["taxRegime", "tax_regime", "regimeTributario", "regime_tributario"],
  payrollInfo: ["payrollInfo", "payroll_info", "folhaPagamento", "folha_pagamento"],
  contacts: ["contacts", "contatos"],
} as const;

const CONTACT_ALIASES = {
  name: ["name", "nome"],
  role: ["type", "role", "tipo", "cargo", "funcao"],
  phone: ["phone", "telefone", "celular"],
  email: ["email", "e-mail"],
} as const;

/** Texto útil ou nada: string vazia e espaço em branco viram `null`. */
function readText(raw: Record<string, unknown>, keys: readonly string[]): string | null {
  for (const key of keys) {
    const value = raw[key];
    if (typeof value === "string" && value.trim().length > 0) return value.trim();
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
  }
  return null;
}

function readContacts(raw: Record<string, unknown>): AzevedoOsContact[] {
  for (const key of FIELD_ALIASES.contacts) {
    const value = raw[key];
    if (!Array.isArray(value)) continue;
    return value
      .filter((item): item is Record<string, unknown> => typeof item === "object" && item !== null)
      .map((item) => ({
        name: readText(item, CONTACT_ALIASES.name) ?? "",
        role: readText(item, CONTACT_ALIASES.role),
        phone: readText(item, CONTACT_ALIASES.phone),
        email: readText(item, CONTACT_ALIASES.email),
      }))
      // Contato sem nome não diz nada a quem atende e ainda ocupa uma linha.
      .filter((contact) => contact.name.length > 0);
  }
  return [];
}

/* --------------------------------------------------------------- *
 * Filtros por característica do cliente (regime tributário e folha)
 * --------------------------------------------------------------- */

/**
 * Os dois endpoints que servem os filtros da Inbox. Eles existem porque o
 * recorte é de CONVERSAS, que só existem no banco do AZVCHAT, enquanto o
 * regime e a folha só existem no do Azevedo-OS: sem uma consulta capaz de
 * cruzar os dois bancos, o caminho é pedir a lista de identificadores das
 * empresas que batem com o critério e recortar as conversas por ela.
 *
 * Perceba o que NÃO se pede: a empresa inteira. Só os ids atravessam, porque
 * é só disso que o recorte precisa, e mandar o cadastro completo arrastaria
 * junto campo que não pode sair de lá.
 */

/** Uma opção com a contagem crua do Azevedo-OS (a contagem não sai da API). */
const facetOptionSchema = z.object({
  value: z.string().trim().min(1),
  label: z.string().trim().min(1).optional(),
  count: z.number().optional(),
});

const facetFieldSchema = z.object({
  options: z.array(facetOptionSchema).default([]),
  noneCount: z.number().optional(),
});

const rawFacetsSchema = z.union([
  z.object({ taxRegime: facetFieldSchema, payroll: facetFieldSchema }),
  z.object({ data: z.object({ taxRegime: facetFieldSchema, payroll: facetFieldSchema }) }),
]);

/** A lista de ids aceita as três formas que o contrato pode tomar. */
const rawIdsSchema = z.union([
  z.array(z.string()),
  z.object({ data: z.array(z.string()), truncated: z.boolean().optional() }),
  z.object({ ids: z.array(z.string()), truncated: z.boolean().optional() }),
]);

export interface AzevedoOsFacetField {
  options: Array<{ value: string; label: string }>;
  /** Quantas empresas estão com o campo em branco. Decide o "Sem informação". */
  noneCount: number;
}

export interface AzevedoOsCompanyFacets {
  taxRegime: AzevedoOsFacetField;
  payroll: AzevedoOsFacetField;
}

export interface AzevedoOsCompanyIds {
  ids: string[];
  /**
   * O Azevedo-OS teve mais empresas do que o teto dele e cortou a lista.
   * Não pode ser engolido: recorte truncado mostraria menos conversas do que
   * existem parecendo estar funcionando, que é o pior defeito possível aqui.
   */
  truncated: boolean;
}

/**
 * Critério do recorte. Pelo menos um dos dois vem preenchido, e cada um
 * aceita VÁRIOS valores: o filtro da Inbox é multisseleção, e os valores
 * marcados somam entre si. O Azevedo-OS recebe a lista separada por vírgula,
 * que é o formato que o endpoint de lá já aceita.
 */
export interface AzevedoOsCompanyCriteria {
  taxRegime?: string[];
  payroll?: string[];
}

/**
 * Rótulo de reserva quando o Azevedo-OS não mandar o dele: a chave do enum
 * fica legível, e nunca fica em branco. Não é dicionário de tradução, é rede
 * de proteção — quem nomeia o vocabulário continua sendo o dono do cadastro.
 */
function fallbackLabel(value: string): string {
  const texto = value.replace(/_/g, " ").trim();
  return texto.charAt(0).toUpperCase() + texto.slice(1);
}

function normalizeFacetField(raw: z.infer<typeof facetFieldSchema>): AzevedoOsFacetField {
  return {
    options: raw.options.map((option) => ({
      value: option.value.trim(),
      label: option.label?.trim() || fallbackLabel(option.value.trim()),
    })),
    noneCount: typeof raw.noneCount === "number" && raw.noneCount > 0 ? raw.noneCount : 0,
  };
}

export function normalizeCompany(raw: RawCompany): AzevedoOsCompany {
  const record = raw as Record<string, unknown>;
  return {
    id: raw.id,
    companyNumber: readText(record, FIELD_ALIASES.companyNumber),
    legalName: readText(record, FIELD_ALIASES.legalName),
    tradeName: readText(record, FIELD_ALIASES.tradeName),
    cnpj: readText(record, FIELD_ALIASES.cnpj),
    status: readText(record, FIELD_ALIASES.status),
    statusLabel: readText(record, FIELD_ALIASES.statusLabel),
    taxRegime: readText(record, FIELD_ALIASES.taxRegime),
    payrollInfo: readText(record, FIELD_ALIASES.payrollInfo),
    contacts: readContacts(record),
  };
}

export interface AzevedoOsClient {
  /** Falso quando falta URL ou token: a tela avisa em vez de tentar. */
  readonly enabled: boolean;
  searchCompanies(term: string, limit: number): Promise<AzevedoOsCompany[]>;
  getCompany(id: string): Promise<AzevedoOsCompany>;
  /** Valores possíveis de regime e folha, para montar os seletores. */
  companyFacets(): Promise<AzevedoOsCompanyFacets>;
  /** Ids das empresas que batem com o critério — só os ids. */
  companyIds(criteria: AzevedoOsCompanyCriteria): Promise<AzevedoOsCompanyIds>;
  /** Endereço da empresa no Azevedo-OS; `null` quando não configurado. */
  companyWebUrl(id: string): string | null;
}

export interface AzevedoOsClientOptions {
  baseUrl?: string | null;
  token?: string | null;
  /** Modelo da URL da empresa na web, com `{id}` onde entra o identificador. */
  webUrlTemplate?: string | null;
  timeoutMs: number;
  logger: Logger;
  /** Injetado nos testes; em produção é o `fetch` global do Node. */
  fetchImpl?: typeof fetch;
}

export function createAzevedoOsClient(options: AzevedoOsClientOptions): AzevedoOsClient {
  const baseUrl = options.baseUrl?.trim().replace(/\/+$/, "") ?? "";
  const token = options.token?.trim() ?? "";
  const enabled = baseUrl.length > 0 && token.length > 0;
  const fetchImpl = options.fetchImpl ?? fetch;
  const logger = options.logger;

  async function call(path: string): Promise<unknown> {
    if (!enabled) throw new AzevedoOsError("disabled");
    let response: Response;
    try {
      response = await fetchImpl(`${baseUrl}${path}`, {
        headers: {
          // O token só existe nesta linha. Nunca vai para log, para o banco
          // nem para qualquer resposta do AZVCHAT.
          Authorization: `Bearer ${token}`,
          Accept: "application/json",
        },
        // Timeout curto e explícito: a Inbox não pode ficar pendurada
        // esperando um sistema externo que caiu.
        signal: AbortSignal.timeout(options.timeoutMs),
      });
    } catch (err) {
      const timedOut = err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
      logger.warn({ event: "azevedo_os_request_failed", path, timedOut }, "azevedo_os_request_failed");
      throw new AzevedoOsError(timedOut ? "timeout" : "unavailable");
    }

    if (!response.ok) {
      logger.warn({ event: "azevedo_os_response_error", path, status: response.status });
      if (response.status === 401 || response.status === 403) {
        throw new AzevedoOsError("unauthorized");
      }
      if (response.status === 404) throw new AzevedoOsError("not_found");
      throw new AzevedoOsError("unavailable");
    }

    try {
      return await response.json();
    } catch {
      logger.warn({ event: "azevedo_os_invalid_json", path });
      throw new AzevedoOsError("invalid_response");
    }
  }

  return {
    enabled,

    async searchCompanies(term, limit) {
      const params = new URLSearchParams({ search: term, limit: String(limit) });
      const payload = await call(`/companies?${params.toString()}`);
      const parsed = rawListSchema.safeParse(payload);
      if (!parsed.success) {
        logger.warn({ event: "azevedo_os_unexpected_payload", path: "/companies" });
        throw new AzevedoOsError("invalid_response");
      }
      const list = Array.isArray(parsed.data)
        ? parsed.data
        : "data" in parsed.data
          ? parsed.data.data
          : "companies" in parsed.data
            ? parsed.data.companies
            : parsed.data.results;
      return list.slice(0, limit).map(normalizeCompany);
    },

    async getCompany(id) {
      const payload = await call(`/companies/${encodeURIComponent(id)}`);
      const parsed = rawSingleSchema.safeParse(payload);
      if (!parsed.success) {
        logger.warn({ event: "azevedo_os_unexpected_payload", path: "/companies/:id" });
        throw new AzevedoOsError("invalid_response");
      }
      const company =
        "id" in parsed.data
          ? parsed.data
          : "data" in parsed.data
            ? parsed.data.data
            : parsed.data.company;
      return normalizeCompany(company);
    },

    async companyFacets() {
      const payload = await call("/company-facets");
      const parsed = rawFacetsSchema.safeParse(payload);
      if (!parsed.success) {
        logger.warn({ event: "azevedo_os_unexpected_payload", path: "/company-facets" });
        throw new AzevedoOsError("invalid_response");
      }
      const data = "data" in parsed.data ? parsed.data.data : parsed.data;
      return {
        taxRegime: normalizeFacetField(data.taxRegime),
        payroll: normalizeFacetField(data.payroll),
      };
    },

    async companyIds(criteria) {
      const params = new URLSearchParams();
      if (criteria.taxRegime?.length) params.set("taxRegime", criteria.taxRegime.join(","));
      if (criteria.payroll?.length) params.set("payroll", criteria.payroll.join(","));
      // Chamar sem critério nenhum pediria a base inteira, e o Azevedo-OS
      // recusa com 400. Barrar aqui evita gastar a viagem para descobrir isso.
      if ([...params.keys()].length === 0) return { ids: [], truncated: false };

      const payload = await call(`/company-ids?${params.toString()}`);
      const parsed = rawIdsSchema.safeParse(payload);
      if (!parsed.success) {
        logger.warn({ event: "azevedo_os_unexpected_payload", path: "/company-ids" });
        throw new AzevedoOsError("invalid_response");
      }
      if (Array.isArray(parsed.data)) return { ids: parsed.data, truncated: false };
      const ids = "data" in parsed.data ? parsed.data.data : parsed.data.ids;
      return { ids, truncated: parsed.data.truncated === true };
    },

    companyWebUrl(id) {
      const template = options.webUrlTemplate?.trim();
      // Sem o endereço real configurado não há link: botão que abre uma URL
      // inventada é pior do que botão nenhum.
      if (!template) return null;
      return template.replace("{id}", encodeURIComponent(id));
    },
  };
}

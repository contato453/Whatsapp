import type { Prisma } from "@azvchat/database";
import { AZEVEDO_OS_SOURCE } from "@azvchat/shared";
import type {
  AzevedoOsClient,
  AzevedoOsCompanyCriteria,
  AzevedoOsCompanyFacets,
  AzevedoOsCompanyIds,
} from "../services/azevedo-os-client.js";

/**
 * Recorte da Inbox por característica do cliente (regime tributário e folha
 * de pagamento), que moram no Azevedo-OS.
 *
 * **Por que pedir a lista de empresas ao portal em vez de cruzar os bancos.**
 * A conversa só existe no banco do AZVCHAT e o cadastro empresarial só existe
 * no do Azevedo-OS: são dois Postgres separados, e de propósito — amarrar os
 * dois esquemas faria migration de um quebrar o outro. Não existe, portanto,
 * consulta única capaz de responder "conversas de clientes do Simples". O que
 * existe é decompor a pergunta: o portal responde QUAIS EMPRESAS batem com o
 * critério (ele é o dono desse dado), e o AZVCHAT recorta as conversas pela
 * lista de identificadores que voltou. Uma viagem por consulta, não uma por
 * conversa.
 *
 * **Por que o cache é curto.** Ele existe só para a mesma pergunta não sair
 * de novo a cada tecla e a cada recarga automática da lista. Regime tributário
 * muda (empresa migra de Simples para Presumido na virada do ano) e a Inbox
 * tem que acompanhar no mesmo dia: cache longo transformaria o filtro num
 * retrato velho que ninguém sabe que está velho. Segundos resolvem a rajada;
 * minutos já começariam a mentir.
 */

/** Vida do recorte: cobre a rajada de digitação, não o dia de trabalho. */
const IDS_TTL_MS = 60_000;

/**
 * As facetas podem viver um pouco mais: são o domínio dos dois enums, que
 * muda quando alguém altera o cadastro do Azevedo-OS, não quando uma empresa
 * troca de regime.
 */
const FACETS_TTL_MS = 300_000;

/**
 * Teto de ids que aceitamos colocar numa consulta. O Azevedo-OS já corta em
 * 5000 e avisa com `truncated`, e 5000 uuids num `IN` ficam muito abaixo do
 * limite de parâmetros do Postgres — então não há lote a fazer aqui, e
 * inventar um só criaria caminho que nunca roda e nunca é testado. O que não
 * pode acontecer é a lista vir cortada em silêncio: por isso o corte vira
 * aviso na tela, e não uma lista curta com cara de completa.
 */
const MAX_IDS = 5_000;

/** Cache de vida curta, com relógio injetável para o teste não dormir. */
export class TtlCache<T> {
  private readonly entries = new Map<string, { value: T; expiresAt: number }>();

  constructor(
    private readonly ttlMs: number,
    private readonly now: () => number = () => Date.now(),
  ) {}

  get(key: string): T | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= this.now()) {
      this.entries.delete(key);
      return undefined;
    }
    return entry.value;
  }

  set(key: string, value: T): void {
    this.entries.set(key, { value, expiresAt: this.now() + this.ttlMs });
  }

  clear(): void {
    this.entries.clear();
  }
}

const idsCache = new TtlCache<AzevedoOsCompanyIds>(IDS_TTL_MS);
const facetsCache = new TtlCache<AzevedoOsCompanyFacets>(FACETS_TTL_MS);

/** Só os testes chamam: o processo real nunca precisa esquecer de propósito. */
export function clearAzevedoOsFilterCache(): void {
  idsCache.clear();
  facetsCache.clear();
}

export function criteriaCacheKey(criteria: AzevedoOsCompanyCriteria): string {
  return `${criteria.taxRegime ?? ""}|${criteria.payroll ?? ""}`;
}

export async function resolveCompanyIds(
  client: AzevedoOsClient,
  criteria: AzevedoOsCompanyCriteria,
  cache: TtlCache<AzevedoOsCompanyIds> = idsCache,
): Promise<AzevedoOsCompanyIds> {
  const key = criteriaCacheKey(criteria);
  const cached = cache.get(key);
  if (cached) return cached;
  const result = await client.companyIds(criteria);
  const resolved: AzevedoOsCompanyIds = {
    ids: result.ids.slice(0, MAX_IDS),
    truncated: result.truncated || result.ids.length > MAX_IDS,
  };
  cache.set(key, resolved);
  return resolved;
}

export async function loadCompanyFacets(
  client: AzevedoOsClient,
  cache: TtlCache<AzevedoOsCompanyFacets> = facetsCache,
): Promise<AzevedoOsCompanyFacets> {
  const cached = cache.get("facets");
  if (cached) return cached;
  const facets = await client.companyFacets();
  cache.set("facets", facets);
  return facets;
}

/**
 * Recorte pelas empresas que bateram. Vale só para conversa vinculada ao
 * Azevedo-OS: o mesmo `externalReference` também guarda o código de cadastro
 * digitado à mão ("EMPRESA 001"), e sem conferir a fonte um código manual
 * igual a um id de empresa entraria no filtro por coincidência.
 */
export function companyReferenceWhere(ids: string[]): Prisma.ConversationWhereInput {
  return { externalSource: AZEVEDO_OS_SOURCE, externalReference: { in: ids } };
}

/**
 * Conversa SEM empresa vinculada: nunca vinculada, vinculada a outra fonte
 * (o código manual) ou com a referência apagada. É o complemento exato de
 * `companyReferenceWhere`, e serve a duas coisas: contar quantas ficaram de
 * fora quando o filtro está ativo, e ser o atalho que a equipe usa para ir
 * vinculando o que falta.
 *
 * O `OR` é explícito, com o `null` listado à parte, porque `not` sozinho não
 * casa linha nula no Postgres — e conversa sem fonte nenhuma é justamente o
 * caso mais comum aqui.
 */
export function unlinkedCompanyWhere(): Prisma.ConversationWhereInput {
  return {
    OR: [
      { externalSource: null },
      { externalSource: { not: AZEVEDO_OS_SOURCE } },
      { externalReference: null },
    ],
  };
}

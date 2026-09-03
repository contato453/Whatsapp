
/**
 * Integração de leitura com o Azevedo-OS.
 *
 * O Azevedo-OS é a fonte da verdade do cadastro empresarial; o AZVCHAT só
 * guarda o ponteiro para a empresa (`Conversation.externalReference`) e
 * busca o resto na hora de exibir. Por isso tudo aqui é contrato e regra de
 * exibição — não há entidade de empresa no banco do AZVCHAT.
 *
 * Este arquivo é compartilhado de propósito: a API e a tela precisam
 * concordar sobre o nome da fonte, o rótulo do status e qual nome da
 * empresa aparece em primeiro lugar. Duplicar isso no frontend faria o card
 * dizer uma coisa e a auditoria registrar outra.
 */

/**
 * Valor gravado em `Conversation.externalSource` quando o vínculo veio
 * desta integração. É o que separa o código de cadastro digitado à mão
 * ("EMPRESA 001", fonte `manual`) do ponteiro para a empresa do Azevedo-OS.
 */
export const AZEVEDO_OS_SOURCE = "azevedo-os";

/** Fontes de `externalReference` que o sistema conhece e aceita gravar. */
export const EXTERNAL_REFERENCE_SOURCES = ["manual", AZEVEDO_OS_SOURCE] as const;
export type ExternalReferenceSource = (typeof EXTERNAL_REFERENCE_SOURCES)[number];

/** Pessoa de contato da empresa, como o Azevedo-OS devolve. */
export interface AzevedoOsContact {
  name: string;
  /** Papel dentro do cliente ("Sócio", "Administrativo"...). */
  role: string | null;
  phone: string | null;
  email: string | null;
}

/**
 * Empresa do Azevedo-OS já normalizada. Só os campos que o card mostra —
 * o cadastro completo continua morando lá, e replicá-lo aqui criaria uma
 * segunda base cadastral, que é exatamente o que a integração evita.
 *
 * Todo campo além do `id` é opcional: contrato externo muda, e um campo
 * ausente precisa sumir do card em vez de derrubá-lo.
 */
export interface AzevedoOsCompany {
  id: string;
  companyNumber: string | null;
  legalName: string | null;
  tradeName: string | null;
  cnpj: string | null;
  /** Código estável do status, o único campo comparado em código. */
  status: string | null;
  /**
   * Rótulo do status **em português, escrito pelo Azevedo-OS**. Ele manda os
   * dois de propósito: o código para o AZVCHAT comparar e o rótulo para o
   * AZVCHAT exibir — assim o vocabulário tem um dono só. Ver o mapa abaixo.
   */
  statusLabel: string | null;
  taxRegime: string | null;
  payrollInfo: string | null;
  contacts: AzevedoOsContact[];
}

/**
 * O que a API devolve ao frontend: a empresa mais o link para abri-la no
 * Azevedo-OS. O link é montado no servidor porque depende de configuração
 * (`AZEVEDO_OS_WEB_URL`) que o navegador não conhece — e é nulo quando o
 * endereço real do Azevedo-OS não foi configurado, para o botão sumir em
 * vez de virar link quebrado.
 */
export interface AzevedoOsCompanyDto extends AzevedoOsCompany {
  webUrl: string | null;
}

/** Tom visual do status — a cor exata é decidida na tela. */
export type AzevedoOsStatusTone = "active" | "inactive" | "neutral";

export interface AzevedoOsStatus {
  tone: AzevedoOsStatusTone;
  label: string;
}

/**
 * Status conhecidos, em português e em inglês.
 *
 * **A divisão de responsabilidade importa mais que a tabela.** O rótulo é do
 * Azevedo-OS: ele manda `statusLabel` pronto, e é ele quem usar. O que é
 * decidido aqui é o **tom**, porque cor é escolha de tela e o Azevedo-OS não
 * conhece a paleta da Inbox. O `label` desta tabela é só a rede de proteção
 * para quando o `statusLabel` não vier.
 *
 * Manter um segundo dicionário de rótulos foi o que já cobrou uma vez: o
 * Azevedo-OS passou a mandar `onboarding` para empresa em implantação, esta
 * tabela não conhecia a chave, e o card escrevia "Onboarding" — palavra em
 * inglês num painel em português — em vez de "Implantação".
 *
 * Valor desconhecido **não vira "inválido"**: sai como veio, em tom neutro.
 * Esconder um status que existe seria pior do que mostrá-lo sem cor.
 */
const STATUS_MAP: Record<string, AzevedoOsStatus> = {
  active: { tone: "active", label: "Ativo" },
  ativo: { tone: "active", label: "Ativo" },
  ativa: { tone: "active", label: "Ativo" },
  inactive: { tone: "inactive", label: "Inativo" },
  inativo: { tone: "inactive", label: "Inativo" },
  inativa: { tone: "inactive", label: "Inativo" },
  // Desativado é como o Azevedo-OS chama o cliente que saiu da operação.
  desativado: { tone: "inactive", label: "Desativado" },
  desativada: { tone: "inactive", label: "Desativado" },
  suspended: { tone: "inactive", label: "Suspenso" },
  suspenso: { tone: "inactive", label: "Suspenso" },
  suspensa: { tone: "inactive", label: "Suspenso" },
  closed: { tone: "inactive", label: "Baixada" },
  baixado: { tone: "inactive", label: "Baixada" },
  baixada: { tone: "inactive", label: "Baixada" },
  // Cliente em implantação ainda não é carteira ativa, mas também não saiu:
  // tom neutro é a leitura honesta, e o rótulo vem do Azevedo-OS.
  onboarding: { tone: "neutral", label: "Implantação" },
  implantacao: { tone: "neutral", label: "Implantação" },
  pending: { tone: "neutral", label: "Pendente" },
  pendente: { tone: "neutral", label: "Pendente" },
  prospect: { tone: "neutral", label: "Prospect" },
};

/**
 * Tom e rótulo do status, a partir do que o Azevedo-OS mandou.
 *
 * `label` é o `statusLabel` da origem quando ele existe — quem nomeia o
 * próprio vocabulário é o dono do cadastro. Só na ausência dele a tabela
 * daqui responde, e, faltando as duas, o código cru aparece capitalizado.
 *
 * O tom nunca vem de fora: é decisão de tela.
 */
export function normalizeAzevedoOsStatus(
  raw: string | null | undefined,
  label?: string | null,
): AzevedoOsStatus | null {
  const value = raw?.trim();
  const fromSource = label?.trim() || null;
  // Sem código não há status — nem quando veio rótulo solto, porque rótulo
  // sem código é texto que a tela não consegue classificar.
  if (!value) return null;
  const known = STATUS_MAP[value.toLowerCase()];
  const fallback = value.charAt(0).toUpperCase() + value.slice(1);
  return {
    tone: known?.tone ?? "neutral",
    label: fromSource ?? known?.label ?? fallback,
  };
}

/**
 * Qual nome aparece em destaque e qual fica como referência embaixo.
 *
 * O nome fantasia vem primeiro: é como o cliente se apresenta e como a
 * equipe o chama no dia a dia. A razão social só aparece embaixo quando é
 * mesmo diferente — repetir "Azevedo Comércio" e "Azevedo Comércio Ltda"
 * em duas linhas gasta espaço do painel sem informar nada.
 */
export function azevedoOsCompanyDisplayName(company: AzevedoOsCompany): {
  primary: string;
  secondary: string | null;
} {
  const trade = company.tradeName?.trim() || null;
  const legal = company.legalName?.trim() || null;
  const primary =
    trade ?? legal ?? (company.companyNumber ? `Empresa nº ${company.companyNumber}` : "Empresa");
  const secondary = legal && legal !== primary ? legal : null;
  return { primary, secondary };
}

/**
 * Mínimo de caracteres da busca. Com uma letra só, a consulta volta com
 * meio cadastro e o Azevedo-OS leva o tranco a cada tecla; com dois já dá
 * para procurar por nome, e busca exata por número da empresa ou por CNPJ
 * continua funcionando (os dois têm bem mais de dois caracteres).
 */
export const AZEVEDO_OS_SEARCH_MIN_LENGTH = 2;

export function azevedoOsSearchIsValid(term: string): boolean {
  return term.trim().length >= AZEVEDO_OS_SEARCH_MIN_LENGTH;
}

/**
 * Quem pode mexer no vínculo NÃO mora mais aqui: são duas chaves do catálogo
 * de permissões (`azevedo_os.link` para preencher conversa vazia e
 * `azevedo_os.relink` para trocar ou desfazer vínculo existente), decididas
 * por `can()` na tela e por `planReferenceUpdate` na API. Uma função de
 * papel aqui voltaria a fixar a regra em código, que é justamente o que o
 * menu de Permissões veio tirar.
 */

/* ------------------------------------------------------------------ *
 * Filtros da Inbox por característica do cliente (regime e folha)
 * ------------------------------------------------------------------ */

/**
 * Por que estes filtros existem aqui, e não no lado de lá: o AZVCHAT filtra
 * CONVERSAS, e conversa só existe neste banco. O regime tributário e a folha
 * moram no Azevedo-OS, em banco separado, então não há consulta única capaz
 * de cruzar as duas coisas. O caminho é pedir ao Azevedo-OS a lista de
 * identificadores das empresas que batem com o critério e usar essa lista
 * para recortar as conversas por `externalReference`.
 *
 * Este arquivo é compartilhado porque a API valida o valor do filtro e a
 * tela desenha o seletor, e as duas precisam concordar sobre o sentinela de
 * "sem informação" e sobre o que é um valor aceitável.
 */

/**
 * Sentinela de "sem informação", combinado com o Azevedo-OS. Vale nos dois
 * campos e significa cadastro em branco (nulo) na empresa — não confundir
 * com o `FILTER_NONE` do responsável, que fala de outra coisa.
 */
export const AZEVEDO_OS_FACET_NONE = "none";

/** Uma opção do seletor, já com o rótulo escrito pelo Azevedo-OS. */
export interface AzevedoOsFacetOption {
  /** Código estável (a chave do enum lá). É o único valor comparado. */
  value: string;
  /** Rótulo em português. Quem nomeia o vocabulário é o dono do cadastro. */
  label: string;
}

export interface AzevedoOsFieldFacets {
  options: AzevedoOsFacetOption[];
  /**
   * Existe empresa com o campo em branco? É isso, e não uma lista fixa, que
   * decide se o seletor oferece "Sem informação": hoje a folha tem dezenas
   * de empresas em branco e o regime não tem nenhuma, e oferecer uma opção
   * que nunca devolve nada é caminho sem saída.
   */
  hasNone: boolean;
}

/**
 * O que a API entrega ao seletor. **Sem as contagens que o Azevedo-OS manda**:
 * elas contam EMPRESAS no cadastro, não conversas na Inbox, e "Simples (191)"
 * ao lado de uma lista com doze conversas faria a pessoa achar que o filtro
 * está quebrado. A contagem entra só na decisão de `hasNone`, no servidor.
 */
export interface AzevedoOsFacetsDto {
  taxRegime: AzevedoOsFieldFacets;
  payroll: AzevedoOsFieldFacets;
}

export const AZEVEDO_OS_TAX_REGIME_LABEL = "Regime tributário";
export const AZEVEDO_OS_PAYROLL_LABEL = "Folha de pgto";
export const AZEVEDO_OS_FACET_NONE_LABEL = "Sem informação";

/**
 * Aviso quando o Azevedo-OS não responde. A Inbox continua inteira e a lista
 * vem SEM o recorte — por isso o texto precisa dizer as duas coisas, senão a
 * pessoa lê uma lista completa achando que ela está filtrada.
 */
export const AZEVEDO_OS_FILTER_UNAVAILABLE_MESSAGE =
  "Não foi possível consultar o cadastro no Azevedo-OS. A lista está sem os filtros de regime e folha.";

/**
 * Forma aceita para o valor de um filtro: chave de enum em snake_case, ou o
 * sentinela. A lista de valores válidos é do Azevedo-OS e não pode ser
 * copiada para cá (viraria dicionário duplicado, que envelhece calado), então
 * o que a validação garante é o FORMATO. Valor bem formado que não existe lá
 * devolve zero conversas, que é resultado, não erro.
 */
const FACET_VALUE_PATTERN = /^[a-z0-9_]{1,60}$/;

export function azevedoOsFacetValueIsValid(value: string): boolean {
  return FACET_VALUE_PATTERN.test(value);
}

/* ------------------------------------------------------------------ *
 * Verificação de saúde (só para quem administra)
 * ------------------------------------------------------------------ */

/**
 * O que a tela de administração mostra sobre a integração — nunca segredo,
 * só o que ajuda a diagnosticar: se a configuração está presente, se o
 * portal respondeu na última checagem e quando foi a última consulta que
 * realmente funcionou. `missingVars` traz NOMES de variável, nunca valor.
 */
export interface AzevedoOsHealthDto {
  /** Falso quando falta `AZEVEDO_OS_API_URL` e/ou `AZEVEDO_OS_API_TOKEN`. */
  configured: boolean;
  /** Nomes das variáveis ausentes — vazio quando `configured` é true. */
  missingVars: string[];
  /**
   * Resultado de uma consulta ao vivo feita na hora da checagem. `null`
   * quando `configured` é falso: sem configuração não há o que testar.
   */
  reachable: boolean | null;
  /** ISO 8601 da última consulta bem-sucedida, ou `null` se nunca houve. */
  lastSuccessAt: string | null;
}

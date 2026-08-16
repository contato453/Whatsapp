import { hasRole, type UserRole } from "./enums.js";

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
  status: string | null;
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
 * Status conhecidos, em português e em inglês. O Azevedo-OS pode mudar o
 * vocabulário sem avisar, então valor desconhecido **não vira "inválido"**:
 * ele é exibido como veio (só com a primeira letra maiúscula), em tom
 * neutro. Esconder um status que existe seria pior do que mostrá-lo sem
 * cor.
 */
const STATUS_MAP: Record<string, AzevedoOsStatus> = {
  active: { tone: "active", label: "Ativo" },
  ativo: { tone: "active", label: "Ativo" },
  ativa: { tone: "active", label: "Ativo" },
  inactive: { tone: "inactive", label: "Inativo" },
  inativo: { tone: "inactive", label: "Inativo" },
  inativa: { tone: "inactive", label: "Inativo" },
  suspended: { tone: "inactive", label: "Suspenso" },
  suspenso: { tone: "inactive", label: "Suspenso" },
  suspensa: { tone: "inactive", label: "Suspenso" },
  closed: { tone: "inactive", label: "Baixada" },
  baixado: { tone: "inactive", label: "Baixada" },
  baixada: { tone: "inactive", label: "Baixada" },
  pending: { tone: "neutral", label: "Pendente" },
  pendente: { tone: "neutral", label: "Pendente" },
  prospect: { tone: "neutral", label: "Prospect" },
};

export function normalizeAzevedoOsStatus(raw: string | null | undefined): AzevedoOsStatus | null {
  const value = raw?.trim();
  if (!value) return null;
  const known = STATUS_MAP[value.toLowerCase()];
  if (known) return known;
  return { tone: "neutral", label: value.charAt(0).toUpperCase() + value.slice(1) };
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
 * Quem pode vincular, trocar e desvincular a empresa: supervisor para cima.
 *
 * A mesma régua vale na API (`requireRole`/`planReferenceUpdate`) e no
 * botão da tela — o `agent` enxerga o card inteiro da empresa vinculada,
 * mas nesta fase não mexe no vínculo.
 */
export function canManageAzevedoOsLink(role: UserRole): boolean {
  return hasRole(role, "supervisor");
}

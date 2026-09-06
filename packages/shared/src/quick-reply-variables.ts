/**
 * Variáveis da resposta rápida.
 *
 * A resposta rápida saía igual para todo mundo, e quem precisava citar a
 * razão social ou o CNPJ digitava na mão — ou deixava um marcador escrito
 * à mão, tipo "[nome do cliente]", que ia literal para o cliente. Aqui
 * mora o catálogo FECHADO do que dá para puxar automaticamente.
 *
 * Este arquivo é compartilhado de propósito: a tela de cadastro monta o
 * menu de variáveis e valida o texto com ele, a API o valida de novo com
 * o MESMO catálogo, e o composer resolve a substituição com ele. Três
 * listas separadas divergiriam, e o defeito só apareceria na mensagem já
 * enviada ao cliente.
 *
 * ------------------------------------------------------------------
 * POR QUE NÃO HÁ NENHUM DADO FINANCEIRO AQUI
 * ------------------------------------------------------------------
 * Honorário, inadimplência e valor de contrato existem no Azevedo-OS, e a
 * integração até conseguiria trazê-los. Lá esses campos são do Financeiro
 * e da Diretoria, e uma variável neste catálogo os entregaria a qualquer
 * atendente com um atalho de duas letras — seria a porta dos fundos
 * daquela regra, aberta de dentro do AZVCHAT. Nenhuma variável financeira
 * entra aqui, mesmo que alguém peça: o caminho é liberar o dado lá.
 */

import {
  normalizeAzevedoOsStatus,
  type AzevedoOsCompany,
} from "./azevedo-os.js";
import { formatPhone, phoneFromChatId } from "./phone.js";

/* ------------------------------------------------------------------ *
 * Sintaxe
 * ------------------------------------------------------------------ */

/**
 * Chaves duplas: `{{empresa.razao_social}}`.
 *
 * A escolha precisa não colidir com duas coisas. Com a formatação do
 * WhatsApp, que usa asterisco, underline, til e crase — nenhum deles
 * aparece aqui, então variável dentro de negrito continua negrito. E com
 * o que já está cadastrado: os marcadores escritos à mão pela equipe usam
 * COLCHETES ("[nome do cliente]"), e adotar colchete faria um texto antigo
 * virar variável inválida da noite para o dia. Chave dupla não aparece em
 * texto de atendimento por acaso.
 */
export const QUICK_REPLY_VARIABLE_OPEN = "{{";
export const QUICK_REPLY_VARIABLE_CLOSE = "}}";

/** Escreve a variável na sintaxe da casa. */
export function quickReplyVariableToken(name: string): string {
  return `${QUICK_REPLY_VARIABLE_OPEN}${name}${QUICK_REPLY_VARIABLE_CLOSE}`;
}

/**
 * Qualquer par de chaves duplas, com o miolo capturado. Aceita espaço em
 * volta do nome ("{{ empresa.cnpj }}") porque quem digita à mão espaça, e
 * recusar por causa de um espaço seria armadilha sem motivo. O miolo pode
 * vir errado de propósito: é a validação que aponta o nome inexistente,
 * não a expressão regular.
 */
const VARIABLE_PATTERN = /\{\{\s*([^{}]*?)\s*\}\}/g;

/* ------------------------------------------------------------------ *
 * Contexto de resolução
 * ------------------------------------------------------------------ */

/** Empresa, conversa, atendente e data — os quatro grupos do catálogo. */
export const QUICK_REPLY_VARIABLE_GROUPS = ["empresa", "conversa", "atendente", "data"] as const;
export type QuickReplyVariableGroup = (typeof QUICK_REPLY_VARIABLE_GROUPS)[number];

export const QUICK_REPLY_VARIABLE_GROUP_LABELS: Record<QuickReplyVariableGroup, string> = {
  empresa: "Empresa",
  conversa: "Conversa",
  atendente: "Atendente",
  data: "Data",
};

/** O que a conversa aberta oferece às variáveis. Montado por `buildQuickReplyConversationContext`. */
export interface QuickReplyConversationContext {
  /** Nome efetivo: o apelido da equipe vence o que veio do WhatsApp. */
  displayName: string | null;
  /** Só telefone de verdade — LID nunca vira número (ver `phone.ts`). */
  phone: string | null;
  departmentName: string | null;
  assigneeName: string | null;
}

export interface QuickReplyAgentContext {
  /** Nome completo de quem está logado; o primeiro nome sai daqui. */
  name: string | null;
}

export interface QuickReplyVariableContext {
  /**
   * Empresa vinculada, como o painel de contexto já a tem em mãos. Nulo
   * quando a conversa não tem vínculo OU quando o Azevedo-OS não respondeu
   * — os dois casos deixam as variáveis de empresa por resolver, que é
   * exatamente o que a atendente precisa enxergar antes de mandar.
   */
  company: AzevedoOsCompany | null;
  conversation: QuickReplyConversationContext | null;
  agent: QuickReplyAgentContext | null;
  /** Data de referência das variáveis calculadas. Entra por parâmetro para o teste fixá-la. */
  now: Date;
}

/**
 * Traduz a conversa aberta para o contexto das variáveis.
 *
 * A precedência do nome fica aqui, e não na tela: `customTitle` (o apelido
 * que a equipe deu) vence o `title` que veio do WhatsApp, que é a mesma
 * regra que a lista de conversas já segue. Grupo entra igual a individual
 * — o que muda é só o telefone, que grupo não tem.
 */
export function buildQuickReplyConversationContext(input: {
  customTitle: string | null;
  title: string;
  externalChatId: string;
  departmentName: string | null;
  assigneeName: string | null;
}): QuickReplyConversationContext {
  return {
    displayName: input.customTitle?.trim() || input.title.trim() || null,
    phone: phoneFromChatId(input.externalChatId),
    departmentName: input.departmentName?.trim() || null,
    assigneeName: input.assigneeName?.trim() || null,
  };
}

/* ------------------------------------------------------------------ *
 * Catálogo
 * ------------------------------------------------------------------ */

export interface QuickReplyVariable {
  /** Nome técnico, o que vai entre as chaves. */
  name: string;
  /** Rótulo em português, o que a pessoa lê no menu. */
  label: string;
  /** Explicação curta: o que esta variável produz. */
  description: string;
  group: QuickReplyVariableGroup;
  /** Valor de mentira da pré-visualização do cadastro. */
  example: string;
  /**
   * Resolve com o contexto da conversa aberta. Devolve `null` quando não
   * há como responder (sem empresa vinculada, campo em branco no cadastro,
   * portal fora do ar) — nunca string vazia, que sumiria em silêncio no
   * meio da frase.
   */
  resolve: (context: QuickReplyVariableContext) => string | null;
}

/** Texto útil ou nada: campo em branco no cadastro é "não resolvida". */
function texto(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

/** Dois dígitos, para as datas calculadas. */
function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

/**
 * O catálogo. Ordem importa: é a ordem do menu da tela de cadastro.
 *
 * Nenhum campo financeiro aqui — o motivo está no cabeçalho do arquivo.
 */
export const QUICK_REPLY_VARIABLES: readonly QuickReplyVariable[] = [
  {
    name: "empresa.razao_social",
    label: "Razão social",
    description: "Razão social da empresa vinculada, como está no Azevedo-OS.",
    group: "empresa",
    example: "Azevedo Comércio de Alimentos Ltda",
    resolve: ({ company }) => texto(company?.legalName),
  },
  {
    name: "empresa.nome_fantasia",
    label: "Nome fantasia",
    description: "Nome fantasia da empresa. Em branco no cadastro, fica por preencher.",
    group: "empresa",
    example: "Mercado Azevedo",
    resolve: ({ company }) => texto(company?.tradeName),
  },
  {
    name: "empresa.numero",
    label: "Número da empresa",
    description: "Número do cadastro da empresa no Azevedo-OS.",
    group: "empresa",
    example: "1042",
    resolve: ({ company }) => texto(company?.companyNumber),
  },
  {
    name: "empresa.cnpj",
    label: "CNPJ",
    description: "CNPJ da empresa, no formato em que o Azevedo-OS o guarda.",
    group: "empresa",
    example: "12.345.678/0001-90",
    resolve: ({ company }) => texto(company?.cnpj),
  },
  {
    name: "empresa.situacao",
    label: "Situação",
    description: "Situação do cliente no Azevedo-OS (Ativo, Implantação, Suspenso...).",
    group: "empresa",
    example: "Ativo",
    // O rótulo é o que o Azevedo-OS escreveu: quem nomeia o próprio
    // vocabulário é o dono do cadastro, e a tabela daqui é rede de proteção.
    resolve: ({ company }) =>
      company ? texto(normalizeAzevedoOsStatus(company.status, company.statusLabel)?.label) : null,
  },
  {
    name: "empresa.regime_tributario",
    label: "Regime tributário",
    description: "Regime tributário da empresa (Simples Nacional, Lucro Presumido...).",
    group: "empresa",
    example: "Simples Nacional",
    resolve: ({ company }) => texto(company?.taxRegime),
  },
  {
    name: "empresa.folha_pagamento",
    label: "Folha de pagamento",
    description: "Informação de folha de pagamento da empresa, como consta no Azevedo-OS.",
    group: "empresa",
    example: "Com folha",
    resolve: ({ company }) => texto(company?.payrollInfo),
  },
  {
    name: "conversa.nome",
    label: "Nome da conversa",
    description: "Nome exibido da conversa: o apelido da equipe, ou o que veio do WhatsApp.",
    group: "conversa",
    example: "Mercado Azevedo — Fiscal",
    resolve: ({ conversation }) => texto(conversation?.displayName),
  },
  {
    name: "conversa.telefone",
    label: "Telefone",
    description: "Telefone da conversa individual, formatado. Grupo não tem telefone.",
    group: "conversa",
    example: "+55 11 99999-8888",
    resolve: ({ conversation }) =>
      conversation?.phone ? texto(formatPhone(conversation.phone)) : null,
  },
  {
    name: "conversa.departamento",
    label: "Departamento",
    description: "Departamento da conversa. Conversa sem departamento fica por preencher.",
    group: "conversa",
    example: "Fiscal",
    resolve: ({ conversation }) => texto(conversation?.departmentName),
  },
  {
    name: "conversa.responsavel",
    label: "Responsável",
    description: "Quem está com o atendimento. Conversa sem responsável fica por preencher.",
    group: "conversa",
    example: "Tatiana Ribeiro",
    resolve: ({ conversation }) => texto(conversation?.assigneeName),
  },
  {
    name: "atendente.primeiro_nome",
    label: "Primeiro nome do atendente",
    description: "Primeiro nome de quem está enviando a mensagem.",
    group: "atendente",
    example: "Camila",
    resolve: ({ agent }) => texto(texto(agent?.name)?.split(/\s+/)[0]),
  },
  {
    name: "data.hoje",
    label: "Data de hoje",
    description: "Data do envio, no formato DD/MM/AAAA.",
    group: "data",
    example: "05/03/2026",
    // Calculada, e não campo de empresa: a data não vem do cadastro, e
    // guardá-la em algum lugar só criaria um valor para envelhecer.
    resolve: ({ now }) => `${pad2(now.getDate())}/${pad2(now.getMonth() + 1)}/${now.getFullYear()}`,
  },
  {
    name: "data.competencia",
    label: "Competência do mês",
    description: "Mês corrente no formato MM/AAAA — a competência em que a mensagem sai.",
    group: "data",
    example: "03/2026",
    resolve: ({ now }) => `${pad2(now.getMonth() + 1)}/${now.getFullYear()}`,
  },
  {
    name: "data.competencia_anterior",
    label: "Competência anterior",
    description: "Mês anterior no formato MM/AAAA — a competência que costuma estar em fechamento.",
    group: "data",
    example: "02/2026",
    resolve: ({ now }) => {
      const mes = now.getMonth();
      return mes === 0
        ? `12/${now.getFullYear() - 1}`
        : `${pad2(mes)}/${now.getFullYear()}`;
    },
  },
];

const VARIABLES_BY_NAME = new Map(
  QUICK_REPLY_VARIABLES.map((variable) => [variable.name, variable] as const),
);

export function quickReplyVariable(name: string): QuickReplyVariable | null {
  return VARIABLES_BY_NAME.get(name) ?? null;
}

/** Catálogo agrupado, na ordem em que o menu da tela desenha os blocos. */
export function quickReplyVariablesByGroup(): {
  group: QuickReplyVariableGroup;
  label: string;
  variables: QuickReplyVariable[];
}[] {
  return QUICK_REPLY_VARIABLE_GROUPS.map((group) => ({
    group,
    label: QUICK_REPLY_VARIABLE_GROUP_LABELS[group],
    variables: QUICK_REPLY_VARIABLES.filter((variable) => variable.group === group),
  })).filter((bloco) => bloco.variables.length > 0);
}

/* ------------------------------------------------------------------ *
 * Leitura do texto
 * ------------------------------------------------------------------ */

export type QuickReplyTemplatePart =
  | { type: "text"; value: string }
  | { type: "variable"; name: string; raw: string; variable: QuickReplyVariable | null };

/** Quebra o texto em pedaços literais e variáveis, na ordem em que aparecem. */
export function parseQuickReplyTemplate(text: string): QuickReplyTemplatePart[] {
  const parts: QuickReplyTemplatePart[] = [];
  let cursor = 0;
  // `matchAll` cria o iterador com a flag global do padrão sem carregar
  // `lastIndex` entre chamadas — nada de estado guardado no módulo.
  for (const match of text.matchAll(VARIABLE_PATTERN)) {
    const start = match.index ?? 0;
    if (start > cursor) parts.push({ type: "text", value: text.slice(cursor, start) });
    const name = match[1] ?? "";
    parts.push({ type: "variable", name, raw: match[0], variable: quickReplyVariable(name) });
    cursor = start + match[0].length;
  }
  if (cursor < text.length) parts.push({ type: "text", value: text.slice(cursor) });
  return parts;
}

export function quickReplyTemplateHasVariables(text: string): boolean {
  return parseQuickReplyTemplate(text).some((part) => part.type === "variable");
}

/**
 * Nomes escritos entre chaves que NÃO existem no catálogo, sem repetição.
 *
 * É o que o cadastro recusa e o que a API recusa: texto salvo com variável
 * inexistente sairia com as chaves literais para o cliente, e o erro só
 * apareceria no celular dele.
 */
export function unknownQuickReplyVariables(text: string): string[] {
  const nomes = parseQuickReplyTemplate(text)
    .filter((part): part is Extract<QuickReplyTemplatePart, { type: "variable" }> =>
      part.type === "variable" && part.variable === null,
    )
    .map((part) => part.raw);
  return [...new Set(nomes)];
}

/** Mensagem de recusa, com os nomes errados à mostra — a pessoa precisa saber qual corrigir. */
export function unknownQuickReplyVariablesMessage(unknown: string[]): string {
  return unknown.length === 1
    ? `Variável desconhecida: ${unknown[0]}`
    : `Variáveis desconhecidas: ${unknown.join(", ")}`;
}

/* ------------------------------------------------------------------ *
 * Resolução
 * ------------------------------------------------------------------ */

/**
 * Como a variável que não resolveu aparece no composer.
 *
 * Ela NÃO pode continuar sendo `{{empresa.cnpj}}`: se a atendente mandar
 * assim mesmo, o cliente recebe o nome técnico da variável. E também não
 * pode virar vazio, que sumiria no meio da frase sem ninguém notar. Vira o
 * rótulo entre colchetes, que é exatamente o marcador que a equipe já
 * escrevia à mão e sabe ler como "falta preencher".
 */
export function quickReplyUnresolvedPlaceholder(label: string): string {
  return `[${label}]`;
}

export interface QuickReplyUnresolved {
  name: string;
  label: string;
  /** O texto que ficou no composer no lugar da variável. */
  placeholder: string;
}

export interface QuickReplyResolution {
  text: string;
  /** Sem repetição, na ordem em que aparecem no texto. */
  unresolved: QuickReplyUnresolved[];
}

/**
 * Troca as variáveis pelos valores do contexto.
 *
 * Variável desconhecida (texto antigo salvo antes desta validação existir)
 * fica como está: apagar as chaves esconderia do olho da atendente que
 * aquele cadastro precisa de conserto.
 */
export function resolveQuickReplyTemplate(
  text: string,
  context: QuickReplyVariableContext,
): QuickReplyResolution {
  const unresolved: QuickReplyUnresolved[] = [];
  const saida = parseQuickReplyTemplate(text)
    .map((part) => {
      if (part.type === "text") return part.value;
      if (!part.variable) return part.raw;
      const valor = part.variable.resolve(context);
      if (valor !== null) return valor;
      const placeholder = quickReplyUnresolvedPlaceholder(part.variable.label);
      if (!unresolved.some((item) => item.name === part.name)) {
        unresolved.push({ name: part.name, label: part.variable.label, placeholder });
      }
      return placeholder;
    })
    .join("");
  return { text: saida, unresolved };
}

/** Contexto de mentira da pré-visualização do cadastro: cada variável mostra o próprio exemplo. */
export function previewQuickReplyTemplate(text: string): string {
  return parseQuickReplyTemplate(text)
    .map((part) =>
      part.type === "text" ? part.value : (part.variable?.example ?? part.raw),
    )
    .join("");
}

/* ------------------------------------------------------------------ *
 * Marcador escrito à mão
 * ------------------------------------------------------------------ */

/**
 * Trechos entre colchetes que parecem marcador manual ("[nome do cliente]").
 *
 * Nada é convertido sozinho: o texto entre colchetes pode ser um recado de
 * verdade, e trocar por variável na cara dura mudaria a mensagem que a
 * equipe escreveu. A tela só aponta e sugere — a decisão é de quem cadastra.
 */
const MANUAL_PLACEHOLDER_PATTERN = /\[([^[\]\n]{2,60})\]/g;

/** Palavra-chave do marcador manual → variável sugerida. Primeiro acerto vence. */
const MANUAL_SUGGESTIONS: { keywords: string[]; variable: string }[] = [
  { keywords: ["cnpj"], variable: "empresa.cnpj" },
  { keywords: ["razao", "razão"], variable: "empresa.razao_social" },
  { keywords: ["fantasia"], variable: "empresa.nome_fantasia" },
  { keywords: ["regime", "tributario", "tributário"], variable: "empresa.regime_tributario" },
  { keywords: ["folha"], variable: "empresa.folha_pagamento" },
  { keywords: ["situacao", "situação"], variable: "empresa.situacao" },
  { keywords: ["numero da empresa", "número da empresa", "cod", "código"], variable: "empresa.numero" },
  { keywords: ["competencia", "competência", "mes", "mês"], variable: "data.competencia" },
  { keywords: ["data", "hoje"], variable: "data.hoje" },
  { keywords: ["telefone", "fone", "whatsapp"], variable: "conversa.telefone" },
  { keywords: ["departamento", "setor"], variable: "conversa.departamento" },
  { keywords: ["responsavel", "responsável"], variable: "conversa.responsavel" },
  { keywords: ["atendente", "meu nome", "assinatura"], variable: "atendente.primeiro_nome" },
  { keywords: ["cliente", "empresa", "nome"], variable: "conversa.nome" },
];

export interface QuickReplyManualPlaceholder {
  /** O trecho como está no texto, colchetes inclusive. */
  raw: string;
  /** Variável do catálogo que provavelmente resolve o caso; nula quando nada casa. */
  suggestion: QuickReplyVariable | null;
}

export function detectManualPlaceholders(text: string): QuickReplyManualPlaceholder[] {
  const vistos = new Set<string>();
  const achados: QuickReplyManualPlaceholder[] = [];
  for (const match of text.matchAll(MANUAL_PLACEHOLDER_PATTERN)) {
    const raw = match[0];
    if (vistos.has(raw)) continue;
    vistos.add(raw);
    const miolo = (match[1] ?? "").toLowerCase();
    const regra = MANUAL_SUGGESTIONS.find((item) =>
      item.keywords.some((keyword) => miolo.includes(keyword)),
    );
    achados.push({ raw, suggestion: regra ? quickReplyVariable(regra.variable) : null });
  }
  return achados;
}

/** Aviso da tela de cadastro. Sugestão, nunca conversão automática. */
export const QUICK_REPLY_MANUAL_PLACEHOLDER_HINT =
  "Este texto parece ter marcador escrito à mão. Ele sai literal para o cliente — troque pela variável correspondente se for o caso.";

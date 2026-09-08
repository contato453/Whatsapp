/**
 * Variáveis de mensagem dos fluxos de automação.
 *
 * Mesma sintaxe de chave dupla da resposta rápida (`{{empresa.cnpj}}`, ver
 * `quick-reply-variables.ts`) — a equipe já lê esse formato —, mas é um
 * CATÁLOGO PRÓPRIO: o contexto de um fluxo é uma EXECUÇÃO (gatilho, respostas
 * já coletadas, protocolo gerado), não uma conversa aberta na Inbox com uma
 * empresa do Azevedo-OS em mãos. Reaproveitar o catálogo da resposta rápida
 * faria `{{empresa.cnpj}}` resolver dentro de um fluxo sem nenhuma consulta
 * ao Azevedo-OS ter acontecido, ou faria `{{protocolo}}` (que só existe aqui)
 * quebrar a resposta rápida por variável desconhecida.
 *
 * `{{campo.<chave>}}` é dinâmico: `<chave>` é o `saveKey` que a própria
 * pessoa escolheu no bloco "Fazer pergunta" ao montar o fluxo, então não dá
 * para ter uma entrada fixa no catálogo — ele é resolvido à parte, direto no
 * `context.answers` da execução.
 */

const VARIABLE_PATTERN = /\{\{\s*([^{}]*?)\s*\}\}/g;

export interface AutomationVariableContext {
  contactName: string | null;
  contactPhone: string | null;
  agentName: string | null;
  departmentName: string | null;
  protocol: string | null;
  /** Respostas já coletadas nesta execução, por `saveKey`. */
  answers: Record<string, string>;
  now: Date;
}

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

function firstName(name: string | null): string | null {
  const trimmed = name?.trim();
  return trimmed ? (trimmed.split(/\s+/)[0] ?? trimmed) : null;
}

/** Nomes fixos do catálogo — os dinâmicos (`campo.*`) são tratados à parte. */
export const AUTOMATION_FIXED_VARIABLES = [
  "nome",
  "primeiro_nome",
  "telefone",
  "atendente",
  "departamento",
  "protocolo",
  "data",
  "hora",
] as const;
export type AutomationFixedVariable = (typeof AUTOMATION_FIXED_VARIABLES)[number];

export const AUTOMATION_VARIABLE_LABELS: Record<AutomationFixedVariable, string> = {
  nome: "Nome do contato",
  primeiro_nome: "Primeiro nome do contato",
  telefone: "Telefone do contato",
  atendente: "Nome do atendente (quando já atribuído)",
  departamento: "Departamento atual da conversa",
  protocolo: "Protocolo gerado pelo fluxo",
  data: "Data de hoje",
  hora: "Hora atual",
};

function resolveFixed(name: AutomationFixedVariable, context: AutomationVariableContext): string | null {
  switch (name) {
    case "nome":
      return context.contactName?.trim() || null;
    case "primeiro_nome":
      return firstName(context.contactName);
    case "telefone":
      return context.contactPhone?.trim() || null;
    case "atendente":
      return context.agentName?.trim() || null;
    case "departamento":
      return context.departmentName?.trim() || null;
    case "protocolo":
      return context.protocol?.trim() || null;
    case "data":
      return `${pad2(context.now.getDate())}/${pad2(context.now.getMonth() + 1)}/${context.now.getFullYear()}`;
    case "hora":
      return `${pad2(context.now.getHours())}:${pad2(context.now.getMinutes())}`;
  }
}

function isFixedVariable(name: string): name is AutomationFixedVariable {
  return (AUTOMATION_FIXED_VARIABLES as readonly string[]).includes(name);
}

export interface AutomationVariableResolution {
  text: string;
  /** Nomes que não resolveram (sem valor, ou desconhecidos) — para log/depuração. */
  unresolved: string[];
}

/**
 * Substitui as variáveis do texto pelo valor do contexto da execução.
 *
 * Variável desconhecida ou sem valor no momento vira string vazia: diferente
 * da resposta rápida (que é revisada por uma pessoa ANTES de enviar), a
 * mensagem do fluxo sai sozinha — deixar `{{protocolo}}` literal chegaria ao
 * cliente, que é pior que uma frase com uma lacuna a menos.
 */
export function resolveAutomationTemplate(
  text: string,
  context: AutomationVariableContext,
): AutomationVariableResolution {
  const unresolved: string[] = [];
  const out = text.replace(VARIABLE_PATTERN, (_match, rawName: string) => {
    const name = rawName.trim();
    if (name.startsWith("campo.")) {
      const key = name.slice("campo.".length);
      const value = context.answers[key];
      if (value != null && value !== "") return value;
      unresolved.push(name);
      return "";
    }
    if (isFixedVariable(name)) {
      const value = resolveFixed(name, context);
      if (value != null) return value;
      unresolved.push(name);
      return "";
    }
    unresolved.push(name);
    return "";
  });
  return { text: out, unresolved };
}

/**
 * Automações — catálogo do construtor visual de fluxos e do motor de
 * execução (AZVCHAT ↔ WhatsApp).
 *
 * Fonte única, no mesmo espírito de `permissions.ts` e
 * `quick-reply-variables.ts`: o construtor visual (frontend), a validação da
 * API e o motor de execução (backend) leem a MESMA lista de tipos de nó,
 * gatilhos e templates. Três catálogos separados divergiriam no primeiro
 * esquecimento, e o defeito só apareceria com o fluxo já publicado.
 *
 * O GRAFO (nós + arestas) é um valor JSON — ver o comentário no
 * `schema.prisma` sobre por que não existem tabelas `automation_nodes` /
 * `automation_edges`. Este arquivo define a FORMA desse JSON.
 */

/* ------------------------------------------------------------------ *
 * Grafo: nós e arestas
 * ------------------------------------------------------------------ */

export interface AutomationPosition {
  x: number;
  y: number;
}

/**
 * Tipos de nó disponíveis hoje. Cobrem a seção 7 do pedido na medida do que
 * a arquitetura atual do AZVCHAT sustenta de verdade — "fila" não é
 * reaproveitado como entidade própria porque o sistema não tem esse
 * conceito separado de departamento (ver `forward_department` e
 * `unassign`, que juntos cobrem "encaminhar para fila" e "voltar para a
 * fila"), e "atribuir atendente" cobre distribuição manual/regra simples,
 * não round-robin (ver o relatório final para as lacunas).
 */
export const AUTOMATION_NODE_TYPES = [
  "trigger",
  "send_message",
  "ask_question",
  "menu",
  "condition",
  "wait",
  "tag_add",
  "tag_remove",
  "change_status",
  "assign_user",
  "unassign",
  "forward_department",
  "webhook",
  "finish",
] as const;
export type AutomationNodeType = (typeof AUTOMATION_NODE_TYPES)[number];

export const AUTOMATION_NODE_CATEGORIES = [
  "inicio",
  "comunicacao",
  "logica",
  "organizacao",
  "atendimento",
  "integracao",
  "finalizacao",
] as const;
export type AutomationNodeCategory = (typeof AUTOMATION_NODE_CATEGORIES)[number];

export const AUTOMATION_NODE_CATEGORY_LABELS: Record<AutomationNodeCategory, string> = {
  inicio: "Início",
  comunicacao: "Comunicação",
  logica: "Lógica",
  organizacao: "Organização",
  atendimento: "Atendimento",
  integracao: "Integração",
  finalizacao: "Finalização",
};

export interface AutomationNodeTypeDefinition {
  type: AutomationNodeType;
  category: AutomationNodeCategory;
  label: string;
  description: string;
  /** Cor de identidade visual do nó no canvas — uma por categoria. */
  color: string;
  /** Rótulos das saídas (arestas) que este nó pode ter. Um item = uma saída
   * sempre presente; nó sem lista aqui tem UMA saída padrão sem rótulo. */
  outputs?: { handle: string; label: string }[];
  /** Só um por fluxo, e é sempre o primeiro nó (sem entrada). */
  isTrigger?: boolean;
  /** Não tem saída — encerra aquele caminho do fluxo. */
  isTerminal?: boolean;
}

export const AUTOMATION_NODE_TYPE_DEFINITIONS: Record<AutomationNodeType, AutomationNodeTypeDefinition> = {
  trigger: {
    type: "trigger",
    category: "inicio",
    label: "Gatilho",
    description: "O que faz este fluxo começar a rodar para uma conversa.",
    color: "#0f766e",
    isTrigger: true,
  },
  send_message: {
    type: "send_message",
    category: "comunicacao",
    label: "Enviar mensagem",
    description: "Manda uma mensagem para o cliente pelo número da conversa.",
    color: "#2563eb",
  },
  ask_question: {
    type: "ask_question",
    category: "comunicacao",
    label: "Fazer pergunta",
    description: "Manda uma pergunta e PARA o fluxo até o cliente responder.",
    color: "#2563eb",
  },
  menu: {
    type: "menu",
    category: "comunicacao",
    label: "Menu de opções",
    description: "Lista numerada de opções — cada uma com sua própria saída.",
    color: "#2563eb",
    outputs: [],
  },
  condition: {
    type: "condition",
    category: "logica",
    label: "Verificar condição",
    description: "Um caminho quando é verdade, outro quando não é.",
    color: "#7c3aed",
    outputs: [
      { handle: "true", label: "Sim" },
      { handle: "false", label: "Não" },
    ],
  },
  wait: {
    type: "wait",
    category: "logica",
    label: "Aguardar",
    description: "Pausa o fluxo por um tempo, ou até o cliente responder.",
    color: "#7c3aed",
    outputs: [
      { handle: "timeout", label: "Tempo esgotado" },
      { handle: "reply", label: "Cliente respondeu" },
    ],
  },
  tag_add: {
    type: "tag_add",
    category: "organizacao",
    label: "Adicionar etiqueta",
    description: "Aplica uma etiqueta à conversa.",
    color: "#b45309",
  },
  tag_remove: {
    type: "tag_remove",
    category: "organizacao",
    label: "Remover etiqueta",
    description: "Tira uma etiqueta da conversa.",
    color: "#b45309",
  },
  change_status: {
    type: "change_status",
    category: "organizacao",
    label: "Alterar status",
    description: "Muda o status do atendimento (aberto, aguardando cliente...).",
    color: "#b45309",
  },
  forward_department: {
    type: "forward_department",
    category: "atendimento",
    label: "Encaminhar para setor",
    description: "Muda o departamento da conversa — quem enxerga o atendimento muda junto.",
    color: "#be123c",
  },
  assign_user: {
    type: "assign_user",
    category: "atendimento",
    label: "Atribuir atendente",
    description: "Passa o atendimento para uma pessoa específica.",
    color: "#be123c",
  },
  unassign: {
    type: "unassign",
    category: "atendimento",
    label: "Devolver para a fila",
    description: "Tira o responsável — a conversa some da caixa de quem tinha e some para quem está livre no setor.",
    color: "#be123c",
  },
  webhook: {
    type: "webhook",
    category: "integracao",
    label: "Chamar webhook",
    description: "Envia os dados da execução para uma URL externa (POST com JSON).",
    color: "#0891b2",
  },
  finish: {
    type: "finish",
    category: "finalizacao",
    label: "Finalizar atendimento",
    description: "Encerra a automação (e, se marcado, conclui o atendimento).",
    color: "#475569",
    isTerminal: true,
  },
};

export interface AutomationNode {
  id: string;
  type: AutomationNodeType;
  position: AutomationPosition;
  /** Config específica do tipo — ver as interfaces `*NodeData` abaixo. */
  data: Record<string, unknown>;
}

export interface AutomationEdge {
  id: string;
  source: string;
  /** Nome da saída, para nó com mais de uma (menu, condição, aguardar). */
  sourceHandle?: string | null;
  target: string;
}

export interface AutomationGraph {
  nodes: AutomationNode[];
  edges: AutomationEdge[];
}

export function emptyAutomationGraph(): AutomationGraph {
  return {
    nodes: [
      {
        id: "trigger-1",
        type: "trigger",
        position: { x: 80, y: 160 },
        data: {},
      },
    ],
    edges: [],
  };
}

/* ------------------------------------------------------------------ *
 * Config de cada tipo de nó (o que `data` carrega)
 * ------------------------------------------------------------------ */

export type AutomationMessageKind = "text" | "image" | "audio" | "video" | "document" | "link";

export interface SendMessageNodeData {
  messageType: AutomationMessageKind;
  /** Texto (ou legenda, para os tipos de mídia). Aceita variáveis `{{...}}`. */
  text: string;
}

export const AUTOMATION_ANSWER_TYPES = [
  "text",
  "number",
  "cpf",
  "cnpj",
  "email",
  "date",
  "option",
] as const;
export type AutomationAnswerType = (typeof AUTOMATION_ANSWER_TYPES)[number];

export const AUTOMATION_ANSWER_TYPE_LABELS: Record<AutomationAnswerType, string> = {
  text: "Texto livre",
  number: "Número",
  cpf: "CPF",
  cnpj: "CNPJ",
  email: "E-mail",
  date: "Data",
  option: "Opção da lista",
};

export interface AskQuestionNodeData {
  question: string;
  answerType: AutomationAnswerType;
  /** Só usado quando `answerType === "option"`. */
  options?: string[];
  /** Nome da variável de execução onde a resposta fica: `{{campo.<key>}}`. */
  saveKey: string;
  /** Minutos até desistir da resposta (opcional — sem prazo por padrão). */
  timeoutMinutes?: number;
}

export interface MenuOption {
  id: string;
  label: string;
}

export interface MenuNodeData {
  question: string;
  options: MenuOption[];
}

export const AUTOMATION_CONDITION_FIELDS = [
  "business_hours",
  "weekday",
  "conversation_status",
  "has_tag",
  "not_has_tag",
  "department",
  "has_assignee",
  "message_contains",
  "message_equals",
  "field_equals",
] as const;
export type AutomationConditionField = (typeof AUTOMATION_CONDITION_FIELDS)[number];

export const AUTOMATION_CONDITION_FIELD_LABELS: Record<AutomationConditionField, string> = {
  business_hours: "Dentro do expediente agora",
  weekday: "Dia da semana",
  conversation_status: "Status do atendimento",
  has_tag: "Conversa possui a etiqueta",
  not_has_tag: "Conversa não possui a etiqueta",
  department: "Departamento atual",
  has_assignee: "Atendimento tem responsável",
  message_contains: "Mensagem do cliente contém",
  message_equals: "Mensagem do cliente é exatamente",
  field_equals: "Variável coletada é igual a",
};

export interface AutomationConditionClause {
  field: AutomationConditionField;
  /** Valor a comparar — id de etiqueta/departamento, texto, "true"/"false"... */
  value: string;
  /** Só para `field_equals`: qual variável (`saveKey` de uma pergunta anterior). */
  key?: string;
}

export interface ConditionNodeData {
  combinator: "and" | "or";
  clauses: AutomationConditionClause[];
}

export const AUTOMATION_WAIT_UNITS = ["minutes", "hours", "days"] as const;
export type AutomationWaitUnit = (typeof AUTOMATION_WAIT_UNITS)[number];

export type AutomationWaitMode = "duration" | "until_next_business_hours";

export interface WaitNodeData {
  mode: AutomationWaitMode;
  amount?: number;
  unit?: AutomationWaitUnit;
  /** Uma resposta do cliente durante a espera interrompe o timer e segue
   * pela saída "reply" em vez de esperar o "timeout". */
  resumeOnReply?: boolean;
}

export interface TagNodeData {
  tagId: string;
}

export interface ChangeStatusNodeData {
  status: "open" | "waiting_client" | "waiting_internal" | "resolved";
}

export interface ForwardDepartmentNodeData {
  departmentId: string;
}

export interface AssignUserNodeData {
  userId: string;
}

export interface WebhookNodeData {
  url: string;
  /** Cabeçalhos extra simples (ex.: token) — nunca segredo de outro sistema. */
  headers?: Record<string, string>;
}

export interface FinishNodeData {
  message?: string;
  resolveConversation?: boolean;
  addTagId?: string;
  generateProtocol?: boolean;
}

/* ------------------------------------------------------------------ *
 * Gatilhos
 * ------------------------------------------------------------------ */

export const AUTOMATION_TRIGGER_TYPES = [
  "new_message",
  "first_message",
  "keyword",
  "no_reply_timeout",
  "conversation_resolved",
  "tag_added",
] as const;
export type AutomationTriggerType = (typeof AUTOMATION_TRIGGER_TYPES)[number];

export const AUTOMATION_TRIGGER_LABELS: Record<AutomationTriggerType, string> = {
  new_message: "Nova mensagem recebida",
  first_message: "Primeira mensagem do contato",
  keyword: "Palavra-chave recebida",
  no_reply_timeout: "Contato sem resposta por um período",
  conversation_resolved: "Atendimento finalizado",
  tag_added: "Etiqueta adicionada",
};

export const AUTOMATION_TRIGGER_DESCRIPTIONS: Record<AutomationTriggerType, string> = {
  new_message: "Roda a cada mensagem nova do cliente, se não houver automação já em andamento na conversa.",
  first_message: "Roda só quando a CONVERSA ainda não tinha nenhuma mensagem antes desta.",
  keyword: "Roda quando o texto da mensagem contém uma das palavras-chave configuradas.",
  no_reply_timeout: "Roda quando o cliente fica um tempo sem responder a última mensagem da equipe.",
  conversation_resolved: "Roda quando o atendimento é marcado como concluído.",
  tag_added: "Roda quando uma etiqueta específica é aplicada à conversa.",
};

export interface KeywordTriggerConfig {
  keywords: string[];
}

export interface NoReplyTimeoutTriggerConfig {
  minutes: number;
}

export interface TagAddedTriggerConfig {
  tagId: string;
}

/* ------------------------------------------------------------------ *
 * Status do fluxo e da execução
 * ------------------------------------------------------------------ */

export const AUTOMATION_FLOW_STATUSES = ["draft", "active", "inactive"] as const;
export type AutomationFlowStatus = (typeof AUTOMATION_FLOW_STATUSES)[number];

export const AUTOMATION_FLOW_STATUS_LABELS: Record<AutomationFlowStatus, string> = {
  draft: "Rascunho",
  active: "Ativo",
  inactive: "Inativo",
};

export const AUTOMATION_FLOW_STATUS_COLORS: Record<AutomationFlowStatus, string> = {
  draft: "#64748b",
  active: "#16a34a",
  inactive: "#dc2626",
};

export const AUTOMATION_EXECUTION_STATUSES = [
  "running",
  "waiting",
  "completed",
  "failed",
  "canceled",
  "handed_off",
] as const;
export type AutomationExecutionStatus = (typeof AUTOMATION_EXECUTION_STATUSES)[number];

export const AUTOMATION_EXECUTION_STATUS_LABELS: Record<AutomationExecutionStatus, string> = {
  running: "Em execução",
  waiting: "Aguardando",
  completed: "Concluído",
  failed: "Erro",
  canceled: "Cancelado",
  handed_off: "Assumido por um atendente",
};

export const AUTOMATION_EXECUTION_STATUS_COLORS: Record<AutomationExecutionStatus, string> = {
  running: "#2563eb",
  waiting: "#d97706",
  completed: "#16a34a",
  failed: "#dc2626",
  canceled: "#64748b",
  handed_off: "#7c3aed",
};

/* ------------------------------------------------------------------ *
 * Validação do fluxo (seção 25) — só a parte que não depende do banco
 * (departamento/usuário/etiqueta existirem é conferido pela API, que tem
 * acesso à organização; aqui é a FORMA do grafo).
 * ------------------------------------------------------------------ */

export interface AutomationFlowProblem {
  nodeId?: string;
  message: string;
}

/**
 * Confere a FORMA do grafo — o suficiente para recusar publicar algo que
 * travaria a primeira mensagem que chegasse. Não é execução: não confere se
 * uma condição é logicamente possível, só se toda saída tem para onde ir.
 */
export function validateAutomationGraph(graph: AutomationGraph): AutomationFlowProblem[] {
  const problems: AutomationFlowProblem[] = [];
  const triggers = graph.nodes.filter((node) => node.type === "trigger");
  if (triggers.length === 0) {
    problems.push({ message: "O fluxo precisa de um bloco de Gatilho." });
  } else if (triggers.length > 1) {
    problems.push({ message: "Só pode haver um bloco de Gatilho por fluxo." });
  }

  const nodeIds = new Set(graph.nodes.map((node) => node.id));
  const outgoingByNode = new Map<string, AutomationEdge[]>();
  for (const edge of graph.edges) {
    if (!nodeIds.has(edge.source) || !nodeIds.has(edge.target)) {
      problems.push({ message: "Existe uma conexão apontando para um bloco que não existe mais." });
      continue;
    }
    const list = outgoingByNode.get(edge.source) ?? [];
    list.push(edge);
    outgoingByNode.set(edge.source, list);
  }

  const reached = new Set<string>();
  if (triggers[0]) {
    const queue = [triggers[0].id];
    while (queue.length > 0) {
      const current = queue.shift() as string;
      if (reached.has(current)) continue;
      reached.add(current);
      for (const edge of outgoingByNode.get(current) ?? []) queue.push(edge.target);
    }
  }
  for (const node of graph.nodes) {
    if (node.type === "trigger") continue;
    if (!reached.has(node.id)) {
      problems.push({ nodeId: node.id, message: "Este bloco não está conectado ao gatilho." });
    }
  }

  for (const node of graph.nodes) {
    const definition = AUTOMATION_NODE_TYPE_DEFINITIONS[node.type];
    if (definition.isTerminal) continue;
    const outgoing = outgoingByNode.get(node.id) ?? [];
    if (outgoing.length === 0) {
      problems.push({ nodeId: node.id, message: `"${definition.label}" não tem para onde seguir.` });
      continue;
    }
    if (node.type === "condition") {
      const handles = new Set(outgoing.map((edge) => edge.sourceHandle));
      if (!handles.has("true") || !handles.has("false")) {
        problems.push({ nodeId: node.id, message: "A condição precisa dos dois caminhos: Sim e Não." });
      }
    }
    if (node.type === "menu") {
      const options = Array.isArray((node.data as unknown as MenuNodeData).options)
        ? (node.data as unknown as MenuNodeData).options
        : [];
      if (options.length === 0) {
        problems.push({ nodeId: node.id, message: "O menu precisa de pelo menos uma opção." });
      }
      const handles = new Set(outgoing.map((edge) => edge.sourceHandle));
      for (const option of options) {
        if (!handles.has(option.id)) {
          problems.push({
            nodeId: node.id,
            message: `A opção "${option.label || option.id}" do menu não está conectada a nada.`,
          });
        }
      }
    }
    if (node.type === "wait" && (node.data as unknown as WaitNodeData).resumeOnReply) {
      const handles = new Set(outgoing.map((edge) => edge.sourceHandle));
      if (!handles.has("timeout") || !handles.has("reply")) {
        problems.push({
          nodeId: node.id,
          message: '"Aguardar" com retomada por resposta precisa das duas saídas: Tempo esgotado e Cliente respondeu.',
        });
      }
    }
  }

  return problems;
}

/* ------------------------------------------------------------------ *
 * Templates prontos (seção 21/22)
 * ------------------------------------------------------------------ */

export interface AutomationTemplate {
  key: string;
  name: string;
  description: string;
  category: string;
  triggerType: AutomationTriggerType;
  triggerConfig?: Record<string, unknown>;
  graph: AutomationGraph;
}

/**
 * O template funcional da seção 22: saudação, expediente, menu de quatro
 * opções, uma pergunta por área e encaminhamento. É o único que a especificação
 * pede PRONTO e funcionando de ponta a ponta — os demais entram como ponto de
 * partida menor, editável na hora.
 */
function atendimentoGeralTemplate(): AutomationTemplate {
  const graph: AutomationGraph = {
    nodes: [
      { id: "trigger", type: "trigger", position: { x: 40, y: 260 }, data: {} },
      {
        id: "check_hours",
        type: "condition",
        position: { x: 300, y: 260 },
        data: { combinator: "and", clauses: [{ field: "business_hours", value: "true" }] } satisfies ConditionNodeData,
      },
      {
        id: "out_of_hours_msg",
        type: "send_message",
        position: { x: 560, y: 60 },
        data: {
          messageType: "text",
          text: "Olá! Nosso atendimento está encerrado neste momento. Sua mensagem foi recebida e retornaremos no próximo período de atendimento.",
        } satisfies SendMessageNodeData,
      },
      { id: "out_of_hours_finish", type: "finish", position: { x: 820, y: 60 }, data: {} satisfies FinishNodeData },
      {
        id: "greeting",
        type: "send_message",
        position: { x: 560, y: 300 },
        data: {
          messageType: "text",
          text: "Olá, {{primeiro_nome}}! Como podemos ajudar?",
        } satisfies SendMessageNodeData,
      },
      {
        id: "menu",
        type: "menu",
        position: { x: 820, y: 300 },
        data: {
          question: "1 - Comercial\n2 - Financeiro\n3 - Suporte\n4 - Falar com atendente",
          options: [
            { id: "comercial", label: "Comercial" },
            { id: "financeiro", label: "Financeiro" },
            { id: "suporte", label: "Suporte" },
            { id: "humano", label: "Falar com atendente" },
          ],
        } satisfies MenuNodeData,
      },
      {
        id: "ask_comercial",
        type: "ask_question",
        position: { x: 1100, y: 40 },
        data: {
          question: "Qual serviço você procura?",
          answerType: "text",
          saveKey: "servico_comercial",
        } satisfies AskQuestionNodeData,
      },
      { id: "tag_comercial", type: "tag_add", position: { x: 1340, y: 40 }, data: { tagId: "" } satisfies TagNodeData },
      {
        id: "forward_comercial",
        type: "forward_department",
        position: { x: 1580, y: 40 },
        data: { departmentId: "" } satisfies ForwardDepartmentNodeData,
      },
      { id: "finish_comercial", type: "finish", position: { x: 1820, y: 40 }, data: {} satisfies FinishNodeData },

      {
        id: "ask_financeiro",
        type: "ask_question",
        position: { x: 1100, y: 220 },
        data: {
          question: "Informe seu CPF ou CNPJ.",
          answerType: "text",
          saveKey: "documento_financeiro",
        } satisfies AskQuestionNodeData,
      },
      { id: "tag_financeiro", type: "tag_add", position: { x: 1340, y: 220 }, data: { tagId: "" } satisfies TagNodeData },
      {
        id: "forward_financeiro",
        type: "forward_department",
        position: { x: 1580, y: 220 },
        data: { departmentId: "" } satisfies ForwardDepartmentNodeData,
      },
      { id: "finish_financeiro", type: "finish", position: { x: 1820, y: 220 }, data: {} satisfies FinishNodeData },

      {
        id: "ask_suporte",
        type: "ask_question",
        position: { x: 1100, y: 400 },
        data: {
          question: "Descreva brevemente o problema.",
          answerType: "text",
          saveKey: "descricao_suporte",
        } satisfies AskQuestionNodeData,
      },
      { id: "tag_suporte", type: "tag_add", position: { x: 1340, y: 400 }, data: { tagId: "" } satisfies TagNodeData },
      {
        id: "forward_suporte",
        type: "forward_department",
        position: { x: 1580, y: 400 },
        data: { departmentId: "" } satisfies ForwardDepartmentNodeData,
      },
      { id: "finish_suporte", type: "finish", position: { x: 1820, y: 400 }, data: {} satisfies FinishNodeData },

      { id: "unassign_humano", type: "unassign", position: { x: 1100, y: 580 }, data: {} },
      { id: "finish_humano", type: "finish", position: { x: 1340, y: 580 }, data: {} satisfies FinishNodeData },
    ],
    edges: [
      { id: "e-trigger-hours", source: "trigger", target: "check_hours" },
      { id: "e-hours-false", source: "check_hours", sourceHandle: "false", target: "out_of_hours_msg" },
      { id: "e-outhours-finish", source: "out_of_hours_msg", target: "out_of_hours_finish" },
      { id: "e-hours-true", source: "check_hours", sourceHandle: "true", target: "greeting" },
      { id: "e-greeting-menu", source: "greeting", target: "menu" },
      { id: "e-menu-comercial", source: "menu", sourceHandle: "comercial", target: "ask_comercial" },
      { id: "e-comercial-tag", source: "ask_comercial", target: "tag_comercial" },
      { id: "e-comercial-forward", source: "tag_comercial", target: "forward_comercial" },
      { id: "e-comercial-finish", source: "forward_comercial", target: "finish_comercial" },
      { id: "e-menu-financeiro", source: "menu", sourceHandle: "financeiro", target: "ask_financeiro" },
      { id: "e-financeiro-tag", source: "ask_financeiro", target: "tag_financeiro" },
      { id: "e-financeiro-forward", source: "tag_financeiro", target: "forward_financeiro" },
      { id: "e-financeiro-finish", source: "forward_financeiro", target: "finish_financeiro" },
      { id: "e-menu-suporte", source: "menu", sourceHandle: "suporte", target: "ask_suporte" },
      { id: "e-suporte-tag", source: "ask_suporte", target: "tag_suporte" },
      { id: "e-suporte-forward", source: "tag_suporte", target: "forward_suporte" },
      { id: "e-suporte-finish", source: "forward_suporte", target: "finish_suporte" },
      { id: "e-menu-humano", source: "menu", sourceHandle: "humano", target: "unassign_humano" },
      { id: "e-humano-finish", source: "unassign_humano", target: "finish_humano" },
    ],
  };
  return {
    key: "atendimento_geral",
    name: "Atendimento Geral",
    description:
      "Saudação, verificação de expediente, menu de quatro opções e encaminhamento por área — o ponto de partida padrão.",
    category: "Geral",
    triggerType: "first_message",
    graph,
  };
}

/** Template menor: só a saudação e a coleta inicial, para a área editar. */
function starterTemplate(input: {
  key: string;
  name: string;
  description: string;
  category: string;
  greeting: string;
  question: string;
  saveKey: string;
}): AutomationTemplate {
  const graph: AutomationGraph = {
    nodes: [
      { id: "trigger", type: "trigger", position: { x: 40, y: 160 }, data: {} },
      {
        id: "greeting",
        type: "send_message",
        position: { x: 300, y: 160 },
        data: { messageType: "text", text: input.greeting } satisfies SendMessageNodeData,
      },
      {
        id: "ask",
        type: "ask_question",
        position: { x: 560, y: 160 },
        data: { question: input.question, answerType: "text", saveKey: input.saveKey } satisfies AskQuestionNodeData,
      },
      { id: "finish", type: "finish", position: { x: 820, y: 160 }, data: {} satisfies FinishNodeData },
    ],
    edges: [
      { id: "e1", source: "trigger", target: "greeting" },
      { id: "e2", source: "greeting", target: "ask" },
      { id: "e3", source: "ask", target: "finish" },
    ],
  };
  return {
    key: input.key,
    name: input.name,
    description: input.description,
    category: input.category,
    triggerType: "first_message",
    graph,
  };
}

export const AUTOMATION_TEMPLATES: readonly AutomationTemplate[] = [
  atendimentoGeralTemplate(),
  starterTemplate({
    key: "comercial",
    name: "Comercial",
    description: "Saudação comercial e coleta do que o cliente procura.",
    category: "Comercial",
    greeting: "Olá, {{primeiro_nome}}! Que bom seu interesse. Vamos te ajudar a encontrar o melhor serviço.",
    question: "Qual serviço você tem interesse em contratar?",
    saveKey: "interesse_comercial",
  }),
  starterTemplate({
    key: "financeiro",
    name: "Financeiro",
    description: "Saudação financeira e coleta de CPF/CNPJ para localizar o cadastro.",
    category: "Financeiro",
    greeting: "Olá, {{primeiro_nome}}! Vamos localizar seu cadastro financeiro.",
    question: "Informe seu CPF ou CNPJ.",
    saveKey: "documento_financeiro",
  }),
  starterTemplate({
    key: "suporte",
    name: "Suporte",
    description: "Saudação de suporte e coleta da descrição do problema.",
    category: "Suporte",
    greeting: "Olá, {{primeiro_nome}}! Sentimos muito pelo transtorno. Vamos resolver.",
    question: "Descreva brevemente o que está acontecendo.",
    saveKey: "descricao_suporte",
  }),
  starterTemplate({
    key: "captacao_lead",
    name: "Captação de Lead",
    description: "Boas-vindas a um contato novo e coleta do nome da empresa.",
    category: "Comercial",
    greeting: "Olá! Obrigado por entrar em contato. Vamos te conhecer melhor.",
    question: "Qual o nome da sua empresa?",
    saveKey: "empresa_lead",
  }),
  starterTemplate({
    key: "pos_venda",
    name: "Pós-venda",
    description: "Mensagem de acompanhamento após o fechamento de um serviço.",
    category: "Pós-venda",
    greeting: "Olá, {{primeiro_nome}}! Passando para saber como está sendo sua experiência.",
    question: "De 0 a 10, o quanto você recomendaria nosso atendimento?",
    saveKey: "nota_pos_venda",
  }),
  starterTemplate({
    key: "cobranca",
    name: "Cobrança",
    description: "Aviso amigável de pendência com confirmação de recebimento.",
    category: "Financeiro",
    greeting: "Olá, {{primeiro_nome}}! Identificamos uma pendência em aberto. Podemos te ajudar a regularizar.",
    question: "Você já efetuou o pagamento?",
    saveKey: "confirmacao_pagamento",
  }),
  starterTemplate({
    key: "follow_up",
    name: "Follow-up",
    description: "Retomada de contato com quem não respondeu há um tempo.",
    category: "Follow-up",
    greeting: "Olá, {{primeiro_nome}}! Você ainda precisa de ajuda com o que conversamos?",
    question: "Podemos continuar de onde paramos?",
    saveKey: "retomada_follow_up",
  }),
] as const;

export function automationTemplate(key: string): AutomationTemplate | null {
  return AUTOMATION_TEMPLATES.find((template) => template.key === key) ?? null;
}

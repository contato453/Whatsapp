import {
  AI_SETTABLE_STATUSES,
  agentAllowsTool,
  type AiAgentConfig,
  type AiToolName,
} from "@azvchat/shared";
import type { AiToolDefinition } from "./provider.js";

/**
 * As ferramentas oferecidas ao modelo — só as que a configuração do agente
 * libera. Desligada na tela, a ferramenta nem aparece para o modelo; e se
 * ele a pedir pelo nome mesmo assim, `actions.ts` recusa de novo. Duas
 * camadas de propósito: o prompt não é controle de acesso.
 */

export interface ToolContext {
  /** Há fonte de conhecimento vinculada? Sem fonte, a busca não é oferecida. */
  hasKnowledge: boolean;
  /** Conversa vinculada a empresa do Azevedo-OS e integração ligada. */
  canLookupCompany: boolean;
  /** Etiquetas que valem para esta conversa (nome) — vão no schema como enum. */
  tagNames: string[];
  /** Campos de coleta configurados (chave) — vão no schema como enum. */
  collectFieldKeys: string[];
}

function definition(
  name: AiToolName,
  description: string,
  properties: Record<string, unknown>,
  required: string[],
): AiToolDefinition {
  return {
    name,
    description,
    parameters: {
      type: "object",
      properties,
      required,
      additionalProperties: false,
    },
  };
}

export function buildToolDefinitions(config: AiAgentConfig, context: ToolContext): AiToolDefinition[] {
  const tools: AiToolDefinition[] = [];
  const allow = (tool: AiToolName) => agentAllowsTool(config, tool);

  if (allow("save_collected_data") && context.collectFieldKeys.length > 0) {
    tools.push(
      definition(
        "save_collected_data",
        "Registra um dado que o cliente acabou de informar (um campo por chamada). Use assim que o cliente disser o dado, antes de responder.",
        {
          field: { type: "string", enum: context.collectFieldKeys, description: "Chave do campo" },
          value: { type: "string", description: "Valor informado pelo cliente, como ele disse" },
        },
        ["field", "value"],
      ),
    );
  }
  if (allow("update_contact_name")) {
    tools.push(
      definition(
        "update_contact_name",
        "Grava o nome pelo qual o cliente se apresentou como nome da conversa. Só quando o cliente disser o próprio nome.",
        { name: { type: "string", description: "Nome do cliente" } },
        ["name"],
      ),
    );
  }
  if (allow("add_tag") && context.tagNames.length > 0) {
    tools.push(
      definition(
        "add_tag",
        "Aplica uma etiqueta à conversa para classificar o atendimento.",
        { name: { type: "string", enum: context.tagNames } },
        ["name"],
      ),
    );
  }
  if (allow("remove_tag") && context.tagNames.length > 0) {
    tools.push(
      definition(
        "remove_tag",
        "Remove uma etiqueta da conversa.",
        { name: { type: "string", enum: context.tagNames } },
        ["name"],
      ),
    );
  }
  if (allow("add_internal_note")) {
    tools.push(
      definition(
        "add_internal_note",
        "Escreve uma nota interna na conversa, visível só para a equipe (o cliente nunca vê). Use para registrar oportunidade, contexto ou pendência.",
        { content: { type: "string", description: "Texto da nota, objetivo" } },
        ["content"],
      ),
    );
  }
  if (allow("set_conversation_status")) {
    tools.push(
      definition(
        "set_conversation_status",
        "Muda o status do atendimento. 'waiting_client' quando você fez uma pergunta e espera o cliente; 'waiting_internal' quando depende de alguém do escritório; 'open' quando volta a andar.",
        { status: { type: "string", enum: [...AI_SETTABLE_STATUSES] } },
        ["status"],
      ),
    );
  }
  if (allow("schedule_followup")) {
    tools.push(
      definition(
        "schedule_followup",
        "Quando o cliente diz que vai pensar, verificar ou retornar depois: coloca a conversa em 'aguardando cliente' e inicia o follow-up automático do escritório (a regra cadastrada pela equipe). Encerra sua participação.",
        { reason: { type: "string", description: "Por que o cliente vai retornar, em uma frase" } },
        [],
      ),
    );
  }
  if (allow("search_knowledge_base") && context.hasKnowledge) {
    tools.push(
      definition(
        "search_knowledge_base",
        "Busca na base de conhecimento do escritório. Use antes de responder sobre serviços, preços, prazos, procedimentos ou qualquer informação institucional.",
        { query: { type: "string", description: "Pergunta ou termos de busca" } },
        ["query"],
      ),
    );
  }
  if (allow("lookup_company") && context.canLookupCompany) {
    tools.push(
      definition(
        "lookup_company",
        "Consulta o cadastro da empresa vinculada a esta conversa (nome, CNPJ, situação, regime tributário). Nunca traz dados financeiros.",
        {},
        [],
      ),
    );
  }
  if (allow("transfer_to_human")) {
    tools.push(
      definition(
        "transfer_to_human",
        "Transfere o atendimento para um atendente humano. Use quando uma regra de transferência se aplicar. Depois desta chamada você NÃO responde mais.",
        {
          reason: { type: "string", description: "Motivo da transferência, em uma frase" },
          subject: { type: "string", description: "Assunto do atendimento" },
          need: { type: "string", description: "O que o cliente precisa, em uma ou duas frases" },
          summary: { type: "string", description: "Resumo do que foi conversado, para o atendente continuar sem perguntar tudo de novo" },
        },
        ["reason", "subject", "need", "summary"],
      ),
    );
  }
  if (allow("finish_conversation")) {
    tools.push(
      definition(
        "finish_conversation",
        "Encerra o atendimento como resolvido, quando o cliente foi atendido por completo e se despediu. Depois desta chamada você NÃO responde mais.",
        { summary: { type: "string", description: "Resumo do atendimento em uma ou duas frases" } },
        ["summary"],
      ),
    );
  }
  return tools;
}

/** Ferramentas que ENCERRAM a participação da IA: depois delas não há outra volta ao modelo. */
export const TERMINAL_TOOLS: ReadonlySet<AiToolName> = new Set([
  "transfer_to_human",
  "finish_conversation",
  "schedule_followup",
]);

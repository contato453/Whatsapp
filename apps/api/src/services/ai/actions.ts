import type { PrismaClient } from "@azvchat/database";
import { z } from "zod";
import {
  AI_SETTABLE_STATUSES,
  agentAllowsTool,
  AI_TOOL_NAMES,
  type AiAgentConfig,
  type AiToolName,
  type ConversationStatus,
} from "@azvchat/shared";
import type { Logger } from "pino";
import type { AzevedoOsClient } from "../azevedo-os-client.js";
import { canApplyToConversation } from "../../lib/department-resource.js";
import { retrieveKnowledge, type KnowledgeSourceInput } from "./knowledge.js";
import type { AiToolCall } from "./provider.js";
import type { AiSessionState } from "./session.js";

/**
 * EXECUÇÃO das ferramentas que o modelo pede. O modelo SOLICITA; quem decide
 * é este arquivo, e a decisão passa por três portas antes de encostar no
 * banco: a capacidade está ligada no agente? os argumentos são válidos? o
 * alvo (etiqueta, campo, status) é permitido para ESTA conversa? Recusa em
 * qualquer uma vira `blocked`, com motivo que volta ao modelo (para ele
 * não fingir que fez) e para o log de consumo.
 *
 * Duas execuções, uma interface: `live` grava de verdade; `dryRun` é o
 * testador — mesmas regras, mesmas recusas, nada gravado.
 */

export interface ActionConversation {
  id: string;
  organizationId: string;
  type: "individual" | "group";
  title: string;
  customTitle: string | null;
  departmentId: string | null;
  externalReference: string | null;
  externalSource: string | null;
}

export interface ActionEnvironment {
  agent: { id: string; name: string };
  config: AiAgentConfig;
  conversation: ActionConversation;
  state: AiSessionState;
  /** Etiquetas que valem para esta conversa. */
  tags: Array<{ id: string; name: string }>;
  knowledgeSources: KnowledgeSourceInput[];
  /** Respostas rápidas que valem para a conversa, quando o agente as usa como conhecimento. */
  quickReplies: KnowledgeSourceInput[];
  azevedoOsEnabled: boolean;
}

export type TerminalAction =
  | { kind: "transfer"; reason: string; subject: string; need: string; summary: string }
  | { kind: "finish"; summary: string }
  | { kind: "followup"; hours: number; message: string };

export interface ActionOutcome {
  name: string;
  /** Texto devolvido ao modelo como resultado da ferramenta. */
  result: string;
  executed: boolean;
  blockedReason: string | null;
  terminal: TerminalAction | null;
  /** Trechos usados (busca na base) — para o modo debug do testador. */
  knowledgeUsed?: Array<{ sourceTitle: string; excerpt: string }>;
}

export interface ActionDeps {
  prisma: PrismaClient;
  logger: Logger;
  azevedoOs: AzevedoOsClient;
}

const schemas = {
  save_collected_data: z.object({ field: z.string().min(1).max(40), value: z.string().min(1).max(500) }),
  update_contact_name: z.object({ name: z.string().min(2).max(120) }),
  add_tag: z.object({ name: z.string().min(1).max(120) }),
  remove_tag: z.object({ name: z.string().min(1).max(120) }),
  add_internal_note: z.object({ content: z.string().min(1).max(4000) }),
  set_conversation_status: z.object({ status: z.enum(["open", "waiting_client", "waiting_internal"]) }),
  schedule_followup: z.object({ hours: z.number().int().min(1).max(720), message: z.string().min(1).max(2000) }),
  search_knowledge_base: z.object({ query: z.string().min(1).max(500) }),
  lookup_company: z.object({}),
  transfer_to_human: z.object({
    reason: z.string().min(1).max(500),
    subject: z.string().max(300).default(""),
    need: z.string().max(1000).default(""),
    summary: z.string().max(4000).default(""),
  }),
  finish_conversation: z.object({ summary: z.string().max(2000).default("") }),
} satisfies Record<AiToolName, z.ZodTypeAny>;

function isToolName(name: string): name is AiToolName {
  return (AI_TOOL_NAMES as readonly string[]).includes(name);
}

function blocked(name: string, reason: string): ActionOutcome {
  return { name, result: `Ação recusada: ${reason}`, executed: false, blockedReason: reason, terminal: null };
}

function done(name: string, result: string, terminal: TerminalAction | null = null): ActionOutcome {
  return { name, result, executed: true, blockedReason: null, terminal };
}

function stamp(state: AiSessionState, tool: string): void {
  state.actions.push({ tool, at: new Date().toISOString() });
}

/**
 * Executa (ou simula) uma ferramenta. MUTA `env.state` — é a memória do
 * atendimento, que o motor grava ao fim do turno.
 */
export async function executeTool(
  deps: ActionDeps,
  env: ActionEnvironment,
  call: AiToolCall,
  mode: "live" | "dryRun",
): Promise<ActionOutcome> {
  if (!isToolName(call.name)) return blocked(call.name, "ferramenta desconhecida.");
  const name = call.name;
  if (!agentAllowsTool(env.config, name)) {
    return blocked(name, "esta ação não está liberada para este agente.");
  }
  const parsed = schemas[name].safeParse(call.arguments);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return blocked(name, `argumentos inválidos (${issue?.path.join(".") || "?"}: ${issue?.message ?? "inválido"}).`);
  }
  const args = parsed.data as Record<string, unknown>;
  const live = mode === "live";
  const { prisma } = deps;
  const conversation = env.conversation;

  switch (name) {
    case "save_collected_data": {
      const { field, value } = args as { field: string; value: string };
      const known = env.config.dataCollection.fields.find((entry) => entry.key === field);
      if (!known) return blocked(name, `o campo "${field}" não está na lista de dados a coletar.`);
      env.state.collected[field] = value.trim();
      stamp(env.state, name);
      return done(name, `Registrado: ${known.label} = ${value.trim()}.`);
    }

    case "update_contact_name": {
      const { name: contactName } = args as { name: string };
      if (conversation.type === "group") return blocked(name, "conversa de grupo não tem nome de contato.");
      // Só quando a conversa ainda não tem nome dado pela equipe: o apelido
      // da equipe (`customTitle`) é decisão de gente e a IA não sobrescreve.
      if (conversation.customTitle) return blocked(name, "a conversa já tem um nome definido pela equipe.");
      if (live) {
        await prisma.conversation.update({ where: { id: conversation.id }, data: { customTitle: contactName.trim() } });
        conversation.customTitle = contactName.trim();
      }
      env.state.collected.nome = env.state.collected.nome ?? contactName.trim();
      stamp(env.state, name);
      return done(name, `Nome da conversa atualizado para "${contactName.trim()}".`);
    }

    case "add_tag":
    case "remove_tag": {
      const { name: tagName } = args as { name: string };
      const tag = env.tags.find((entry) => entry.name.toLowerCase() === tagName.trim().toLowerCase());
      if (!tag) return blocked(name, `a etiqueta "${tagName}" não existe ou não vale para esta conversa.`);
      if (live) {
        if (name === "add_tag") {
          await prisma.conversationTag.upsert({
            where: { conversationId_tagId: { conversationId: conversation.id, tagId: tag.id } },
            update: {},
            create: { conversationId: conversation.id, tagId: tag.id },
          });
        } else {
          await prisma.conversationTag.deleteMany({ where: { conversationId: conversation.id, tagId: tag.id } });
        }
      }
      stamp(env.state, name);
      return done(name, name === "add_tag" ? `Etiqueta "${tag.name}" aplicada.` : `Etiqueta "${tag.name}" removida.`);
    }

    case "add_internal_note": {
      const { content } = args as { content: string };
      if (live) {
        await prisma.internalNote.create({
          data: {
            organizationId: conversation.organizationId,
            conversationId: conversation.id,
            userId: null,
            content: `[${env.agent.name}] ${content.trim()}`,
          },
        });
      }
      stamp(env.state, name);
      return done(name, "Nota interna registrada (o cliente não a vê).");
    }

    case "set_conversation_status": {
      const { status } = args as { status: ConversationStatus };
      if (!AI_SETTABLE_STATUSES.includes(status)) return blocked(name, "status não permitido.");
      if (live) {
        await prisma.conversation.update({ where: { id: conversation.id }, data: { status } });
      }
      stamp(env.state, name);
      return done(name, `Status do atendimento: ${status}.`);
    }

    case "schedule_followup": {
      const { hours, message } = args as { hours: number; message: string };
      const scheduledFor = new Date(Date.now() + hours * 60 * 60 * 1000);
      if (live) {
        await prisma.$transaction([
          prisma.scheduledMessage.create({
            data: {
              organizationId: conversation.organizationId,
              conversationId: conversation.id,
              content: message.trim(),
              scheduledFor,
              createdById: null,
            },
          }),
          prisma.conversation.update({ where: { id: conversation.id }, data: { status: "waiting_client" } }),
        ]);
      }
      env.state.followupScheduledAt = scheduledFor.toISOString();
      stamp(env.state, name);
      return done(name, `Follow-up agendado para daqui a ${hours}h. Sua participação termina aqui.`, {
        kind: "followup",
        hours,
        message: message.trim(),
      });
    }

    case "search_knowledge_base": {
      const { query } = args as { query: string };
      const sources = [...env.knowledgeSources, ...(env.config.knowledge.includeQuickReplies ? env.quickReplies : [])];
      const hits = retrieveKnowledge(sources, query, { topK: 4 });
      stamp(env.state, name);
      if (hits.length === 0) {
        return { ...done(name, "Nada encontrado na base para esta pergunta."), knowledgeUsed: [] };
      }
      const text = hits.map((hit) => `[${hit.sourceTitle}]\n${hit.text}`).join("\n\n");
      return {
        ...done(name, text),
        knowledgeUsed: hits.map((hit) => ({ sourceTitle: hit.sourceTitle, excerpt: hit.text.slice(0, 200) })),
      };
    }

    case "lookup_company": {
      if (!env.azevedoOsEnabled) return blocked(name, "a integração com o Azevedo-OS não está disponível.");
      if (conversation.externalSource !== "azevedo-os" || !conversation.externalReference) {
        return blocked(name, "esta conversa não está vinculada a uma empresa.");
      }
      try {
        const company = await deps.azevedoOs.getCompany(conversation.externalReference);
        stamp(env.state, name);
        // Só cadastro. Nada financeiro atravessa (ver CLAUDE.md §15).
        const lines = [
          company.legalName ? `Razão social: ${company.legalName}` : null,
          company.tradeName ? `Nome fantasia: ${company.tradeName}` : null,
          company.cnpj ? `CNPJ: ${company.cnpj}` : null,
          company.companyNumber ? `Número da empresa: ${company.companyNumber}` : null,
          company.statusLabel ?? company.status ? `Situação: ${company.statusLabel ?? company.status}` : null,
          company.taxRegime ? `Regime tributário: ${company.taxRegime}` : null,
          company.payrollInfo ? `Folha de pagamento: ${company.payrollInfo}` : null,
        ].filter((line): line is string => line != null);
        return done(name, lines.length ? lines.join("\n") : "Empresa vinculada sem dados de cadastro preenchidos.");
      } catch (err) {
        deps.logger.warn({ event: "ai_lookup_company_failed", conversationId: conversation.id, error: String(err) });
        return blocked(name, "o Azevedo-OS não respondeu agora.");
      }
    }

    case "transfer_to_human": {
      const { reason, subject, need, summary } = args as { reason: string; subject: string; need: string; summary: string };
      env.state.subject = subject || env.state.subject;
      env.state.summary = summary || env.state.summary;
      stamp(env.state, name);
      return done(name, "Transferência registrada. Não responda mais ao cliente.", {
        kind: "transfer",
        reason: reason.trim(),
        subject: subject.trim(),
        need: need.trim(),
        summary: summary.trim(),
      });
    }

    case "finish_conversation": {
      const { summary } = args as { summary: string };
      env.state.summary = summary || env.state.summary;
      stamp(env.state, name);
      return done(name, "Atendimento marcado como concluído. Não responda mais.", {
        kind: "finish",
        summary: summary.trim(),
      });
    }
  }
}

/** Etiquetas que valem para esta conversa (geral ou do departamento dela). */
export async function loadApplicableTags(
  prisma: PrismaClient,
  organizationId: string,
  departmentId: string | null,
): Promise<Array<{ id: string; name: string }>> {
  const tags = await prisma.tag.findMany({
    where: { organizationId },
    include: { departments: { select: { departmentId: true } } },
    orderBy: { name: "asc" },
  });
  return tags
    .filter((tag) => canApplyToConversation(tag, departmentId))
    .map((tag) => ({ id: tag.id, name: tag.name }));
}

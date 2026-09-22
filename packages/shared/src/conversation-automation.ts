import { AI_SESSION_STATUS_COLORS } from "./ai.js";

/**
 * "Esta conversa está no automático" — o sinal que o card da lista mostra.
 *
 * Duas coisas diferentes atendem sozinhas no AZVCHAT, e a equipe precisa
 * reconhecer as duas ANTES de abrir a conversa: o atendimento por IA
 * (`AiSession` ativa, seção 20) e a execução de um fluxo do construtor
 * (`AutomationExecution` em andamento, seção 18). Sem o aviso no card, dois
 * atendentes escrevem por cima de um atendimento que já estava acontecendo —
 * e, no caso do fluxo, quem responde ainda derruba a automação no meio
 * (`handleHumanTakeover`) sem ter tido como saber que ela existia.
 *
 * As duas viajam JUNTAS num estado só porque respondem à mesma pergunta na
 * tela. Podem valer ao mesmo tempo: o bloco "Atendimento por IA" do
 * construtor deixa a execução `waiting` enquanto a sessão de IA conversa.
 *
 * Isto NÃO vive no `ConversationDto`: aquele DTO é publicado a cada card da
 * lista e carregá-lo com duas consultas por linha é o mesmo custo que
 * mantém `scheduledPendingCount` e as fixações fora dele. O mapa vem da
 * resposta da lista e é mantido em dia pelo evento `conversation:automation`.
 */

/** Atendimento por IA ativo agora (`AiSession.status = "active"`). */
export interface ConversationAiSignalDto {
  sessionId: string;
  agentId: string;
  agentName: string;
}

/** Execução de fluxo em andamento (`running` ou `waiting`). */
export interface ConversationFlowSignalDto {
  executionId: string;
  flowId: string;
  flowName: string;
}

export interface ConversationAutomationDto {
  ai: ConversationAiSignalDto | null;
  flow: ConversationFlowSignalDto | null;
}

/** Nada automático na conversa — o estado que o card desenha sem chip algum. */
export const EMPTY_CONVERSATION_AUTOMATION: ConversationAutomationDto = { ai: null, flow: null };

export const CONVERSATION_AI_BADGE_LABEL = "IA";
export const CONVERSATION_FLOW_BADGE_LABEL = "Fluxo";

/**
 * O indigo é o MESMO da faixa "Atendimento por IA" do topo da conversa
 * (`AI_SESSION_STATUS_COLORS.active`), para o chip do card e a faixa serem
 * lidos como a mesma coisa; o fluxo fica no azul, ao lado dele, porque é
 * atendimento automático também — e nenhum dos dois usa o verde de estado
 * nem a paleta de marca (ver a seção 9 do CLAUDE.md).
 */
export const CONVERSATION_AI_BADGE_COLOR = AI_SESSION_STATUS_COLORS.active;
export const CONVERSATION_FLOW_BADGE_COLOR = "#0284c7";

export function hasConversationAutomation(
  state: ConversationAutomationDto | null | undefined,
): boolean {
  return Boolean(state && (state.ai || state.flow));
}

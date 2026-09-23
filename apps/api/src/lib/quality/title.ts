import type { PrismaClient } from "@azvchat/database";
import { resolveConversationPersonNames } from "../person-profile.js";

/**
 * O que o Quality precisa saber de uma conversa para nomeá-la. Sai daqui, e
 * não copiado em cada rota, porque seis respostas do módulo montam título e a
 * sétima escolheria campos diferentes — e aí a mesma conversa apareceria com
 * dois nomes dentro do próprio módulo.
 */
export const QUALITY_CONVERSATION_SELECT = {
  id: true,
  type: true,
  externalChatId: true,
  title: true,
  customTitle: true,
} as const;

export interface QualityConversationRef {
  id: string;
  type: string;
  externalChatId: string;
  title: string | null;
  customTitle: string | null;
}

/**
 * Título efetivo de uma conversa, com a MESMA precedência da lista de
 * conversas: `customTitle` (apelido que a equipe deu a ESTA conversa) vence o
 * nome da PESSOA (`PersonProfile.customName`, a correção que vale em todos os
 * grupos dela), que vence o `title` que veio do WhatsApp e que o sync
 * sobrescreve.
 *
 * O degrau do meio não é detalhe: quem corrige um nome pelo lápis espera vê-lo
 * em todo lugar, e um relatório de avaliação que ainda mostrasse o pushName
 * antigo faria o administrador procurar no chat um cliente que já não se chama
 * assim. Em conversa de GRUPO ele não existe (o nome é do grupo), então a
 * cadeia cai direto no `title`.
 */
export function conversationDisplayTitle(
  conversation: { title: string | null; customTitle: string | null } | null | undefined,
  personName?: string | null,
): string | null {
  if (!conversation) return null;
  return conversation.customTitle?.trim() || personName?.trim() || conversation.title?.trim() || null;
}

/**
 * Os títulos de uma PÁGINA inteira, em uma consulta a mais — nunca uma por
 * conversa. `resolveConversationPersonNames` já resolve em lote e só olha as
 * individuais, então a lista de grupos não paga nada.
 */
export async function resolveQualityTitles(
  prisma: PrismaClient,
  organizationId: string,
  conversations: ReadonlyArray<QualityConversationRef | null | undefined>,
): Promise<Map<string, string | null>> {
  const reais = conversations.filter((conversation): conversation is QualityConversationRef => conversation != null);
  const nomes = await resolveConversationPersonNames(prisma, organizationId, reais);
  const titulos = new Map<string, string | null>();
  for (const conversation of reais) {
    titulos.set(conversation.id, conversationDisplayTitle(conversation, nomes.get(conversation.id)));
  }
  return titulos;
}

/**
 * Não lidas da Inbox — por usuário, e por isso fora do DTO da conversa.
 *
 * O DTO da conversa é publicado por socket para a audiência inteira (todos
 * que enxergam aquela conversa), então um contador dentro dele seria o mesmo
 * número para todo mundo — exatamente o defeito que a leitura por usuário
 * veio consertar. O contador chega em separado: o mapa inicial na resposta
 * da lista, e as mudanças pelo evento `conversation:read`, dirigido só às
 * abas de quem leu.
 *
 * Regras puras, sem React, para ficarem cobertas por teste.
 */

/** Contador de cada conversa, pela chave do id. */
export type UnreadCounts = Readonly<Record<string, number>>;

/**
 * Acima disto o badge vira "99+". A API também para de contar aí (o teto
 * dela é 100): saber que são 4.000 não muda um pixel da tela.
 */
export const UNREAD_BADGE_CAP = 99;

/** Texto do badge. Zero não desenha badge nenhum — quem decide é a tela. */
export function formatUnreadBadge(count: number): string {
  return count > UNREAD_BADGE_CAP ? `${UNREAD_BADGE_CAP}+` : String(count);
}

/** Define o contador de uma conversa (leitura, "não lida", recarga). */
export function setUnreadCount(
  counts: UnreadCounts,
  conversationId: string,
  count: number,
): UnreadCounts {
  if ((counts[conversationId] ?? 0) === count) return counts;
  return { ...counts, [conversationId]: count };
}

/**
 * Mensagem recebida numa conversa que esta pessoa não está com aberta: o
 * contador dela sobe. É local de propósito — cada aba soma o que chegou para
 * quem está logado nela, e ninguém precisa consultar o servidor por mensagem.
 */
export function bumpUnreadCount(counts: UnreadCounts, conversationId: string): UnreadCounts {
  const current = counts[conversationId] ?? 0;
  // Passar do teto não muda o badge ("99+"), e deixar o número crescer sem
  // limite só criaria diferença invisível com o que a API devolveria.
  if (current > UNREAD_BADGE_CAP) return counts;
  return { ...counts, [conversationId]: current + 1 };
}

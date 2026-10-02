/**
 * Conversa fixada no topo da lista — POR USUÁRIO, como no WhatsApp Web.
 *
 * Fonte única do teto e do formato do mapa, porque a API recusa com ele e a
 * tela ordena com ele. Não confundir com a fixação de MENSAGEM
 * (`PinnedItem`), que é da equipe e vive dentro da conversa.
 */

/** Quantas conversas cada pessoa pode fixar — o mesmo teto do WhatsApp. */
export const MAX_PINNED_CONVERSATIONS = 3;

/**
 * As fixadas de UMA pessoa: id da conversa → instante em que ela fixou
 * (ISO). O instante é o que ordena o topo: a fixada mais recente fica em
 * primeiro, igual ao WhatsApp. Ausência no mapa = não fixada.
 */
export type ConversationPinMap = Record<string, string>;

/**
 * Ordena a lista com as fixadas no topo (a mais recente primeiro) e o resto
 * na ordem em que veio. Estável de propósito: a ordem por última mensagem
 * que o servidor e o tempo real já decidiram não pode ser embaralhada.
 */
export function sortWithPinnedFirst<T extends { id: string }>(
  items: readonly T[],
  pinned: ConversationPinMap,
): T[] {
  const fixadas = items
    .filter((item) => pinned[item.id] !== undefined)
    .sort((a, b) => (pinned[b.id] ?? "").localeCompare(pinned[a.id] ?? ""));
  if (fixadas.length === 0) return [...items];
  return [...fixadas, ...items.filter((item) => pinned[item.id] === undefined)];
}

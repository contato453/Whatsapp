/**
 * Título efetivo de uma conversa para as telas do Quality.
 *
 * `customTitle` (apelido que a equipe deu) vence `title` (o que vem do
 * WhatsApp, e que o sync sobrescreve) — a mesma precedência do resto do sistema.
 * Vive num arquivo próprio, e não copiada dentro da rota, porque quatro respostas
 * do módulo precisam dela e a quinta divergiria.
 */
export function conversationDisplayTitle(
  conversation: { title: string | null; customTitle: string | null } | null | undefined,
): string | null {
  if (!conversation) return null;
  return conversation.customTitle?.trim() || conversation.title?.trim() || null;
}

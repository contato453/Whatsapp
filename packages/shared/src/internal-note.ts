/**
 * Quem pode editar ou excluir uma nota interna.
 *
 * A regra mora aqui porque a API decide se aceita e a tela decide se desenha
 * os botões — e agora são DOIS lugares na tela (o cartão dentro da conversa e
 * o item do painel lateral). Regra copiada em três pontos vira afrouxamento
 * silencioso no dia em que um deles mudar: a tela ofereceria o lápis e a API
 * responderia 403, ou pior, o inverso passaria despercebido.
 */

/** Papéis que podem mexer em nota de terceiro. Abaixo disso, só a própria. */
export type InternalNoteActorRole = "admin" | "supervisor" | "agent";

export interface InternalNoteManagePermission {
  /** Autor da nota. Nulo quando o usuário foi excluído do cadastro. */
  authorId: string | null | undefined;
  /** Quem está pedindo. Nulo enquanto a sessão ainda carrega — nega. */
  actorId: string | null | undefined;
  actorRole: InternalNoteActorRole | null | undefined;
}

/**
 * Autor sempre pode; supervisor e admin podem em nota de qualquer um.
 * Sessão ainda carregando (`actorId`/`actorRole` nulos) cai no lado seguro:
 * esconder o botão custa um clique, mostrar um que a API recusa custa
 * confiança.
 */
export function canManageInternalNote({
  authorId,
  actorId,
  actorRole,
}: InternalNoteManagePermission): boolean {
  if (!actorRole) return false;
  if (actorRole === "admin" || actorRole === "supervisor") return true;
  return Boolean(actorId) && authorId === actorId;
}

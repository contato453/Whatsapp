/**
 * Quem pode editar ou excluir uma nota interna.
 *
 * A regra mora aqui porque a API decide se aceita e a tela decide se desenha
 * os botões — e agora são DOIS lugares na tela (o cartão dentro da conversa e
 * o item do painel lateral). Regra copiada em três pontos vira afrouxamento
 * silencioso no dia em que um deles mudar: a tela ofereceria o lápis e a API
 * responderia 403, ou pior, o inverso passaria despercebido.
 */

export interface InternalNoteManagePermission {
  /** Autor da nota. Nulo quando o usuário foi excluído do cadastro. */
  authorId: string | null | undefined;
  /** Quem está pedindo. Nulo enquanto a sessão ainda carrega — nega. */
  actorId: string | null | undefined;
  /**
   * Chave `note.delete_other` do catálogo de permissões, já resolvida
   * (padrão: supervisor para cima).
   *
   * É booleano, e não papel, de propósito: com o papel aqui, ligar a chave
   * na tela de Permissões mudaria a API e não mudaria o botão — e a
   * configuração viraria mentira visual exatamente no lugar onde este
   * arquivo existe para impedir a divergência.
   */
  canManageOthers: boolean;
}

/**
 * Autor sempre pode — isso é código, não chave, e é o que garante que
 * nenhuma configuração tranque a pessoa fora da própria nota. Nota de
 * terceiro depende da chave.
 *
 * Sessão ainda carregando (`actorId` nulo, `canManageOthers` falso) cai no
 * lado seguro: esconder o botão custa um clique, mostrar um que a API recusa
 * custa confiança.
 */
export function canManageInternalNote({
  authorId,
  actorId,
  canManageOthers,
}: InternalNoteManagePermission): boolean {
  if (canManageOthers) return true;
  return Boolean(actorId) && authorId === actorId;
}

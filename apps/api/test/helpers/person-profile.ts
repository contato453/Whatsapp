/**
 * Organização sem NENHUM registro de pessoa (`PersonProfile`) — o estado de
 * quem nunca editou participante depois da unificação, e o que a maioria dos
 * testes de rota quer: tudo caindo no legado por grupo.
 *
 * Fica aqui pelo mesmo motivo do `rolePermissionStub`: a resolução do nome
 * da pessoa entrou no caminho de QUEM PUBLICA conversa (lista, detalhe,
 * eventos), e um `fakePrisma` sem esta delegação falharia com 500 — o teste
 * pareceria reprovar a regra quando na verdade reprovou o próprio dublê.
 */
export const personProfileStub = {
  findMany: async () => [] as Array<Record<string, unknown>>,
  findUnique: async () => null,
};

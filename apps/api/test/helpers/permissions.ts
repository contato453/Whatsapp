/**
 * Organização sem NENHUMA linha de configuração de permissão — o estado
 * normal de quem nunca abriu a tela de Permissões, e o que os testes de
 * rota querem exercitar: tudo decidido pelos padrões do catálogo.
 *
 * Fica aqui, e não repetido em cada arquivo, porque toda rota autenticada
 * passa pelo motor de permissão: um `fakePrisma` que esquecesse esta
 * delegação falharia com 500, e o teste pareceria reprovar a regra quando
 * na verdade reprovou o próprio dublê.
 */
export const rolePermissionStub = {
  findMany: async () => [] as Array<{ role: string; action: string; allowed: boolean }>,
};

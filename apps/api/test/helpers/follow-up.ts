/**
 * Organização sem NENHUMA regra de follow-up automático cadastrada — o
 * estado de quem nunca abriu a tela de Automações.
 *
 * Fica aqui pelo mesmo motivo do `rolePermissionStub`: `reconcileConversation`
 * (`lib/follow-up-engine.ts`) passou a ser chamada depois de status, resolver,
 * reabrir, arquivar e transferir departamento — TODA rota que mexe nisso. Um
 * `fakePrisma` sem esta delegação falharia com 500, e o teste pareceria
 * reprovar a regra da rota quando na verdade reprovou o próprio dublê.
 */
export const followUpRuleStub = {
  findMany: async () => [] as Array<Record<string, unknown>>,
  findFirst: async () => null,
  findUnique: async () => null,
};

export const followUpExecutionStub = {
  findMany: async () => [] as Array<Record<string, unknown>>,
  findFirst: async () => null,
  findUnique: async () => null,
  groupBy: async () => [] as Array<Record<string, unknown>>,
};

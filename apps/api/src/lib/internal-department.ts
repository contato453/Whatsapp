import type { Prisma, PrismaClient } from "@azvchat/database";

/**
 * Departamentos INTERNOS — o que fica de fora dos números.
 *
 * **Por que este arquivo existe.** Grupo interno da equipe não é atendimento
 * a cliente, mas o sistema o contava como tal: ele entrava nos cards do
 * dashboard, nos gráficos e no relatório por atendente. O pior caso era o
 * "Atrasados agora" — num grupo interno a última mensagem é quase sempre de
 * entrada, ninguém "responde" a ela, e a conversa acumulava atraso para
 * sempre. O painel passava a medir conversa nossa em vez de cliente
 * esperando, que é exatamente o número que faz a equipe parar de confiar na
 * tela.
 *
 * **Interno NÃO é arquivado.** Arquivar faz duas coisas juntas: some da
 * lista (sem badge, sem som, sem piscar o título) e sai dos números. Aqui só
 * a segunda vale — a equipe usa esses grupos o dia inteiro e precisa ser
 * avisada de mensagem neles. Por isso `conversation-reads.ts`, o som e o
 * título da aba não sabem que isto existe, e nem devem passar a saber.
 *
 * **E não é visibilidade.** Nada aqui encosta em `lib/access.ts`: o recorte
 * entra POR CIMA do escopo, e só sabe TIRAR conversa de uma contagem —
 * nunca trazer de volta uma que a pessoa não enxergaria.
 */

/**
 * Os ids dos departamentos marcados como internos.
 *
 * Lido a cada requisição, sem cache, pelo mesmo motivo dos parâmetros de
 * atendimento: marcar um departamento como interno tem que limpar o número
 * na próxima atualização da tela, e não depois de reiniciar o container.
 * São poucas linhas por organização, com índice próprio.
 */
export async function loadInternalDepartmentIds(
  prisma: PrismaClient,
  organizationId: string,
): Promise<string[]> {
  const rows = await prisma.department.findMany({
    where: { organizationId, isInternal: true },
    select: { id: true },
  });
  return rows.map((row) => row.id);
}

/**
 * O recorte, pronto para ser ACRESCENTADO ao `AND` que já carrega
 * `conversationScope` — nunca posto no lugar dele.
 *
 * Sem departamento interno nenhum não devolve item algum: um `AND` com
 * objeto vazio dentro não filtra nada e só polui a consulta.
 *
 * A conversa **sem departamento** continua contando, e por isso o ramo
 * explícito do `null`: em SQL, `departmentId NOT IN (...)` é nulo quando a
 * coluna é nula, então a conversa que o número não classificou sumiria dos
 * números sem ninguém pedir — e ela é justamente a que precisa de atenção.
 */
export function excludeInternalDepartments(
  internalDepartmentIds: string[],
): Prisma.ConversationWhereInput[] {
  if (internalDepartmentIds.length === 0) return [];
  return [
    { OR: [{ departmentId: null }, { departmentId: { notIn: internalDepartmentIds } }] },
  ];
}

/** Atalho para quem só quer o recorte, sem guardar os ids. */
export async function internalDepartmentConditions(
  prisma: PrismaClient,
  organizationId: string,
): Promise<Prisma.ConversationWhereInput[]> {
  return excludeInternalDepartments(await loadInternalDepartmentIds(prisma, organizationId));
}

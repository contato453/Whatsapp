import type { PrismaClient } from "@azvchat/database";
import { AppError } from "./errors.js";

/**
 * Confere que todo id marcado num filtro existe na organização.
 *
 * **Por que recusar em vez de ignorar.** Um id desconhecido ignorado em
 * silêncio produz uma lista plausível recortada por um critério diferente do
 * que a pessoa marcou: ela lê a tela achando que está vendo "Contábil mais
 * Fiscal" quando o Fiscal foi descartado. Erro visível é melhor do que
 * resposta errada com cara de certa.
 *
 * Isso não briga com a poda silenciosa da tela: lá o item extinto é removido
 * do estado guardado ANTES de virar consulta, justamente para o atendente
 * nunca ver este 400. Chegar um id desconhecido aqui significa link colado à
 * mão ou estado corrompido, e aí o erro é a resposta certa.
 *
 * As quatro checagens saem em paralelo e só para a lista que veio preenchida:
 * filtro não usado não paga consulta.
 */
export async function assertKnownFilterIds(
  prisma: PrismaClient,
  organizationId: string,
  filtros: {
    departmentIds: string[];
    userIds: string[];
    tagIds: string[];
    instanceIds: string[];
  },
): Promise<void> {
  const [departments, users, tags, instances] = await Promise.all([
    filtros.departmentIds.length > 0
      ? prisma.department.findMany({
          where: { organizationId, id: { in: filtros.departmentIds } },
          select: { id: true },
        })
      : Promise.resolve([]),
    filtros.userIds.length > 0
      ? prisma.user.findMany({
          where: { organizationId, id: { in: filtros.userIds } },
          select: { id: true },
        })
      : Promise.resolve([]),
    filtros.tagIds.length > 0
      ? prisma.tag.findMany({
          where: { organizationId, id: { in: filtros.tagIds } },
          select: { id: true },
        })
      : Promise.resolve([]),
    filtros.instanceIds.length > 0
      ? prisma.whatsAppInstance.findMany({
          where: { organizationId, id: { in: filtros.instanceIds } },
          select: { id: true },
        })
      : Promise.resolve([]),
  ]);

  conferir("departamento", filtros.departmentIds, departments);
  conferir("responsável", filtros.userIds, users);
  conferir("etiqueta", filtros.tagIds, tags);
  conferir("conexão de WhatsApp", filtros.instanceIds, instances);
}

/**
 * A mensagem diz QUAL filtro tem o item desconhecido, mas nunca o id: id de
 * departamento ou de pessoa numa mensagem de erro é dado de cadastro
 * vazando por uma porta que ninguém audita.
 */
function conferir(rotulo: string, pedidos: string[], achados: Array<{ id: string }>): void {
  if (pedidos.length === 0 || achados.length === pedidos.length) return;
  throw new AppError(`Filtro de ${rotulo} com item que não existe mais.`, 400, "validation_error");
}

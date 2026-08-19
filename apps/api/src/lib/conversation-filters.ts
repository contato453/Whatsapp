import { z } from "zod";
import type { PrismaClient } from "@azvchat/database";
import { AppError } from "./errors.js";

/**
 * Um parâmetro de filtro que aceita LISTA. A tela manda o mesmo nome
 * repetido (`?tagId=a&tagId=b`), e aceitamos também separado por vírgula
 * porque é o que um link colado à mão costuma trazer. Ausente ou vazio vira
 * lista vazia, que significa "todos" — nunca "nenhum".
 *
 * Fica aqui, e não dentro de um módulo de rota, porque a Inbox e o Dashboard
 * precisam ler lista do MESMO jeito: duas cópias divergiriam no dia em que
 * uma delas passasse a aceitar (ou a recusar) o separador por vírgula, e o
 * link que funciona numa tela quebraria na outra.
 *
 * O teto de itens não é conforto de tela: a lista vira `IN (...)` e, quando é
 * de id, uma consulta de conferência. Um link forjado com milhares de valores
 * chegaria ao limite de parâmetros do Postgres e derrubaria a requisição com
 * erro de driver, que não diz nada a ninguém. Recusar com 400 é a resposta
 * honesta, e nenhuma tela chega perto do teto — a organização inteira tem
 * dezenas de departamentos, pessoas e números.
 */
const MAX_ITENS_POR_FILTRO = 200;

export function listaDe<T extends z.ZodTypeAny>(item: T) {
  return z.preprocess((valor) => {
    if (valor === undefined || valor === null || valor === "") return [];
    const bruto = Array.isArray(valor) ? valor : [valor];
    return bruto
      .flatMap((entrada) => String(entrada).split(","))
      .map((entrada) => entrada.trim())
      .filter((entrada) => entrada.length > 0);
  }, z.array(item).max(MAX_ITENS_POR_FILTRO, "Filtro com valores demais")).default([]);
}

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

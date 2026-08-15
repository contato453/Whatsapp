import type { PrismaClient } from "@azvchat/database";
import { z } from "zod";
import { canWriteGeneralResource, canWriteInAllDepartments } from "./access.js";
import type { AuthTokenPayload } from "./auth.js";
import { AppError, ForbiddenError } from "./errors.js";

/**
 * Regras comuns de etiqueta e resposta rápida, que se relacionam com
 * departamento em N:N e têm exatamente o mesmo contrato: ou o item é geral,
 * ou tem pelo menos um departamento.
 *
 * Vive aqui, e não duplicado nas duas rotas, para que as duas não possam
 * divergir: uma diferença silenciosa entre elas seria um furo de acesso.
 */

/**
 * Estado de destino válido — validado nos dois sentidos:
 * geral nunca vem com departamento, restrito nunca vem vazio.
 *
 * O vazio é recusado porque um item restrito sem departamento não aparece
 * para ninguém além do admin. Ele pode existir no banco (é o que sobra
 * quando o departamento é excluído), mas nunca pode ser criado assim.
 */
export const departmentTargetSchema = z
  .object({
    isGeneral: z.boolean(),
    departmentIds: z.array(z.string().uuid()),
  })
  .refine((target) => !(target.isGeneral && target.departmentIds.length > 0), {
    message: "Item geral vale para todos os departamentos e não aceita seleção",
    path: ["departmentIds"],
  })
  .refine((target) => target.isGeneral || target.departmentIds.length > 0, {
    message: "Selecione pelo menos um departamento",
    path: ["departmentIds"],
  });

export interface DepartmentTarget {
  isGeneral: boolean;
  /** Já sem repetição: o vínculo é substituído em bloco, nunca somado. */
  departmentIds: string[];
}

/**
 * Valida o estado de destino, confere que os departamentos são da
 * organização e decide se esta pessoa pode gravar assim.
 *
 * Escrita exige acesso a TODOS os departamentos escolhidos, não a um só:
 * com acesso apenas ao Fiscal ninguém pendura a etiqueta também no Contábil.
 * Falta um, nada é gravado.
 */
export async function resolveDepartmentTarget(
  prisma: PrismaClient,
  user: AuthTokenPayload,
  accessibleIds: string[] | null,
  input: { isGeneral: boolean; departmentIds: string[] },
  labels: { general: string; foreign: string },
): Promise<DepartmentTarget> {
  const target = departmentTargetSchema.parse({
    isGeneral: input.isGeneral,
    departmentIds: [...new Set(input.departmentIds)],
  });

  if (target.isGeneral) {
    // Quem cria item geral continua sendo só o admin, como antes do N:N.
    if (!canWriteGeneralResource(accessibleIds)) throw new ForbiddenError(labels.general);
    return { isGeneral: true, departmentIds: [] };
  }

  const found = await prisma.department.findMany({
    where: { id: { in: target.departmentIds }, organizationId: user.organizationId },
    select: { id: true },
  });
  if (found.length !== target.departmentIds.length) {
    throw new AppError("Departamento inválido", 400, "invalid_department");
  }
  if (!canWriteInAllDepartments(accessibleIds, target.departmentIds)) {
    throw new ForbiddenError(labels.foreign);
  }
  return { isGeneral: false, departmentIds: target.departmentIds };
}

/**
 * Pode mexer no item como ele está hoje?
 *
 * É a checagem do estado atual, feita antes de olhar o destino: sem ela,
 * quem tem acesso ao Fiscal editaria uma etiqueta só do Contábil bastando
 * mandar o Fiscal no corpo da requisição.
 *
 * Item que ficou sem departamento (o departamento foi excluído) é assunto de
 * admin: para os demais ele nem aparece na listagem.
 */
export function assertCanManageResource(
  accessibleIds: string[] | null,
  current: { isGeneral: boolean; departmentIds: string[] },
  labels: { general: string; foreign: string; orphan: string },
): void {
  if (accessibleIds === null) return;
  if (current.isGeneral) throw new ForbiddenError(labels.general);
  if (current.departmentIds.length === 0) throw new ForbiddenError(labels.orphan);
  if (!canWriteInAllDepartments(accessibleIds, current.departmentIds)) {
    throw new ForbiddenError(labels.foreign);
  }
}

/**
 * A etiqueta vale para esta conversa?
 *
 * Geral vale sempre; restrita, só se o departamento da conversa estiver
 * entre os dela. Conversa sem departamento aceita qualquer etiqueta que a
 * pessoa enxergue — é o comportamento que já existia, e ela aparece quando o
 * número não tem departamento padrão.
 *
 * Serve também para o `/atalho`: a resposta rápida segue a mesma regra.
 */
export function canApplyToConversation(
  resource: { isGeneral: boolean; departments: Array<{ departmentId: string }> },
  conversationDepartmentId: string | null,
): boolean {
  if (resource.isGeneral) return true;
  if (conversationDepartmentId === null) return true;
  return resource.departments.some((link) => link.departmentId === conversationDepartmentId);
}

/**
 * Retrato do vínculo para a auditoria — o antes e o depois de cada edição.
 * Só id e nome: o log de auditoria não é lugar de carregar entidade inteira.
 */
export function auditDepartmentSnapshot(
  isGeneral: boolean,
  links: Array<{ department: { id: string; name: string } }>,
): { isGeneral: boolean; departments: Array<{ id: string; name: string }> } {
  return {
    isGeneral,
    departments: links.map((link) => ({ id: link.department.id, name: link.department.name })),
  };
}

import { describe, expect, it } from "vitest";
import type { PrismaClient } from "@azvchat/database";
import {
  canWriteGeneralResource,
  canWriteInAllDepartments,
  departmentResourceScope,
  type DepartmentResourceScope,
} from "../src/lib/access.js";
import {
  assertCanManageResource,
  auditDepartmentSnapshot,
  canApplyToConversation,
  departmentTargetSchema,
  resolveDepartmentTarget,
} from "../src/lib/department-resource.js";
import type { AuthTokenPayload } from "../src/lib/auth.js";

/**
 * Etiquetas e respostas rápidas em N:N com departamento.
 *
 * O cenário da operação, usado o tempo todo aqui: a etiqueta "Urgente" vale
 * para Contábil e Fiscal ao mesmo tempo. Supervisor só do Fiscal enxerga e
 * aplica; usuário só do DP não enxerga; a etiqueta geral aparece para todos.
 */

const CONTABIL = "11111111-1111-4111-8111-111111111111";
const FISCAL = "22222222-2222-4222-8222-222222222222";
const DP = "33333333-3333-4333-8333-333333333333";

interface FakeResource {
  nome: string;
  isGeneral: boolean;
  departments: Array<{ departmentId: string }>;
}

const urgente: FakeResource = {
  nome: "Urgente",
  isGeneral: false,
  departments: [{ departmentId: CONTABIL }, { departmentId: FISCAL }],
};
const geral: FakeResource = { nome: "Aguardando cliente", isGeneral: true, departments: [] };
const soDoDp: FakeResource = {
  nome: "Folha",
  isGeneral: false,
  departments: [{ departmentId: DP }],
};

/**
 * Interpreta o filtro do Prisma na mão, com a mesma semântica que o banco
 * aplicaria: `{}` não filtra nada, e o `OR` casa quando qualquer ramo casa.
 * É o que deixa o cenário legível em vez de comparar objetos de filtro.
 */
function enxerga(scope: DepartmentResourceScope, resource: FakeResource): boolean {
  if (!scope.OR) return true;
  return scope.OR.some((branch) => {
    if ("isGeneral" in branch) return resource.isGeneral;
    const permitidos = branch.departments.some.departmentId.in;
    return resource.departments.some((link) => permitidos.includes(link.departmentId));
  });
}

function user(role: AuthTokenPayload["role"]): AuthTokenPayload {
  return {
    sub: "user-1",
    organizationId: "org-1",
    role,
    name: "Fulano",
    email: "fulano@example.com",
  };
}

/** Prisma falso: só responde quais departamentos existem na organização. */
function fakePrisma(existentes: string[]): PrismaClient {
  return {
    department: {
      findMany: async ({ where }: { where: { id: { in: string[] } } }) =>
        where.id.in.filter((id) => existentes.includes(id)).map((id) => ({ id })),
    },
  } as unknown as PrismaClient;
}

describe("visibilidade N:N", () => {
  it("supervisor só do Fiscal enxerga a etiqueta de Contábil e Fiscal", () => {
    const scope = departmentResourceScope([FISCAL]);
    expect(enxerga(scope, urgente)).toBe(true);
  });

  it("usuário só do DP não enxerga a etiqueta de Contábil e Fiscal", () => {
    const scope = departmentResourceScope([DP]);
    expect(enxerga(scope, urgente)).toBe(false);
  });

  it("a etiqueta geral aparece para os três", () => {
    expect(enxerga(departmentResourceScope([FISCAL]), geral)).toBe(true);
    expect(enxerga(departmentResourceScope([DP]), geral)).toBe(true);
    expect(enxerga(departmentResourceScope(null), geral)).toBe(true);
  });

  it("admin enxerga tudo, sem filtro", () => {
    const scope = departmentResourceScope(null);
    expect(enxerga(scope, urgente)).toBe(true);
    expect(enxerga(scope, soDoDp)).toBe(true);
  });

  it("basta um departamento em comum — não precisa de todos", () => {
    // É a diferença entre ler e escrever: ler exige um, escrever exige todos.
    expect(enxerga(departmentResourceScope([CONTABIL]), urgente)).toBe(true);
  });
});

describe("fail closed depois da exclusão de departamento", () => {
  // Excluir o Fiscal deixa "Urgente" só com o Contábil; excluir o Contábil
  // também a deixa sem departamento nenhum. O registro continua existindo.
  const semFiscal: FakeResource = {
    nome: "Urgente",
    isGeneral: false,
    departments: [{ departmentId: CONTABIL }],
  };
  const orfa: FakeResource = { nome: "Urgente", isGeneral: false, departments: [] };

  it("sem o Fiscal, quem é do Contábil continua enxergando", () => {
    expect(enxerga(departmentResourceScope([CONTABIL]), semFiscal)).toBe(true);
    expect(enxerga(departmentResourceScope([FISCAL]), semFiscal)).toBe(false);
  });

  it("sem departamento nenhum, some para todo mundo que não é admin", () => {
    // Este é o ponto da flag: lista vazia NÃO vira geral. Se virasse, uma
    // etiqueta restrita passaria a valer para a organização inteira só
    // porque um departamento foi excluído.
    expect(orfa.isGeneral).toBe(false);
    expect(enxerga(departmentResourceScope([CONTABIL]), orfa)).toBe(false);
    expect(enxerga(departmentResourceScope([FISCAL]), orfa)).toBe(false);
    expect(enxerga(departmentResourceScope([]), orfa)).toBe(false);
  });

  it("mas o admin continua vendo, para poder arrumar", () => {
    expect(enxerga(departmentResourceScope(null), orfa)).toBe(true);
  });

  it("quem não é admin não consegue nem editar a órfã", () => {
    expect(() =>
      assertCanManageResource([CONTABIL], { isGeneral: false, departmentIds: [] }, LABELS),
    ).toThrowError(/sem departamento/);
  });
});

const LABELS = {
  general: "Apenas o administrador",
  foreign: "Departamento fora do seu alcance",
  orphan: "Item sem departamento",
};

describe("escrita exige TODOS os departamentos", () => {
  it("supervisor do Fiscal e do Contábil grava nos dois", () => {
    expect(canWriteInAllDepartments([FISCAL, CONTABIL], [CONTABIL, FISCAL])).toBe(true);
  });

  it("supervisor só do Fiscal não grava incluindo o Contábil", () => {
    expect(canWriteInAllDepartments([FISCAL], [CONTABIL, FISCAL])).toBe(false);
  });

  it("criar incluindo departamento fora do alcance é 403, sem gravação parcial", async () => {
    await expect(
      resolveDepartmentTarget(
        fakePrisma([CONTABIL, FISCAL, DP]),
        user("supervisor"),
        [FISCAL],
        { isGeneral: false, departmentIds: [CONTABIL, FISCAL] },
        LABELS,
      ),
    ).rejects.toMatchObject({ statusCode: 403 });
  });

  it("departamento de outra organização é 400, não 403", async () => {
    await expect(
      resolveDepartmentTarget(
        fakePrisma([FISCAL]),
        user("admin"),
        null,
        { isGeneral: false, departmentIds: [FISCAL, DP] },
        LABELS,
      ),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it("admin grava a combinação inteira", async () => {
    const target = await resolveDepartmentTarget(
      fakePrisma([CONTABIL, FISCAL]),
      user("admin"),
      null,
      { isGeneral: false, departmentIds: [CONTABIL, FISCAL] },
      LABELS,
    );
    expect(target).toEqual({ isGeneral: false, departmentIds: [CONTABIL, FISCAL] });
  });

  it("departamento repetido não vira vínculo duplicado", async () => {
    const target = await resolveDepartmentTarget(
      fakePrisma([FISCAL]),
      user("admin"),
      null,
      { isGeneral: false, departmentIds: [FISCAL, FISCAL] },
      LABELS,
    );
    expect(target.departmentIds).toEqual([FISCAL]);
  });
});

describe("quem cria item geral (regra inalterada)", () => {
  it("continua sendo só o admin", async () => {
    expect(canWriteGeneralResource(null)).toBe(true);
    await expect(
      resolveDepartmentTarget(
        fakePrisma([FISCAL]),
        user("supervisor"),
        [FISCAL],
        { isGeneral: true, departmentIds: [] },
        LABELS,
      ),
    ).rejects.toMatchObject({ statusCode: 403 });
  });

  it("admin cria geral e o vínculo sai vazio", async () => {
    const target = await resolveDepartmentTarget(
      fakePrisma([FISCAL]),
      user("admin"),
      null,
      { isGeneral: true, departmentIds: [] },
      LABELS,
    );
    expect(target).toEqual({ isGeneral: true, departmentIds: [] });
  });
});

describe("estado válido (refine nos dois sentidos)", () => {
  it("geral com departamento selecionado é recusado", () => {
    const result = departmentTargetSchema.safeParse({
      isGeneral: true,
      departmentIds: [FISCAL],
    });
    expect(result.success).toBe(false);
  });

  it("restrito sem nenhum departamento é recusado", () => {
    const result = departmentTargetSchema.safeParse({ isGeneral: false, departmentIds: [] });
    expect(result.success).toBe(false);
  });

  it("os dois estados válidos passam", () => {
    expect(departmentTargetSchema.safeParse({ isGeneral: true, departmentIds: [] }).success).toBe(
      true,
    );
    expect(
      departmentTargetSchema.safeParse({ isGeneral: false, departmentIds: [FISCAL] }).success,
    ).toBe(true);
  });
});

describe("aplicação na conversa", () => {
  it("etiqueta de Contábil e Fiscal aplica em conversa do Fiscal", () => {
    expect(canApplyToConversation(urgente, FISCAL)).toBe(true);
  });

  it("mas não em conversa do DP", () => {
    expect(canApplyToConversation(urgente, DP)).toBe(false);
  });

  it("etiqueta geral aplica em qualquer conversa", () => {
    expect(canApplyToConversation(geral, DP)).toBe(true);
    expect(canApplyToConversation(geral, null)).toBe(true);
  });

  it("conversa sem departamento aceita qualquer etiqueta visível", () => {
    // Comportamento preservado: essa conversa existe quando o número não tem
    // departamento padrão, e recusar tudo travaria o atendimento dela.
    expect(canApplyToConversation(urgente, null)).toBe(true);
    expect(canApplyToConversation(soDoDp, null)).toBe(true);
  });

  it("etiqueta órfã não se aplica a conversa com departamento", () => {
    // Fail closed: sem departamento, ela não casa com nenhum.
    expect(canApplyToConversation({ isGeneral: false, departments: [] }, FISCAL)).toBe(false);
  });
});

describe("auditoria registra o antes e o depois", () => {
  it("guarda a flag e a lista de departamentos, só id e nome", () => {
    expect(
      auditDepartmentSnapshot(false, [
        { department: { id: FISCAL, name: "Fiscal" } },
        { department: { id: CONTABIL, name: "Contábil" } },
      ]),
    ).toEqual({
      isGeneral: false,
      departments: [
        { id: FISCAL, name: "Fiscal" },
        { id: CONTABIL, name: "Contábil" },
      ],
    });
  });

  it("item geral sai com lista vazia", () => {
    expect(auditDepartmentSnapshot(true, [])).toEqual({ isGeneral: true, departments: [] });
  });
});

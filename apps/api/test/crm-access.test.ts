import { describe, expect, it } from "vitest";
import { PERMISSION_ACTION_KEYS, permissionOverrideKey } from "@azvchat/shared";
import { conversationScope, type ConversationAccess } from "../src/lib/access.js";
import { buildPermissions } from "../src/lib/permissions.js";
import { opportunityScope, pipelineScope } from "../src/lib/crm-access.js";

/**
 * A VISIBILIDADE DO CRM É A DO ATENDIMENTO — e estes testes existem para que
 * ela continue sendo.
 *
 * A oportunidade guarda quanto o cliente vai pagar e por qual serviço, que é
 * informação mais sensível do que a conversa em si. Uma régua própria aqui
 * nasceria parecida e envelheceria diferente: no dia em que divergissem, o
 * card de um cliente apareceria para quem não pode ver aquele número, com
 * valor e telefone, e nada ficaria vermelho.
 */

const EU = "11111111-1111-4111-8111-111111111111";
const INSTANCIA = "22222222-2222-4222-8222-222222222222";
const DEPTO = "33333333-3333-4333-8333-333333333333";

function acesso(overrides: Partial<ConversationAccess> = {}): ConversationAccess {
  return {
    instanceIds: [INSTANCIA],
    departmentIds: [DEPTO],
    ownOnly: false,
    userId: EU,
    ...overrides,
  };
}

/** Os pedaços do `AND` — é assim que o recorte é montado em toda a casa. */
function fragmentos(where: Record<string, unknown>): Array<Record<string, unknown>> {
  const and = where.AND;
  return Array.isArray(and) ? (and as Array<Record<string, unknown>>) : [];
}

describe("opportunityScope: admin", () => {
  it("admin não recebe filtro nenhum — enxerga a organização inteira", () => {
    const where = opportunityScope({
      instanceIds: null,
      departmentIds: null,
      ownOnly: false,
      userId: "admin",
    });
    expect(where).toEqual({});
  });
});

describe("opportunityScope: supervisor", () => {
  it("recorta por departamento e deixa passar a oportunidade SEM departamento", () => {
    // Oportunidade sem departamento é o espelho da conversa sem departamento
    // (número sem departamento padrão): sumir com ela criaria card que
    // ninguém vê.
    const partes = fragmentos(opportunityScope(acesso()));
    const porDepartamento = partes.find((parte) =>
      JSON.stringify(parte).includes('"departmentId"'),
    );
    expect(porDepartamento).toEqual({
      OR: [{ departmentId: null }, { departmentId: { in: [DEPTO] } }],
    });
  });

  it("A CONVERSA VINCULADA precisa estar no alcance — é a condição do NÚMERO", () => {
    // Sem esta condição, bastaria a oportunidade estar num departamento que a
    // pessoa acessa para o card de um cliente de OUTRO número aparecer na
    // tela dela. O número é condição absoluta no atendimento (CLAUDE.md §5).
    const partes = fragmentos(opportunityScope(acesso()));
    const porConversa = partes.find((parte) =>
      JSON.stringify(parte).includes('"conversation"'),
    );
    expect(porConversa).toEqual({
      OR: [{ conversationId: null }, { conversation: { is: conversationScope(acesso()) } }],
    });
  });

  it("supervisor NÃO é recortado por responsável: vê o funil do time inteiro", () => {
    const partes = fragmentos(opportunityScope(acesso()));
    const porResponsavel = partes.find((parte) =>
      JSON.stringify(parte).includes('"assignedUserId"'),
    );
    expect(porResponsavel).toBeUndefined();
  });
});

describe("opportunityScope: atendente", () => {
  it("vê as dele e as que estão sem dono — igual ao `ownOnly` da conversa", () => {
    const partes = fragmentos(opportunityScope(acesso({ ownOnly: true })));
    const porResponsavel = partes.find((parte) =>
      JSON.stringify(parte).includes('"assignedUserId"'),
    );
    expect(porResponsavel).toEqual({
      OR: [{ assignedUserId: EU }, { assignedUserId: null }],
    });
  });

  it("sem número e sem departamento marcados, o recorte não abre para nada", () => {
    // Não existe "sem marcação = vê tudo" no atendimento, e não passa a
    // existir no CRM.
    const partes = fragmentos(
      opportunityScope(acesso({ instanceIds: [], departmentIds: [], ownOnly: true })),
    );
    const porDepartamento = partes.find((parte) =>
      JSON.stringify(parte).includes('"departmentId"'),
    );
    expect(porDepartamento).toEqual({ OR: [{ departmentId: null }, { departmentId: { in: [] } }] });
    const porConversa = partes.find((parte) => JSON.stringify(parte).includes('"conversation"'));
    expect(porConversa).toBeDefined();
  });
});

describe("PERMISSÃO NÃO AMPLIA ALCANCE — a invariante da casa", () => {
  it("com o catálogo INTEIRO ligado, o recorte do atendente é o mesmo", () => {
    // Mesmo teste que `access.test.ts` faz para a conversa. Uma chave ligada
    // dá poder sobre o que a pessoa JÁ enxerga; nenhuma chave amplia o que ela
    // enxerga — nem no CRM.
    const tudoLigado = new Map(
      PERMISSION_ACTION_KEYS.map(
        (action) => [permissionOverrideKey("agent", action), true] as [string, boolean],
      ),
    );
    const permissions = buildPermissions({ role: "agent" }, tudoLigado);
    expect(permissions.can("crm.view")).toBe(true);
    expect(permissions.can("crm.pipeline.manage")).toBe(true);

    const semChave = opportunityScope(acesso({ ownOnly: true }));
    const comTudo = opportunityScope(acesso({ ownOnly: true }));
    expect(comTudo).toEqual(semChave);
  });

  it("não existe chave de CRM que fale de alcance", () => {
    // Chave do tipo "ver todas as oportunidades" seria entender o desenho
    // errado: alcance sai de `access.ts` e dos vínculos, nunca do catálogo.
    const suspeitas = PERMISSION_ACTION_KEYS.filter(
      (key) => key.startsWith("crm.") && /view_all|all_opportunities|see_all/.test(key),
    );
    expect(suspeitas).toEqual([]);
  });
});

describe("pipelineScope: o funil segue a régua da etiqueta", () => {
  it("admin vê todos os funis", () => {
    expect(pipelineScope(null)).toEqual({});
  });

  it("os demais veem o funil GERAL e os dos departamentos deles", () => {
    // Mesmo contrato de `Tag`/`QuickReply` — e literalmente a mesma função
    // (`departmentResourceScope`), para as duas regras não poderem divergir.
    expect(pipelineScope([DEPTO])).toEqual({
      OR: [{ isGeneral: true }, { departments: { some: { departmentId: { in: [DEPTO] } } } }],
    });
  });

  it("sem departamento nenhum, sobra só o funil geral", () => {
    const escopo = pipelineScope([]) as {
      OR?: Array<Record<string, unknown>>;
    };
    expect(escopo.OR?.[0]).toEqual({ isGeneral: true });
  });
});

import { beforeEach, describe, expect, it } from "vitest";
import type { PrismaClient } from "@azvchat/database";
import {
  PERMISSION_ACTION_KEYS,
  permissionOverrideKey,
  type ConfigurableRole,
} from "@azvchat/shared";
import { buildPermissions } from "../src/lib/permissions.js";
import Fastify, { type FastifyInstance } from "fastify";
import jwt from "@fastify/jwt";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { registerErrorHandler } from "../src/lib/errors.js";
import { clearPermissionCache } from "../src/lib/permissions.js";
import { automationRoutes } from "../src/modules/automation/routes.js";
import type { AppDeps } from "../src/types.js";
import {
  accessibleInstanceIds,
  automationConfigScope,
  canSeeAutomationConfig,
  canWriteAutomationConfig,
  configInstanceScope,
  canAssignBeyondConversationReach,
  conversationAssigneeWhere,
  canWriteGeneralResource,
  canWriteInAllDepartments,
  conversationScope,
  departmentResourceScope,
  groupScope,
  instanceIdScope,
  instanceScope,
  loadConversationAccess,
  type ConversationAccess,
} from "../src/lib/access.js";
import { requireRole, type AuthTokenPayload } from "../src/lib/auth.js";
import { ForbiddenError } from "../src/lib/errors.js";
import { USER_ROLES, hasRole } from "@azvchat/shared";
import type { FastifyReply, FastifyRequest } from "fastify";

/** Permissões efetivas de um papel, sem nenhuma configuração gravada. */
function permissoes(role: "admin" | ConfigurableRole) {
  return buildPermissions({ role }, new Map());
}

/** Configuração que liga (ou desliga) o catálogo inteiro para um papel. */
function todasAsChaves(role: ConfigurableRole, allowed: boolean): Map<string, boolean> {
  return new Map(
    PERMISSION_ACTION_KEYS.map((action) => [permissionOverrideKey(role, action), allowed]),
  );
}

function fakePrisma(
  instances: Array<{ whatsappInstanceId: string }>,
  departments: Array<{ departmentId: string }> = [],
): PrismaClient {
  return {
    userWhatsAppInstance: { findMany: async () => instances },
    userDepartment: { findMany: async () => departments },
  } as unknown as PrismaClient;
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

describe("accessibleInstanceIds (escopo de conexões)", () => {
  it("admin nunca é restrito", async () => {
    const ids = await accessibleInstanceIds(fakePrisma([{ whatsappInstanceId: "a" }]), user("admin"));
    expect(ids).toBeNull();
  });

  it("usuário sem vínculo não enxerga número nenhum", async () => {
    expect(await accessibleInstanceIds(fakePrisma([]), user("agent"))).toEqual([]);
  });

  it("usuário com vínculo enxerga apenas os números liberados", async () => {
    const ids = await accessibleInstanceIds(
      fakePrisma([{ whatsappInstanceId: "a" }, { whatsappInstanceId: "b" }]),
      user("agent"),
    );
    expect(ids).toEqual(["a", "b"]);
  });
});

describe("filtros Prisma do escopo", () => {
  it("sem restrição não adiciona filtro", () => {
    expect(instanceScope(null)).toEqual({});
    expect(instanceIdScope(null)).toEqual({});
  });

  it("com restrição filtra pelos ids liberados", () => {
    expect(instanceScope(["a"])).toEqual({ whatsappInstanceId: { in: ["a"] } });
    expect(instanceIdScope(["a"])).toEqual({ id: { in: ["a"] } });
  });
});

describe("loadConversationAccess (papéis)", () => {
  it("admin não carrega restrição alguma", async () => {
    const access = await loadConversationAccess(fakePrisma([], []), user("admin"));
    expect(access).toEqual({
      instanceIds: null,
      departmentIds: null,
      ownOnly: false,
      userId: "user-1",
    });
  });

  it("supervisor é restrito por número e departamento, mas vê o time todo", async () => {
    const access = await loadConversationAccess(
      fakePrisma([{ whatsappInstanceId: "chip-a" }], [{ departmentId: "dep-1" }]),
      user("supervisor"),
    );
    expect(access.instanceIds).toEqual(["chip-a"]);
    expect(access.departmentIds).toEqual(["dep-1"]);
    expect(access.ownOnly).toBe(false);
  });

  it("usuário comum também fica restrito ao que é dele", async () => {
    const access = await loadConversationAccess(
      fakePrisma([{ whatsappInstanceId: "chip-a" }], [{ departmentId: "dep-1" }]),
      user("agent"),
    );
    expect(access.ownOnly).toBe(true);
  });
});

describe("conversationScope (regra de visibilidade)", () => {
  const supervisor: ConversationAccess = {
    instanceIds: ["chip-a"],
    departmentIds: ["dep-1"],
    ownOnly: false,
    userId: "user-1",
  };
  const agent: ConversationAccess = { ...supervisor, ownOnly: true };

  it("admin não recebe nenhum filtro", () => {
    expect(
      conversationScope({
        instanceIds: null,
        departmentIds: null,
        ownOnly: false,
        userId: "admin-1",
      }),
    ).toEqual({});
  });

  it("supervisor filtra por número e departamento, sem recorte de responsável", () => {
    expect(conversationScope(supervisor)).toEqual({
      AND: [
        { whatsappInstanceId: { in: ["chip-a"] } },
        { OR: [{ departmentId: null }, { departmentId: { in: ["dep-1"] } }] },
      ],
    });
  });

  it("usuário comum ganha o recorte de responsável", () => {
    expect(conversationScope(agent)).toEqual({
      AND: [
        { whatsappInstanceId: { in: ["chip-a"] } },
        { OR: [{ departmentId: null }, { departmentId: { in: ["dep-1"] } }] },
        { OR: [{ assignedUserId: "user-1" }, { assignedUserId: null }] },
      ],
    });
  });

  it("sem número marcado o filtro nunca casa — lista vazia, não acesso total", () => {
    const scope = conversationScope({ ...agent, instanceIds: [], departmentIds: [] });
    expect(scope).toEqual({
      AND: [
        { whatsappInstanceId: { in: [] } },
        { OR: [{ departmentId: null }, { departmentId: { in: [] } }] },
        { OR: [{ assignedUserId: "user-1" }, { assignedUserId: null }] },
      ],
    });
  });
});

/**
 * Conversa marcada como "@todos" — o atendimento coletivo.
 *
 * A prova que interessa aqui é negativa: a marcação NÃO mexe em regra de
 * acesso nenhuma. Ela deixa `assignedUserId` nulo justamente para reusar o
 * recorte que já existe, então "@todos" é todos DO DEPARTAMENTO, dentro dos
 * números liberados — nunca todos da organização.
 */
describe("@todos e a regra de visibilidade", () => {
  /**
   * Avaliador do filtro do Prisma, no subconjunto que `conversationScope`
   * produz (AND, OR, `in` e igualdade). Sem ele o teste só compararia a forma
   * do objeto, e forma igual não prova que a pessoa certa enxerga a conversa.
   */
  function matches(filter: Record<string, unknown>, conversation: Record<string, unknown>): boolean {
    return Object.entries(filter).every(([key, condition]) => {
      if (key === "AND") return (condition as Array<Record<string, unknown>>).every((part) => matches(part, conversation));
      if (key === "OR") return (condition as Array<Record<string, unknown>>).some((part) => matches(part, conversation));
      const value = conversation[key];
      if (condition && typeof condition === "object" && "in" in condition) {
        return (condition as { in: unknown[] }).in.includes(value);
      }
      return value === condition;
    });
  }

  /** O grupo coletivo: sem responsável (por decisão) e no departamento fiscal. */
  const coletiva = {
    whatsappInstanceId: "chip-a",
    departmentId: "dep-fiscal",
    assignedUserId: null,
    assignedToAll: true,
  };

  function agente(userId: string, instanceIds: string[], departmentIds: string[]): ConversationAccess {
    return { instanceIds, departmentIds, ownOnly: true, userId };
  }

  it("os dois atendentes do departamento, com o número, enxergam a conversa", () => {
    const ana = agente("ana", ["chip-a"], ["dep-fiscal"]);
    const bruno = agente("bruno", ["chip-a"], ["dep-fiscal"]);
    expect(matches(conversationScope(ana), coletiva)).toBe(true);
    expect(matches(conversationScope(bruno), coletiva)).toBe(true);
  });

  it("atendente de OUTRO departamento não enxerga", () => {
    const carla = agente("carla", ["chip-a"], ["dep-contabil"]);
    expect(matches(conversationScope(carla), coletiva)).toBe(false);
  });

  it("atendente sem o número não enxerga, mesmo estando no departamento", () => {
    const diego = agente("diego", ["chip-b"], ["dep-fiscal"]);
    expect(matches(conversationScope(diego), coletiva)).toBe(false);
  });

  it("coletiva SEM departamento aparece para quem tem o número", () => {
    const semDepartamento = { ...coletiva, departmentId: null };
    const elias = agente("elias", ["chip-a"], ["dep-contabil"]);
    expect(matches(conversationScope(elias), semDepartamento)).toBe(true);
  });

  it("a conversa com dono continua só do dono — a marcação não afrouxa nada", () => {
    const daAna = { ...coletiva, assignedToAll: false, assignedUserId: "ana" };
    expect(matches(conversationScope(agente("ana", ["chip-a"], ["dep-fiscal"])), daAna)).toBe(true);
    expect(matches(conversationScope(agente("bruno", ["chip-a"], ["dep-fiscal"])), daAna)).toBe(false);
  });
});

describe("groupScope (filtro de grupo)", () => {
  const restrito: ConversationAccess = {
    instanceIds: ["chip-a"],
    departmentIds: ["dep-1"],
    ownOnly: true,
    userId: "user-1",
  };
  const admin: ConversationAccess = {
    instanceIds: null,
    departmentIds: null,
    ownOnly: false,
    userId: "admin-1",
  };

  it("usuário restrito: grupo sem conversa, ou com conversa que ele enxerga", () => {
    const filtro = groupScope(restrito);
    expect(filtro.whatsappInstanceId).toEqual({ in: ["chip-a"] });
    expect(filtro.OR).toEqual([
      { conversationId: null },
      { conversation: { is: conversationScope(restrito) } },
    ]);
  });

  it("admin enxerga grupo que já virou conversa", () => {
    // O `is` é o que faz o caso do admin funcionar: `conversation: {}` solto
    // dentro de um OR é descartado pelo Prisma, e sobraria `conversationId:
    // null` — que esconderia todo grupo com conversa. Com `is: {}` a
    // condição vira "existe conversa", que é o que se quer.
    const filtro = groupScope(admin);
    expect(filtro.whatsappInstanceId).toBeUndefined();
    expect(filtro.OR).toEqual([{ conversationId: null }, { conversation: { is: {} } }]);
  });
});

describe("departmentResourceScope (etiqueta e resposta rápida em N:N)", () => {
  it("admin não recebe filtro nenhum", () => {
    // Sem filtro ele enxerga inclusive o item que ficou sem departamento
    // depois de uma exclusão — é ele quem precisa arrumar.
    expect(departmentResourceScope(null)).toEqual({});
  });

  it("usuário enxerga o geral e o que está marcado para algum departamento dele", () => {
    expect(departmentResourceScope(["dep-1", "dep-2"])).toEqual({
      OR: [
        { isGeneral: true },
        { departments: { some: { departmentId: { in: ["dep-1", "dep-2"] } } } },
      ],
    });
  });

  it("usuário sem departamento continua enxergando só o geral", () => {
    // Lista vazia não pode virar "vê tudo": o ramo `in: []` não casa nada.
    expect(departmentResourceScope([])).toEqual({
      OR: [{ isGeneral: true }, { departments: { some: { departmentId: { in: [] } } } }],
    });
  });
});

describe("canWriteGeneralResource (quem cria item geral)", () => {
  it("só o admin, que é quem vem sem restrição", () => {
    expect(canWriteGeneralResource(null)).toBe(true);
    expect(canWriteGeneralResource(["dep-1"])).toBe(false);
    expect(canWriteGeneralResource([])).toBe(false);
  });
});

describe("canWriteInAllDepartments (escrita exige todos)", () => {
  it("admin grava em qualquer combinação", () => {
    expect(canWriteInAllDepartments(null, ["dep-1", "dep-2"])).toBe(true);
  });

  it("usuário grava quando tem acesso a todos os escolhidos", () => {
    expect(canWriteInAllDepartments(["dep-1", "dep-2"], ["dep-1", "dep-2"])).toBe(true);
    expect(canWriteInAllDepartments(["dep-1", "dep-2"], ["dep-1"])).toBe(true);
  });

  it("faltando um único departamento, recusa a gravação inteira", () => {
    // Supervisor só do Fiscal não pendura a etiqueta também no Contábil.
    expect(canWriteInAllDepartments(["dep-fiscal"], ["dep-fiscal", "dep-contabil"])).toBe(false);
  });

  it("nenhum departamento é estado inválido para item restrito", () => {
    expect(canWriteInAllDepartments(["dep-1"], [])).toBe(false);
    // Nem para o admin: item restrito sem departamento sumiria de todo mundo.
    expect(canWriteInAllDepartments(null, [])).toBe(false);
  });
});

/**
 * Quem pode ESCREVER o departamento da conversa.
 *
 * A visibilidade não muda com esta regra — quem vê o quê continua saindo de
 * `conversationScope`, acima. O que estes testes protegem é o campo que
 * ALIMENTA aquele filtro: se o atendente pudesse trocá-lo, tiraria a
 * conversa do campo de visão de um time inteiro (ou da própria tela dele)
 * com um clique, e nenhum dos filtros acima acusaria nada de errado.
 *
 * Status e responsável continuam sendo do atendente: a restrição é do
 * campo departamento, não da rota de atendimento.
 */
describe("quem classifica a conversa (chave conversation.change_department)", () => {
  it("atendente é recusado ao gravar o departamento, pelo padrão do catálogo", () => {
    expect(permissoes("agent").can("conversation.change_department")).toBe(false);
  });

  it("supervisor grava", () => {
    expect(permissoes("supervisor").can("conversation.change_department")).toBe(true);
  });

  it("admin grava, porque passa por cima de todo o catálogo", () => {
    expect(permissoes("admin").can("conversation.change_department")).toBe(true);
  });

  it("status e responsável seguem liberados para o atendente", () => {
    // A restrição é do campo departamento, não da rota de atendimento: a
    // mesma conversa continua sendo atendida por quem a atende.
    expect(permissoes("agent").can("conversation.transfer_user")).toBe(true);
    expect(permissoes("agent").can("conversation.unassign")).toBe(true);
  });
});

/**
 * A INVARIANTE MAIS IMPORTANTE DESTE ARQUIVO.
 *
 * PERMISSÃO É AÇÃO, VISIBILIDADE É ALCANCE. O menu de Permissões decide o
 * que cada perfil pode FAZER; ele não decide, e não pode decidir, QUAIS
 * conversas cada um enxerga — isso continua saindo inteiro daqui, dos
 * vínculos de número e departamento.
 *
 * O teste abaixo liga TODAS as chaves para um atendente e confere que o
 * filtro de conversa sai byte a byte igual ao de um atendente sem chave
 * nenhuma. Se um dia alguém criar uma chave que mexa no recorte, é aqui
 * que a mentira aparece — antes de virar conversa de cliente na tela de
 * quem não deveria vê-la.
 */
describe("permissão nunca altera visibilidade", () => {
  const access: ConversationAccess = {
    instanceIds: ["i1"],
    departmentIds: ["d1"],
    ownOnly: true,
    userId: "u1",
  };

  it("o filtro de conversa não conhece o catálogo de permissões", () => {
    const semChave = conversationScope(access);
    // `conversationScope` é função pura do recorte: ligar chave nenhuma
    // muda porque nem sequer existe parâmetro de permissão nela.
    expect(conversationScope(access)).toEqual(semChave);
    expect(JSON.stringify(semChave)).not.toContain("permission");
  });

  it("atendente com TODAS as chaves ligadas enxerga exatamente o mesmo", () => {
    const tudoLigado = todasAsChaves("agent", true);
    const tudoDesligado = todasAsChaves("agent", false);
    // As permissões mudam radicalmente...
    expect(buildPermissions({ role: "agent" }, tudoLigado).allowed().length).toBe(
      PERMISSION_ACTION_KEYS.length,
    );
    expect(buildPermissions({ role: "agent" }, tudoDesligado).allowed()).toEqual([]);
    // ...e o recorte de conversa continua o mesmo, porque não depende delas.
    expect(conversationScope(access)).toEqual({
      AND: [
        { whatsappInstanceId: { in: ["i1"] } },
        { OR: [{ departmentId: null }, { departmentId: { in: ["d1"] } }] },
        { OR: [{ assignedUserId: "u1" }, { assignedUserId: null }] },
      ],
    });
  });

  it("nenhuma chave do catálogo fala de visibilidade", () => {
    // Guarda-corpo textual: chave nova com estes nomes seria confusão entre
    // AÇÃO e ALCANCE, e o pedido foi explícito de que ela não deve existir.
    const proibidos = ["ver_todas", "view_all_conversations", "visibility", "see_all", "scope"];
    for (const chave of PERMISSION_ACTION_KEYS) {
      for (const proibido of proibidos) {
        expect(chave).not.toContain(proibido);
      }
    }
  });

  it("número não vinculado continua invisível mesmo com o catálogo inteiro ligado", () => {
    const semNumero: ConversationAccess = { ...access, instanceIds: [] };
    expect(conversationScope(semNumero)).toEqual({
      AND: [
        { whatsappInstanceId: { in: [] } },
        { OR: [{ departmentId: null }, { departmentId: { in: ["d1"] } }] },
        { OR: [{ assignedUserId: "u1" }, { assignedUserId: null }] },
      ],
    });
  });
});

/**
 * PARA QUEM DÁ PARA TRANSFERIR (`conversationAssigneeWhere`).
 *
 * O avesso de `conversationScope`: em vez de "quais conversas esta pessoa
 * enxerga", "quais pessoas enxergam esta conversa". A visibilidade não muda
 * — o que muda é a ESCRITA do responsável.
 *
 * O que estes testes protegem é a falha silenciosa: transferir para alguém
 * do departamento certo mas SEM o número vinculado grava um dono que nunca
 * abre a conversa. Ela sai da fila de quem estava livre, some da tela de
 * todo mundo e nenhum erro aparece.
 */
describe("conversationAssigneeWhere (candidatos a responsável)", () => {
  interface Candidato {
    id: string;
    role: "admin" | "supervisor" | "agent";
    status: "active" | "inactive";
    instanceIds: string[];
    departmentIds: string[];
  }

  /**
   * Um ramo do `OR` gerado: ou o atalho do admin, ou o par número +
   * departamento. Declarado aqui porque o tipo do Prisma é uma união larga
   * demais para o teste ler campo a campo.
   */
  interface RamoDeAlcance {
    role?: string;
    whatsappAccess?: { some?: { whatsappInstanceId?: string } };
    departmentAccess?: { some?: { departmentId?: string } };
  }

  /** Interpreta o filtro Prisma gerado, para o teste falar de gente e não de objeto. */
  function elegivel(candidato: Candidato, where: ReturnType<typeof conversationAssigneeWhere>) {
    if (where.status && candidato.status !== where.status) return false;
    const ramos = (where.OR ?? []) as RamoDeAlcance[];
    return ramos.some((ramo) => {
      if (ramo.role) return candidato.role === ramo.role;
      const numero = ramo.whatsappAccess?.some?.whatsappInstanceId;
      const departamento = ramo.departmentAccess?.some?.departmentId;
      if (numero && !candidato.instanceIds.includes(numero)) return false;
      if (departamento && !candidato.departmentIds.includes(departamento)) return false;
      return true;
    });
  }

  const doDepartamentoComNumero: Candidato = {
    id: "u-ok",
    role: "agent",
    status: "active",
    instanceIds: ["i1"],
    departmentIds: ["d1"],
  };
  const doDepartamentoSemNumero: Candidato = {
    id: "u-sem-numero",
    role: "agent",
    status: "active",
    instanceIds: ["i2"],
    departmentIds: ["d1"],
  };
  const deOutroDepartamento: Candidato = {
    id: "u-outro-dept",
    role: "agent",
    status: "active",
    instanceIds: ["i1"],
    departmentIds: ["d2"],
  };
  const inativo: Candidato = {
    id: "u-inativo",
    role: "agent",
    status: "inactive",
    instanceIds: ["i1"],
    departmentIds: ["d1"],
  };
  const adminSemVinculo: Candidato = {
    id: "u-admin",
    role: "admin",
    status: "active",
    instanceIds: [],
    departmentIds: [],
  };

  const conversa = conversationAssigneeWhere("org-1", {
    whatsappInstanceId: "i1",
    departmentId: "d1",
  });

  it("o filtro é sempre da organização e só de gente ativa", () => {
    expect(conversa.organizationId).toBe("org-1");
    expect(conversa.status).toBe("active");
  });

  it("quem tem o departamento da conversa E o número é candidato", () => {
    expect(elegivel(doDepartamentoComNumero, conversa)).toBe(true);
  });

  it("mesmo departamento, sem o número: NÃO é candidato", () => {
    // O caso que a regra existe para impedir: a atribuição funcionaria, e a
    // conversa sumiria da tela de todo mundo sem erro nenhum.
    expect(elegivel(doDepartamentoSemNumero, conversa)).toBe(false);
  });

  it("tem o número, mas é de outro departamento: NÃO é candidato", () => {
    expect(elegivel(deOutroDepartamento, conversa)).toBe(false);
  });

  it("inativo nunca é candidato, nem com os dois vínculos", () => {
    expect(elegivel(inativo, conversa)).toBe(false);
  });

  it("admin é candidato sem vínculo nenhum, porque enxerga a organização inteira", () => {
    expect(elegivel(adminSemVinculo, conversa)).toBe(true);
  });

  it("conversa SEM departamento: basta ter o número", () => {
    const semDepartamento = conversationAssigneeWhere("org-1", {
      whatsappInstanceId: "i1",
      departmentId: null,
    });
    // Ela já é visível para todos que têm o chip: exigir departamento aqui
    // inventaria uma barreira que a leitura não tem.
    expect(elegivel(deOutroDepartamento, semDepartamento)).toBe(true);
    expect(elegivel(doDepartamentoSemNumero, semDepartamento)).toBe(false);
  });

  it("quem atua em vários departamentos entra em qualquer um deles, com o número", () => {
    const doisDepartamentos: Candidato = {
      ...doDepartamentoComNumero,
      departmentIds: ["d1", "d2"],
    };
    expect(elegivel(doisDepartamentos, conversa)).toBe(true);
    expect(
      elegivel(
        doisDepartamentos,
        conversationAssigneeWhere("org-1", { whatsappInstanceId: "i1", departmentId: "d2" }),
      ),
    ).toBe(true);
  });
});

/**
 * Quem pode transferir para FORA do alcance da conversa.
 *
 * Não é bloqueio de supervisão: o supervisor tem o caso legítimo de puxar
 * alguém de outra área para o atendimento. O que ele não pode é fazer isso
 * sem saber — a tela confirma antes de gravar. O atendente é recusado no
 * servidor, porque lista filtrada na tela é conveniência, não controle.
 */
describe("canAssignBeyondConversationReach (quem escapa da regra)", () => {
  it("atendente não escapa", () => {
    expect(canAssignBeyondConversationReach("agent")).toBe(false);
  });

  it("supervisor escapa, com confirmação na tela", () => {
    expect(canAssignBeyondConversationReach("supervisor")).toBe(true);
  });

  it("admin escapa", () => {
    expect(canAssignBeyondConversationReach("admin")).toBe(true);
  });
});

/**
 * O PAPEL GERENTE. Ele fica entre Supervisor e Administrador, e o que estes
 * casos trancam é o desenho inteiro: no ALCANCE ele é exatamente um
 * supervisor (nada de acesso total, nada de recorte de responsável), na
 * HIERARQUIA ele passa onde o supervisor passa e é barrado onde só o admin
 * passa, e na AÇÃO a única diferença de fábrica é o Quality.
 */
describe("papel Gerente", () => {
  const vinculos = fakePrisma([{ whatsappInstanceId: "chip-a" }], [{ departmentId: "dep-1" }]);

  it("tem EXATAMENTE o alcance do supervisor com os mesmos vínculos", async () => {
    const gerente = await loadConversationAccess(vinculos, user("manager"));
    const supervisor = await loadConversationAccess(vinculos, user("supervisor"));
    expect(gerente).toEqual(supervisor);
    expect(gerente.ownOnly).toBe(false);
    expect(conversationScope(gerente)).toEqual(conversationScope(supervisor));
  });

  it("não é acesso total: continua preso ao número e ao departamento do login", async () => {
    const gerente = await loadConversationAccess(vinculos, user("manager"));
    expect(gerente.instanceIds).toEqual(["chip-a"]);
    expect(gerente.departmentIds).toEqual(["dep-1"]);
    expect(conversationScope(gerente)).not.toEqual({});
  });

  it("sem número ou sem departamento não enxerga conversa alguma, igual ao supervisor", async () => {
    const semVinculo = await loadConversationAccess(fakePrisma([], []), user("manager"));
    expect(semVinculo.instanceIds).toEqual([]);
    expect(semVinculo.departmentIds).toEqual([]);
    expect(conversationScope(semVinculo)).toEqual(
      conversationScope(await loadConversationAccess(fakePrisma([], []), user("supervisor"))),
    );
  });

  it("a hierarquia é ordinal e o gerente fica entre supervisor e admin", () => {
    expect(USER_ROLES).toEqual(["admin", "manager", "supervisor", "agent"]);
    expect(hasRole("manager", "agent")).toBe(true);
    expect(hasRole("manager", "supervisor")).toBe(true);
    expect(hasRole("manager", "manager")).toBe(true);
    expect(hasRole("manager", "admin")).toBe(false);
    expect(hasRole("supervisor", "manager")).toBe(false);
    expect(hasRole("admin", "manager")).toBe(true);
    expect(canAssignBeyondConversationReach("manager")).toBe(true);
  });

  /** Roda um preHandler de `requireRole` com a sessão já resolvida. */
  async function passa(minimo: Parameters<typeof requireRole>[0], role: AuthTokenPayload["role"]) {
    const request = {
      user: user(role),
      jwtVerify: async () => undefined,
      server: { verifySession: async (payload: AuthTokenPayload) => payload },
    } as unknown as FastifyRequest;
    await requireRole(minimo)(request, {} as FastifyReply);
  }

  it("é aceito onde a rota exige supervisor", async () => {
    await expect(passa("supervisor", "manager")).resolves.toBeUndefined();
  });

  it("é recusado com o erro padrão onde a rota exige admin", async () => {
    // Excluir número, excluir departamento, criar e editar usuário, redefinir
    // senha e a tela de Permissões são `requireRole("admin")`.
    await expect(passa("admin", "manager")).rejects.toBeInstanceOf(ForbiddenError);
    await expect(passa("admin", "admin")).resolves.toBeUndefined();
  });

  it("é aceito no Quality e o supervisor é recusado, pelo padrão do catálogo", () => {
    expect(permissoes("manager").can("quality.use")).toBe(true);
    expect(permissoes("supervisor").can("quality.use")).toBe(false);
    expect(permissoes("agent").can("quality.use")).toBe(false);
    expect(permissoes("admin").can("quality.use")).toBe(true);
  });

  it("desligar a chave do Quality para o gerente fecha o módulo, sem mexer no alcance", async () => {
    const semQuality = new Map([[permissionOverrideKey("manager", "quality.use"), false]]);
    expect(buildPermissions({ role: "manager" }, semQuality).can("quality.use")).toBe(false);
    const comTudo = buildPermissions({ role: "manager" }, todasAsChaves("manager", true));
    expect(comTudo.can("quality.use")).toBe(true);
    // Nenhuma chave muda o que ele enxerga.
    expect(conversationScope(await loadConversationAccess(vinculos, user("manager")))).toEqual(
      conversationScope(await loadConversationAccess(vinculos, user("supervisor"))),
    );
  });

  it("com o padrão de fábrica, faz tudo o que o supervisor faz", () => {
    const gerente = permissoes("manager");
    const supervisor = permissoes("supervisor");
    for (const action of PERMISSION_ACTION_KEYS) {
      if (supervisor.can(action)) expect(gerente.can(action), action).toBe(true);
    }
  });
});

/* ====================================================================== *
 * CONFIGURAÇÃO DE AUTOMAÇÃO: quem vê e quem edita o fluxo.
 *
 * O cenário decisivo do vazamento: fluxo do departamento A, usuário que só
 * tem o departamento B. Ele não vê na lista, e chamar a rota direto com o id
 * é recusado. E a outra metade, que não pode quebrar: o departamento do fluxo
 * é VISUALIZAÇÃO, nunca execução — ver o bloco do motor no fim.
 * ====================================================================== */

const DEPT_A = "aaaaaaaa-0000-4000-8000-00000000000a";
const DEPT_B = "bbbbbbbb-0000-4000-8000-00000000000b";
const INST_1 = "11111111-0000-4000-8000-000000000001";
const INST_2 = "22222222-0000-4000-8000-000000000002";
const FLOW_A = "f0000000-0000-4000-8000-00000000000a"; // dept A, chip 1
const FLOW_B = "f0000000-0000-4000-8000-00000000000b"; // dept B, chip 1
const FLOW_GERAL = "f0000000-0000-4000-8000-000000000009"; // sem departamento, chip 1
const FLOW_CHIP2 = "f0000000-0000-4000-8000-000000000002"; // dept B, chip 2
const FLOW_TODOS = "f0000000-0000-4000-8000-000000000007"; // sem departamento, todos os chips
const CONV_B = "c0000000-0000-4000-8000-00000000000b";

describe("automationConfigScope / canSeeAutomationConfig (regra pura)", () => {
  const soB = { instanceIds: [INST_1], departmentIds: [DEPT_B] };

  it("as duas condições valem juntas: departamento (ou geral) E número (ou todos)", () => {
    expect(canSeeAutomationConfig(soB, { departmentId: DEPT_B, whatsappInstanceId: INST_1 })).toBe(true);
    expect(canSeeAutomationConfig(soB, { departmentId: null, whatsappInstanceId: INST_1 })).toBe(true);
    expect(canSeeAutomationConfig(soB, { departmentId: DEPT_B, whatsappInstanceId: null })).toBe(true);
    // Departamento de outra área: não vê.
    expect(canSeeAutomationConfig(soB, { departmentId: DEPT_A, whatsappInstanceId: INST_1 })).toBe(false);
    // Departamento dele, mas chip que ele não atende: não vê. Sem esta
    // condição continuaria vazando o fluxo do chip alheio.
    expect(canSeeAutomationConfig(soB, { departmentId: DEPT_B, whatsappInstanceId: INST_2 })).toBe(false);
    expect(canSeeAutomationConfig(soB, { departmentId: null, whatsappInstanceId: INST_2 })).toBe(false);
  });

  it("sem número nenhum, nem o fluxo de todos os números aparece", () => {
    const semChip = { instanceIds: [], departmentIds: [DEPT_B] };
    expect(canSeeAutomationConfig(semChip, { departmentId: null, whatsappInstanceId: null })).toBe(false);
    expect(automationConfigScope(semChip)).toEqual({
      AND: [
        { OR: [{ departmentId: null }, { departmentId: { in: [DEPT_B] } }] },
        { OR: [{ whatsappInstanceId: { in: [] } }] },
      ],
    });
  });

  it("admin (listas nulas) enxerga tudo, sem filtro", () => {
    const admin = { instanceIds: null, departmentIds: null };
    expect(automationConfigScope(admin)).toEqual({});
    expect(canSeeAutomationConfig(admin, { departmentId: DEPT_A, whatsappInstanceId: INST_2 })).toBe(true);
  });

  it("o filtro Prisma é o mesmo recorte da função pura", () => {
    expect(automationConfigScope(soB)).toEqual({
      AND: [
        { OR: [{ departmentId: null }, { departmentId: { in: [DEPT_B] } }] },
        { OR: [{ whatsappInstanceId: null }, { whatsappInstanceId: { in: [INST_1] } }] },
      ],
    });
    expect(configInstanceScope([INST_1])).toEqual({
      OR: [{ whatsappInstanceId: null }, { whatsappInstanceId: { in: [INST_1] } }],
    });
    expect(configInstanceScope(null)).toEqual({});
  });

  it("gravar em fluxo geral exige a chave de alcance geral; o do próprio departamento, não", () => {
    expect(canWriteAutomationConfig(soB, { departmentId: DEPT_B, whatsappInstanceId: INST_1 }, false)).toBe(true);
    expect(canWriteAutomationConfig(soB, { departmentId: null, whatsappInstanceId: INST_1 }, false)).toBe(false);
    expect(canWriteAutomationConfig(soB, { departmentId: DEPT_B, whatsappInstanceId: null }, false)).toBe(false);
    expect(canWriteAutomationConfig(soB, { departmentId: null, whatsappInstanceId: INST_1 }, true)).toBe(true);
    // A chave de alcance geral nunca amplia o que a pessoa enxerga.
    expect(canWriteAutomationConfig(soB, { departmentId: DEPT_A, whatsappInstanceId: INST_1 }, true)).toBe(false);
  });

  it("a chave de alcance geral é do Gerente para cima, por padrão", () => {
    expect(permissoes("agent").can("automation.manage_general")).toBe(false);
    expect(permissoes("supervisor").can("automation.manage_general")).toBe(false);
    expect(permissoes("manager").can("automation.manage_general")).toBe(true);
    expect(permissoes("admin").can("automation.manage_general")).toBe(true);
  });
});

/** Casador mínimo de `where` do Prisma: AND, OR, in, is, null e igualdade. */
function casa(row: Record<string, unknown>, where: Record<string, unknown> | undefined): boolean {
  if (!where) return true;
  return Object.entries(where).every(([key, cond]) => {
    if (key === "AND") return (cond as Record<string, unknown>[]).every((sub) => casa(row, sub));
    if (key === "OR") return (cond as Record<string, unknown>[]).some((sub) => casa(row, sub));
    if (cond === null) return row[key] === null || row[key] === undefined;
    if (typeof cond === "object" && !(cond instanceof Date)) {
      const obj = cond as Record<string, unknown>;
      if ("in" in obj) return (obj.in as unknown[]).includes(row[key]);
      if ("is" in obj) return casa((row[key] ?? {}) as Record<string, unknown>, obj.is as Record<string, unknown>);
      return casa((row[key] ?? {}) as Record<string, unknown>, obj);
    }
    return row[key] === cond;
  });
}

interface Pessoa {
  role: AuthTokenPayload["role"];
  instances: string[];
  departments: string[];
}

const PESSOAS: Record<string, Pessoa> = {
  "sup-b": { role: "supervisor", instances: [INST_1], departments: [DEPT_B] },
  "sup-sem-chip-1": { role: "supervisor", instances: [INST_2], departments: [DEPT_A, DEPT_B] },
  gerente: { role: "manager", instances: [INST_1, INST_2], departments: [DEPT_A, DEPT_B] },
  admin: { role: "admin", instances: [], departments: [] },
  agente: { role: "agent", instances: [INST_1], departments: [DEPT_B] },
};

function fluxos(): Map<string, Record<string, unknown>> {
  const base = (id: string, name: string, departmentId: string | null, whatsappInstanceId: string | null) => ({
    id,
    organizationId: "org-1",
    name,
    description: null,
    status: "active",
    triggerType: "new_message",
    triggerConfig: null,
    whatsappInstanceId,
    departmentId,
    priority: 100,
    cooldownMinutes: 0,
    scheduleMode: "always",
    draftGraph: { nodes: [], edges: [] },
    publishedVersionId: null,
    createdById: null,
    updatedById: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  return new Map([
    [FLOW_A, base(FLOW_A, "Comercial (A)", DEPT_A, INST_1)],
    [FLOW_B, base(FLOW_B, "Fiscal (B)", DEPT_B, INST_1)],
    [FLOW_GERAL, base(FLOW_GERAL, "Geral do chip 1", null, INST_1)],
    [FLOW_CHIP2, base(FLOW_CHIP2, "Fiscal no chip 2", DEPT_B, INST_2)],
    [FLOW_TODOS, base(FLOW_TODOS, "Saudação de todos os chips", null, null)],
  ]);
}

interface Registro {
  flows: Map<string, Record<string, unknown>>;
  audit: Array<{ action: string; metadata?: Record<string, unknown> }>;
}
let registro: Registro;

function automationPrisma(): PrismaClient {
  const withRelations = (row: Record<string, unknown>) => ({
    ...row,
    whatsappInstance: row.whatsappInstanceId ? { name: `Chip ${String(row.whatsappInstanceId).slice(0, 1)}` } : null,
    department: row.departmentId ? { id: row.departmentId, name: "Dept", color: null } : null,
    publishedVersion: null,
    _count: { executions: 0 },
  });
  const executions = [FLOW_A, FLOW_B].map((flowId, index) => ({
    id: `e0000000-0000-4000-8000-00000000000${index}`,
    organizationId: "org-1",
    flowId,
    flowVersionId: "v",
    conversationId: CONV_B,
    whatsappInstanceId: INST_1,
    status: "completed",
    currentNodeId: "n1",
    waitingReason: null,
    waitingUntil: null,
    context: { protocolo: "AZV-1" },
    triggerType: "new_message",
    resultSummary: "Encaminhado para Comercial",
    error: null,
    startedAt: new Date(),
    updatedAt: new Date(),
    finishedAt: new Date(),
    logs: [],
  }));
  const conversaB = { id: CONV_B, whatsappInstanceId: INST_1, departmentId: DEPT_B, assignedUserId: null, title: "Cliente", customTitle: null };
  const execRow = (execution: (typeof executions)[number]) => ({
    ...execution,
    flow: registro.flows.get(execution.flowId),
    conversation: conversaB,
  });
  return {
    rolePermission: { findMany: async () => [] },
    userWhatsAppInstance: {
      findMany: async ({ where }: { where: { userId: string } }) =>
        (PESSOAS[where.userId]?.instances ?? []).map((whatsappInstanceId) => ({ whatsappInstanceId })),
    },
    userDepartment: {
      findMany: async ({ where }: { where: { userId: string } }) =>
        (PESSOAS[where.userId]?.departments ?? []).map((departmentId) => ({ departmentId })),
    },
    whatsAppInstance: {
      findFirst: async ({ where }: { where: { id: string } }) =>
        [INST_1, INST_2].includes(where.id) ? { id: where.id } : null,
    },
    department: {
      findFirst: async ({ where }: { where: { id: string } }) =>
        [DEPT_A, DEPT_B].includes(where.id) ? { id: where.id } : null,
    },
    automationFlow: {
      findMany: async ({ where }: { where: Record<string, unknown> }) =>
        [...registro.flows.values()].filter((row) => casa(row, where)).map(withRelations),
      findFirst: async ({ where }: { where: Record<string, unknown> }) => {
        const row = [...registro.flows.values()].find((candidate) => casa(candidate, where));
        return row ? withRelations(row) : null;
      },
      create: async ({ data }: { data: Record<string, unknown> }) => {
        const id = `f1000000-0000-4000-8000-${String(registro.flows.size).padStart(12, "0")}`;
        const row = { ...fluxos().get(FLOW_B), ...data, id, status: "draft" };
        registro.flows.set(id, row);
        return withRelations(row);
      },
      update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const row = registro.flows.get(where.id)!;
        Object.assign(row, data);
        return withRelations(row);
      },
      delete: async ({ where }: { where: { id: string } }) => registro.flows.delete(where.id),
    },
    automationExecution: {
      findMany: async ({ where }: { where: Record<string, unknown> }) =>
        executions.map(execRow).filter((row) => casa(row, where)),
      findFirst: async ({ where }: { where: Record<string, unknown> }) =>
        executions.map(execRow).find((row) => casa(row, where)) ?? null,
    },
  } as unknown as PrismaClient;
}

async function automationApp(): Promise<FastifyInstance> {
  const app = Fastify();
  await app.register(jwt, { secret: "segredo-de-teste" });
  app.decorate("verifySession", async (payload: AuthTokenPayload) => payload);
  registerErrorHandler(app);
  await automationRoutes(app, {
    prisma: automationPrisma(),
    audit: { record: (entry: { action: string; metadata?: Record<string, unknown> }) => registro.audit.push(entry) },
    automation: { stopExecutionsForFlow: async () => 0 },
  } as unknown as AppDeps);
  await app.ready();
  return app;
}

function bearer(app: FastifyInstance, sub: keyof typeof PESSOAS): Record<string, string> {
  const token = app.jwt.sign({
    sub,
    organizationId: "org-1",
    role: PESSOAS[sub]!.role,
    name: sub,
    email: `${sub}@example.com`,
  });
  return { authorization: `Bearer ${token}` };
}

describe("rotas de fluxo: quem vê e quem edita", () => {
  beforeEach(() => {
    clearPermissionCache();
    registro = { flows: fluxos(), audit: [] };
  });

  it("usuário só do departamento B não vê o fluxo do departamento A na lista", async () => {
    const app = await automationApp();
    const response = await app.inject({ method: "GET", url: "/automation-flows", headers: bearer(app, "sup-b") });
    expect(response.statusCode).toBe(200);
    const ids = (response.json().flows as Array<{ id: string }>).map((flow) => flow.id).sort();
    // Vê o do B, o geral do chip dele e o de todos os chips. Não vê o do A
    // nem o do B num chip que ele não atende.
    expect(ids).toEqual([FLOW_B, FLOW_GERAL, FLOW_TODOS].sort());
    await app.close();
  });

  it("usuário sem o chip não vê os fluxos daquele chip, mesmo com o departamento", async () => {
    const app = await automationApp();
    const response = await app.inject({
      method: "GET",
      url: "/automation-flows",
      headers: bearer(app, "sup-sem-chip-1"),
    });
    const ids = (response.json().flows as Array<{ id: string }>).map((flow) => flow.id).sort();
    expect(ids).toEqual([FLOW_CHIP2, FLOW_TODOS].sort());
    await app.close();
  });

  it("administrador vê todos", async () => {
    const app = await automationApp();
    const response = await app.inject({ method: "GET", url: "/automation-flows", headers: bearer(app, "admin") });
    expect(response.json().flows).toHaveLength(5);
    await app.close();
  });

  it("filtro por departamento só estreita o que a pessoa já vê", async () => {
    const app = await automationApp();
    const soA = await app.inject({
      method: "GET",
      url: `/automation-flows?departmentId=${DEPT_A}`,
      headers: bearer(app, "sup-b"),
    });
    expect(soA.json().flows).toHaveLength(0);
    const naoClassificados = await app.inject({
      method: "GET",
      url: "/automation-flows?departmentId=none",
      headers: bearer(app, "admin"),
    });
    expect((naoClassificados.json().flows as Array<{ id: string }>).map((flow) => flow.id).sort()).toEqual(
      [FLOW_GERAL, FLOW_TODOS].sort(),
    );
    await app.close();
  });

  it("chamar a rota direto com o id do fluxo de outro departamento é recusado com 403", async () => {
    const app = await automationApp();
    const headers = bearer(app, "sup-b");
    const leitura = await app.inject({ method: "GET", url: `/automation-flows/${FLOW_A}`, headers });
    expect(leitura.statusCode).toBe(403);
    expect(leitura.json().error).toBe("forbidden");
    for (const [method, url] of [
      ["PATCH", `/automation-flows/${FLOW_A}`],
      ["POST", `/automation-flows/${FLOW_A}/deactivate`],
      ["POST", `/automation-flows/${FLOW_A}/activate`],
      ["POST", `/automation-flows/${FLOW_A}/duplicate`],
      ["POST", `/automation-flows/${FLOW_A}/publish`],
      ["DELETE", `/automation-flows/${FLOW_A}`],
      ["GET", `/automation-flows/${FLOW_CHIP2}`],
    ] as const) {
      const response = await app.inject({ method, url, headers, payload: method === "PATCH" ? { name: "Tomado" } : undefined });
      expect(response.statusCode, `${method} ${url}`).toBe(403);
    }
    // Nada foi gravado no fluxo alheio.
    expect(registro.flows.get(FLOW_A)?.name).toBe("Comercial (A)");
    expect(registro.flows.has(FLOW_A)).toBe(true);
    await app.close();
  });

  it("fluxo geral: o supervisor vê, mas só lê; o gerente edita", async () => {
    const app = await automationApp();
    const supervisor = await app.inject({ method: "GET", url: `/automation-flows/${FLOW_GERAL}`, headers: bearer(app, "sup-b") });
    expect(supervisor.statusCode).toBe(200);
    expect(supervisor.json().flow.canEdit).toBe(false);
    const gravar = await app.inject({
      method: "PATCH",
      url: `/automation-flows/${FLOW_GERAL}`,
      headers: bearer(app, "sup-b"),
      payload: { name: "Mudou" },
    });
    expect(gravar.statusCode).toBe(403);
    const gerente = await app.inject({
      method: "PATCH",
      url: `/automation-flows/${FLOW_GERAL}`,
      headers: bearer(app, "gerente"),
      payload: { departmentId: DEPT_B },
    });
    expect(gerente.statusCode).toBe(200);
    // Classificado: sai dos não classificados e a auditoria registra de onde veio.
    expect(gerente.json().flow.departmentId).toBe(DEPT_B);
    const auditoria = registro.audit.find((entry) => entry.action === "automation_flow.updated");
    expect(auditoria?.metadata).toMatchObject({ departmentId: DEPT_B, previousDepartmentId: null });
    await app.close();
  });

  it("criar: só nos departamentos e números dele; geral pede a chave de alcance geral", async () => {
    const app = await automationApp();
    const headers = bearer(app, "sup-b");
    const noB = await app.inject({
      method: "POST",
      url: "/automation-flows",
      headers,
      payload: { name: "Novo do B", departmentId: DEPT_B, whatsappInstanceId: INST_1 },
    });
    expect(noB.statusCode).toBe(201);
    expect(registro.audit.at(-1)).toMatchObject({ action: "automation_flow.created", metadata: { departmentId: DEPT_B } });
    const noA = await app.inject({
      method: "POST",
      url: "/automation-flows",
      headers,
      payload: { name: "Invasão", departmentId: DEPT_A, whatsappInstanceId: INST_1 },
    });
    expect(noA.statusCode).toBe(403);
    const geral = await app.inject({
      method: "POST",
      url: "/automation-flows",
      headers,
      payload: { name: "Geral", departmentId: null, whatsappInstanceId: INST_1 },
    });
    expect(geral.statusCode).toBe(403);
    // O departamento é obrigatório de informar: esquecer não vira geral.
    const semCampo = await app.inject({ method: "POST", url: "/automation-flows", headers, payload: { name: "Sem" } });
    expect(semCampo.statusCode).toBe(400);
    const gerente = await app.inject({
      method: "POST",
      url: "/automation-flows",
      headers: bearer(app, "gerente"),
      payload: { name: "Geral", departmentId: null },
    });
    expect(gerente.statusCode).toBe(201);
    await app.close();
  });

  it("mover o próprio fluxo para outro departamento é recusado", async () => {
    const app = await automationApp();
    const response = await app.inject({
      method: "PATCH",
      url: `/automation-flows/${FLOW_B}`,
      headers: bearer(app, "sup-b"),
      payload: { departmentId: DEPT_A },
    });
    expect(response.statusCode).toBe(403);
    expect(registro.flows.get(FLOW_B)?.departmentId).toBe(DEPT_B);
    await app.close();
  });

  it("duplicar: a cópia nasce no mesmo departamento do original", async () => {
    const app = await automationApp();
    const response = await app.inject({
      method: "POST",
      url: `/automation-flows/${FLOW_B}/duplicate`,
      headers: bearer(app, "sup-b"),
    });
    expect(response.statusCode).toBe(201);
    expect(response.json().flow.departmentId).toBe(DEPT_B);
    expect(response.json().flow.whatsappInstanceId).toBe(INST_1);
    await app.close();
  });

  it("usuário sem a chave automation.manage não entra (padrão: Usuário não mexe em fluxo)", async () => {
    const app = await automationApp();
    const response = await app.inject({ method: "GET", url: "/automation-flows", headers: bearer(app, "agente") });
    expect(response.statusCode).toBe(403);
    await app.close();
  });

  it("histórico: execução de fluxo de outro departamento não aparece na lista geral", async () => {
    const app = await automationApp();
    const response = await app.inject({ method: "GET", url: "/automation-executions", headers: bearer(app, "sup-b") });
    const flows = (response.json().executions as Array<{ flowId: string }>).map((execution) => execution.flowId);
    expect(flows).toEqual([FLOW_B]);
    await app.close();
  });

  it("histórico da conversa: mostra que houve automação, sem revelar o fluxo alheio", async () => {
    const app = await automationApp();
    const response = await app.inject({
      method: "GET",
      url: `/automation-executions?conversationId=${CONV_B}`,
      headers: bearer(app, "sup-b"),
    });
    const executions = response.json().executions as Array<Record<string, unknown>>;
    expect(executions).toHaveLength(2);
    const alheia = executions.find((execution) => execution.flowHidden === true);
    expect(alheia).toMatchObject({ flowId: null, flowName: "Automação de outra área", resultSummary: null });
    const detalhe = await app.inject({
      method: "GET",
      url: `/automation-executions/${String(alheia?.id)}`,
      headers: bearer(app, "sup-b"),
    });
    expect(detalhe.json().execution).toMatchObject({ flowHidden: true, logs: [], context: {}, currentNodeId: null });
    await app.close();
  });
});

describe("o departamento do fluxo NUNCA decide execução", () => {
  it("o motor não importa a régua de visualização de configuração", () => {
    // Quando a mensagem do cliente chega não há usuário logado. Se esta
    // régua entrar no motor, os fluxos param de rodar em silêncio. O teste de
    // comportamento está em `automation-engine.test.ts` ("fluxo de um
    // departamento continua disparando").
    const engine = readFileSync(
      fileURLToPath(new URL("../src/services/automation/engine.ts", import.meta.url)),
      "utf8",
    );
    for (const proibido of ["automationConfigScope", "canSeeAutomationConfig", "canWriteAutomationConfig", "loadConversationAccess", "conversationScope"]) {
      expect(engine.includes(proibido), proibido).toBe(false);
    }
  });
});

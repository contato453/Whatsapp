import { describe, expect, it } from "vitest";
import type { PrismaClient } from "@azvchat/database";
import {
  PERMISSION_ACTION_KEYS,
  permissionOverrideKey,
  type ConfigurableRole,
} from "@azvchat/shared";
import { buildPermissions } from "../src/lib/permissions.js";
import {
  accessibleInstanceIds,
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
import type { AuthTokenPayload } from "../src/lib/auth.js";

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

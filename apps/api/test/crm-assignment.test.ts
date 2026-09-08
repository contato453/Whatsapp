import { beforeEach, describe, expect, it } from "vitest";
import type { PrismaClient } from "@azvchat/database";
import { crmLeastOpenPick, crmRoundRobinPick } from "@azvchat/shared";
import { resolveCrmAssignee } from "../src/lib/crm-assignment.js";

/**
 * DISTRIBUIÇÃO AUTOMÁTICA — o rodízio e os irmãos dele.
 *
 * O que estes testes trancam:
 *
 * 1. **só recebe quem ENXERGA a conversa.** É a mesma régua da transferência
 *    manual (CLAUDE.md §13). Aqui a falha seria pior do que lá, porque
 *    intermitente: o card sumiria da tela de todo mundo só nas vezes em que a
 *    vez fosse da pessoa sem acesso àquele número;
 * 2. **o rodízio conta no BANCO.** O cursor é incrementado atomicamente e o
 *    índice sai do valor devolvido — duas criações simultâneas recebem
 *    números diferentes. Calcular "o próximo" em memória perderia a corrida
 *    em silêncio e entregaria dois leads seguidos para a mesma pessoa;
 * 3. **sem candidato, a oportunidade nasce ÓRFÃ e não falha.** Recusar a
 *    criação faria o clique do atendente quebrar por causa de configuração;
 * 4. **o padrão continua sendo herdar da conversa** — mudar isso mexeria, num
 *    deploy, em quem recebe os leads de quem já usa o CRM.
 */

const ORG = "org-1";
const CONVERSA = { whatsappInstanceId: "inst-1", departmentId: "dep-1" };

interface Gravado {
  incrementos: number;
  usuariosConsultados: Array<Record<string, unknown>>;
  logs: Array<Record<string, unknown>>;
}
let gravado: Gravado;

beforeEach(() => {
  gravado = { incrementos: 0, usuariosConsultados: [], logs: [] };
});

/**
 * `elegiveis` devolve quem o `where` deixa passar. O fake replica a parte que
 * importa: pool explícito (`id.in`) e quem "enxerga" a conversa.
 */
function fakePrisma(options: {
  visiveis?: string[];
  cursorInicial?: number;
  cargas?: Array<{ assignedUserId: string; count: number }>;
}): PrismaClient {
  const visiveis = options.visiveis ?? ["u-ana", "u-bruno", "u-carla"];
  let cursor = options.cursorInicial ?? 0;
  return {
    user: {
      findMany: async (args: { where?: Record<string, unknown> }) => {
        gravado.usuariosConsultados.push(args.where ?? {});
        const pool = (args.where?.id as { in?: string[] } | undefined)?.in;
        const lista = pool ? visiveis.filter((id) => pool.includes(id)) : visiveis;
        return [...lista].sort().map((id) => ({ id }));
      },
    },
    crmPipeline: {
      update: async () => {
        gravado.incrementos += 1;
        cursor += 1;
        return { assignmentCursor: cursor };
      },
    },
    crmOpportunity: {
      groupBy: async () =>
        (options.cargas ?? []).map((linha) => ({
          assignedUserId: linha.assignedUserId,
          _count: { _all: linha.count },
        })),
    },
  } as unknown as PrismaClient;
}

function deps(prisma: PrismaClient) {
  return {
    prisma,
    logger: {
      warn: (dados: Record<string, unknown>) => gravado.logs.push(dados),
      info: (dados: Record<string, unknown>) => gravado.logs.push(dados),
    },
  } as unknown as Parameters<typeof resolveCrmAssignee>[0];
}

function funil(overrides: Record<string, unknown> = {}) {
  return {
    id: "funil-1",
    assignmentMode: "round_robin" as const,
    assignmentFixedUserId: null,
    assignees: [],
    ...overrides,
  };
}

describe("modo padrão: herdar da conversa", () => {
  it("o responsável da oportunidade é quem já atende o cliente", async () => {
    const resultado = await resolveCrmAssignee(deps(fakePrisma({})), {
      organizationId: ORG,
      pipeline: funil({ assignmentMode: "inherit_conversation" }),
      conversation: CONVERSA,
      conversationAssigneeId: "u-atendente",
    });
    expect(resultado).toEqual({ userId: "u-atendente", mode: "inherit_conversation" });
    // Nem consulta candidatos nem mexe no cursor: é o caminho de sempre.
    expect(gravado.incrementos).toBe(0);
  });

  it("conversa sem responsável continua sem responsável", async () => {
    const resultado = await resolveCrmAssignee(deps(fakePrisma({})), {
      organizationId: ORG,
      pipeline: funil({ assignmentMode: "inherit_conversation" }),
      conversation: CONVERSA,
      conversationAssigneeId: null,
    });
    expect(resultado.userId).toBeNull();
  });
});

describe("rodízio (round robin)", () => {
  it("gira a fila: cada oportunidade nova vai para o próximo", async () => {
    const prisma = fakePrisma({ visiveis: ["u-ana", "u-bruno", "u-carla"] });
    const escolhidos: Array<string | null> = [];
    for (let i = 0; i < 6; i += 1) {
      const resultado = await resolveCrmAssignee(deps(prisma), {
        organizationId: ORG,
        pipeline: funil(),
        conversation: CONVERSA,
        conversationAssigneeId: null,
      });
      escolhidos.push(resultado.userId);
    }
    // Ordem estável (por id) e volta ao começo depois da última pessoa.
    expect(escolhidos).toEqual([
      "u-ana",
      "u-bruno",
      "u-carla",
      "u-ana",
      "u-bruno",
      "u-carla",
    ]);
    // Um incremento por distribuição: é ele que garante números diferentes
    // para duas criações simultâneas.
    expect(gravado.incrementos).toBe(6);
  });

  it("SÓ ENTRA NO RODÍZIO QUEM ENXERGA A CONVERSA", async () => {
    // Bruno está no pool configurado, mas não tem o número da conversa: dar o
    // lead a ele faria o card sumir da tela de todo mundo, sem erro nenhum.
    const prisma = fakePrisma({ visiveis: ["u-ana", "u-carla"] });
    const escolhidos: Array<string | null> = [];
    for (let i = 0; i < 4; i += 1) {
      const resultado = await resolveCrmAssignee(deps(prisma), {
        organizationId: ORG,
        pipeline: funil({
          assignees: [{ userId: "u-ana" }, { userId: "u-bruno" }, { userId: "u-carla" }],
        }),
        conversation: CONVERSA,
        conversationAssigneeId: null,
      });
      escolhidos.push(resultado.userId);
    }
    expect(escolhidos).not.toContain("u-bruno");
    expect(escolhidos).toEqual(["u-ana", "u-carla", "u-ana", "u-carla"]);
  });

  it("o pool configurado restringe a fila; pool vazio é 'todo mundo que enxerga'", async () => {
    const prisma = fakePrisma({});
    await resolveCrmAssignee(deps(prisma), {
      organizationId: ORG,
      pipeline: funil({ assignees: [{ userId: "u-carla" }] }),
      conversation: CONVERSA,
      conversationAssigneeId: null,
    });
    expect(gravado.usuariosConsultados[0]).toMatchObject({ id: { in: ["u-carla"] } });

    await resolveCrmAssignee(deps(prisma), {
      organizationId: ORG,
      pipeline: funil({ assignees: [] }),
      conversation: CONVERSA,
      conversationAssigneeId: null,
    });
    // Sem pool, nenhuma restrição por id — vale quem enxerga a conversa.
    expect(gravado.usuariosConsultados[1]).not.toHaveProperty("id");
  });

  it("sem ninguém elegível a oportunidade nasce ÓRFÃ, com log, e não falha", async () => {
    const prisma = fakePrisma({ visiveis: [] });
    const resultado = await resolveCrmAssignee(deps(prisma), {
      organizationId: ORG,
      pipeline: funil(),
      conversation: CONVERSA,
      conversationAssigneeId: null,
    });
    expect(resultado).toMatchObject({ userId: null, reason: "sem_candidatos" });
    expect(gravado.logs.some((log) => log.event === "crm_assignment_without_candidates")).toBe(
      true,
    );
    // Sem candidato não faz sentido queimar um número do rodízio.
    expect(gravado.incrementos).toBe(0);
  });

  it("lead avulso (sem conversa) distribui pelos ativos, sem checar número", async () => {
    const prisma = fakePrisma({});
    const resultado = await resolveCrmAssignee(deps(prisma), {
      organizationId: ORG,
      pipeline: funil(),
      conversation: null,
      conversationAssigneeId: null,
    });
    expect(resultado.userId).toBe("u-ana");
    expect(gravado.usuariosConsultados[0]).toMatchObject({
      organizationId: ORG,
      status: "active",
    });
  });
});

describe("menor carga (least open)", () => {
  it("escolhe quem tem menos cards abertos NESTE funil", async () => {
    const prisma = fakePrisma({
      cargas: [
        { assignedUserId: "u-ana", count: 7 },
        { assignedUserId: "u-bruno", count: 2 },
        { assignedUserId: "u-carla", count: 5 },
      ],
    });
    const resultado = await resolveCrmAssignee(deps(prisma), {
      organizationId: ORG,
      pipeline: funil({ assignmentMode: "least_open" }),
      conversation: CONVERSA,
      conversationAssigneeId: null,
    });
    expect(resultado.userId).toBe("u-bruno");
  });

  it("quem não aparece na contagem está com ZERO, e ganha a vez", async () => {
    // Ausência no `groupBy` significa nenhuma oportunidade aberta — tratá-la
    // como "sem dado" mandaria o lead para quem já está cheio.
    const prisma = fakePrisma({
      cargas: [
        { assignedUserId: "u-ana", count: 3 },
        { assignedUserId: "u-bruno", count: 4 },
      ],
    });
    const resultado = await resolveCrmAssignee(deps(prisma), {
      organizationId: ORG,
      pipeline: funil({ assignmentMode: "least_open" }),
      conversation: CONVERSA,
      conversationAssigneeId: null,
    });
    expect(resultado.userId).toBe("u-carla");
  });

  it("empate é desfeito pelo rodízio, não pelo primeiro nome da lista", async () => {
    // Com todo mundo zerado (começo do dia, funil novo) o primeiro nome
    // receberia tudo se o desempate fosse pela ordem.
    const prisma = fakePrisma({ cargas: [] });
    const escolhidos: Array<string | null> = [];
    for (let i = 0; i < 3; i += 1) {
      const resultado = await resolveCrmAssignee(deps(prisma), {
        organizationId: ORG,
        pipeline: funil({ assignmentMode: "least_open" }),
        conversation: CONVERSA,
        conversationAssigneeId: null,
      });
      escolhidos.push(resultado.userId);
    }
    expect(new Set(escolhidos).size).toBe(3);
  });
});

describe("pessoa fixa", () => {
  it("manda para a pessoa configurada quando ela enxerga a conversa", async () => {
    const resultado = await resolveCrmAssignee(deps(fakePrisma({})), {
      organizationId: ORG,
      pipeline: funil({ assignmentMode: "fixed", assignmentFixedUserId: "u-bruno" }),
      conversation: CONVERSA,
      conversationAssigneeId: null,
    });
    expect(resultado.userId).toBe("u-bruno");
  });

  it("pessoa fixa desativada (ou sem o número) deixa o card órfão, com log", async () => {
    const prisma = fakePrisma({ visiveis: ["u-ana"] });
    const resultado = await resolveCrmAssignee(deps(prisma), {
      organizationId: ORG,
      pipeline: funil({ assignmentMode: "fixed", assignmentFixedUserId: "u-bruno" }),
      conversation: CONVERSA,
      conversationAssigneeId: null,
    });
    expect(resultado).toMatchObject({ userId: null, reason: "fixo_indisponivel" });
    expect(gravado.logs.some((log) => log.event === "crm_assignment_fixed_unavailable")).toBe(
      true,
    );
  });
});

describe("modo 'ninguém'", () => {
  it("a oportunidade nasce sem dono, mesmo com a conversa atribuída", async () => {
    const resultado = await resolveCrmAssignee(deps(fakePrisma({})), {
      organizationId: ORG,
      pipeline: funil({ assignmentMode: "none" }),
      conversation: CONVERSA,
      conversationAssigneeId: "u-atendente",
    });
    expect(resultado).toMatchObject({ userId: null, mode: "none" });
  });
});

describe("as funções puras da escolha", () => {
  it("o índice do rodízio dá a volta e aceita cursor grande", () => {
    const fila = ["a", "b", "c"];
    expect(crmRoundRobinPick(fila, 0)).toBe("a");
    expect(crmRoundRobinPick(fila, 4)).toBe("b");
    expect(crmRoundRobinPick(fila, 3_000_002)).toBe("c");
    expect(crmRoundRobinPick([], 3)).toBeNull();
  });

  it("menor carga com lista vazia devolve null em vez de estourar", () => {
    expect(crmLeastOpenPick([], 0)).toBeNull();
  });
});

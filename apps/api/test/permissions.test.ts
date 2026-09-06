import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CONFIGURABLE_ROLES,
  PERMISSION_ACTIONS,
  PERMISSION_ACTION_KEYS,
  PERMISSION_AREAS,
  allowedPermissions,
  defaultPermission,
  isConfigurableRole,
  isPermissionAction,
  permissionActionDefinition,
  permissionDeniedMessage,
  permissionOverrideKey,
  resolvePermission,
  type ConfigurableRole,
  type PermissionAction,
} from "@azvchat/shared";
import { buildPermissions } from "../src/lib/permissions.js";

/**
 * O motor de permissão. É a peça que abre ou fecha o sistema inteiro, então
 * o que estes testes fixam não é comodidade: é que a decisão saia de UM
 * lugar, que o padrão do catálogo valha na ausência de configuração, e que
 * o administrador nunca dependa de chave nenhuma.
 */

function overrides(pares: Array<[ConfigurableRole, PermissionAction, boolean]>) {
  return new Map(pares.map(([role, action, allowed]) => [permissionOverrideKey(role, action), allowed]));
}

describe("resolvePermission — padrão do catálogo", () => {
  it("sem configuração nenhuma, vale o padrão de cada ação", () => {
    for (const action of PERMISSION_ACTIONS) {
      for (const role of CONFIGURABLE_ROLES) {
        expect(resolvePermission(role, action.key, new Map())).toBe(action.defaults[role]);
      }
    }
  });

  it("organização sem uma única linha funciona inteira pelos padrões", () => {
    const agente = buildPermissions({ role: "agent" }, new Map());
    expect(agente.can("conversation.transfer_user")).toBe(true);
    expect(agente.can("audit.view")).toBe(false);
  });
});

describe("resolvePermission — configuração da organização", () => {
  it("a linha gravada vence o padrão, nos dois sentidos", () => {
    const ligado = overrides([["agent", "conversation.change_department", true]]);
    expect(defaultPermission("conversation.change_department", "agent")).toBe(false);
    expect(resolvePermission("agent", "conversation.change_department", ligado)).toBe(true);

    const desligado = overrides([["supervisor", "audit.view", false]]);
    expect(defaultPermission("audit.view", "supervisor")).toBe(true);
    expect(resolvePermission("supervisor", "audit.view", desligado)).toBe(false);
  });

  it("a linha de um papel não vaza para o outro", () => {
    const so_agente = overrides([["agent", "audit.view", true]]);
    expect(resolvePermission("agent", "audit.view", so_agente)).toBe(true);
    expect(resolvePermission("supervisor", "audit.view", so_agente)).toBe(
      defaultPermission("audit.view", "supervisor"),
    );
  });
});

describe("admin passa por cima de tudo", () => {
  it("com o catálogo inteiro desligado, o admin continua podendo tudo", () => {
    // Desligar "para o admin" nem é representável: a configuração só tem
    // linhas de agent e supervisor. Aqui desligamos os dois papéis
    // configuráveis e conferimos que ele segue intacto.
    const tudoDesligado = new Map(
      CONFIGURABLE_ROLES.flatMap((role) =>
        PERMISSION_ACTION_KEYS.map(
          (action) => [permissionOverrideKey(role, action), false] as [string, boolean],
        ),
      ),
    );
    const admin = buildPermissions({ role: "admin" }, tudoDesligado);
    for (const action of PERMISSION_ACTION_KEYS) {
      expect(admin.can(action)).toBe(true);
    }
    expect(admin.allowed()).toEqual([...PERMISSION_ACTION_KEYS]);
  });

  it("não existe chave de admin no catálogo", () => {
    for (const action of PERMISSION_ACTIONS) {
      expect(Object.keys(action.defaults).sort()).toEqual([...CONFIGURABLE_ROLES].sort());
    }
    expect(isConfigurableRole("admin")).toBe(false);
  });
});

describe("nome de ação inválido é recusado", () => {
  it("chave fora do catálogo não é reconhecida", () => {
    expect(isPermissionAction("conversation.change_department")).toBe(true);
    expect(isPermissionAction("inventada.qualquer")).toBe(false);
    expect(isPermissionAction("")).toBe(false);
  });

  it("linha gravada para ação que saiu do código é ignorada, não quebra", () => {
    // A leitura descarta a chave desconhecida; aqui simulamos o mapa já
    // filtrado e conferimos que a decisão segue pelo catálogo.
    expect(permissionActionDefinition("acao.que.sumiu")).toBeNull();
    const mapa = new Map([[permissionOverrideKey("agent", "acao.que.sumiu"), true]]);
    expect(allowedPermissions("agent", mapa)).toEqual(
      PERMISSION_ACTION_KEYS.filter((action) => defaultPermission(action, "agent")),
    );
  });
});

describe("assert recusa com mensagem que nomeia a chave", () => {
  it("403 com a ação no texto, e não um 'acesso negado' genérico", () => {
    const agente = buildPermissions({ role: "agent" }, new Map());
    try {
      agente.assert("audit.view");
      throw new Error("deveria ter recusado");
    } catch (error) {
      const err = error as { statusCode?: number; code?: string; message: string };
      expect(err.statusCode).toBe(403);
      expect(err.code).toBe("permission_denied");
      expect(err.message).toBe(permissionDeniedMessage("audit.view"));
      expect(err.message.toLowerCase()).toContain("auditoria");
    }
  });
});

describe("catálogo bem formado", () => {
  it("não há chave repetida", () => {
    expect(new Set(PERMISSION_ACTION_KEYS).size).toBe(PERMISSION_ACTION_KEYS.length);
  });

  it("toda ação tem rótulo, explicação e área conhecida", () => {
    for (const action of PERMISSION_ACTIONS) {
      expect(action.label.length).toBeGreaterThan(3);
      expect(action.description.length).toBeGreaterThan(20);
      expect(PERMISSION_AREAS).toContain(action.area);
    }
  });
});

/**
 * VARREDURA: toda rota que representa uma ação do catálogo precisa decidir
 * pela função única.
 *
 * O que este teste evita é o pior defeito possível aqui — a rota que
 * continua com `requireRole` depois de a chave existir na tela. O dono do
 * escritório desligaria a chave, veria o botão sumir e continuaria com a
 * rota aberta, sem nada vermelho em lugar nenhum.
 */
const modulesDirForRead = join(import.meta.dirname, "../src/modules");

describe("varredura das rotas", () => {
  const modulesDir = modulesDirForRead;
  const arquivos = readdirSync(modulesDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(modulesDir, entry.name, "routes.ts"));

  const fontes = arquivos
    .map((file) => {
      try {
        return { file, code: readFileSync(file, "utf8") };
      } catch {
        return null;
      }
    })
    .filter((item): item is { file: string; code: string } => item !== null);

  const codigoDaApi = fontes.map((item) => item.code).join("\n");

  it("toda chave do catálogo é consultada em algum lugar da API", () => {
    const semUso = PERMISSION_ACTION_KEYS.filter((action) => !codigoDaApi.includes(`"${action}"`));
    expect(semUso).toEqual([]);
  });

  it("requireRole só sobrou no que é fixo por decisão: admin", () => {
    // Excluir número, excluir departamento, criar/editar usuário e a própria
    // tela de Permissões continuam exclusivos de admin, sem chave — e é
    // exatamente isso que este teste tranca.
    for (const { file, code } of fontes) {
      const usos = code.match(/requireRole\("([a-z]+)"\)/g) ?? [];
      for (const uso of usos) {
        expect(uso, `${file}: requireRole fora de admin`).toBe('requireRole("admin")');
      }
    }
  });

  it("nenhum handler decide entre agent e supervisor na mão", () => {
    // `if (user.role === "agent")` dentro de handler é o caminho que faz a
    // configuração valer em umas rotas e não em outras. Comparação com
    // "admin" continua permitida: o que é exclusivo do administrador é fixo
    // no código de propósito e não tem chave no catálogo.
    for (const { file, code } of fontes) {
      expect(code, `${file}: comparação de papel solta no handler`).not.toMatch(
        /user\.role\s*===\s*"(agent|supervisor)"/,
      );
      expect(code, `${file}: hasRole com papel configurável no handler`).not.toMatch(
        /hasRole\([^)]*"(agent|supervisor)"\)/,
      );
    }
  });
});

/**
 * A POLÍTICA PEDIDA PELO ESCRITÓRIO.
 *
 * Estes casos fixam os padrões de fábrica de cada chave. Não é redundância
 * com o teste de "padrão do catálogo" acima: aquele confere que o motor LÊ o
 * padrão; este confere QUAL é o padrão. Mudança silenciosa de padrão altera
 * o que a equipe inteira pode fazer no próximo deploy, sem ninguém abrir a
 * tela de Permissões.
 */
describe("padrões de fábrica (Usuário / Supervisor)", () => {
  const esperado: Array<[PermissionAction, boolean, boolean]> = [
    // Atendimento
    ["message.delete_sent", false, true],
    ["message.edit_sent", false, true],
    ["message.pin", true, true],
    ["scheduled_message.cancel_other", false, true],
    ["conversation.transfer_user", true, true],
    ["conversation.unassign", true, true],
    ["conversation.change_department", false, true],
    ["conversation.assign_all", true, true],
    ["conversation.archive", false, true],
    ["note.delete_other", false, true],
    ["conversation.rename", true, true],
    ["group_participant.rename", true, true],
    ["azevedo_os.link", true, true],
    ["azevedo_os.relink", false, true],
    // Cadastros
    ["tag.manage", false, true],
    ["tag.delete", false, true],
    ["quick_reply.manage", true, true],
    ["quick_reply.create_shared", false, true],
    ["user.deactivate", false, false],
    ["department.manage", false, true],
    ["whatsapp_instance.manage", false, true],
    ["whatsapp_instance.connection", false, true],
    ["whatsapp_instance.backup", false, true],
    // Visão e relatórios
    ["reports.view", false, true],
    ["dashboard.view_team", false, true],
    ["audit.view", false, true],
    ["attendance_settings.manage", false, true],
    // Ligações
    ["call.answer", true, true],
    ["call.view", true, true],
    ["call.recording.play", false, true],
    ["call.recording.delete", false, false],
    // Inteligência artificial
    ["ai.agent.manage", false, true],
    ["ai.view_usage", false, true],
    ["ai.session.stop", true, true],
    ["ai.session.resume", false, true],
  ];

  it.each(esperado)("%s → Usuário %s, Supervisor %s", (action, agent, supervisor) => {
    expect(defaultPermission(action, "agent")).toBe(agent);
    expect(defaultPermission(action, "supervisor")).toBe(supervisor);
  });

  it("o catálogo não tem ação além das declaradas aqui", () => {
    expect([...PERMISSION_ACTION_KEYS].sort()).toEqual(esperado.map(([key]) => key).sort());
  });
});

/**
 * NÃO EXISTE CAMINHO PARA TRANCAR O ATENDENTE FORA DO PRÓPRIO TRABALHO.
 *
 * Com TODAS as chaves desligadas, a pessoa ainda precisa conseguir ler a
 * conversa, enviar mensagem, mudar status e mexer na própria nota. Se um dia
 * alguém criar chave para uma dessas quatro coisas, é aqui que aparece —
 * antes de um clique na tela de Permissões deixar a equipe sem trabalhar.
 */
describe("o atendente nunca fica trancado fora do próprio trabalho", () => {
  const SEM_CHAVE = ["ler", "read", "message.send", "conversation.read", "note.create"];

  it("ler e enviar mensagem não são chaves do catálogo", () => {
    for (const proibida of SEM_CHAVE) {
      expect(PERMISSION_ACTION_KEYS).not.toContain(proibida);
    }
  });

  it("mudar status e escrever nota própria também não são", () => {
    expect(PERMISSION_ACTION_KEYS).not.toContain("conversation.status");
    expect(PERMISSION_ACTION_KEYS).not.toContain("note.create");
    // "note.delete_other" existe, mas fala de nota DE TERCEIRO: a própria
    // cada um sempre edita, e isso é código, não chave.
    expect(PERMISSION_ACTION_KEYS).toContain("note.delete_other");
  });

  it("as rotas de ler e enviar não passam por requirePermission", () => {
    const conversas = readFileSync(join(modulesDirForRead, "conversations/routes.ts"), "utf8");
    const mensagens = readFileSync(join(modulesDirForRead, "messages/routes.ts"), "utf8");
    for (const [rota, code] of [
      ['app.get("/conversations"', conversas],
      ['app.get("/conversations/:id"', conversas],
      ['app.post("/conversations/:id/status"', conversas],
      ['app.post("/conversations/:id/read"', conversas],
      ['app.post("/conversations/:id/notes"', conversas],
      ['app.get("/conversations/:id/messages"', mensagens],
      ['app.post("/conversations/:id/messages"', mensagens],
    ] as const) {
      const trecho = code.slice(code.indexOf(rota), code.indexOf(rota) + 160);
      expect(trecho, `${rota} deveria seguir com authenticate puro`).toContain(
        "preHandler: authenticate",
      );
    }
  });
});

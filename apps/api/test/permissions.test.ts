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
describe("varredura das rotas", () => {
  const modulesDir = join(import.meta.dirname, "../src/modules");
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

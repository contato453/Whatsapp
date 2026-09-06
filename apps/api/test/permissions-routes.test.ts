import Fastify, { type FastifyInstance } from "fastify";
import jwt from "@fastify/jwt";
import { beforeEach, describe, expect, it } from "vitest";
import type { PrismaClient } from "@azvchat/database";
import { PERMISSION_ACTION_KEYS, type ConfigurableRole, type PermissionAction } from "@azvchat/shared";
import type { AuthTokenPayload } from "../src/lib/auth.js";
import { registerErrorHandler } from "../src/lib/errors.js";
import { clearPermissionCache } from "../src/lib/permissions.js";
import { conversationRoutes } from "../src/modules/conversations/routes.js";
import { messageRoutes } from "../src/modules/messages/routes.js";
import { permissionRoutes } from "../src/modules/permissions/routes.js";
import { userRoutes } from "../src/modules/users/routes.js";
import type { AppDeps } from "../src/types.js";

/**
 * A configuração da organização mandando de verdade, pela rota — não só na
 * função pura.
 *
 * É o que o dono do escritório vai fazer no primeiro dia: desligar uma chave
 * de Supervisor e ligar uma de Usuário. Se a rota continuasse decidindo pelo
 * papel, tudo abaixo passaria na função e falharia na vida real.
 */

const CONV_ID = "11111111-1111-4111-8111-111111111111";
const MSG_ID = "22222222-2222-4222-8222-222222222222";

interface Gravado {
  auditActions: string[];
  conversationUpdates: Array<Record<string, unknown>>;
  permissionWrites: Array<Record<string, unknown>>;
  permissionDeletes: Array<Record<string, unknown>>;
  deletedMessages: string[];
}
let gravado: Gravado;

beforeEach(() => {
  gravado = {
    auditActions: [],
    conversationUpdates: [],
    permissionWrites: [],
    permissionDeletes: [],
    deletedMessages: [],
  };
  // O cache é de módulo: sem limpar, a configuração de um caso vazaria para
  // o seguinte e o teste passaria (ou falharia) pelo motivo errado.
  clearPermissionCache();
});

function fakeIo() {
  // `sockets.sockets` existe porque `disconnectUser` percorre as conexões
  // abertas ao mudar papel, status ou recorte de acesso.
  return {
    to: () => ({ emit: () => undefined }),
    sockets: { sockets: new Map() },
  };
}

function conversa(overrides: Record<string, unknown> = {}) {
  return {
    id: CONV_ID,
    organizationId: "org-1",
    whatsappInstanceId: "inst-1",
    externalChatId: "5511999@s.whatsapp.net",
    type: "group",
    title: "Cliente",
    customTitle: null,
    status: "open",
    assignedUserId: null,
    assignedToAll: false,
    departmentId: null,
    unreadCount: 0,
    archivedAt: null,
    archivedByUserId: null,
    externalReference: null,
    externalSource: null,
    lastMessageAt: new Date(),
    lastMessagePreview: null,
    profilePicture: null,
    createdAt: new Date(),
    assignedUser: null,
    archivedBy: null,
    department: null,
    instance: null,
    tags: [],
    ...overrides,
  };
}

/**
 * Prisma de mentira com a configuração de permissão que o caso quiser. É a
 * única fonte de decisão: nenhuma rota abaixo conhece papel.
 */
function fakePrisma(
  overrides: Array<[ConfigurableRole, PermissionAction, boolean]> = [],
): PrismaClient {
  const rows = overrides.map(([role, action, allowed]) => ({
    role,
    action,
    allowed,
    updatedAt: new Date("2026-08-18T12:00:00Z"),
    updatedBy: null,
  }));
  return {
    rolePermission: {
      findMany: async () => rows,
      upsert: async (args: Record<string, unknown>) => {
        gravado.permissionWrites.push(args);
        return {};
      },
      deleteMany: async (args: Record<string, unknown>) => {
        gravado.permissionDeletes.push(args);
        return { count: 1 };
      },
    },
    userWhatsAppInstance: { findMany: async () => [{ whatsappInstanceId: "inst-1" }] },
    userDepartment: { findMany: async () => [{ departmentId: "dep-1" }] },
    department: { findFirst: async () => ({ id: "dep-1", organizationId: "org-1" }) },
    conversation: {
      findFirst: async () => conversa(),
      findUnique: async () => conversa(),
      update: async (args: Record<string, unknown>) => {
        gravado.conversationUpdates.push(args);
        return conversa();
      },
    },
    conversationAssignmentHistory: { create: async () => ({}) },
    // Transferir e atribuir consultam o atendimento por IA da conversa
    // (para interrompê-lo): sem sessão, a rota segue como antes.
    aiSession: { findFirst: async () => null },
    message: {
      findFirst: async () => ({
        id: MSG_ID,
        organizationId: "org-1",
        direction: "outbound",
        type: "text",
        externalMessageId: "wa-1",
        deletedAt: null,
        timestamp: new Date(),
        content: "oi",
        mediaUrl: null,
        mimeType: null,
        filename: null,
        conversation: conversa(),
      }),
      update: async () => {
        gravado.deletedMessages.push(MSG_ID);
        return {
          id: MSG_ID,
          conversationId: CONV_ID,
          externalMessageId: "wa-1",
          senderExternalId: null,
          senderName: null,
          senderPhone: null,
          direction: "outbound",
          type: "text",
          content: null,
          mediaUrl: null,
          mimeType: null,
          filename: null,
          quotedMessageId: null,
          timestamp: new Date(),
          deletedAt: new Date(),
          editedAt: null,
          status: "sent",
          metadata: null,
          sentByUserId: null,
          createdAt: new Date(),
        };
      },
    },
    // A rota confere se a mensagem apagada estava fixada (e devolve a
    // lista atual mesmo sem remover nada) — sem fixação nenhuma neste
    // teste, então as duas nunca acham linha.
    pinnedItem: { findFirst: async () => null, findMany: async () => [] },
    $transaction: async (arg: unknown) =>
      typeof arg === "function"
        ? (arg as (tx: unknown) => Promise<unknown>)({
            rolePermission: {
              upsert: async (args: Record<string, unknown>) => {
                gravado.permissionWrites.push(args);
                return {};
              },
              deleteMany: async (args: Record<string, unknown>) => {
                gravado.permissionDeletes.push(args);
                return { count: 1 };
              },
            },
          })
        : Promise.all(arg as Promise<unknown>[]),
  } as unknown as PrismaClient;
}

function deps(prisma: PrismaClient): AppDeps {
  return {
    prisma,
    io: fakeIo(),
    audit: {
      record: (entry: { action: string }) => gravado.auditActions.push(entry.action),
    },
    provider: { deleteMessage: async () => undefined },
  } as unknown as AppDeps;
}

async function buildApp(
  register: (app: FastifyInstance, appDeps: AppDeps) => Promise<void>,
  prisma: PrismaClient,
): Promise<FastifyInstance> {
  const app = Fastify();
  await app.register(jwt, { secret: "segredo-de-teste" });
  app.decorate("verifySession", async (payload: AuthTokenPayload) => payload);
  registerErrorHandler(app);
  await register(app, deps(prisma));
  await app.ready();
  return app;
}

function tokenFor(app: FastifyInstance, role: AuthTokenPayload["role"]): string {
  return app.jwt.sign({
    sub: `user-${role}`,
    organizationId: "org-1",
    role,
    name: "Fulano de Tal",
    email: `${role}@example.com`,
  });
}

describe("desligar uma chave fecha a rota de verdade", () => {
  it("supervisor com 'apagar mensagem enviada' DESLIGADO recebe 403", async () => {
    const app = await buildApp(
      messageRoutes,
      fakePrisma([["supervisor", "message.delete_sent", false]]),
    );
    const response = await app.inject({
      method: "DELETE",
      url: `/messages/${MSG_ID}`,
      headers: { authorization: `Bearer ${tokenFor(app, "supervisor")}` },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json().error).toBe("permission_denied");
    // A recusa nomeia a chave: "acesso negado" genérico não diria ao dono do
    // escritório qual chave precisa religar.
    expect(String(response.json().message).toLowerCase()).toContain("apagar mensagem");
    expect(gravado.deletedMessages).toHaveLength(0);
    await app.close();
  });

  it("sem a linha, o mesmo supervisor apaga normalmente", async () => {
    const app = await buildApp(messageRoutes, fakePrisma());
    const response = await app.inject({
      method: "DELETE",
      url: `/messages/${MSG_ID}`,
      headers: { authorization: `Bearer ${tokenFor(app, "supervisor")}` },
    });
    expect(response.statusCode).toBe(200);
    expect(gravado.deletedMessages).toHaveLength(1);
    await app.close();
  });
});

describe("ligar uma chave abre a rota de verdade", () => {
  it("atendente com 'mudar o departamento' LIGADO transfere", async () => {
    const app = await buildApp(
      conversationRoutes,
      fakePrisma([["agent", "conversation.change_department", true]]),
    );
    const response = await app.inject({
      method: "POST",
      url: `/conversations/${CONV_ID}/transfer-department`,
      payload: { departmentId: "33333333-3333-4333-8333-333333333333" },
      headers: { authorization: `Bearer ${tokenFor(app, "agent")}` },
    });
    expect(response.statusCode).toBe(200);
    await app.close();
  });

  it("sem a linha, o mesmo atendente recebe 403 — é o padrão do catálogo", async () => {
    const app = await buildApp(conversationRoutes, fakePrisma());
    const response = await app.inject({
      method: "POST",
      url: `/conversations/${CONV_ID}/transfer-department`,
      payload: { departmentId: "33333333-3333-4333-8333-333333333333" },
      headers: { authorization: `Bearer ${tokenFor(app, "agent")}` },
    });
    expect(response.statusCode).toBe(403);
    await app.close();
  });
});

describe("admin com o catálogo inteiro desligado continua podendo tudo", () => {
  const tudoDesligado = (["agent", "supervisor"] as const).flatMap((role) =>
    PERMISSION_ACTION_KEYS.map(
      (action) => [role, action, false] as [ConfigurableRole, PermissionAction, boolean],
    ),
  );

  it("apaga mensagem", async () => {
    const app = await buildApp(messageRoutes, fakePrisma(tudoDesligado));
    const response = await app.inject({
      method: "DELETE",
      url: `/messages/${MSG_ID}`,
      headers: { authorization: `Bearer ${tokenFor(app, "admin")}` },
    });
    expect(response.statusCode).toBe(200);
    await app.close();
  });

  it("troca o departamento da conversa", async () => {
    const app = await buildApp(conversationRoutes, fakePrisma(tudoDesligado));
    const response = await app.inject({
      method: "POST",
      url: `/conversations/${CONV_ID}/transfer-department`,
      payload: { departmentId: "33333333-3333-4333-8333-333333333333" },
      headers: { authorization: `Bearer ${tokenFor(app, "admin")}` },
    });
    expect(response.statusCode).toBe(200);
    await app.close();
  });
});

describe("PUT /permissions", () => {
  it("nome de ação fora do catálogo é recusado, e nada é gravado", async () => {
    const app = await buildApp(permissionRoutes, fakePrisma());
    const response = await app.inject({
      method: "PUT",
      url: "/permissions",
      payload: { entries: [{ role: "agent", action: "acao.inventada", allowed: true }] },
      headers: { authorization: `Bearer ${tokenFor(app, "admin")}` },
    });
    expect(response.statusCode).toBe(400);
    expect(gravado.permissionWrites).toHaveLength(0);
    await app.close();
  });

  it("papel 'admin' é recusado: administrador não tem chave", async () => {
    const app = await buildApp(permissionRoutes, fakePrisma());
    const response = await app.inject({
      method: "PUT",
      url: "/permissions",
      payload: { entries: [{ role: "admin", action: "audit.view", allowed: false }] },
      headers: { authorization: `Bearer ${tokenFor(app, "admin")}` },
    });
    expect(response.statusCode).toBe(400);
    expect(gravado.permissionWrites).toHaveLength(0);
    await app.close();
  });

  it("supervisor não abre nem grava a tela — ela é fixa em admin", async () => {
    const app = await buildApp(permissionRoutes, fakePrisma());
    const leitura = await app.inject({
      method: "GET",
      url: "/permissions",
      headers: { authorization: `Bearer ${tokenFor(app, "supervisor")}` },
    });
    expect(leitura.statusCode).toBe(403);
    const gravacao = await app.inject({
      method: "PUT",
      url: "/permissions",
      payload: { entries: [{ role: "agent", action: "audit.view", allowed: true }] },
      headers: { authorization: `Bearer ${tokenFor(app, "supervisor")}` },
    });
    expect(gravacao.statusCode).toBe(403);
    await app.close();
  });

  it("voltar ao padrão APAGA a linha, em vez de gravar o valor igual", async () => {
    // Guardar o padrão como linha congelaria o padrão de hoje para esta
    // organização: mudá-lo no código deixaria de valer para ela.
    const app = await buildApp(
      permissionRoutes,
      fakePrisma([["agent", "audit.view", true]]),
    );
    const response = await app.inject({
      method: "PUT",
      url: "/permissions",
      payload: { entries: [{ role: "agent", action: "audit.view", allowed: false }] },
      headers: { authorization: `Bearer ${tokenFor(app, "admin")}` },
    });
    expect(response.statusCode).toBe(200);
    expect(gravado.permissionDeletes).toHaveLength(1);
    expect(gravado.permissionWrites).toHaveLength(0);
    // Toda gravação de permissão vai para a auditoria: é o registro mais
    // sensível do sistema e precisa ter dono e data.
    expect(gravado.auditActions).toContain("permissions.updated");
    await app.close();
  });

  it("gravar valor diferente do padrão cria a linha e audita", async () => {
    const app = await buildApp(permissionRoutes, fakePrisma());
    const response = await app.inject({
      method: "PUT",
      url: "/permissions",
      payload: { entries: [{ role: "agent", action: "audit.view", allowed: true }] },
      headers: { authorization: `Bearer ${tokenFor(app, "admin")}` },
    });
    expect(response.statusCode).toBe(200);
    expect(gravado.permissionWrites).toHaveLength(1);
    expect(gravado.auditActions).toContain("permissions.updated");
    await app.close();
  });
});

/**
 * Desativar usuário: a chave abre UM CAMPO, e não a tela de cadastro.
 *
 * É o par de chaves mais delicado do catálogo, porque a rota que atende o
 * campo é a mesma que troca papel e redefine senha. Sem a conferência de
 * campo, ligar "desativar usuário" para supervisor entregaria a ele o
 * cadastro inteiro — inclusive `role: "admin"` para si mesmo.
 */
describe("user.deactivate abre o campo status, e só ele", () => {
  const ALVO = "44444444-4444-4444-8444-444444444444";

  function usersPrisma(
    overrides: Array<[ConfigurableRole, PermissionAction, boolean]>,
    alvo: { role: string; status: string } = { role: "agent", status: "active" },
  ): PrismaClient {
    const rows = overrides.map(([role, action, allowed]) => ({
      role,
      action,
      allowed,
      updatedAt: new Date("2026-08-18T12:00:00Z"),
      updatedBy: null,
    }));
    const usuario = {
      id: ALVO,
      organizationId: "org-1",
      name: "Fulano",
      email: "fulano@example.com",
      role: alvo.role,
      status: alvo.status,
      avatarUrl: null,
      signMessages: false,
      notificationSound: "sound_1",
      notificationVolume: "medium",
      lastLoginAt: null,
      createdAt: new Date(),
      whatsappAccess: [],
      departmentAccess: [],
    };
    return {
      rolePermission: { findMany: async () => rows },
      user: {
        findFirst: async () => usuario,
        findMany: async () => [usuario],
        update: async (args: Record<string, unknown>) => {
          gravado.conversationUpdates.push(args);
          return { ...usuario, ...(args.data as Record<string, unknown>) };
        },
        count: async () => 1,
      },
      userWhatsAppInstance: { deleteMany: async () => ({ count: 0 }) },
      userDepartment: { deleteMany: async () => ({ count: 0 }) },
      $queryRaw: async () => [],
      $transaction: async (arg: unknown) =>
        typeof arg === "function"
          ? (arg as (tx: unknown) => Promise<unknown>)({
              user: {
                update: async (args: Record<string, unknown>) => {
                  gravado.conversationUpdates.push(args);
                  return { ...usuario, ...(args.data as Record<string, unknown>) };
                },
                count: async () => 1,
              },
              userWhatsAppInstance: { deleteMany: async () => ({ count: 0 }) },
              userDepartment: { deleteMany: async () => ({ count: 0 }) },
              $queryRaw: async () => [],
            })
          : Promise.all(arg as Promise<unknown>[]),
    } as unknown as PrismaClient;
  }

  it("sem a chave, supervisor não desativa — o padrão é não/não", async () => {
    const app = await buildApp(userRoutes, usersPrisma([]));
    const response = await app.inject({
      method: "PATCH",
      url: `/users/${ALVO}`,
      payload: { status: "inactive" },
      headers: { authorization: `Bearer ${tokenFor(app, "supervisor")}` },
    });
    expect(response.statusCode).toBe(403);
    expect(gravado.conversationUpdates).toHaveLength(0);
    await app.close();
  });

  it("com a chave, supervisor desativa", async () => {
    const app = await buildApp(
      userRoutes,
      usersPrisma([["supervisor", "user.deactivate", true]]),
    );
    const response = await app.inject({
      method: "PATCH",
      url: `/users/${ALVO}`,
      payload: { status: "inactive" },
      headers: { authorization: `Bearer ${tokenFor(app, "supervisor")}` },
    });
    expect(response.statusCode).toBe(200);
    expect(gravado.conversationUpdates).toHaveLength(1);
    await app.close();
  });

  it("com a chave, NÃO vira administrador de carona no mesmo corpo", async () => {
    const app = await buildApp(
      userRoutes,
      usersPrisma([["supervisor", "user.deactivate", true]]),
    );
    const response = await app.inject({
      method: "PATCH",
      url: `/users/${ALVO}`,
      payload: { status: "inactive", role: "admin" },
      headers: { authorization: `Bearer ${tokenFor(app, "supervisor")}` },
    });
    expect(response.statusCode).toBe(403);
    expect(gravado.conversationUpdates).toHaveLength(0);
    await app.close();
  });

  it("com a chave, NÃO renomeia nem redefine senha de ninguém", async () => {
    const app = await buildApp(
      userRoutes,
      usersPrisma([["supervisor", "user.deactivate", true]]),
    );
    for (const payload of [{ name: "Outro Nome" }, { password: "senha-nova-123" }]) {
      const response = await app.inject({
        method: "PATCH",
        url: `/users/${ALVO}`,
        payload,
        headers: { authorization: `Bearer ${tokenFor(app, "supervisor")}` },
      });
      expect(response.statusCode).toBe(403);
    }
    expect(gravado.conversationUpdates).toHaveLength(0);
    await app.close();
  });

  it("com a chave, NÃO desativa um administrador", async () => {
    // Sem esta trava, um supervisor desligaria a administração inteira até
    // sobrar o último — que é o único que a trava do último admin barra.
    const app = await buildApp(
      userRoutes,
      usersPrisma([["supervisor", "user.deactivate", true]], {
        role: "admin",
        status: "active",
      }),
    );
    const response = await app.inject({
      method: "PATCH",
      url: `/users/${ALVO}`,
      payload: { status: "inactive" },
      headers: { authorization: `Bearer ${tokenFor(app, "supervisor")}` },
    });
    expect(response.statusCode).toBe(403);
    expect(gravado.conversationUpdates).toHaveLength(0);
    await app.close();
  });

  it("administrador segue editando o cadastro inteiro, sem chave nenhuma", async () => {
    const app = await buildApp(userRoutes, usersPrisma([]));
    const response = await app.inject({
      method: "PATCH",
      url: `/users/${ALVO}`,
      payload: { name: "Nome Novo", status: "inactive" },
      headers: { authorization: `Bearer ${tokenFor(app, "admin")}` },
    });
    expect(response.statusCode).toBe(200);
    await app.close();
  });

  it("criar usuário continua fixo em admin: a chave não alcança o POST", async () => {
    const app = await buildApp(
      userRoutes,
      usersPrisma([["supervisor", "user.deactivate", true]]),
    );
    const response = await app.inject({
      method: "POST",
      url: "/users",
      payload: {
        name: "Novo",
        email: "novo@example.com",
        password: "senha-forte-123",
        role: "agent",
      },
      headers: { authorization: `Bearer ${tokenFor(app, "supervisor")}` },
    });
    expect(response.statusCode).toBe(403);
    await app.close();
  });
});

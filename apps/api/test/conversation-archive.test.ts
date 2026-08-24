import { beforeEach, describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import jwt from "@fastify/jwt";
import type { PrismaClient } from "@azvchat/database";
import type { Logger } from "pino";
import { registerErrorHandler } from "../src/lib/errors.js";
import type { AuthTokenPayload } from "../src/lib/auth.js";
import { conversationRoutes } from "../src/modules/conversations/routes.js";
import { searchRoutes } from "../src/modules/search/routes.js";
import { whatsappInstanceRoutes } from "../src/modules/whatsapp-instances/routes.js";
import { MessageIngestService } from "../src/services/message-ingest.js";
import type { MediaStorage } from "../src/lib/media-storage.js";
import type { AppDeps } from "../src/types.js";
import { rolePermissionStub } from "./helpers/permissions.js";
import { personProfileStub } from "./helpers/person-profile.js";

/**
 * O que estes testes fixam sobre o arquivamento:
 *
 * 1. a listagem exclui arquivadas por padrão, e o parâmetro traz SÓ elas —
 *    nunca as duas misturadas;
 * 2. arquivar passa pelo escopo de acesso (conversa fora do recorte é 404);
 * 3. mensagem nova NÃO desarquiva e não mexe no status (não lido não é mais
 *    contador de conversa: é por usuário, ver conversation-reads.test.ts);
 * 4. a busca global continua encontrando arquivada;
 * 5. a marcação de backup e o arquivamento em massa exigem supervisor;
 * 6. no número de backup a conversa nova já nasce arquivada.
 */

const CONV_ID = "33333333-3333-4333-8333-333333333333";
const INSTANCE_ID = "44444444-4444-4444-8444-444444444444";

interface Recorded {
  conversationFindMany: Array<Record<string, unknown>>;
  conversationCount: Array<Record<string, unknown>>;
  conversationUpdates: Array<Record<string, unknown>>;
  conversationUpdateMany: Array<Record<string, unknown>>;
  conversationCreates: Array<Record<string, unknown>>;
  auditActions: string[];
}

let recorded: Recorded;

function fakeIo() {
  return { to: () => ({ emit: () => undefined }) };
}

function baseConversation(overrides: Record<string, unknown> = {}) {
  return {
    id: CONV_ID,
    organizationId: "org-1",
    whatsappInstanceId: INSTANCE_ID,
    externalChatId: "5511999@s.whatsapp.net",
    type: "individual",
    title: "Cliente",
    customTitle: null,
    profilePicture: null,
    status: "open",
    assignedUserId: null,
    departmentId: null,
    unreadCount: 2,
    archivedAt: null,
    archivedByUserId: null,
    archivedBy: null,
    lastMessageAt: new Date(),
    lastMessagePreview: "Oi",
    externalReference: null,
    externalSource: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    assignedUser: null,
    department: null,
    instance: null,
    tags: [],
    ...overrides,
  };
}

function fakeConversationPrisma(conversation: Record<string, unknown> | null): PrismaClient {
  return {
    rolePermission: rolePermissionStub,
    personProfile: personProfileStub,
    userWhatsAppInstance: { findMany: async () => [] },
    userDepartment: { findMany: async () => [] },
    conversation: {
      findFirst: async () => conversation,
      findUnique: async () => conversation,
      findMany: async (args: Record<string, unknown>) => {
        recorded.conversationFindMany.push(args);
        return [];
      },
      count: async (args: Record<string, unknown>) => {
        recorded.conversationCount.push(args);
        return 0;
      },
      update: async (args: Record<string, unknown>) => {
        recorded.conversationUpdates.push(args);
        return conversation;
      },
    },
  } as unknown as PrismaClient;
}

function depsWith(prisma: PrismaClient): AppDeps {
  return {
    prisma,
    io: fakeIo(),
    audit: {
      record: (entry: { action: string }) => {
        recorded.auditActions.push(entry.action);
      },
    },
  } as unknown as AppDeps;
}

async function buildApp(
  register: (app: FastifyInstance, deps: AppDeps) => Promise<void>,
  prisma: PrismaClient,
): Promise<FastifyInstance> {
  const app = Fastify();
  await app.register(jwt, { secret: "segredo-de-teste" });
  app.decorate("verifySession", async (payload: AuthTokenPayload) => payload);
  registerErrorHandler(app);
  await register(app, depsWith(prisma));
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

beforeEach(() => {
  recorded = {
    conversationFindMany: [],
    conversationCount: [],
    conversationUpdates: [],
    conversationUpdateMany: [],
    conversationCreates: [],
    auditActions: [],
  };
});

describe("GET /conversations (recorte de arquivadas)", () => {
  it("exclui arquivadas por padrão", async () => {
    const app = await buildApp(conversationRoutes, fakeConversationPrisma(null));
    const response = await app.inject({
      method: "GET",
      url: "/conversations",
      headers: { authorization: `Bearer ${tokenFor(app, "admin")}` },
    });
    expect(response.statusCode).toBe(200);
    const where = recorded.conversationFindMany[0]?.where as Record<string, unknown>;
    expect(where.archivedAt).toBeNull();
    // A contagem usa o mesmo filtro da lista.
    expect((recorded.conversationCount[0]?.where as Record<string, unknown>).archivedAt).toBeNull();
    await app.close();
  });

  it("archived=true lista SÓ as arquivadas — nunca misturadas", async () => {
    const app = await buildApp(conversationRoutes, fakeConversationPrisma(null));
    await app.inject({
      method: "GET",
      url: "/conversations?archived=true",
      headers: { authorization: `Bearer ${tokenFor(app, "admin")}` },
    });
    const where = recorded.conversationFindMany[0]?.where as Record<string, unknown>;
    expect(where.archivedAt).toEqual({ not: null });
    await app.close();
  });

});

describe("POST /conversations/:id/archive|unarchive", () => {
  it("atendente NÃO arquiva: o padrão da chave é não/sim", async () => {
    // Arquivar tira a conversa da lista de todo mundo. Depois do menu de
    // Permissões isso é chave (`conversation.archive`), e o padrão de
    // fábrica é supervisor para cima — ligar a chave na tela libera.
    const app = await buildApp(conversationRoutes, fakeConversationPrisma(baseConversation()));
    const response = await app.inject({
      method: "POST",
      url: `/conversations/${CONV_ID}/archive`,
      headers: { authorization: `Bearer ${tokenFor(app, "agent")}` },
    });
    expect(response.statusCode).toBe(403);
    expect(recorded.conversationUpdates).toHaveLength(0);
    await app.close();
  });

  it("arquiva marcando data e autor, e audita", async () => {
    const app = await buildApp(conversationRoutes, fakeConversationPrisma(baseConversation()));
    const response = await app.inject({
      method: "POST",
      url: `/conversations/${CONV_ID}/archive`,
      headers: { authorization: `Bearer ${tokenFor(app, "supervisor")}` },
    });
    expect(response.statusCode).toBe(200);
    const update = recorded.conversationUpdates[0]?.data as Record<string, unknown>;
    expect(update.archivedAt).toBeInstanceOf(Date);
    expect(update.archivedByUserId).toBe("user-supervisor");
    // Não lido não é mais coluna da conversa: nada para zerar aqui, e a
    // contagem por usuário já descarta conversa arquivada.
    expect(update).not.toHaveProperty("unreadCount");
    // Ortogonal ao status: arquivar nunca toca no status do atendimento.
    expect(update).not.toHaveProperty("status");
    expect(recorded.auditActions).toContain("conversation.archived");
    await app.close();
  });

  it("desarquivar limpa data e autor, sem tocar no status", async () => {
    const app = await buildApp(
      conversationRoutes,
      fakeConversationPrisma(
        baseConversation({ archivedAt: new Date(), archivedByUserId: "user-x" }),
      ),
    );
    const response = await app.inject({
      method: "POST",
      url: `/conversations/${CONV_ID}/unarchive`,
      headers: { authorization: `Bearer ${tokenFor(app, "supervisor")}` },
    });
    expect(response.statusCode).toBe(200);
    const update = recorded.conversationUpdates[0]?.data as Record<string, unknown>;
    expect(update).toEqual({ archivedAt: null, archivedByUserId: null });
    expect(recorded.auditActions).toContain("conversation.unarchived");
    await app.close();
  });

  it("conversa fora do escopo de acesso é 404 — arquivar respeita o recorte", async () => {
    // findFirst devolve null: é o que acontece quando conversationScope
    // não casa (número não vinculado, departamento de fora, ownOnly...).
    const app = await buildApp(conversationRoutes, fakeConversationPrisma(null));
    const response = await app.inject({
      method: "POST",
      url: `/conversations/${CONV_ID}/archive`,
      headers: { authorization: `Bearer ${tokenFor(app, "supervisor")}` },
    });
    expect(response.statusCode).toBe(404);
    expect(recorded.conversationUpdates).toHaveLength(0);
    await app.close();
  });
});

describe("mensagem nova em conversa arquivada (ingestão)", () => {
  function ingestHarness(conversation: Record<string, unknown>) {
    const prisma = {
    rolePermission: rolePermissionStub,
      conversation: {
        findUnique: async (args: Record<string, unknown>) => {
          // Duas buscas possíveis: a do upsert (por chave composta) e não há
          // outras neste cenário — a conversa já existe.
          void args;
          return conversation;
        },
        update: async (args: Record<string, unknown>) => {
          recorded.conversationUpdates.push(args);
          return conversation;
        },
        create: async (args: Record<string, unknown>) => {
          recorded.conversationCreates.push(args);
          return { ...baseConversation(), ...(args.data as Record<string, unknown>) };
        },
      },
      whatsAppInstance: {
        findUnique: async () => ({ departmentId: null, defaultAssigneeId: null, isBackup: false }),
      },
      message: {
        findUnique: async () => null,
        create: async () => ({ id: "msg-1" }),
      },
      user: { findFirst: async () => null },
      groupParticipant: { findFirst: async () => null },
    } as unknown as PrismaClient;
    const logger = { info: () => undefined, warn: () => undefined } as unknown as Logger;
    const storage = {} as MediaStorage;
    return new MessageIngestService(prisma, storage, logger);
  }

  const inbound = {
    instanceId: INSTANCE_ID,
    externalChatId: "5511999@s.whatsapp.net",
    externalMessageId: "wamid-1",
    chatType: "individual" as const,
    chatName: null,
    direction: "inbound" as const,
    type: "text" as const,
    content: "Oi",
    senderExternalId: "5511999@s.whatsapp.net",
    senderName: "Cliente",
    senderPhone: "5511999",
    quotedExternalMessageId: null,
    mentionedExternalIds: [],
    timestamp: new Date(),
    media: null,
  };

  it("não desarquiva e não mexe no status", async () => {
    const service = ingestHarness(
      // `lastMessageAt` claramente ANTES da mensagem que está chegando —
      // `inbound.timestamp` é fixado no carregamento do arquivo, e sem
      // isso o `lastMessageAt` fresco (criado agora, na montagem do
      // cenário) ficaria depois dela por coincidência de relógio, e a
      // guarda contra regressão (mensagem antiga não empurra a conversa
      // para trás) pularia a atualização — não é isso que este teste quer
      // exercitar.
      baseConversation({ archivedAt: new Date(), status: "resolved", lastMessageAt: new Date(0) }),
    );
    const result = await service.ingest(inbound, { organizationId: "org-1" });
    expect(result?.isNewMessage).toBe(true);
    const update = recorded.conversationUpdates[0]?.data as Record<string, unknown>;
    // A mensagem é gravada e o preview anda — o histórico fica completo...
    expect(update.lastMessageAt).toBeInstanceOf(Date);
    // ...mas nada de trazer a conversa de volta: sem reabrir status e sem
    // tocar no arquivamento.
    expect(update).not.toHaveProperty("status");
    expect(update).not.toHaveProperty("archivedAt");
  });

  it("na conversa NÃO arquivada o comportamento de sempre continua", async () => {
    const service = ingestHarness(baseConversation({ status: "resolved", lastMessageAt: new Date(0) }));
    await service.ingest(inbound, { organizationId: "org-1" });
    const update = recorded.conversationUpdates.at(-1)?.data as Record<string, unknown>;
    // Nenhum contador de conversa é tocado — o não lido é por usuário.
    expect(update).not.toHaveProperty("unreadCount");
    expect(update.status).toBe("open");
  });
});

describe("número de backup (ingestão e papéis)", () => {
  it("conversa nova no número de backup já nasce arquivada", async () => {
    const prisma = {
    rolePermission: rolePermissionStub,
      conversation: {
        findUnique: async () => null,
        create: async (args: Record<string, unknown>) => {
          recorded.conversationCreates.push(args);
          return {
            // Conversa RECÉM-criada: `lastMessageAt` nulo, como a real —
            // `baseConversation()` sozinho estampa `new Date()` na hora do
            // mock rodar, o que fica DEPOIS do timestamp da mensagem
            // (capturado antes, na montagem do `ingest(...)`) e acionava
            // por engano a guarda contra regredir `lastMessageAt`.
            ...baseConversation({ lastMessageAt: null }),
            ...(args.data as Record<string, unknown>),
          };
        },
        update: async (args: Record<string, unknown>) => {
          recorded.conversationUpdates.push(args);
          return baseConversation();
        },
      },
      whatsAppInstance: {
        findUnique: async () => ({ departmentId: null, defaultAssigneeId: null, isBackup: true }),
      },
      message: { findUnique: async () => null, create: async () => ({ id: "msg-1" }) },
      user: { findFirst: async () => null },
      groupParticipant: { findFirst: async () => null },
    } as unknown as PrismaClient;
    const logger = { info: () => undefined, warn: () => undefined } as unknown as Logger;
    const service = new MessageIngestService(prisma, {} as MediaStorage, logger);

    await service.ingest(
      {
        instanceId: INSTANCE_ID,
        externalChatId: "5511888@s.whatsapp.net",
        externalMessageId: "wamid-2",
        chatType: "individual",
        chatName: null,
        direction: "inbound",
        type: "text",
        content: "Oi",
        senderExternalId: "5511888@s.whatsapp.net",
        senderName: "Cliente",
        senderPhone: "5511888",
        quotedExternalMessageId: null,
        mentionedExternalIds: [],
        timestamp: new Date(),
        media: null,
      },
      { organizationId: "org-1" },
    );
    const created = recorded.conversationCreates[0]?.data as Record<string, unknown>;
    expect(created.archivedAt).toBeInstanceOf(Date);
    // Nascida arquivada: sem responsável padrão e sem reabrir status.
    const update = recorded.conversationUpdates[0]?.data as Record<string, unknown>;
    expect(update).not.toHaveProperty("unreadCount");
  });

  function instancePrisma(): PrismaClient {
    return {
      rolePermission: rolePermissionStub,
      userWhatsAppInstance: { findMany: async () => [{ whatsappInstanceId: INSTANCE_ID }] },
      whatsAppInstance: {
        findFirst: async () => ({
          id: INSTANCE_ID,
          organizationId: "org-1",
          name: "Backup",
          phoneNumber: null,
          departmentId: null,
          defaultAssigneeId: null,
          isBackup: false,
          status: "connected",
          provider: "qrcode",
          lastConnectionAt: null,
          lastDisconnectionAt: null,
          createdAt: new Date(),
        }),
        update: async (args: { data: Record<string, unknown> }) => ({
          id: INSTANCE_ID,
          organizationId: "org-1",
          name: "Backup",
          phoneNumber: null,
          departmentId: null,
          defaultAssigneeId: null,
          isBackup: Boolean(args.data.isBackup),
          status: "connected",
          provider: "qrcode",
          lastConnectionAt: null,
          lastDisconnectionAt: null,
          createdAt: new Date(),
        }),
      },
      conversation: {
        count: async (args: Record<string, unknown>) => {
          recorded.conversationCount.push(args);
          return 3;
        },
        findMany: async (args: Record<string, unknown>) => {
          recorded.conversationFindMany.push(args);
          // Uma rodada com lote e a seguinte vazia, para o laço terminar.
          if (recorded.conversationFindMany.length > 1) return [];
          return [{ id: CONV_ID }];
        },
        updateMany: async (args: Record<string, unknown>) => {
          recorded.conversationUpdateMany.push(args);
          return { count: 1 };
        },
      },
    } as unknown as PrismaClient;
  }

  it("agent não liga a marcação de backup nem arquiva em massa (403)", async () => {
    const app = await buildApp(whatsappInstanceRoutes, instancePrisma());
    const patch = await app.inject({
      method: "PATCH",
      url: `/whatsapp-instances/${INSTANCE_ID}`,
      payload: { isBackup: true },
      headers: { authorization: `Bearer ${tokenFor(app, "agent")}` },
    });
    expect(patch.statusCode).toBe(403);
    const bulk = await app.inject({
      method: "POST",
      url: `/whatsapp-instances/${INSTANCE_ID}/archive-all`,
      headers: { authorization: `Bearer ${tokenFor(app, "agent")}` },
    });
    expect(bulk.statusCode).toBe(403);
    const count = await app.inject({
      method: "GET",
      url: `/whatsapp-instances/${INSTANCE_ID}/archivable-count`,
      headers: { authorization: `Bearer ${tokenFor(app, "agent")}` },
    });
    expect(count.statusCode).toBe(403);
    await app.close();
  });

  it("supervisor liga a marcação, com auditoria própria", async () => {
    const app = await buildApp(whatsappInstanceRoutes, instancePrisma());
    const response = await app.inject({
      method: "PATCH",
      url: `/whatsapp-instances/${INSTANCE_ID}`,
      payload: { isBackup: true },
      headers: { authorization: `Bearer ${tokenFor(app, "supervisor")}` },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().instance.isBackup).toBe(true);
    expect(recorded.auditActions).toContain("whatsapp.backup_enabled");
    await app.close();
  });

  it("arquivamento em massa roda em lote e audita a quantidade", async () => {
    const app = await buildApp(whatsappInstanceRoutes, instancePrisma());
    const response = await app.inject({
      method: "POST",
      url: `/whatsapp-instances/${INSTANCE_ID}/archive-all`,
      headers: { authorization: `Bearer ${tokenFor(app, "supervisor")}` },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ archived: 1 });
    const data = recorded.conversationUpdateMany[0]?.data as Record<string, unknown>;
    expect(data.archivedAt).toBeInstanceOf(Date);
    expect(data.archivedByUserId).toBe("user-supervisor");
    expect(data).not.toHaveProperty("unreadCount");
    // O lote só pega as ainda não arquivadas — rodar duas vezes não regrava.
    const where = recorded.conversationFindMany[0]?.where as Record<string, unknown>;
    expect(where.archivedAt).toBeNull();
    expect(recorded.auditActions).toContain("whatsapp.conversations_bulk_archived");
    await app.close();
  });
});

describe("GET /search (arquivada continua aparecendo)", () => {
  it("a busca de conversas não filtra por arquivamento", async () => {
    const prisma = {
    rolePermission: rolePermissionStub,
      personProfile: personProfileStub,
      userWhatsAppInstance: { findMany: async () => [] },
      userDepartment: { findMany: async () => [] },
      conversation: {
        findMany: async (args: Record<string, unknown>) => {
          recorded.conversationFindMany.push(args);
          return [];
        },
      },
      message: { findMany: async () => [] },
      groupParticipant: { findMany: async () => [] },
    } as unknown as PrismaClient;
    const app = await buildApp(searchRoutes, prisma);
    const response = await app.inject({
      method: "GET",
      url: "/search?q=cliente",
      headers: { authorization: `Bearer ${tokenFor(app, "admin")}` },
    });
    expect(response.statusCode).toBe(200);
    // Se sumisse de tudo, não haveria como achá-la para desarquivar.
    const where = recorded.conversationFindMany[0]?.where as Record<string, unknown>;
    expect(where).not.toHaveProperty("archivedAt");
    await app.close();
  });
});

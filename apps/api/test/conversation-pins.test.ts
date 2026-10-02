import { beforeEach, describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import jwt from "@fastify/jwt";
import type { PrismaClient } from "@azvchat/database";
import { MAX_PINNED_CONVERSATIONS, RealtimeEvents, sortWithPinnedFirst } from "@azvchat/shared";
import { registerErrorHandler } from "../src/lib/errors.js";
import type { AuthTokenPayload } from "../src/lib/auth.js";
import { loadVisiblePins, pinConversation, unpinConversation } from "../src/lib/conversation-pins.js";
import { conversationRoutes } from "../src/modules/conversations/routes.js";
import type { AppDeps } from "../src/types.js";
import { rolePermissionStub } from "./helpers/permissions.js";
import { personProfileStub } from "./helpers/person-profile.js";
import { followUpExecutionStub, followUpRuleStub } from "./helpers/follow-up.js";

/**
 * O que estes testes fixam sobre a conversa fixada no topo da lista:
 *
 * 1. é POR PESSOA — fixar não aparece para mais ninguém, e uma pessoa não
 *    desafixa a da outra;
 * 2. o teto é de 3, e a quarta é recusada com 409 nomeando o teto;
 * 3. fixação de conversa fora do alcance (ou arquivada) não ocupa vaga: é
 *    podada na próxima fixação, em vez de travar o teto com uma invisível;
 * 4. a lista só põe as fixadas no topo quando a Inbox pede (`pinnedFirst`),
 *    elas passam pelos mesmos filtros e não aparecem duas vezes;
 * 5. o evento vai para a sala PESSOAL, nunca para a audiência da conversa.
 */

const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const C = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const D = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

interface FakeConversation {
  id: string;
  archivedAt: Date | null;
  /** Simula o recorte de `access.ts`: falso = fora do alcance da pessoa. */
  visible: boolean;
}
interface FakePin {
  id: string;
  organizationId: string;
  userId: string;
  conversationId: string;
  pinnedAt: Date;
}

/**
 * Prisma mínimo para as fixações. O filtro `conversation.is` é avaliado como
 * "no alcance E não arquivada", que é exatamente o que a lib pede ao banco.
 */
function pinStore(conversations: FakeConversation[]) {
  const pins: FakePin[] = [];
  let clock = 1_000;
  const passes = (conversationId: string) => {
    const conversation = conversations.find((item) => item.id === conversationId);
    return Boolean(conversation && conversation.visible && !conversation.archivedAt);
  };
  const matches = (pin: FakePin, where: Record<string, unknown>) => {
    if (where.userId && pin.userId !== where.userId) return false;
    if (where.conversationId && pin.conversationId !== where.conversationId) return false;
    if (where.conversation && !passes(pin.conversationId)) return false;
    if (where.NOT && passes(pin.conversationId)) return false;
    return true;
  };
  const prisma = {
    conversationPin: {
      findMany: async ({ where }: { where: Record<string, unknown> }) =>
        pins
          .filter((pin) => matches(pin, where))
          .sort((a, b) => b.pinnedAt.getTime() - a.pinnedAt.getTime()),
      findUnique: async ({
        where,
      }: {
        where: { userId_conversationId: { userId: string; conversationId: string } };
      }) =>
        pins.find(
          (pin) =>
            pin.userId === where.userId_conversationId.userId &&
            pin.conversationId === where.userId_conversationId.conversationId,
        ) ?? null,
      count: async ({ where }: { where: Record<string, unknown> }) =>
        pins.filter((pin) => matches(pin, where)).length,
      create: async ({ data }: { data: Omit<FakePin, "id" | "pinnedAt"> }) => {
        const pin = { ...data, id: `pin-${pins.length}`, pinnedAt: new Date((clock += 1000)) };
        pins.push(pin);
        return pin;
      },
      deleteMany: async ({ where }: { where: Record<string, unknown> }) => {
        const before = pins.length;
        for (let i = pins.length - 1; i >= 0; i--) {
          if (matches(pins[i]!, where)) pins.splice(i, 1);
        }
        return { count: before - pins.length };
      },
    },
  };
  return { prisma: prisma as unknown as PrismaClient, pins };
}

const visibleWhere = { organizationId: "org-1" };

function pin(prisma: PrismaClient, userId: string, conversationId: string) {
  return pinConversation(prisma, { organizationId: "org-1", userId, conversationId, visibleWhere });
}

describe("lib/conversation-pins", () => {
  it("é por pessoa: a fixação de uma não aparece nem é desfeita pela outra", async () => {
    const { prisma } = pinStore([{ id: A, archivedAt: null, visible: true }]);
    await pin(prisma, "tatiana", A);
    expect(Object.keys(await loadVisiblePins(prisma, "tatiana", visibleWhere))).toEqual([A]);
    expect(await loadVisiblePins(prisma, "damiana", visibleWhere)).toEqual({});

    await unpinConversation(prisma, { userId: "damiana", conversationId: A, visibleWhere });
    expect(Object.keys(await loadVisiblePins(prisma, "tatiana", visibleWhere))).toEqual([A]);
  });

  it(`recusa a ${MAX_PINNED_CONVERSATIONS + 1}ª com 409, e fixar de novo a mesma é no-op`, async () => {
    const { prisma, pins } = pinStore(
      [A, B, C, D].map((id) => ({ id, archivedAt: null, visible: true })),
    );
    await pin(prisma, "u", A);
    await pin(prisma, "u", B);
    await pin(prisma, "u", C);
    // Clique repetido não regrava a data nem conta como nova.
    await pin(prisma, "u", C);
    expect(pins).toHaveLength(3);
    await expect(pin(prisma, "u", D)).rejects.toMatchObject({
      statusCode: 409,
      code: "conversation_pin_limit_reached",
    });
  });

  it("a mais recente fica no topo", async () => {
    const { prisma } = pinStore([A, B].map((id) => ({ id, archivedAt: null, visible: true })));
    await pin(prisma, "u", A);
    const pinned = await pin(prisma, "u", B);
    expect(Object.keys(pinned)).toEqual([B, A]);
    expect(sortWithPinnedFirst([{ id: C }, { id: A }, { id: D }, { id: B }], pinned)).toEqual([
      { id: B },
      { id: A },
      { id: C },
      { id: D },
    ]);
  });

  it("fixação que saiu do alcance ou foi arquivada não trava o teto: é podada", async () => {
    const conversations = [A, B, C, D].map((id) => ({
      id,
      archivedAt: null as Date | null,
      visible: true,
    }));
    const { prisma, pins } = pinStore(conversations);
    await pin(prisma, "u", A);
    await pin(prisma, "u", B);
    await pin(prisma, "u", C);
    conversations[0]!.visible = false; // A trocou de departamento
    conversations[1]!.archivedAt = new Date(); // B foi arquivada por outro caminho

    // Só C aparece — e há vaga para D.
    expect(Object.keys(await loadVisiblePins(prisma, "u", visibleWhere))).toEqual([C]);
    const pinned = await pin(prisma, "u", D);
    expect(Object.keys(pinned)).toEqual([D, C]);
    expect(pins.map((item) => item.conversationId).sort()).toEqual([C, D].sort());
  });
});

// ---------------- Rotas ----------------

function conversationRow(id: string) {
  return {
    id,
    organizationId: "org-1",
    whatsappInstanceId: "44444444-4444-4444-8444-444444444444",
    externalChatId: `${id}@s.whatsapp.net`,
    type: "individual",
    title: id,
    customTitle: null,
    status: "open",
    assignedUserId: null,
    assignedToAll: false,
    departmentId: null,
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
  };
}

interface RouteRecorded {
  findMany: Array<{ where: Record<string, unknown> }>;
  emits: Array<{ room: string; event: string; payload: unknown }>;
}
let routeRecorded: RouteRecorded;

beforeEach(() => {
  routeRecorded = { findMany: [], emits: [] };
});

async function buildApp(prisma: Record<string, unknown>): Promise<FastifyInstance> {
  const app = Fastify();
  await app.register(jwt, { secret: "segredo-de-teste" });
  app.decorate("verifySession", async (payload: AuthTokenPayload) => payload);
  registerErrorHandler(app);
  const deps = {
    prisma: {
      rolePermission: rolePermissionStub,
      personProfile: personProfileStub,
      followUpRule: followUpRuleStub,
      followUpExecution: followUpExecutionStub,
      userWhatsAppInstance: { findMany: async () => [] },
      userDepartment: { findMany: async () => [] },
      conversationRead: { findMany: async () => [] },
      aiSession: { findMany: async () => [] },
      automationExecution: { findMany: async () => [] },
      $queryRaw: async () => [],
      ...prisma,
    },
    io: {
      to: (room: string) => ({
        emit: (event: string, payload: unknown) => routeRecorded.emits.push({ room, event, payload }),
      }),
    },
    audit: { record: () => undefined },
  } as unknown as AppDeps;
  await conversationRoutes(app, deps);
  await app.ready();
  return app;
}

function adminToken(app: FastifyInstance): string {
  return app.jwt.sign({
    sub: "user-admin",
    organizationId: "org-1",
    role: "admin",
    name: "Admin",
    email: "admin@example.com",
  });
}

function listPrisma(pinnedAt: Date | null) {
  return {
    conversationPin: {
      findMany: async () => (pinnedAt ? [{ conversationId: C, pinnedAt }] : []),
    },
    conversation: {
      findMany: async (args: { where: Record<string, unknown> }) => {
        routeRecorded.findMany.push(args);
        const and = (args.where.AND as Array<Record<string, unknown>>) ?? [];
        const pinnedOnly = and.some(
          (item) => (item.id as { in?: string[] } | undefined)?.in !== undefined,
        );
        return pinnedOnly ? [conversationRow(C)] : [conversationRow(A), conversationRow(B)];
      },
      count: async () => 3,
    },
  };
}

describe("GET /conversations com pinnedFirst", () => {
  it("põe a fixada no topo, fora da paginação normal, pelos mesmos filtros", async () => {
    const app = await buildApp(listPrisma(new Date("2026-10-02T10:00:00Z")));
    const response = await app.inject({
      method: "GET",
      url: "/conversations?pinnedFirst=true&status=open",
      headers: { authorization: `Bearer ${adminToken(app)}` },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      conversations: Array<{ id: string }>;
      pinned: Record<string, string>;
      total: number;
    };
    expect(body.conversations.map((item) => item.id)).toEqual([C, A, B]);
    expect(body.pinned).toEqual({ [C]: "2026-10-02T10:00:00.000Z" });
    expect(body.total).toBe(3);

    const [main, pinnedQuery] = routeRecorded.findMany;
    const mainAnd = main!.where.AND as Array<Record<string, unknown>>;
    const pinnedAnd = pinnedQuery!.where.AND as Array<Record<string, unknown>>;
    // Fora da paginação normal: não aparece duas vezes.
    expect(mainAnd).toContainEqual({ id: { notIn: [C] } });
    // E passa pelo MESMO filtro de status da lista — não fura o recorte.
    expect(pinnedAnd).toContainEqual({ status: { in: ["open"] } });
    expect(pinnedAnd).toContainEqual({ id: { in: [C] } });
    await app.close();
  });

  it("sem o parâmetro (Quality, relatório) nada muda: sem consulta de fixadas", async () => {
    const app = await buildApp(listPrisma(new Date()));
    const response = await app.inject({
      method: "GET",
      url: "/conversations",
      headers: { authorization: `Bearer ${adminToken(app)}` },
    });
    const body = response.json() as { conversations: Array<{ id: string }>; pinned: unknown };
    expect(body.conversations.map((item) => item.id)).toEqual([A, B]);
    expect(body.pinned).toEqual({});
    expect(routeRecorded.findMany).toHaveLength(1);
    await app.close();
  });
});

describe("POST /conversations/:id/pin", () => {
  it("avisa só a sala PESSOAL de quem fixou", async () => {
    const { prisma } = pinStore([{ id: A, archivedAt: null, visible: true }]);
    const app = await buildApp({
      conversationPin: (prisma as unknown as { conversationPin: unknown }).conversationPin,
      conversation: { findFirst: async () => conversationRow(A) },
    });
    const response = await app.inject({
      method: "POST",
      url: `/conversations/${A}/pin`,
      headers: { authorization: `Bearer ${adminToken(app)}` },
    });
    expect(response.statusCode).toBe(200);
    expect(Object.keys((response.json() as { pinned: object }).pinned)).toEqual([A]);
    expect(routeRecorded.emits).toEqual([
      {
        room: "user:user-admin",
        event: RealtimeEvents.ConversationPins,
        payload: { pinned: (response.json() as { pinned: object }).pinned },
      },
    ]);
    await app.close();
  });

  it("conversa arquivada não é fixada", async () => {
    const app = await buildApp({
      conversation: {
        findFirst: async () => ({ ...conversationRow(A), archivedAt: new Date() }),
      },
    });
    const response = await app.inject({
      method: "POST",
      url: `/conversations/${A}/pin`,
      headers: { authorization: `Bearer ${adminToken(app)}` },
    });
    expect(response.statusCode).toBe(409);
    await app.close();
  });
});

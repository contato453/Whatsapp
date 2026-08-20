import { beforeEach, describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import jwt from "@fastify/jwt";
import type { PrismaClient } from "@azvchat/database";
import { registerErrorHandler } from "../src/lib/errors.js";
import type { AuthTokenPayload } from "../src/lib/auth.js";
import { messageRoutes } from "../src/modules/messages/routes.js";
import type { AppDeps } from "../src/types.js";
import { rolePermissionStub } from "./helpers/permissions.js";

/**
 * O que estes testes fixam sobre a fixação (pin):
 *
 * 1. o limite de 3 fixadas por conversa é recusado com 409, e substituir a
 *    mais antiga (`replaceItemId`) troca as duas numa transação só;
 * 2. fixar respeita o MESMO escopo de acesso das outras rotas de mensagem —
 *    mensagem fora do recorte (número/departamento fora do alcance) é 404,
 *    como se não existisse;
 * 3. fixar e desafixar NUNCA chamam o provider — é interna ao AZVCHAT, e
 *    nunca deve tocar o WhatsApp.
 */

const CONV_ID = "33333333-3333-4333-8333-333333333333";
const INSTANCE_ID = "44444444-4444-4444-8444-444444444444";
const MESSAGE_ID = "55555555-5555-4555-8555-555555555555";
// `replaceItemId` é validado por `z.string().uuid()` na rota — ids de
// fixação de teste precisam ser UUID de verdade, não só "pin-1".
const PIN_1 = "11111111-1111-4111-8111-111111111111";
const PIN_2 = "22222222-2222-4222-8222-222222222222";
const PIN_3 = "77777777-7777-4777-8777-777777777777";
const PIN_EXISTING = "66666666-6666-4666-8666-666666666666";

function baseConversation(overrides: Record<string, unknown> = {}) {
  return {
    id: CONV_ID,
    organizationId: "org-1",
    whatsappInstanceId: INSTANCE_ID,
    departmentId: null,
    assignedUserId: null,
    ...overrides,
  };
}

function baseMessage(overrides: Record<string, unknown> = {}) {
  return {
    id: MESSAGE_ID,
    conversationId: CONV_ID,
    organizationId: "org-1",
    externalMessageId: "wamid-1",
    direction: "inbound",
    type: "text",
    content: "https://exemplo.com/formulario",
    deletedAt: null,
    editedAt: null,
    timestamp: new Date("2026-08-20T12:00:00Z"),
    status: "delivered",
    metadata: null,
    mimeType: null,
    filename: null,
    quotedMessageId: null,
    senderExternalId: null,
    senderName: null,
    senderPhone: null,
    sentByUserId: null,
    conversation: baseConversation(),
    ...overrides,
  };
}

interface PinRecord {
  id: string;
  conversationId: string;
  messageId: string | null;
  noteId: string | null;
  pinnedByUserId: string | null;
  pinnedAt: Date;
  message: Record<string, unknown> | null;
  note: Record<string, unknown> | null;
  pinnedBy: Record<string, unknown> | null;
}

interface Recorded {
  pinnedCreate: Array<Record<string, unknown>>;
  pinnedDelete: Array<Record<string, unknown>>;
  auditActions: string[];
}

let recorded: Recorded;

/** Nenhum método pode ser chamado — é assim que o teste prova que fixar
 * nunca toca o provider. Chamar qualquer coisa aqui derruba o teste. */
function forbiddenProvider() {
  return new Proxy(
    {},
    {
      get() {
        throw new Error("fixar/desafixar não deveria chamar o provider");
      },
    },
  );
}

function fakeIo() {
  return { to: () => ({ emit: () => undefined }) };
}

function fakePrisma(message: Record<string, unknown> | null, initialPins: PinRecord[]): PrismaClient {
  const items = [...initialPins];
  return {
    rolePermission: rolePermissionStub,
    userWhatsAppInstance: { findMany: async () => [] },
    userDepartment: { findMany: async () => [] },
    message: { findFirst: async () => message },
    pinnedItem: {
      findFirst: async (args: { where: Record<string, unknown> }) => {
        const where = args.where;
        return (
          items.find(
            (item) =>
              item.conversationId === where.conversationId &&
              (where.id === undefined || item.id === where.id) &&
              (where.messageId === undefined || item.messageId === where.messageId) &&
              (where.noteId === undefined || item.noteId === where.noteId),
          ) ?? null
        );
      },
      count: async (args: { where: Record<string, unknown> }) =>
        items.filter((item) => item.conversationId === args.where.conversationId).length,
      findMany: async (args: { where: Record<string, unknown> }) =>
        items
          .filter((item) => item.conversationId === args.where.conversationId)
          .sort((a, b) => a.pinnedAt.getTime() - b.pinnedAt.getTime()),
      create: async (args: { data: Record<string, unknown> }) => {
        recorded.pinnedCreate.push(args);
        const messageId = (args.data.messageId as string) ?? null;
        const record: PinRecord = {
          id: `88888888-8888-4888-8888-${String(items.length + 1).padStart(12, "0")}`,
          conversationId: args.data.conversationId as string,
          messageId,
          noteId: (args.data.noteId as string) ?? null,
          pinnedByUserId: (args.data.pinnedByUserId as string) ?? null,
          pinnedAt: new Date(),
          // Resolve a "junção" que um include de verdade faria: só a
          // mensagem que o teste está fixando tem o objeto disponível aqui.
          message: message && messageId === (message as { id?: string }).id ? message : null,
          note: null,
          pinnedBy: null,
        };
        items.push(record);
        return record;
      },
      delete: async (args: { where: { id: string } }) => {
        recorded.pinnedDelete.push(args);
        const index = items.findIndex((item) => item.id === args.where.id);
        const [removed] = items.splice(index, 1);
        return removed;
      },
    },
    $transaction: async (ops: Array<Promise<unknown>>) => Promise.all(ops),
  } as unknown as PrismaClient;
}

function depsWith(prisma: PrismaClient): AppDeps {
  return {
    prisma,
    io: fakeIo(),
    provider: forbiddenProvider(),
    audit: {
      record: (entry: { action: string }) => {
        recorded.auditActions.push(entry.action);
      },
    },
  } as unknown as AppDeps;
}

async function buildApp(prisma: PrismaClient): Promise<FastifyInstance> {
  const app = Fastify();
  await app.register(jwt, { secret: "segredo-de-teste" });
  app.decorate("verifySession", async (payload: AuthTokenPayload) => payload);
  registerErrorHandler(app);
  await messageRoutes(app, depsWith(prisma));
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

function pinRecord(overrides: Partial<PinRecord> = {}): PinRecord {
  return {
    id: PIN_EXISTING,
    conversationId: CONV_ID,
    messageId: "msg-antiga",
    noteId: null,
    pinnedByUserId: "user-agent",
    pinnedAt: new Date("2026-08-01T00:00:00Z"),
    message: null,
    note: null,
    pinnedBy: null,
    ...overrides,
  };
}

beforeEach(() => {
  recorded = { pinnedCreate: [], pinnedDelete: [], auditActions: [] };
});

describe("POST /messages/:id/pin (limite de 3)", () => {
  it("papel mínimo agent já fixa, com padrão liberado", async () => {
    const app = await buildApp(fakePrisma(baseMessage(), []));
    const response = await app.inject({
      method: "POST",
      url: `/messages/${MESSAGE_ID}/pin`,
      headers: { authorization: `Bearer ${tokenFor(app, "agent")}` },
    });
    expect(response.statusCode).toBe(201);
    expect(response.json().items).toHaveLength(1);
    expect(recorded.auditActions).toContain("message.pinned");
    await app.close();
  });

  it("a quarta fixada é recusada com 409, sem criar linha", async () => {
    const tresFixadas = [
      pinRecord({ id: PIN_1, messageId: "msg-1", pinnedAt: new Date("2026-08-01T00:00:00Z") }),
      pinRecord({ id: PIN_2, messageId: "msg-2", pinnedAt: new Date("2026-08-02T00:00:00Z") }),
      pinRecord({ id: PIN_3, messageId: "msg-3", pinnedAt: new Date("2026-08-03T00:00:00Z") }),
    ];
    const app = await buildApp(fakePrisma(baseMessage(), tresFixadas));
    const response = await app.inject({
      method: "POST",
      url: `/messages/${MESSAGE_ID}/pin`,
      headers: { authorization: `Bearer ${tokenFor(app, "agent")}` },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().error).toBe("pin_limit_reached");
    expect(recorded.pinnedCreate).toHaveLength(0);
    expect(recorded.auditActions).not.toContain("message.pinned");
    await app.close();
  });

  it("substituir a mais antiga troca as duas numa transação só, e audita as duas pontas", async () => {
    const tresFixadas = [
      pinRecord({ id: PIN_1, messageId: "msg-1", pinnedAt: new Date("2026-08-01T00:00:00Z") }),
      pinRecord({ id: PIN_2, messageId: "msg-2", pinnedAt: new Date("2026-08-02T00:00:00Z") }),
      pinRecord({ id: PIN_3, messageId: "msg-3", pinnedAt: new Date("2026-08-03T00:00:00Z") }),
    ];
    const app = await buildApp(fakePrisma(baseMessage(), tresFixadas));
    const response = await app.inject({
      method: "POST",
      url: `/messages/${MESSAGE_ID}/pin`,
      payload: { replaceItemId: PIN_1 },
      headers: { authorization: `Bearer ${tokenFor(app, "agent")}` },
    });
    expect(response.statusCode).toBe(201);
    const items = response.json().items as Array<{ id: string; message: { id: string } | null }>;
    expect(items).toHaveLength(3);
    // A mais antiga saiu, a nova entrou — nunca 4 fixadas ao mesmo tempo.
    expect(items.some((item) => item.id === PIN_1)).toBe(false);
    expect(items.some((item) => item.message?.id === MESSAGE_ID)).toBe(true);
    expect(recorded.auditActions).toContain("message.pinned");
    expect(recorded.auditActions).toContain("message.unpinned");
    await app.close();
  });

  it("fixar o que já está fixado é idempotente — não duplica linha", async () => {
    const jaFixada = [pinRecord({ id: PIN_EXISTING, messageId: MESSAGE_ID })];
    const app = await buildApp(fakePrisma(baseMessage(), jaFixada));
    const response = await app.inject({
      method: "POST",
      url: `/messages/${MESSAGE_ID}/pin`,
      headers: { authorization: `Bearer ${tokenFor(app, "agent")}` },
    });
    expect(response.statusCode).toBe(201);
    expect(response.json().items).toHaveLength(1);
    expect(recorded.pinnedCreate).toHaveLength(0);
    // Sem novidade, sem auditoria — fixar de novo não é uma ação nova.
    expect(recorded.auditActions).not.toContain("message.pinned");
    await app.close();
  });
});

describe("POST /messages/:id/pin|unpin (escopo de acesso)", () => {
  it("mensagem fora do recorte de acesso é 404, como se não existisse", async () => {
    // `message.findFirst` devolve null: é o que acontece quando o filtro
    // por `conversationScope` não casa (número não vinculado ao login).
    const app = await buildApp(fakePrisma(null, []));
    const pin = await app.inject({
      method: "POST",
      url: `/messages/${MESSAGE_ID}/pin`,
      headers: { authorization: `Bearer ${tokenFor(app, "agent")}` },
    });
    expect(pin.statusCode).toBe(404);
    expect(recorded.pinnedCreate).toHaveLength(0);

    const unpin = await app.inject({
      method: "POST",
      url: `/messages/${MESSAGE_ID}/unpin`,
      headers: { authorization: `Bearer ${tokenFor(app, "agent")}` },
    });
    expect(unpin.statusCode).toBe(404);
    await app.close();
  });
});

describe("fixar e desafixar NUNCA chamam o provider", () => {
  it("fixa sem tocar o WhatsApp", async () => {
    const app = await buildApp(fakePrisma(baseMessage(), []));
    const response = await app.inject({
      method: "POST",
      url: `/messages/${MESSAGE_ID}/pin`,
      headers: { authorization: `Bearer ${tokenFor(app, "agent")}` },
    });
    // Se algum caminho tivesse chamado o provider, o proxy teria lançado e
    // a resposta seria 500 — chegar em 201 já prova a ausência da chamada.
    expect(response.statusCode).toBe(201);
    await app.close();
  });

  it("desafixa sem tocar o WhatsApp", async () => {
    const jaFixada = [pinRecord({ id: PIN_EXISTING, messageId: MESSAGE_ID })];
    const app = await buildApp(fakePrisma(baseMessage(), jaFixada));
    const response = await app.inject({
      method: "POST",
      url: `/messages/${MESSAGE_ID}/unpin`,
      headers: { authorization: `Bearer ${tokenFor(app, "agent")}` },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().items).toHaveLength(0);
    expect(recorded.auditActions).toContain("message.unpinned");
    await app.close();
  });
});

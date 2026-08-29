import { beforeEach, describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import type { PrismaClient } from "@azvchat/database";
import { normalizeBrazilPhone } from "@azvchat/shared";
import { registerErrorHandler } from "../src/lib/errors.js";
import { hashIntegrationToken } from "../src/lib/integration-token.js";
import { registerIntegrationSendRoute } from "../src/modules/integrations/message-api.js";
import type { AppDeps } from "../src/types.js";

/**
 * POST /integrations/messages — envio por token de MÁQUINA.
 *
 * Os riscos que estes testes trancam: (1) sem token válido não passa (sem
 * header, token errado, token revogado → 401); (2) o token não envia por
 * instância que não é a dele (403); (3) a idempotência não deixa reenviar a
 * mesma chave; (4) o telefone é normalizado antes de qualquer coisa.
 */

const INSTANCE_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_INSTANCE_ID = "22222222-2222-4222-8222-222222222222";
const TOKEN = "azv_um-token-de-integracao-valido-com-entropia";
const TOKEN_HASH = hashIntegrationToken(TOKEN);

interface LogRow {
  conversationId: string | null;
  messageId: string | null;
  normalizedPhone: string;
  status: string;
  createdAt: Date;
}
interface Recorded {
  sendTextArgs: Array<{ instanceId: string; chatId: string; text: string }>;
  messageCreateArgs: Array<Record<string, unknown>>;
  auditActions: string[];
  emitted: string[];
  logRows: Map<string, LogRow>;
  tokenUpdated: number;
}
let recorded: Recorded;

function buildApp(
  opts: { active?: boolean; connectionStatus?: string; instance?: Record<string, unknown> | null } = {},
): FastifyInstance {
  const token = {
    id: "tok-1",
    organizationId: "org-1",
    name: "Agendamento",
    tokenPrefix: "azv_umtoken",
    tokenHash: TOKEN_HASH,
    whatsappInstanceId: INSTANCE_ID,
    active: opts.active ?? true,
    createdById: null,
    lastUsedAt: null,
    usageCount: 0,
  };
  const instance =
    opts.instance !== undefined
      ? opts.instance
      : { id: INSTANCE_ID, organizationId: "org-1", name: "Atendimento", departmentId: null };

  const prisma = {
    integrationToken: {
      findFirst: async ({ where }: { where: { tokenHash: string } }) =>
        where.tokenHash === TOKEN_HASH ? token : null,
      update: async () => {
        recorded.tokenUpdated += 1;
        return token;
      },
    },
    integrationMessageLog: {
      findUnique: async ({
        where,
      }: {
        where: { integrationTokenId_idempotencyKey: { integrationTokenId: string; idempotencyKey: string } };
      }) => recorded.logRows.get(where.integrationTokenId_idempotencyKey.idempotencyKey) ?? null,
      upsert: async ({
        where,
        create,
      }: {
        where: { integrationTokenId_idempotencyKey: { idempotencyKey: string } };
        create: Record<string, unknown>;
      }) => {
        recorded.logRows.set(where.integrationTokenId_idempotencyKey.idempotencyKey, {
          conversationId: (create.conversationId as string) ?? null,
          messageId: (create.messageId as string) ?? null,
          normalizedPhone: create.normalizedPhone as string,
          status: create.status as string,
          createdAt: new Date(),
        });
        return {};
      },
    },
    whatsAppInstance: { findUnique: async () => instance },
    message: {
      create: async (args: { data: Record<string, unknown> }) => {
        recorded.messageCreateArgs.push(args.data);
        return { id: "msg-1", ...args.data };
      },
    },
    conversation: { update: async () => ({}) },
  } as unknown as PrismaClient;

  const deps = {
    config: { INTEGRATION_TOKEN_RATE_LIMIT_PER_MINUTE: 60 },
    prisma,
    logger: { info() {}, warn() {}, error() {} },
    io: { to: () => ({ emit: (event: string) => recorded.emitted.push(event) }) },
    audit: { record: (entry: { action: string }) => recorded.auditActions.push(entry.action) },
    provider: {
      getConnectionStatus: async () => opts.connectionStatus ?? "connected",
      sendText: async (instanceId: string, chatId: string, text: string) => {
        recorded.sendTextArgs.push({ instanceId, chatId, text });
        return { externalMessageId: "wamid-1", timestamp: new Date("2026-08-29T12:00:00Z") };
      },
    },
    ingest: {
      ensureConversation: async (
        input: { instanceId: string; externalChatId: string },
        organizationId: string,
      ) => ({
        id: "conv-1",
        organizationId,
        whatsappInstanceId: input.instanceId,
        externalChatId: input.externalChatId,
        type: "individual",
        departmentId: null,
        assignedUserId: null,
        instance: null,
        assignedUser: null,
        assignedToAll: false,
        department: null,
        tags: [],
        customTitle: null,
        title: null,
        profilePicture: null,
        status: "open",
        archivedAt: null,
        archivedBy: null,
        lastMessageAt: null,
        lastMessagePreview: null,
        externalReference: null,
        externalSource: null,
        createdAt: new Date("2026-08-29T11:00:00Z"),
      }),
    },
  } as unknown as AppDeps;

  const app = Fastify();
  registerErrorHandler(app);
  void registerIntegrationSendRoute(app, deps);
  return app;
}

function send(app: FastifyInstance, body: Record<string, unknown>, bearer: string | null = TOKEN) {
  return app.inject({
    method: "POST",
    url: "/integrations/messages",
    headers: bearer ? { authorization: `Bearer ${bearer}` } : {},
    payload: body,
  });
}

beforeEach(() => {
  recorded = {
    sendTextArgs: [],
    messageCreateArgs: [],
    auditActions: [],
    emitted: [],
    logRows: new Map(),
    tokenUpdated: 0,
  };
});

describe("POST /integrations/messages — autenticação por token", () => {
  it("sem header nenhum é 401, e nada é enviado", async () => {
    const app = buildApp();
    await app.ready();
    const res = await send(app, { telefone: "5511999998888", mensagem: "oi" }, null);
    expect(res.statusCode).toBe(401);
    expect(recorded.sendTextArgs).toHaveLength(0);
    await app.close();
  });

  it("token errado é 401", async () => {
    const app = buildApp();
    await app.ready();
    const res = await send(app, { telefone: "5511999998888", mensagem: "oi" }, "azv_token-que-nao-existe");
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it("token revogado (active=false) é 401, não 403", async () => {
    const app = buildApp({ active: false });
    await app.ready();
    const res = await send(app, { telefone: "5511999998888", mensagem: "oi" });
    expect(res.statusCode).toBe(401);
    expect(recorded.sendTextArgs).toHaveLength(0);
    await app.close();
  });
});

describe("POST /integrations/messages — amarração à instância", () => {
  it("token tentando enviar por OUTRA instância é 403, e nada é enviado", async () => {
    const app = buildApp();
    await app.ready();
    const res = await send(app, {
      telefone: "5511999998888",
      mensagem: "oi",
      instanceId: OTHER_INSTANCE_ID,
    });
    expect(res.statusCode).toBe(403);
    expect(recorded.sendTextArgs).toHaveLength(0);
    await app.close();
  });

  it("envia SEMPRE pela instância do token, persiste, emite e audita", async () => {
    const app = buildApp();
    await app.ready();
    const res = await send(app, { telefone: "(55) 11 99999-8888", mensagem: "Reunião confirmada." });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      status: "sent",
      messageId: "msg-1",
      conversationId: "conv-1",
      phone: "5511999998888",
      idempotent: false,
    });
    expect(recorded.sendTextArgs[0]).toMatchObject({
      instanceId: INSTANCE_ID,
      chatId: "5511999998888@s.whatsapp.net",
      text: "Reunião confirmada.",
    });
    expect(recorded.messageCreateArgs[0]).toMatchObject({
      direction: "outbound",
      type: "text",
      content: "Reunião confirmada.",
      senderName: "Integração (Agendamento)",
      metadata: { origem: "api-integration", integrationTokenId: "tok-1" },
    });
    expect(recorded.emitted).toEqual(expect.arrayContaining(["message:new", "conversation:updated"]));
    expect(recorded.auditActions).toContain("message.sent.integration");
    expect(recorded.tokenUpdated).toBe(1);
    await app.close();
  });
});

describe("POST /integrations/messages — bordas", () => {
  it("número inválido é 422, sem enviar", async () => {
    const app = buildApp();
    await app.ready();
    const res = await send(app, { telefone: "123", mensagem: "oi" });
    expect(res.statusCode).toBe(422);
    expect(res.json().error).toBe("telefone_invalido");
    expect(recorded.sendTextArgs).toHaveLength(0);
    await app.close();
  });

  it("texto em branco é 422", async () => {
    const app = buildApp();
    await app.ready();
    const res = await send(app, { telefone: "5511999998888", mensagem: "   " });
    expect(res.statusCode).toBe(422);
    expect(res.json().error).toBe("mensagem_vazia");
    await app.close();
  });

  it("destino de grupo é 422", async () => {
    const app = buildApp();
    await app.ready();
    const res = await send(app, { telefone: "120363000000000000@g.us", mensagem: "oi" });
    expect(res.statusCode).toBe(422);
    expect(res.json().error).toBe("grupo_nao_suportado");
    await app.close();
  });

  it("instância desconectada é 409", async () => {
    const app = buildApp({ connectionStatus: "qr_required" });
    await app.ready();
    const res = await send(app, { telefone: "5511999998888", mensagem: "oi" });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("instance_offline");
    expect(recorded.sendTextArgs).toHaveLength(0);
    await app.close();
  });

  it("instância do token excluída é 409", async () => {
    const app = buildApp({ instance: null });
    await app.ready();
    const res = await send(app, { telefone: "5511999998888", mensagem: "oi" });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("instance_unavailable");
    await app.close();
  });
});

describe("POST /integrations/messages — idempotência", () => {
  it("a MESMA chave dentro de 24h não reenvia e devolve o resultado original", async () => {
    const app = buildApp();
    await app.ready();
    const first = await send(app, {
      telefone: "5511999998888",
      mensagem: "oi",
      idempotencyKey: "reserva-42",
    });
    expect(first.statusCode).toBe(200);
    const second = await send(app, {
      telefone: "5511999998888",
      mensagem: "oi",
      idempotencyKey: "reserva-42",
    });
    expect(second.statusCode).toBe(200);
    expect(second.json()).toMatchObject({
      conversationId: "conv-1",
      messageId: "msg-1",
      idempotent: true,
    });
    // Enviou uma vez só.
    expect(recorded.sendTextArgs).toHaveLength(1);
    await app.close();
  });
});

describe("normalizeBrazilPhone", () => {
  it("aceita com/sem 55 e com/sem pontuação", () => {
    expect(normalizeBrazilPhone("11999998888")).toMatchObject({ ok: true, phone: "5511999998888" });
    expect(normalizeBrazilPhone("(55) 11 99999-8888")).toMatchObject({
      ok: true,
      phone: "5511999998888",
    });
    expect(normalizeBrazilPhone("5511999998888")).toMatchObject({ ok: true, phone: "5511999998888" });
  });
  it("aceita fixo de 10 dígitos e recusa lixo/comprimento fora do padrão", () => {
    expect(normalizeBrazilPhone("1133224455")).toMatchObject({ ok: true, phone: "551133224455" });
    expect(normalizeBrazilPhone("123").ok).toBe(false);
    expect(normalizeBrazilPhone("----").ok).toBe(false);
    expect(normalizeBrazilPhone("").ok).toBe(false);
  });
  it("recusa JID de grupo", () => {
    const result = normalizeBrazilPhone("120363000@g.us");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("group");
  });
});

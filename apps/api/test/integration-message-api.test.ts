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
const USER_ID = "33333333-3333-4333-8333-333333333333";
const OTHER_ORG_USER_ID = "44444444-4444-4444-8444-444444444444";
const TAG_ID = "55555555-5555-4555-8555-555555555555";
const OTHER_ORG_TAG_ID = "66666666-6666-4666-8666-666666666666";

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
  conversationUpdates: Array<Record<string, unknown>>;
  historyRows: Array<Record<string, unknown>>;
  tagLinks: Array<{ conversationId: string; tagId: string }>;
  userWhere: Array<Record<string, unknown>>;
  /** Ordem dos efeitos: prova que a atribuição acontece ANTES do envio. */
  timeline: string[];
}
let recorded: Recorded;

function buildApp(
  opts: {
    active?: boolean;
    connectionStatus?: string;
    instance?: Record<string, unknown> | null;
    existingAssignedUserId?: string | null;
  } = {},
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
    // Só o usuário da org-1 existe para a org-1 — o filtro real (ativo, com
    // acesso ao número) é do `eligibleAssigneeWhere`, conferido à parte.
    user: {
      findFirst: async ({ where }: { where: { id: string; organizationId: string } }) => {
        recorded.userWhere.push(where as unknown as Record<string, unknown>);
        return where.id === USER_ID && where.organizationId === "org-1"
          ? { id: USER_ID, name: "Ana Comercial" }
          : null;
      },
    },
    tag: {
      findFirst: async ({ where }: { where: { id: string; organizationId: string } }) =>
        where.id === TAG_ID && where.organizationId === "org-1" ? { id: TAG_ID } : null,
    },
    $transaction: async (ops: Array<Promise<unknown>>) => Promise.all(ops),
    conversationAssignmentHistory: {
      create: async (args: { data: Record<string, unknown> }) => {
        recorded.historyRows.push(args.data);
        return args.data;
      },
    },
    conversationTag: {
      upsert: async (args: { create: { conversationId: string; tagId: string } }) => {
        recorded.timeline.push("tag");
        recorded.tagLinks.push(args.create);
        return args.create;
      },
    },
    aiSession: { findFirst: async () => null },
    message: {
      create: async (args: { data: Record<string, unknown> }) => {
        recorded.messageCreateArgs.push(args.data);
        return { id: "msg-1", ...args.data };
      },
    },
    conversation: {
      update: async (args: { data: Record<string, unknown> }) => {
        if ("assignedUserId" in args.data) recorded.timeline.push("assign");
        recorded.conversationUpdates.push(args.data);
        return {};
      },
      findUnique: async () => ({
        ...baseConversation(INSTANCE_ID, "org-1"),
        assignedUserId: USER_ID,
        assignedUser: { id: USER_ID, name: "Ana Comercial" },
        tags: [],
      }),
    },
  } as unknown as PrismaClient;

  function baseConversation(instanceId: string, organizationId: string) {
    return {
      id: "conv-1",
      organizationId,
      whatsappInstanceId: instanceId,
      externalChatId: "5511999998888@s.whatsapp.net",
      type: "individual",
      departmentId: null,
      assignedUserId: opts.existingAssignedUserId ?? null,
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
    };
  }

  const deps = {
    config: { INTEGRATION_TOKEN_RATE_LIMIT_PER_MINUTE: 60 },
    prisma,
    logger: { info() {}, warn() {}, error() {} },
    io: { to: () => ({ emit: (event: string) => recorded.emitted.push(event) }) },
    audit: { record: (entry: { action: string }) => recorded.auditActions.push(entry.action) },
    provider: {
      getConnectionStatus: async () => opts.connectionStatus ?? "connected",
      sendText: async (instanceId: string, chatId: string, text: string) => {
        recorded.timeline.push("send");
        recorded.sendTextArgs.push({ instanceId, chatId, text });
        return { externalMessageId: "wamid-1", timestamp: new Date("2026-08-29T12:00:00Z") };
      },
    },
    ingest: {
      ensureConversation: async (
        input: { instanceId: string; externalChatId: string },
        organizationId: string,
      ) => baseConversation(input.instanceId, organizationId),
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
    conversationUpdates: [],
    historyRows: [],
    tagLinks: [],
    userWhere: [],
    timeline: [],
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

describe("POST /integrations/messages — responsável e etiqueta", () => {
  it("sem os campos, a conversa segue sem responsável e sem etiqueta (comportamento de antes)", async () => {
    const app = buildApp();
    await app.ready();
    const res = await send(app, { telefone: "5511999998888", mensagem: "oi" });
    expect(res.statusCode).toBe(200);
    expect(recorded.historyRows).toHaveLength(0);
    expect(recorded.tagLinks).toHaveLength(0);
    expect(recorded.conversationUpdates.some((d) => "assignedUserId" in d)).toBe(false);
    await app.close();
  });

  it("atribui o responsável e aplica a etiqueta ANTES de enviar, com histórico e auditoria", async () => {
    const app = buildApp();
    await app.ready();
    const res = await send(app, {
      telefone: "5511999998888",
      mensagem: "oi",
      assignedUserId: USER_ID,
      tagId: TAG_ID,
    });
    expect(res.statusCode).toBe(200);
    expect(recorded.conversationUpdates).toContainEqual({ assignedUserId: USER_ID, assignedToAll: false });
    expect(recorded.historyRows[0]).toMatchObject({
      action: "assigned",
      toUserId: USER_ID,
      performedByUserId: null,
      note: "Atribuído pela integração (Agendamento)",
    });
    expect(recorded.tagLinks).toEqual([{ conversationId: "conv-1", tagId: TAG_ID }]);
    expect(recorded.auditActions).toEqual(
      expect.arrayContaining(["conversation.assigned", "conversation.tag_added", "message.sent.integration"]),
    );
    // A conversa já tem dono quando a mensagem sai: a IA "só sem responsável"
    // não pega a resposta do cliente, por mais rápida que seja.
    expect(recorded.timeline.indexOf("assign")).toBeLessThan(recorded.timeline.indexOf("send"));
    expect(recorded.timeline.indexOf("tag")).toBeLessThan(recorded.timeline.indexOf("send"));
    await app.close();
  });

  it("o responsável é procurado na organização e no número DO TOKEN", async () => {
    const app = buildApp();
    await app.ready();
    await send(app, { telefone: "5511999998888", mensagem: "oi", assignedUserId: USER_ID });
    expect(recorded.userWhere[0]).toMatchObject({ id: USER_ID, organizationId: "org-1", status: "active" });
    expect(JSON.stringify(recorded.userWhere[0])).toContain(INSTANCE_ID);
    await app.close();
  });

  it("conversa que já era de outra pessoa vira transferência", async () => {
    const app = buildApp({ existingAssignedUserId: "77777777-7777-4777-8777-777777777777" });
    await app.ready();
    const res = await send(app, { telefone: "5511999998888", mensagem: "oi", assignedUserId: USER_ID });
    expect(res.statusCode).toBe(200);
    expect(recorded.historyRows[0]).toMatchObject({ action: "transferred_user", toUserId: USER_ID });
    await app.close();
  });

  it("conversa que já é do mesmo responsável não gera histórico repetido", async () => {
    const app = buildApp({ existingAssignedUserId: USER_ID });
    await app.ready();
    const res = await send(app, { telefone: "5511999998888", mensagem: "oi", assignedUserId: USER_ID });
    expect(res.statusCode).toBe(200);
    expect(recorded.historyRows).toHaveLength(0);
    await app.close();
  });

  it("responsável de OUTRA organização é 400, e nada é enviado nem atribuído", async () => {
    const app = buildApp();
    await app.ready();
    const res = await send(app, { telefone: "5511999998888", mensagem: "oi", assignedUserId: OTHER_ORG_USER_ID });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("responsavel_invalido");
    expect(recorded.sendTextArgs).toHaveLength(0);
    expect(recorded.historyRows).toHaveLength(0);
    await app.close();
  });

  it("etiqueta de OUTRA organização é 400, e nada é enviado nem etiquetado", async () => {
    const app = buildApp();
    await app.ready();
    const res = await send(app, { telefone: "5511999998888", mensagem: "oi", tagId: OTHER_ORG_TAG_ID });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("etiqueta_invalida");
    expect(recorded.sendTextArgs).toHaveLength(0);
    expect(recorded.tagLinks).toHaveLength(0);
    await app.close();
  });

  it("id que não é uuid é recusado na validação, sem enviar", async () => {
    const app = buildApp();
    await app.ready();
    const res = await send(app, { telefone: "5511999998888", mensagem: "oi", tagId: "nao-e-uuid" });
    expect(res.statusCode).toBe(400);
    expect(recorded.sendTextArgs).toHaveLength(0);
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

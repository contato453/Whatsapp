import { beforeEach, describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import type { PrismaClient } from "@azvchat/database";
import { registerErrorHandler } from "../src/lib/errors.js";
import { financeiroLembreteRoutes } from "../src/modules/integrations/financeiro-lembrete.js";
import type { AppDeps } from "../src/types.js";

/**
 * POST /integrations/financeiro/lembrete — entrada de serviço do Azevedo-OS
 * (Financeiro), sentido inverso da integração de leitura já existente.
 *
 * Os dois riscos que estes testes protegem: (1) a rota nunca pode ficar
 * aberta por omissão — sem token configurado, ou com token errado, tem que
 * recusar; (2) o escopo é fixo por desenho (um único WhatsAppInstance do
 * `.env`) — o corpo da chamada nunca escolhe a instância.
 */

const INSTANCE_ID = "11111111-1111-4111-8111-111111111111";
const TOKEN = "token-de-teste-com-mais-de-16-chars";

interface Recorded {
  ensureConversationArgs: unknown[];
  sendTextArgs: unknown[];
  messageCreateArgs: unknown[];
  conversationUpdateArgs: unknown[];
  auditActions: string[];
  emitted: Array<{ event: string; payload: unknown }>;
}

let recorded: Recorded;

function buildApp(opts: {
  configOverrides?: Record<string, unknown>;
  connectionStatus?: string;
  instance?: Record<string, unknown> | null;
}): FastifyInstance {
  const instance =
    opts.instance !== undefined
      ? opts.instance
      : { id: INSTANCE_ID, organizationId: "org-1", name: "Financeiro" };

  const prisma = {
    whatsAppInstance: { findUnique: async () => instance },
    message: {
      create: async (args: Record<string, unknown>) => {
        recorded.messageCreateArgs.push(args.data);
        return { id: "msg-1", ...(args.data as Record<string, unknown>) };
      },
    },
    conversation: {
      update: async (args: Record<string, unknown>) => {
        recorded.conversationUpdateArgs.push(args);
        return {};
      },
    },
  } as unknown as PrismaClient;

  const deps = {
    config: {
      FINANCEIRO_LEMBRETE_TOKEN: TOKEN,
      FINANCEIRO_WHATSAPP_INSTANCE_ID: INSTANCE_ID,
      ...opts.configOverrides,
    },
    prisma,
    io: {
      to: () => ({
        emit: (event: string, payload: unknown) => recorded.emitted.push({ event, payload }),
      }),
    },
    audit: {
      record: (entry: { action: string }) => recorded.auditActions.push(entry.action),
    },
    provider: {
      getConnectionStatus: async () => opts.connectionStatus ?? "connected",
      sendText: async (instanceId: string, chatId: string, text: string) => {
        recorded.sendTextArgs.push({ instanceId, chatId, text });
        return { externalMessageId: "wamid-novo", timestamp: new Date("2026-08-26T12:00:00Z") };
      },
    },
    ingest: {
      ensureConversation: async (input: unknown, organizationId: string) => {
        recorded.ensureConversationArgs.push({ input, organizationId });
        // Formato real de uma linha de Conversation (com relações), o que
        // `serializeConversation` de fato lê — não um recorte, senão o teste
        // passaria sobre um mock que a rota de verdade nunca recebe.
        return {
          id: "conv-1",
          organizationId,
          whatsappInstanceId: INSTANCE_ID,
          instance: null,
          externalChatId: "5511999999999@s.whatsapp.net",
          type: "individual",
          customTitle: null,
          title: null,
          profilePicture: null,
          status: "open",
          assignedUser: null,
          assignedToAll: false,
          department: null,
          tags: [],
          archivedAt: null,
          archivedBy: null,
          lastMessageAt: null,
          lastMessagePreview: null,
          externalReference: null,
          externalSource: null,
          createdAt: new Date("2026-08-26T11:00:00Z"),
        };
      },
    },
  } as unknown as AppDeps;

  const app = Fastify();
  registerErrorHandler(app);
  void financeiroLembreteRoutes(app, deps);
  return app;
}

function enviar(app: FastifyInstance, body: Record<string, unknown>, token = TOKEN) {
  return app.inject({
    method: "POST",
    url: "/integrations/financeiro/lembrete",
    headers: token ? { authorization: `Bearer ${token}` } : {},
    payload: body,
  });
}

beforeEach(() => {
  recorded = {
    ensureConversationArgs: [],
    sendTextArgs: [],
    messageCreateArgs: [],
    conversationUpdateArgs: [],
    auditActions: [],
    emitted: [],
  };
});

describe("POST /integrations/financeiro/lembrete", () => {
  it("sem FINANCEIRO_LEMBRETE_TOKEN configurado, responde 503 — nunca aberta por omissão", async () => {
    const app = buildApp({ configOverrides: { FINANCEIRO_LEMBRETE_TOKEN: undefined } });
    await app.ready();
    const response = await enviar(app, { telefone: "5511999999999", mensagem: "oi" });
    expect(response.statusCode).toBe(503);
    expect(recorded.sendTextArgs).toHaveLength(0);
    await app.close();
  });

  it("sem FINANCEIRO_WHATSAPP_INSTANCE_ID configurado, responde 503", async () => {
    const app = buildApp({ configOverrides: { FINANCEIRO_WHATSAPP_INSTANCE_ID: undefined } });
    await app.ready();
    const response = await enviar(app, { telefone: "5511999999999", mensagem: "oi" });
    expect(response.statusCode).toBe(503);
    await app.close();
  });

  it("token errado é recusado com 401, e nada é enviado", async () => {
    const app = buildApp({});
    await app.ready();
    const response = await enviar(app, { telefone: "5511999999999", mensagem: "oi" }, "token-errado-qualquer");
    expect(response.statusCode).toBe(401);
    expect(recorded.sendTextArgs).toHaveLength(0);
    await app.close();
  });

  it("sem header nenhum, também recusa", async () => {
    const app = buildApp({});
    await app.ready();
    const response = await enviar(app, { telefone: "5511999999999", mensagem: "oi" }, "");
    expect(response.statusCode).toBe(401);
    await app.close();
  });

  it("instância desconectada responde 503, não 500 genérico", async () => {
    const app = buildApp({ connectionStatus: "disconnected" });
    await app.ready();
    const response = await enviar(app, { telefone: "5511999999999", mensagem: "oi" });
    expect(response.statusCode).toBe(503);
    expect(response.json().error).toBe("instance_offline");
    expect(recorded.sendTextArgs).toHaveLength(0);
    await app.close();
  });

  it("token certo e instância conectada: envia, persiste, atualiza a prévia, emite e audita", async () => {
    const app = buildApp({});
    await app.ready();
    const response = await enviar(app, {
      telefone: "(55) 11 99999-9999",
      mensagem: "Sua cobrança vence amanhã.",
      externalReference: "charge-123",
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body).toEqual({ ok: true, conversationId: "conv-1", messageId: "msg-1" });

    // Telefone só com dígitos — parênteses, espaço e hífen somem.
    expect(recorded.sendTextArgs[0]).toMatchObject({
      instanceId: INSTANCE_ID,
      chatId: "5511999999999@s.whatsapp.net",
      text: "Sua cobrança vence amanhã.",
    });
    expect(recorded.ensureConversationArgs[0]).toMatchObject({
      input: { instanceId: INSTANCE_ID, externalChatId: "5511999999999@s.whatsapp.net", isGroup: false },
      organizationId: "org-1",
    });
    expect(recorded.messageCreateArgs[0]).toMatchObject({
      organizationId: "org-1",
      conversationId: "conv-1",
      direction: "outbound",
      type: "text",
      content: "Sua cobrança vence amanhã.",
    });
    expect(recorded.conversationUpdateArgs[0]).toMatchObject({ where: { id: "conv-1" } });
    expect(recorded.emitted.map((e) => e.event)).toEqual(
      expect.arrayContaining(["message:new", "conversation:updated"]),
    );
    expect(recorded.auditActions).toContain("message.sent.integration");
    await app.close();
  });

  it("a instância configurada não existir mais também é 503, não 500", async () => {
    const app = buildApp({ instance: null });
    await app.ready();
    const response = await enviar(app, { telefone: "5511999999999", mensagem: "oi" });
    expect(response.statusCode).toBe(503);
    await app.close();
  });

  it("telefone sem nenhum dígito é 400", async () => {
    const app = buildApp({});
    await app.ready();
    const response = await enviar(app, { telefone: "----", mensagem: "oi" });
    expect(response.statusCode).toBe(400);
    await app.close();
  });
});

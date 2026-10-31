import { beforeEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import type { PrismaClient } from "@azvchat/database";
import { normalizeBrazilPhone } from "@azvchat/shared";
import { registerErrorHandler } from "../src/lib/errors.js";
import { hashIntegrationToken } from "../src/lib/integration-token.js";
import { registerIntegrationSendRoute } from "../src/modules/integrations/message-api.js";
import type { AppDeps } from "../src/types.js";

// O card no CRM tem teste próprio (integration-crm.test.ts); aqui interessa
// só QUANDO a rota o pede e o que ela faz com a resposta.
const crmCalls: Array<Record<string, unknown>> = [];
let crmResult: { status: string; opportunityId: string | null } = {
  status: "created",
  opportunityId: "opp-1",
};
vi.mock("../src/lib/integration-crm.js", () => ({
  openIntegrationOpportunity: async (_deps: unknown, input: Record<string, unknown>) => {
    crmCalls.push(input);
    return crmResult;
  },
}));

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
const PIPELINE_ID = "33333333-3333-4333-8333-333333333333";
const STAGE_ID = "44444444-4444-4444-8444-444444444444";
const OTHER_PIPELINE_ID = "55555555-5555-4555-8555-555555555555";
const OTHER_STAGE_ID = "66666666-6666-4666-8666-666666666666";

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
  opts: {
    active?: boolean;
    connectionStatus?: string;
    instance?: Record<string, unknown> | null;
    crmPipelineId?: string | null;
    crmStageId?: string | null;
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
    crmPipelineId: opts.crmPipelineId ?? null,
    crmStageId: opts.crmStageId ?? null,
  };
  // Dois funis ativos, cada um com uma etapa.
  const pipelines: Record<string, { isActive: boolean; stages: { id: string }[] }> = {
    [PIPELINE_ID]: { isActive: true, stages: [{ id: STAGE_ID }] },
    [OTHER_PIPELINE_ID]: { isActive: true, stages: [{ id: OTHER_STAGE_ID }] },
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
    crmPipeline: {
      findFirst: async ({ where }: { where: { id: string } }) => pipelines[where.id] ?? null,
    },
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
  crmCalls.length = 0;
  crmResult = { status: "created", opportunityId: "opp-1" };
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
    // Token sem destino no CRM: só manda a mensagem, como sempre.
    expect(res.json().crm).toBeNull();
    expect(crmCalls).toHaveLength(0);
    await app.close();
  });
});

describe("POST /integrations/messages — card no CRM", () => {
  it("token com funil: envia E abre o card na etapa dele, com o nome do formulário", async () => {
    const app = buildApp({ crmPipelineId: PIPELINE_ID, crmStageId: STAGE_ID });
    await app.ready();
    const res = await send(app, { telefone: "5511999998888", mensagem: "Inscrição recebida!", nome: "Maria" });
    expect(res.statusCode).toBe(200);
    expect(recorded.sendTextArgs).toHaveLength(1);
    expect(crmCalls[0]).toMatchObject({
      organizationId: "org-1",
      conversationId: "conv-1",
      pipelineId: PIPELINE_ID,
      stageId: STAGE_ID,
      title: "Maria",
      integrationTokenId: "tok-1",
    });
    expect(res.json().crm).toEqual({ status: "created", opportunityId: "opp-1" });
    await app.close();
  });

  it("card que não abre NÃO derruba o envio: a mensagem já saiu", async () => {
    crmResult = { status: "failed", opportunityId: null };
    const app = buildApp({ crmPipelineId: PIPELINE_ID });
    await app.ready();
    const res = await send(app, { telefone: "5511999998888", mensagem: "oi" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: "sent", crm: { status: "failed" } });
    await app.close();
  });

  it("funil na chamada vence o do token e começa na primeira etapa dele", async () => {
    const app = buildApp({ crmPipelineId: PIPELINE_ID, crmStageId: STAGE_ID });
    await app.ready();
    const res = await send(app, { telefone: "5511999998888", mensagem: "oi", funilId: OTHER_PIPELINE_ID });
    expect(res.statusCode).toBe(200);
    expect(crmCalls[0]).toMatchObject({ pipelineId: OTHER_PIPELINE_ID, stageId: null });
    await app.close();
  });

  it("funil inexistente na chamada é 422 ANTES de enviar", async () => {
    const app = buildApp();
    await app.ready();
    const res = await send(app, {
      telefone: "5511999998888",
      mensagem: "oi",
      funilId: "77777777-7777-4777-8777-777777777777",
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error).toBe("funil_invalido");
    expect(recorded.sendTextArgs).toHaveLength(0);
    await app.close();
  });

  it("etapa de outro funil é 422 ANTES de enviar", async () => {
    const app = buildApp({ crmPipelineId: PIPELINE_ID });
    await app.ready();
    const res = await send(app, { telefone: "5511999998888", mensagem: "oi", etapaId: OTHER_STAGE_ID });
    expect(res.statusCode).toBe(422);
    expect(res.json().error).toBe("etapa_invalida");
    expect(recorded.sendTextArgs).toHaveLength(0);
    await app.close();
  });

  it("etapa sem funil (nem na chamada nem no token) é 422", async () => {
    const app = buildApp();
    await app.ready();
    const res = await send(app, { telefone: "5511999998888", mensagem: "oi", etapaId: STAGE_ID });
    expect(res.statusCode).toBe(422);
    expect(res.json().error).toBe("funil_nao_informado");
    expect(recorded.sendTextArgs).toHaveLength(0);
    await app.close();
  });

  it("repetição idempotente não abre o card de novo", async () => {
    const app = buildApp({ crmPipelineId: PIPELINE_ID });
    await app.ready();
    await send(app, { telefone: "5511999998888", mensagem: "oi", idempotencyKey: "lead-9" });
    const second = await send(app, { telefone: "5511999998888", mensagem: "oi", idempotencyKey: "lead-9" });
    expect(second.json()).toMatchObject({ idempotent: true, crm: null });
    expect(crmCalls).toHaveLength(1);
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

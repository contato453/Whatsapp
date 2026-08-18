import { beforeEach, describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import jwt from "@fastify/jwt";
import type { PrismaClient } from "@azvchat/database";
import {
  EDITABLE_MESSAGE_TYPES,
  MESSAGE_EDIT_WINDOW_MINUTES,
  isEditableMessageType,
  isWithinEditWindow,
} from "@azvchat/shared";
import { registerErrorHandler } from "../src/lib/errors.js";
import type { AuthTokenPayload } from "../src/lib/auth.js";
import { messageRoutes } from "../src/modules/messages/routes.js";
import type { AppDeps } from "../src/types.js";
import { rolePermissionStub } from "./helpers/permissions.js";

/**
 * Editar mensagem já enviada. O risco aqui é silencioso: o WhatsApp só
 * aceita a edição por alguns minutos, e se gravarmos o texto novo depois
 * disso a Inbox passa a mostrar uma frase que o cliente nunca recebeu.
 *
 * O outro ponto é a LEGENDA de mídia: a edição substitui a mensagem inteira,
 * então o arquivo precisa ir junto — sem ele a foto sumiria da conversa.
 */

const MESSAGE_ID = "55555555-5555-4555-8555-555555555555";

describe("regras de edição (fonte única no shared)", () => {
  it("texto, imagem, vídeo e documento são editáveis", () => {
    expect([...EDITABLE_MESSAGE_TYPES]).toEqual(["text", "image", "video", "document"]);
    for (const type of EDITABLE_MESSAGE_TYPES) expect(isEditableMessageType(type)).toBe(true);
  });

  it("áudio, figurinha e chamada ficam de fora — não têm legenda", () => {
    expect(isEditableMessageType("audio")).toBe(false);
    expect(isEditableMessageType("sticker")).toBe(false);
    expect(isEditableMessageType("call")).toBe(false);
    expect(isEditableMessageType("poll")).toBe(false);
  });

  it("a janela fecha depois do prazo do WhatsApp", () => {
    const agora = new Date("2026-08-18T12:00:00Z");
    const recente = new Date(agora.getTime() - 60_000);
    const antiga = new Date(agora.getTime() - (MESSAGE_EDIT_WINDOW_MINUTES + 1) * 60_000);
    expect(isWithinEditWindow(recente, agora)).toBe(true);
    expect(isWithinEditWindow(antiga, agora)).toBe(false);
  });

  it("mensagem com relógio adiantado continua editável", () => {
    // O timestamp vem do WhatsApp e pode estar à frente do nosso relógio;
    // tratar isso como "vencida" tiraria a edição de quem acabou de mandar.
    const agora = new Date("2026-08-18T12:00:00Z");
    const futuro = new Date(agora.getTime() + 30_000);
    expect(isWithinEditWindow(futuro, agora)).toBe(true);
  });

  it("aceita data em texto (é assim que ela chega do DTO)", () => {
    const agora = new Date("2026-08-18T12:00:00Z");
    expect(isWithinEditWindow("2026-08-18T11:59:00.000Z", agora)).toBe(true);
    expect(isWithinEditWindow("data-invalida", agora)).toBe(false);
  });
});

interface Recorded {
  edits: Array<{ newText: string; hasMedia: boolean; mediaType?: string }>;
  updates: Array<Record<string, unknown>>;
  audit: string[];
}

let recorded: Recorded;

function buildMessage(overrides: Record<string, unknown> = {}) {
  return {
    id: MESSAGE_ID,
    organizationId: "org-1",
    externalMessageId: "wamid-1",
    direction: "outbound",
    type: "text",
    content: "texto original",
    mediaUrl: null,
    mimeType: null,
    filename: null,
    deletedAt: null,
    editedAt: null,
    timestamp: new Date(),
    reactions: [],
    conversation: {
      id: "conv-1",
      organizationId: "org-1",
      whatsappInstanceId: "inst-1",
      externalChatId: "5511999@s.whatsapp.net",
      departmentId: null,
      assignedUserId: null,
    },
    ...overrides,
  };
}

async function buildApp(message: Record<string, unknown> | null): Promise<FastifyInstance> {
  const prisma = {
    rolePermission: rolePermissionStub,
    userWhatsAppInstance: { findMany: async () => [] },
    userDepartment: { findMany: async () => [] },
    message: {
      findFirst: async () => message,
      update: async (args: Record<string, unknown>) => {
        recorded.updates.push(args.data as Record<string, unknown>);
        return { ...message, ...(args.data as Record<string, unknown>) };
      },
    },
  } as unknown as PrismaClient;

  const deps = {
    prisma,
    io: { to: () => ({ emit: () => undefined }) },
    logger: { info: () => undefined, warn: () => undefined },
    audit: {
      record: (entry: { action: string }) => recorded.audit.push(entry.action),
    },
    storage: {
      read: async () => Buffer.from("binario-da-midia"),
      save: async () => "chave",
    },
    provider: {
      editMessage: async (
        _instanceId: string,
        _chatId: string,
        _target: unknown,
        newText: string,
        options?: { media?: { type: string } },
      ) => {
        recorded.edits.push({
          newText,
          hasMedia: !!options?.media,
          ...(options?.media ? { mediaType: options.media.type } : {}),
        });
      },
    },
  } as unknown as AppDeps;

  const app = Fastify();
  await app.register(jwt, { secret: "segredo-de-teste" });
  app.decorate("verifySession", async (payload: AuthTokenPayload) => payload);
  registerErrorHandler(app);
  await messageRoutes(app, deps);
  await app.ready();
  return app;
}

function token(app: FastifyInstance): string {
  return app.jwt.sign({
    sub: "user-1",
    organizationId: "org-1",
    role: "agent",
    name: "Fulano de Tal",
    email: "fulano@example.com",
  });
}

async function edit(app: FastifyInstance, content = "texto novo") {
  return app.inject({
    method: "PATCH",
    url: `/messages/${MESSAGE_ID}`,
    headers: { authorization: `Bearer ${token(app)}` },
    payload: { content },
  });
}

beforeEach(() => {
  recorded = { edits: [], updates: [], audit: [] };
});

describe("PATCH /messages/:id", () => {
  it("edita o texto e grava editedAt", async () => {
    const app = await buildApp(buildMessage());
    const response = await edit(app);
    expect(response.statusCode).toBe(200);
    expect(recorded.edits[0]).toEqual({ newText: "texto novo", hasMedia: false });
    expect(recorded.updates[0]?.content).toBe("texto novo");
    expect(recorded.updates[0]?.editedAt).toBeInstanceOf(Date);
    expect(recorded.audit).toContain("message.edited");
    await app.close();
  });

  it("edita a LEGENDA de uma imagem mandando o arquivo junto", async () => {
    // Sem a mídia, a edição trocaria a foto do cliente por uma mensagem de
    // texto — a imagem sumiria da conversa dele.
    const app = await buildApp(
      buildMessage({ type: "image", mediaUrl: "inst-1/foto.jpg", mimeType: "image/jpeg" }),
    );
    const response = await edit(app, "legenda nova");
    expect(response.statusCode).toBe(200);
    expect(recorded.edits[0]).toEqual({
      newText: "legenda nova",
      hasMedia: true,
      mediaType: "image",
    });
    await app.close();
  });

  it("recusa depois de fechada a janela do WhatsApp — sem gravar nada", async () => {
    const vencida = new Date(Date.now() - (MESSAGE_EDIT_WINDOW_MINUTES + 5) * 60_000);
    const app = await buildApp(buildMessage({ timestamp: vencida }));
    const response = await edit(app);
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toBe("edit_window_closed");
    expect(recorded.edits).toHaveLength(0);
    expect(recorded.updates).toHaveLength(0);
    await app.close();
  });

  it("recusa áudio: não há legenda para editar", async () => {
    const app = await buildApp(
      buildMessage({ type: "audio", mediaUrl: "inst-1/audio.ogg", mimeType: "audio/ogg" }),
    );
    const response = await edit(app);
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toBe("not_editable");
    await app.close();
  });

  it("recusa mensagem recebida — só o que saiu daqui pode ser editado", async () => {
    const app = await buildApp(buildMessage({ direction: "inbound" }));
    expect((await edit(app)).statusCode).toBe(400);
    await app.close();
  });

  it("recusa mensagem apagada", async () => {
    const app = await buildApp(buildMessage({ deletedAt: new Date() }));
    const response = await edit(app);
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toBe("deleted");
    await app.close();
  });

  it("mídia sem arquivo no storage não vira edição pela metade", async () => {
    const app = await buildApp(buildMessage({ type: "image", mediaUrl: null }));
    const response = await edit(app);
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toBe("media_missing");
    expect(recorded.edits).toHaveLength(0);
    await app.close();
  });

  it("mensagem de outra organização é 404", async () => {
    const app = await buildApp(null);
    expect((await edit(app)).statusCode).toBe(404);
    await app.close();
  });

  it("nada sai para o WhatsApp quando o texto é vazio (Zod barra antes)", async () => {
    const app = await buildApp(buildMessage());
    const response = await edit(app, "");
    expect(response.statusCode).toBe(400);
    expect(recorded.edits).toHaveLength(0);
    await app.close();
  });
});

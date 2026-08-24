import { beforeEach, describe, expect, it } from "vitest";
import type { PrismaClient } from "@azvchat/database";
import type { Logger } from "pino";
import { MEDIA_DOWNLOAD_FAILED_METADATA_KEY } from "@azvchat/shared";
import { MessageIngestService } from "../src/services/message-ingest.js";
import type { MediaStorage } from "../src/lib/media-storage.js";
import { rolePermissionStub } from "./helpers/permissions.js";

/**
 * BUG: cliente manda mensagem, ela chega no celular pareado com o número,
 * mas some antes de virar linha no AZVCHAT — intermitente, não ausência
 * total do recurso.
 *
 * Causa raiz encontrada por leitura de código (sem acesso a log/banco de
 * produção neste ambiente): `messages.upsert` do Baileys entrega o LOTE
 * inteiro de mensagens de uma vez, e cada uma é processada com `void`, sem
 * esperar a anterior terminar (`packages/whatsapp/src/qrcode/qrcode-provider.ts`).
 * Quando um contato NOVO manda duas mensagens em sequência rápida, as duas
 * chamadas de `ingest()` correm em paralelo e podem ver "conversa não
 * existe" ao mesmo tempo — as duas tentam criar a linha em
 * `Conversation(whatsappInstanceId, externalChatId)`, a perdedora recebe
 * P2002 do Prisma, a exceção subia sem tratamento específico até o `catch`
 * genérico do `instance-manager` (só sabia o `instanceId`) e a mensagem
 * dela morria ali — nunca virava linha, nunca era retentada. O mesmo vale
 * para duas chamadas concorrentes que disputam o MESMO `externalMessageId`
 * (mensagem ao vivo cruzando com o backfill de histórico da seção 6).
 *
 * Este arquivo tranca a correção: nenhuma das duas corridas perde
 * mensagem, mídia que falha ao SALVAR (e não só ao baixar) não derruba a
 * ingestão, reingestão do mesmo id não duplica, e mensagem antiga
 * (backfill) não regride a ordenação da Inbox nem reabre conversa
 * concluída.
 */

const INSTANCE_ID = "44444444-4444-4444-8444-444444444444";
const CHAT_ID = "5511999@s.whatsapp.net";

interface Recorded {
  conversationCreateAttempts: number;
  conversationUpdates: Array<Record<string, unknown>>;
  messageCreateAttempts: string[];
  errors: Array<Record<string, unknown>>;
  warnings: Array<Record<string, unknown>>;
}

let recorded: Recorded;

function inboundText(externalMessageId: string, content: string, timestamp: Date) {
  return {
    instanceId: INSTANCE_ID,
    externalChatId: CHAT_ID,
    externalMessageId,
    chatType: "individual" as const,
    chatName: null,
    direction: "inbound" as const,
    type: "text" as const,
    content,
    senderExternalId: CHAT_ID,
    senderName: "Cliente",
    senderPhone: "5511999",
    quotedExternalMessageId: null,
    mentionedExternalIds: [],
    timestamp,
    media: null,
  };
}

/**
 * Fábrica de um Prisma falso com ESTADO — é o que permite reproduzir a
 * corrida de verdade: duas chamadas concorrentes veem o mesmo estado
 * "ainda não existe" antes de qualquer uma delas criar, exatamente como
 * duas mensagens do mesmo lote do `messages.upsert`.
 */
function buildHarness(options: { existingConversation?: Record<string, unknown> } = {}) {
  let conversation: Record<string, unknown> | null = options.existingConversation ?? null;
  const messages = new Map<string, Record<string, unknown>>();

  function uniqueViolation(): never {
    const err = new Error("Unique constraint failed") as Error & { code: string };
    err.code = "P2002";
    throw err;
  }

  const prisma = {
    rolePermission: rolePermissionStub,
    conversation: {
      findUnique: async () => conversation,
      findUniqueOrThrow: async () => {
        if (!conversation) throw new Error("conversa não encontrada");
        return conversation;
      },
      create: async ({ data }: { data: Record<string, unknown> }) => {
        recorded.conversationCreateAttempts += 1;
        if (conversation) uniqueViolation();
        conversation = {
          id: "conv-1",
          assignedUserId: null,
          assignedToAll: false,
          archivedAt: null,
          lastMessageAt: null,
          status: "open",
          title: "Cliente",
          externalChatId: CHAT_ID,
          whatsappInstanceId: INSTANCE_ID,
          type: "individual",
          ...data,
        };
        return conversation;
      },
      update: async ({ data }: { data: Record<string, unknown> }) => {
        recorded.conversationUpdates.push(data);
        conversation = { ...(conversation ?? {}), ...data };
        return conversation;
      },
    },
    whatsAppInstance: {
      findUnique: async () => ({ departmentId: null, defaultAssigneeId: null, isBackup: false }),
    },
    message: {
      findUnique: async ({ where }: { where: { conversationId_externalMessageId: { externalMessageId: string } } }) =>
        messages.get(where.conversationId_externalMessageId.externalMessageId) ?? null,
      findUniqueOrThrow: async ({
        where,
      }: {
        where: { conversationId_externalMessageId: { externalMessageId: string } };
      }) => {
        const row = messages.get(where.conversationId_externalMessageId.externalMessageId);
        if (!row) throw new Error("mensagem não encontrada");
        return row;
      },
      create: async ({ data }: { data: Record<string, unknown> }) => {
        const externalMessageId = data.externalMessageId as string;
        recorded.messageCreateAttempts.push(externalMessageId);
        if (messages.has(externalMessageId)) uniqueViolation();
        const row = { id: `msg-${messages.size + 1}`, ...data };
        messages.set(externalMessageId, row);
        return row;
      },
    },
    user: { findFirst: async () => null },
    groupParticipant: { findFirst: async () => null },
  } as unknown as PrismaClient;

  const storage = {
    save: async (_data: Buffer) => "chave-no-storage",
  } as unknown as MediaStorage;

  const logger = {
    info: () => undefined,
    warn: (payload: Record<string, unknown>) => recorded.warnings.push(payload),
    error: (payload: Record<string, unknown>) => recorded.errors.push(payload),
  } as unknown as Logger;

  const service = new MessageIngestService(prisma, storage, logger);
  return { service, getConversation: () => conversation, getMessages: () => messages };
}

beforeEach(() => {
  recorded = { conversationCreateAttempts: 0, conversationUpdates: [], messageCreateAttempts: [], errors: [], warnings: [] };
});

describe("ingestão: corrida na criação da conversa", () => {
  it("duas mensagens do MESMO contato novo, chegando ao mesmo tempo, não perdem nenhuma", async () => {
    const { service, getMessages } = buildHarness();
    const t = new Date("2026-08-24T10:00:00.000Z");

    const [a, b] = await Promise.all([
      service.ingest(inboundText("wamid-1", "oi", t), { organizationId: "org-1" }),
      service.ingest(inboundText("wamid-2", "preciso de ajuda", new Date(t.getTime() + 500)), {
        organizationId: "org-1",
      }),
    ]);

    // As duas tentaram criar a conversa (a corrida aconteceu), mas as duas
    // mensagens viraram linha — nenhuma foi perdida por causa do P2002.
    expect(recorded.conversationCreateAttempts).toBe(2);
    expect(a?.isNewMessage).toBe(true);
    expect(b?.isNewMessage).toBe(true);
    expect(getMessages().size).toBe(2);
    // As duas caem na MESMA conversa (a que sobreviveu à corrida).
    expect(a?.conversationId).toBe(b?.conversationId);
    expect(recorded.errors).toHaveLength(0);
  });
});

describe("ingestão: corrida na criação da mensagem", () => {
  it("a mesma mensagem chegando por dois canais ao mesmo tempo (ao vivo + backfill) não duplica nem se perde", async () => {
    const { service, getMessages } = buildHarness({
      existingConversation: {
        id: "conv-1",
        assignedUserId: "user-1",
        assignedToAll: false,
        archivedAt: null,
        lastMessageAt: null,
        status: "open",
        title: "Cliente",
        externalChatId: CHAT_ID,
        whatsappInstanceId: INSTANCE_ID,
        type: "individual",
      },
    });
    const t = new Date("2026-08-24T10:00:00.000Z");

    const [a, b] = await Promise.all([
      service.ingest(inboundText("wamid-dup", "confirma o CNPJ?", t), { organizationId: "org-1" }),
      service.ingest(inboundText("wamid-dup", "confirma o CNPJ?", t), { organizationId: "org-1" }),
    ]);

    expect(recorded.messageCreateAttempts).toEqual(["wamid-dup", "wamid-dup"]);
    expect(getMessages().size).toBe(1);
    // Uma das duas venceu a corrida (isNewMessage true), a outra reconhece
    // a duplicata (isNewMessage false) — nenhuma lança, nenhuma se perde.
    const results = [a, b];
    expect(results.filter((r) => r?.isNewMessage).length).toBe(1);
    expect(results.filter((r) => !r?.isNewMessage).length).toBe(1);
    expect(a?.messageId).toBe(b?.messageId);
  });
});

describe("ingestão: reentrega idempotente", () => {
  it("reingerir o mesmo externalMessageId em sequência não duplica", async () => {
    const { service, getMessages } = buildHarness();
    const t = new Date("2026-08-24T10:00:00.000Z");

    const first = await service.ingest(inboundText("wamid-seq", "olá", t), { organizationId: "org-1" });
    const second = await service.ingest(inboundText("wamid-seq", "olá", t), { organizationId: "org-1" });

    expect(first?.isNewMessage).toBe(true);
    expect(second?.isNewMessage).toBe(false);
    expect(second?.messageId).toBe(first?.messageId);
    expect(getMessages().size).toBe(1);
  });
});

describe("ingestão: mensagem antiga vinda em lote (backfill de histórico)", () => {
  it("não regride lastMessageAt nem reabre conversa concluída depois dela", async () => {
    const newer = new Date("2026-08-20T12:00:00.000Z");
    const older = new Date("2026-08-18T09:00:00.000Z");
    const { service, getConversation } = buildHarness({
      existingConversation: {
        id: "conv-1",
        assignedUserId: "user-1",
        assignedToAll: false,
        archivedAt: null,
        lastMessageAt: newer,
        status: "resolved",
        title: "Cliente",
        externalChatId: CHAT_ID,
        whatsappInstanceId: INSTANCE_ID,
        type: "individual",
      },
    });

    const result = await service.ingest(inboundText("wamid-old", "mensagem antiga do histórico", older), {
      organizationId: "org-1",
    });

    // A mensagem em si É gravada — o histórico fica completo.
    expect(result?.isNewMessage).toBe(true);
    // Mas a conversa não regride: nem a data, nem o status reabre.
    const conversation = getConversation();
    expect(conversation?.lastMessageAt).toBe(newer);
    expect(conversation?.status).toBe("resolved");
    expect(recorded.conversationUpdates).toHaveLength(0);
  });

  it("mensagem MAIS NOVA continua atualizando normalmente (a guarda não trava o caminho comum)", async () => {
    const older = new Date("2026-08-18T09:00:00.000Z");
    const newer = new Date("2026-08-20T12:00:00.000Z");
    const { service, getConversation } = buildHarness({
      existingConversation: {
        id: "conv-1",
        assignedUserId: "user-1",
        assignedToAll: false,
        archivedAt: null,
        lastMessageAt: older,
        status: "resolved",
        title: "Cliente",
        externalChatId: CHAT_ID,
        whatsappInstanceId: INSTANCE_ID,
        type: "individual",
      },
    });

    await service.ingest(inboundText("wamid-new", "mensagem nova", newer), { organizationId: "org-1" });

    const conversation = getConversation();
    expect(conversation?.lastMessageAt).toBe(newer);
    expect(conversation?.status).toBe("open");
  });
});

describe("ingestão: falha ao SALVAR mídia (não só ao baixar)", () => {
  it("disco cheio / erro de storage não derruba a mensagem — grava sem mídia e marca em metadata", async () => {
    const t = new Date("2026-08-24T10:00:00.000Z");
    const messageCreates: Array<Record<string, unknown>> = [];

    const failingStorage = {
      save: async () => {
        throw new Error("ENOSPC: no space left on device");
      },
    } as unknown as MediaStorage;
    const logger = {
      info: () => undefined,
      warn: (payload: Record<string, unknown>) => recorded.warnings.push(payload),
      error: (payload: Record<string, unknown>) => recorded.errors.push(payload),
    } as unknown as Logger;

    const prisma = {
      rolePermission: rolePermissionStub,
      conversation: {
        findUnique: async () => null,
        create: async ({ data }: { data: Record<string, unknown> }) => ({
          id: "conv-1",
          assignedUserId: null,
          assignedToAll: false,
          archivedAt: null,
          lastMessageAt: null,
          status: "open",
          title: "Cliente",
          ...data,
        }),
        update: async () => undefined,
      },
      whatsAppInstance: {
        findUnique: async () => ({ departmentId: null, defaultAssigneeId: null, isBackup: false }),
      },
      message: {
        findUnique: async () => null,
        create: async ({ data }: { data: Record<string, unknown> }) => {
          messageCreates.push(data);
          return { id: "msg-1", ...data };
        },
      },
      user: { findFirst: async () => null },
      groupParticipant: { findFirst: async () => null },
    } as unknown as PrismaClient;

    const localService = new MessageIngestService(prisma, failingStorage, logger);
    const result = await localService.ingest(
      {
        ...inboundText("wamid-media", "segue o comprovante", t),
        type: "image",
        media: { mimeType: "image/jpeg", filename: null, download: async () => Buffer.from("foto") },
      },
      { organizationId: "org-1" },
    );

    expect(result?.isNewMessage).toBe(true);
    expect(messageCreates).toHaveLength(1);
    expect(messageCreates[0]?.mediaUrl).toBeNull();
    expect(messageCreates[0]?.content).toBe("segue o comprovante");
    const metadata = messageCreates[0]?.metadata as Record<string, unknown> | undefined;
    expect(metadata?.[MEDIA_DOWNLOAD_FAILED_METADATA_KEY]).toBe(true);
    expect(recorded.errors.some((e) => e.event === "media_save_failed")).toBe(true);
  });
});

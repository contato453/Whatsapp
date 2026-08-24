import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@azvchat/database";
import type { Logger } from "pino";
import { MessageIngestService } from "../src/services/message-ingest.js";
import type { MediaStorage } from "../src/lib/media-storage.js";
import { rolePermissionStub } from "./helpers/permissions.js";

/**
 * Cliente manda um PDF, o AZVCHAT mostra "Mídia indisponível" e no celular
 * dele o arquivo abre normalmente. A causa era `message.media.download()`
 * falhando de forma TRANSITÓRIA (rede, ou o reupload do Baileys chegando
 * cedo demais) sem nenhuma segunda chance: a falha virava `mediaUrl: null`
 * para sempre, porque a edição de legenda feita depois só atualiza texto.
 *
 * Este arquivo tranca duas coisas: uma falha isolada não pode derrubar a
 * mídia (a retentativa resolve sozinha), e esgotadas as tentativas a
 * ingestão continua — a mensagem entra sem mídia, nunca é perdida.
 */

const CONV_ID = "33333333-3333-4333-8333-333333333333";
const INSTANCE_ID = "44444444-4444-4444-8444-444444444444";

interface Recorded {
  conversationUpdates: Array<Record<string, unknown>>;
  messageCreates: Array<Record<string, unknown>>;
  storageSaves: Array<Buffer>;
  warnings: Array<Record<string, unknown>>;
}

let recorded: Recorded;

function baseConversation(overrides: Record<string, unknown> = {}) {
  return {
    id: CONV_ID,
    whatsappInstanceId: INSTANCE_ID,
    externalChatId: "5511999@s.whatsapp.net",
    title: "Cliente",
    departmentId: null,
    status: "open",
    assignedUserId: null,
    assignedToAll: false,
    archivedAt: null,
    ...overrides,
  };
}

function ingestHarness(download: () => Promise<Buffer>) {
  const conversation = baseConversation();
  const prisma = {
    rolePermission: rolePermissionStub,
    conversation: {
      findUnique: async () => conversation,
      update: async (args: Record<string, unknown>) => {
        recorded.conversationUpdates.push(args);
        return conversation;
      },
    },
    whatsAppInstance: {
      findUnique: async () => ({ departmentId: null, defaultAssigneeId: null, isBackup: false }),
    },
    message: {
      findUnique: async () => null,
      create: async (args: Record<string, unknown>) => {
        recorded.messageCreates.push(args);
        return { id: "msg-1", ...(args.data as Record<string, unknown>) };
      },
    },
    user: { findFirst: async () => null },
    groupParticipant: { findFirst: async () => null },
  } as unknown as PrismaClient;

  const storage = {
    save: async (data: Buffer) => {
      recorded.storageSaves.push(data);
      return "chave-no-storage";
    },
  } as unknown as MediaStorage;

  const logger = {
    info: () => undefined,
    warn: (payload: Record<string, unknown>) => {
      recorded.warnings.push(payload);
    },
  } as unknown as Logger;

  const service = new MessageIngestService(prisma, storage, logger);

  const inbound = {
    instanceId: INSTANCE_ID,
    externalChatId: "5511999@s.whatsapp.net",
    externalMessageId: "wamid-1",
    chatType: "individual" as const,
    chatName: null,
    direction: "inbound" as const,
    type: "document" as const,
    content: "Segue o contracheque",
    senderExternalId: "5511999@s.whatsapp.net",
    senderName: "Cliente",
    senderPhone: "5511999",
    quotedExternalMessageId: null,
    mentionedExternalIds: [],
    timestamp: new Date(),
    media: {
      mimeType: "application/pdf",
      filename: "Lucas Cortes.pdf",
      download,
    },
  };

  return { service, inbound };
}

beforeEach(() => {
  recorded = { conversationUpdates: [], messageCreates: [], storageSaves: [], warnings: [] };
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("ingestão: retentativa de download de mídia", () => {
  it("uma falha isolada não derruba a mídia — a retentativa resolve sozinha", async () => {
    let calls = 0;
    const buffer = Buffer.from("pdf");
    const download = async () => {
      calls += 1;
      if (calls < 3) throw new Error("ECONNRESET");
      return buffer;
    };
    const { service, inbound } = ingestHarness(download);

    const promise = service.ingest(inbound, { organizationId: "org-1" });
    await vi.runAllTimersAsync();
    await promise;

    expect(calls).toBe(3);
    expect(recorded.storageSaves).toEqual([buffer]);
    const created = recorded.messageCreates[0]?.data as Record<string, unknown>;
    expect(created.mediaUrl).toBe("chave-no-storage");
    // Resolveu sozinha: não é incidente, não gera log de falha.
    expect(recorded.warnings).toHaveLength(0);
  });

  it("esgotadas as tentativas, a mensagem entra sem mídia — nunca é perdida", async () => {
    const download = async () => {
      throw new Error("ECONNRESET");
    };
    const { service, inbound } = ingestHarness(download);

    const promise = service.ingest(inbound, { organizationId: "org-1" });
    await vi.runAllTimersAsync();
    const result = await promise;

    expect(result?.isNewMessage).toBe(true);
    expect(recorded.storageSaves).toHaveLength(0);
    const created = recorded.messageCreates[0]?.data as Record<string, unknown>;
    // A mídia falhou, mas o texto/legenda do cliente não se perde.
    expect(created.mediaUrl).toBeNull();
    expect(created.content).toBe("Segue o contracheque");
    expect(recorded.warnings).toHaveLength(1);
    expect(recorded.warnings[0]).toMatchObject({
      event: "media_download_failed",
      attempts: 3,
    });
  });
});

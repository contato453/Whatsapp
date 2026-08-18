import { describe, expect, it } from "vitest";
import type { PrismaClient } from "@azvchat/database";
import { loadQuotedPreviews, previewFromMessage } from "../src/lib/quoted-preview.js";

/**
 * A regra que estes testes trancam: a citação NUNCA é descartada por a
 * mensagem original não estar no banco. Original presente → prévia completa,
 * com navegação; ausente → prévia do resumo gravado na ingestão
 * (`metadata.quoted`), sem navegação — mas visível.
 */

const CONVERSATION = {
  id: "conv-1",
  whatsappInstanceId: "inst-1",
  externalChatId: "12345@g.us",
  type: "group",
};

function prismaWith(overrides: {
  originals?: Array<Record<string, unknown>>;
  participants?: Array<Record<string, unknown>>;
  contacts?: Array<Record<string, unknown>>;
}): PrismaClient {
  return {
    message: {
      findMany: async () => overrides.originals ?? [],
    },
    groupParticipant: {
      findMany: async () => overrides.participants ?? [],
    },
    contact: {
      findMany: async () => overrides.contacts ?? [],
    },
  } as unknown as PrismaClient;
}

describe("loadQuotedPreviews", () => {
  it("original no banco: prévia com id e timestamp para navegar", async () => {
    const timestamp = new Date("2026-08-18T12:00:00Z");
    const prisma = prismaWith({
      originals: [
        {
          id: "msg-original",
          externalMessageId: "WA-1",
          senderName: "Marcelle",
          senderPhone: "5511999998888",
          content: "Segue a lista de documentos",
          type: "text",
          direction: "inbound",
          timestamp,
        },
      ],
    });
    const map = await loadQuotedPreviews(prisma, CONVERSATION, [
      { quotedMessageId: "WA-1", metadata: null },
    ]);
    expect(map.get("WA-1")).toEqual({
      id: "msg-original",
      senderName: "Marcelle",
      content: "Segue a lista de documentos",
      type: "text",
      timestamp: timestamp.toISOString(),
    });
  });

  it("original FORA do banco: a prévia sai do resumo do payload, sem navegação", async () => {
    const prisma = prismaWith({
      participants: [
        {
          externalContactId: "5511999998888@s.whatsapp.net",
          phoneNumber: "5511999998888",
          name: "Marcelle",
        },
      ],
    });
    const map = await loadQuotedPreviews(prisma, CONVERSATION, [
      {
        quotedMessageId: "WA-ANTIGA",
        metadata: {
          quoted: {
            participantExternalId: "5511999998888@s.whatsapp.net",
            fromMe: false,
            type: "text",
            content: "Mensagem anterior à sincronização",
          },
        },
      },
    ]);
    expect(map.get("WA-ANTIGA")).toEqual({
      id: null,
      senderName: "Marcelle",
      content: "Mensagem anterior à sincronização",
      type: "text",
      timestamp: null,
    });
  });

  it("citado sem cadastro nenhum: cai para os dígitos do telefone — nunca some", async () => {
    const prisma = prismaWith({});
    const map = await loadQuotedPreviews(prisma, CONVERSATION, [
      {
        quotedMessageId: "WA-X",
        metadata: {
          quoted: {
            participantExternalId: "5511888887777@s.whatsapp.net",
            fromMe: false,
            type: "image",
            content: null,
          },
        },
      },
    ]);
    const preview = map.get("WA-X");
    expect(preview?.senderName).toBe("5511888887777");
    // Citação de mídia guarda o tipo — o bloco indica "Imagem" em vez de vazio.
    expect(preview?.type).toBe("image");
  });

  it("citado nosso (fromMe) aparece como Você", async () => {
    const prisma = prismaWith({});
    const map = await loadQuotedPreviews(prisma, CONVERSATION, [
      {
        quotedMessageId: "WA-OUT",
        metadata: {
          quoted: {
            participantExternalId: "5511000000000@s.whatsapp.net",
            fromMe: true,
            type: "text",
            content: "Bom dia!",
          },
        },
      },
    ]);
    expect(map.get("WA-OUT")?.senderName).toBe("Você");
  });

  it("LID citado nunca vira telefone na tela", async () => {
    const prisma = prismaWith({});
    const map = await loadQuotedPreviews(prisma, CONVERSATION, [
      {
        quotedMessageId: "WA-LID",
        metadata: {
          quoted: {
            participantExternalId: "123456789012@lid",
            fromMe: false,
            type: "text",
            content: "oi",
          },
        },
      },
    ]);
    // Sem nome conhecido e sem telefone de verdade: senderName nulo — a tela
    // mostra o rótulo genérico, jamais os dígitos do LID como se fossem número.
    expect(map.get("WA-LID")?.senderName).toBeNull();
  });

  it("sem original e sem resumo (mensagem antiga da nossa própria base) não há prévia", async () => {
    const prisma = prismaWith({});
    const map = await loadQuotedPreviews(prisma, CONVERSATION, [
      { quotedMessageId: "WA-SEM-NADA", metadata: null },
    ]);
    expect(map.has("WA-SEM-NADA")).toBe(false);
  });
});

describe("previewFromMessage", () => {
  it("enviada sem autor registrado vira Você", () => {
    const preview = previewFromMessage({
      id: "m1",
      senderName: null,
      senderPhone: null,
      content: "olá",
      type: "text",
      direction: "outbound",
      timestamp: new Date("2026-08-18T10:00:00Z"),
    });
    expect(preview.senderName).toBe("Você");
    expect(preview.timestamp).toBe("2026-08-18T10:00:00.000Z");
  });
});

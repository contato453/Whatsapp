import { describe, expect, it, beforeEach } from "vitest";
import type { Message, PrismaClient } from "@azvchat/database";
import type { Logger } from "pino";
import type { NormalizedMessage } from "@azvchat/shared";
import {
  quotedPreviewText,
  quotedSenderLabel,
  readQuotedSnapshot,
  withQuotedSnapshot,
} from "@azvchat/shared";
import { MessageIngestService } from "../src/services/message-ingest.js";
import { serializeMessage } from "../src/lib/serialize.js";
import type { MediaStorage } from "../src/lib/media-storage.js";

/**
 * Citação (reply) que sobrevive ao envio e à recepção.
 *
 * Dois defeitos silenciosos moram aqui, e os dois eram de EXIBIÇÃO (a
 * citação sempre foi enviada ao WhatsApp): a resposta recém-enviada chegava
 * à tela sem o bloco, porque a resposta do POST e os eventos de tempo real
 * serializavam sem o preview; e a resposta do cliente citando mensagem
 * anterior à conexão do número perdia a citação para sempre, porque só o
 * stanzaId era guardado e a original nunca estaria no banco.
 *
 * A regra que não pode regredir: o resumo da citada (autor, trecho, tipo) é
 * CONGELADO em `metadata.quoted` na gravação, e `serializeMessage` cai nele
 * quando não há leitura ao vivo. Citação nunca é descartada em silêncio.
 */

const CONVERSA_GRUPO = {
  id: "conv-grupo",
  organizationId: "org-1",
  whatsappInstanceId: "inst-1",
  externalChatId: "123@g.us",
  type: "group",
  title: "Grupo Contábil",
  status: "open",
  assignedUserId: "user-1",
  assignedToAll: false,
  archivedAt: null,
};

const CONVERSA_INDIVIDUAL = {
  ...CONVERSA_GRUPO,
  id: "conv-ind",
  externalChatId: "5511999998888@s.whatsapp.net",
  type: "individual",
  title: "Fernanda Souza",
};

interface Estado {
  conversa: typeof CONVERSA_GRUPO;
  /** Original citada quando está no banco (achada por externalMessageId). */
  original: Record<string, unknown> | null;
  participante: { customName: string | null; name: string | null } | null;
  criadas: Array<Record<string, unknown>>;
}

let estado: Estado;

function buildIngest(): MessageIngestService {
  const prisma = {
    conversation: {
      findUnique: async () => estado.conversa,
      update: async () => ({}),
    },
    message: {
      // O mesmo findUnique atende a deduplicação (id da mensagem que chega)
      // e a busca da original citada — o id pedido diz qual é qual.
      findUnique: async (args: {
        where: { conversationId_externalMessageId: { externalMessageId: string } };
      }) => {
        const pedido = args.where.conversationId_externalMessageId.externalMessageId;
        if (estado.original && pedido === estado.original.externalMessageId) {
          return estado.original;
        }
        return null;
      },
      create: async (args: { data: Record<string, unknown> }) => {
        estado.criadas.push(args.data);
        return { id: "msg-nova", ...args.data };
      },
    },
    groupParticipant: {
      findFirst: async () => estado.participante,
      update: async () => ({}),
    },
  } as unknown as PrismaClient;
  const storage = {} as MediaStorage;
  const logger = { info: () => undefined, warn: () => undefined } as unknown as Logger;
  return new MessageIngestService(prisma, storage, logger);
}

function respostaRecebida(overrides: Partial<NormalizedMessage> = {}): NormalizedMessage {
  return {
    instanceId: "inst-1",
    externalMessageId: "wamid-resposta",
    externalChatId: CONVERSA_GRUPO.externalChatId,
    chatType: "group",
    chatName: null,
    direction: "inbound",
    type: "text",
    content: "sim, pode emitir",
    senderExternalId: "5511988887777@s.whatsapp.net",
    senderPhone: "5511988887777",
    senderName: "Cliente",
    quotedExternalMessageId: "wamid-original",
    quotedInfo: {
      participantExternalId: "5511977776666@s.whatsapp.net",
      content: "posso emitir a nota?",
      type: "text",
    },
    mentionedExternalIds: [],
    timestamp: new Date("2026-08-20T12:00:00Z"),
    media: null,
    ...overrides,
  };
}

beforeEach(() => {
  estado = {
    conversa: CONVERSA_GRUPO,
    original: null,
    participante: null,
    criadas: [],
  };
});

describe("resumo da citação na ingestão", () => {
  it("original no banco: o resumo sai dela e leva o id local (é o que faz o clique navegar)", async () => {
    estado.original = {
      id: "msg-original",
      externalMessageId: "wamid-original",
      senderName: "Tatiana",
      senderPhone: "5511977776666",
      content: "posso emitir a nota?",
      type: "text",
      direction: "inbound",
    };
    await buildIngest().ingest(respostaRecebida(), { organizationId: "org-1" });

    const gravada = estado.criadas[0];
    expect(gravada?.quotedMessageId).toBe("wamid-original");
    expect(readQuotedSnapshot(gravada?.metadata)).toEqual({
      id: "msg-original",
      senderName: "Tatiana",
      content: "posso emitir a nota?",
      type: "text",
    });
  });

  it("original DESCONHECIDA (anterior à conexão): o resumo sai do payload — a citação não é descartada", async () => {
    estado.participante = { customName: "Tatiana (sócia)", name: "Tati" };
    await buildIngest().ingest(respostaRecebida(), { organizationId: "org-1" });

    const resumo = readQuotedSnapshot(estado.criadas[0]?.metadata);
    expect(resumo).toEqual({
      id: null, // sem original no banco não há para onde navegar — o bloco aparece do mesmo jeito
      senderName: "Tatiana (sócia)",
      content: "posso emitir a nota?",
      type: "text",
    });
  });

  it("na conversa individual, citar a fala do cliente usa o título como autor", async () => {
    estado.conversa = CONVERSA_INDIVIDUAL;
    await buildIngest().ingest(
      respostaRecebida({
        externalChatId: CONVERSA_INDIVIDUAL.externalChatId,
        chatType: "individual",
        quotedInfo: {
          participantExternalId: CONVERSA_INDIVIDUAL.externalChatId,
          content: "segue o boleto",
          type: "text",
        },
      }),
      { organizationId: "org-1" },
    );
    expect(readQuotedSnapshot(estado.criadas[0]?.metadata)?.senderName).toBe("Fernanda Souza");
  });

  it("citação de mídia guarda o TIPO — o bloco de um áudio citado não pode ficar vazio", async () => {
    await buildIngest().ingest(
      respostaRecebida({
        quotedInfo: { participantExternalId: null, content: null, type: "audio" },
      }),
      { organizationId: "org-1" },
    );
    const resumo = readQuotedSnapshot(estado.criadas[0]?.metadata);
    expect(resumo?.type).toBe("audio");
    expect(quotedPreviewText(resumo?.content ?? null, resumo?.type ?? "other")).toBe("🎤 Áudio");
  });

  it("o resumo divide o metadata com as marcações do @ sem apagá-las", async () => {
    await buildIngest().ingest(
      respostaRecebida({ mentionedExternalIds: ["5511966665555@s.whatsapp.net"] }),
      { organizationId: "org-1" },
    );
    const metadata = estado.criadas[0]?.metadata as Record<string, unknown>;
    expect(metadata.mentions).toEqual(["5511966665555@s.whatsapp.net"]);
    expect(readQuotedSnapshot(metadata)).not.toBeNull();
  });

  it("mensagem sem citação não ganha metadata nenhum", async () => {
    await buildIngest().ingest(
      respostaRecebida({ quotedExternalMessageId: null, quotedInfo: null }),
      { organizationId: "org-1" },
    );
    expect(estado.criadas[0]).not.toHaveProperty("metadata");
  });
});

describe("serialização com o resumo congelado", () => {
  function mensagem(overrides: Partial<Message> = {}): Message {
    return {
      id: "msg-1",
      organizationId: "org-1",
      conversationId: "conv-1",
      externalMessageId: "wamid-1",
      senderExternalId: null,
      senderName: "Ana",
      senderPhone: null,
      direction: "outbound",
      type: "text",
      content: "resposta",
      mediaUrl: null,
      mimeType: null,
      filename: null,
      quotedMessageId: "wamid-original",
      timestamp: new Date("2026-08-20T12:00:00Z"),
      status: "sent",
      sentByUserId: "user-1",
      deletedAt: null,
      editedAt: null,
      metadata: null,
      createdAt: new Date("2026-08-20T12:00:00Z"),
      ...overrides,
    } as Message;
  }

  const resumo = { id: "msg-original", senderName: "Tatiana", content: "oi", type: "text" };

  it("sem leitura ao vivo, vale o resumo do metadata — é o que faz o bloco aparecer JÁ no envio", () => {
    const dto = serializeMessage(mensagem({ metadata: withQuotedSnapshot(null, resumo) as never }));
    expect(dto.quoted).toEqual(resumo);
  });

  it("a leitura ao vivo vence o resumo (nome corrigido pela equipe aparece)", () => {
    const aoVivo = { id: "msg-original", senderName: "Tatiana Corrigida", content: "oi", type: "text" };
    const dto = serializeMessage(
      mensagem({ metadata: withQuotedSnapshot(null, resumo) as never }),
      aoVivo,
    );
    expect(dto.quoted).toEqual(aoVivo);
  });

  it("sem citação nenhuma, quoted é null", () => {
    expect(serializeMessage(mensagem({ quotedMessageId: null })).quoted).toBeNull();
  });

  it("metadata com lixo no lugar do resumo não derruba a serialização", () => {
    const dto = serializeMessage(mensagem({ metadata: { quoted: "lixo" } as never }));
    expect(dto.quoted).toBeNull();
  });
});

describe("réguas compartilhadas", () => {
  it("o autor exibido segue a MESMA régua na leitura ao vivo e no resumo", () => {
    expect(quotedSenderLabel({ direction: "outbound", senderName: null, senderPhone: null })).toBe("Você");
    expect(quotedSenderLabel({ direction: "outbound", senderName: "Ana", senderPhone: null })).toBe("Ana");
    expect(
      quotedSenderLabel({ direction: "inbound", senderName: null, senderPhone: "5511999998888" }),
    ).toBe("5511999998888");
  });

  it("quotedPreviewText: o trecho vence, e mídia sem legenda vira o rótulo do tipo", () => {
    expect(quotedPreviewText("texto", "image")).toBe("texto");
    expect(quotedPreviewText(null, "document")).toBe("📄 Documento");
    expect(quotedPreviewText(null, "tipo-que-nao-existe")).toBe("Mensagem");
  });
});

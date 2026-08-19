import { describe, expect, it, beforeEach } from "vitest";
import type { PrismaClient } from "@azvchat/database";
import type { Logger } from "pino";
import { readMessageVersions } from "@azvchat/shared";
import { MessageIngestService } from "../src/services/message-ingest.js";
import type { MediaStorage } from "../src/lib/media-storage.js";

/**
 * Edição feita pelo CLIENTE no celular.
 *
 * O defeito que este arquivo tranca é silencioso e caro: a edição chega como
 * pacote de protocolo, e tratá-la como mensagem criava uma bolha lixo no
 * histórico enquanto a original seguia exibindo o texto ANTIGO. A atendente
 * continuava lendo o valor, o CNPJ ou a competência que o cliente já tinha
 * corrigido.
 *
 * Três regras não podem regredir: edição ATUALIZA a mensagem existente,
 * edição de mensagem desconhecida é ignorada sem criar registro, e o mesmo
 * evento chegando duas vezes (ele chega pelos dois canais do Baileys) não
 * duplica versão nem reescreve nada.
 */

const CONVERSA = {
  id: "conv-1",
  whatsappInstanceId: "inst-1",
  departmentId: null,
  assignedUserId: null,
};

interface Estado {
  conversa: typeof CONVERSA | null;
  mensagem: Record<string, unknown> | null;
  updates: Array<Record<string, unknown>>;
  criadas: number;
  previews: string[];
}

let estado: Estado;

function buildIngest(): MessageIngestService {
  const prisma = {
    conversation: {
      findUnique: async () => estado.conversa,
      update: async (args: { data: { lastMessagePreview?: string } }) => {
        if (args.data.lastMessagePreview) estado.previews.push(args.data.lastMessagePreview);
        return {};
      },
    },
    message: {
      findUnique: async () => estado.mensagem,
      // Nenhum teste deve criar mensagem: edição nunca é mensagem nova.
      create: async () => {
        estado.criadas += 1;
        return {};
      },
      update: async (args: { data: Record<string, unknown> }) => {
        estado.updates.push(args.data);
        estado.mensagem = { ...(estado.mensagem ?? {}), ...args.data };
        return estado.mensagem;
      },
      findFirst: async () => (estado.mensagem ? { id: estado.mensagem.id } : null),
    },
  } as unknown as PrismaClient;
  const storage = {} as MediaStorage;
  const logger = { info: () => undefined, warn: () => undefined } as unknown as Logger;
  return new MessageIngestService(prisma, storage, logger);
}

function mensagemOriginal(overrides: Record<string, unknown> = {}) {
  return {
    id: "msg-1",
    conversationId: "conv-1",
    externalMessageId: "wamid-1",
    type: "text",
    content: "CNPJ 11.111.111/0001-11",
    deletedAt: null,
    editedAt: null,
    metadata: null,
    timestamp: new Date("2026-08-18T12:00:00Z"),
    ...overrides,
  };
}

beforeEach(() => {
  estado = {
    conversa: CONVERSA,
    mensagem: mensagemOriginal(),
    updates: [],
    criadas: 0,
    previews: [],
  };
});

describe("aplicação da edição recebida", () => {
  it("atualiza a mensagem existente e guarda o conteúdo anterior", async () => {
    const editadaEm = new Date("2026-08-18T12:03:00Z");
    const resultado = await buildIngest().applyEdit({
      instanceId: "inst-1",
      externalChatId: "5511999@s.whatsapp.net",
      targetExternalMessageId: "wamid-1",
      newContent: "CNPJ 22.222.222/0001-22",
      editedAt: editadaEm,
    });

    expect(resultado).not.toBeNull();
    expect(estado.criadas).toBe(0);
    expect(estado.updates).toHaveLength(1);
    expect(estado.updates[0]?.content).toBe("CNPJ 22.222.222/0001-22");
    expect(estado.updates[0]?.editedAt).toEqual(editadaEm);

    const versoes = readMessageVersions(estado.updates[0]?.metadata);
    expect(versoes).toHaveLength(1);
    expect(versoes[0]?.content).toBe("CNPJ 11.111.111/0001-11");
    expect(versoes[0]?.at).toBe(editadaEm.toISOString());
  });

  it("atualiza a prévia quando a editada é a última da conversa", async () => {
    await buildIngest().applyEdit({
      instanceId: "inst-1",
      externalChatId: "5511999@s.whatsapp.net",
      targetExternalMessageId: "wamid-1",
      newContent: "texto corrigido",
      editedAt: null,
    });
    expect(estado.previews).toEqual(["texto corrigido"]);
  });

  it("edições sucessivas empilham as versões na ordem certa", async () => {
    const ingest = buildIngest();
    for (const [texto, quando] of [
      ["segunda", "2026-08-18T12:01:00Z"],
      ["terceira", "2026-08-18T12:02:00Z"],
      ["quarta", "2026-08-18T12:03:00Z"],
    ] as const) {
      await ingest.applyEdit({
        instanceId: "inst-1",
        externalChatId: "5511999@s.whatsapp.net",
        targetExternalMessageId: "wamid-1",
        newContent: texto,
        editedAt: new Date(quando),
      });
    }
    const versoes = readMessageVersions(estado.mensagem?.metadata);
    expect(versoes.map((v) => v.content)).toEqual([
      "CNPJ 11.111.111/0001-11",
      "segunda",
      "terceira",
    ]);
    expect(estado.mensagem?.content).toBe("quarta");
  });

  it("preserva o que já estava no metadata (as marcações do @)", async () => {
    estado.mensagem = mensagemOriginal({ metadata: { mentions: ["5511999@s.whatsapp.net"] } });
    await buildIngest().applyEdit({
      instanceId: "inst-1",
      externalChatId: "5511999@s.whatsapp.net",
      targetExternalMessageId: "wamid-1",
      newContent: "novo",
      editedAt: null,
    });
    const metadata = estado.updates[0]?.metadata as Record<string, unknown>;
    expect(metadata.mentions).toEqual(["5511999@s.whatsapp.net"]);
    expect(readMessageVersions(metadata)).toHaveLength(1);
  });

  it("mensagem original inexistente é ignorada, sem criar registro", async () => {
    estado.mensagem = null;
    const resultado = await buildIngest().applyEdit({
      instanceId: "inst-1",
      externalChatId: "5511999@s.whatsapp.net",
      targetExternalMessageId: "wamid-desconhecida",
      newContent: "texto de uma mensagem que nunca sincronizamos",
      editedAt: null,
    });
    expect(resultado).toBeNull();
    expect(estado.criadas).toBe(0);
    expect(estado.updates).toHaveLength(0);
  });

  it("conversa inexistente também é ignorada em silêncio", async () => {
    estado.conversa = null;
    const resultado = await buildIngest().applyEdit({
      instanceId: "inst-1",
      externalChatId: "5511000@s.whatsapp.net",
      targetExternalMessageId: "wamid-1",
      newContent: "qualquer coisa",
      editedAt: null,
    });
    expect(resultado).toBeNull();
    expect(estado.criadas).toBe(0);
  });

  it("o mesmo evento duas vezes não duplica versão nem reescreve", async () => {
    const ingest = buildIngest();
    const entrada = {
      instanceId: "inst-1",
      externalChatId: "5511999@s.whatsapp.net",
      targetExternalMessageId: "wamid-1",
      newContent: "corrigido",
      editedAt: new Date("2026-08-18T12:05:00Z"),
    };
    const primeira = await ingest.applyEdit(entrada);
    const segunda = await ingest.applyEdit(entrada);

    expect(primeira).not.toBeNull();
    // Conteúdo igual ao que já está gravado: nada a fazer.
    expect(segunda).toBeNull();
    expect(estado.updates).toHaveLength(1);
    expect(readMessageVersions(estado.mensagem?.metadata)).toHaveLength(1);
  });

  it("mensagem apagada não volta a ter texto", async () => {
    estado.mensagem = mensagemOriginal({
      deletedAt: new Date("2026-08-18T12:04:00Z"),
      content: null,
    });
    const resultado = await buildIngest().applyEdit({
      instanceId: "inst-1",
      externalChatId: "5511999@s.whatsapp.net",
      targetExternalMessageId: "wamid-1",
      newContent: "texto que chegou depois do apagar",
      editedAt: null,
    });
    expect(resultado).toBeNull();
    expect(estado.updates).toHaveLength(0);
  });

  it("legenda de mídia é atualizada sem tocar no arquivo", async () => {
    estado.mensagem = mensagemOriginal({
      type: "image",
      content: "competência 07/2026",
      mediaUrl: "chave-no-storage",
    });
    await buildIngest().applyEdit({
      instanceId: "inst-1",
      externalChatId: "5511999@s.whatsapp.net",
      targetExternalMessageId: "wamid-1",
      newContent: "competência 08/2026",
      editedAt: null,
    });
    expect(estado.updates[0]?.content).toBe("competência 08/2026");
    expect(estado.updates[0]).not.toHaveProperty("mediaUrl");
    expect(estado.mensagem?.mediaUrl).toBe("chave-no-storage");
  });
});

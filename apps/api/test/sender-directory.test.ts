import { describe, expect, it } from "vitest";
import type { PrismaClient } from "@azvchat/database";
import { resolveSenders } from "../src/lib/sender-directory.js";
import { serializeMessage } from "../src/lib/serialize.js";
import type { Message } from "@azvchat/database";

interface FakeRows {
  participants?: Array<{ externalContactId: string; phoneNumber: string; name: string | null }>;
  contacts?: Array<{
    externalId: string;
    phoneNumber: string | null;
    name: string | null;
    pushName: string | null;
  }>;
}

function fakePrisma(rows: FakeRows): PrismaClient {
  return {
    groupParticipant: { findMany: async () => rows.participants ?? [] },
    contact: { findMany: async () => rows.contacts ?? [] },
  } as unknown as PrismaClient;
}

const groupScope = {
  whatsappInstanceId: "inst-1",
  externalChatId: "12345@g.us",
  type: "group",
};

describe("resolveSenders", () => {
  it("acha o telefone do participante pelo identificador interno (@lid)", async () => {
    const directory = await resolveSenders(
      fakePrisma({
        participants: [
          { externalContactId: "248141869793281@lid", phoneNumber: "5511988887777", name: "Lincoln" },
        ],
      }),
      groupScope,
      ["248141869793281@lid"],
    );
    expect(directory.get("248141869793281@lid")).toEqual({
      phoneNumber: "5511988887777",
      name: "Lincoln",
    });
  });

  it("cai para o cadastro de contatos quando o grupo não tem o número", async () => {
    const directory = await resolveSenders(
      fakePrisma({
        participants: [{ externalContactId: "9@lid", phoneNumber: "", name: null }],
        contacts: [
          { externalId: "9@lid", phoneNumber: "5511977776666", name: null, pushName: "Ana" },
        ],
      }),
      groupScope,
      ["9@lid"],
    );
    expect(directory.get("9@lid")).toEqual({ phoneNumber: "5511977776666", name: "Ana" });
  });

  it("não inventa telefone quando nenhuma fonte conhece o participante", async () => {
    const directory = await resolveSenders(fakePrisma({}), groupScope, ["9@lid"]);
    expect(directory.get("9@lid")).toBeUndefined();
  });

  it("não consulta nada quando o lote não tem remetente identificado", async () => {
    const directory = await resolveSenders(
      fakePrisma({ participants: [{ externalContactId: "x", phoneNumber: "1", name: null }] }),
      groupScope,
      [null, null],
    );
    expect(directory.size).toBe(0);
  });
});

function message(overrides: Partial<Message>): Message {
  return {
    senderExternalId: "9@lid",
    senderName: null,
    senderPhone: null,
    direction: "inbound",
    type: "text",
    content: "oi",
    timestamp: new Date("2026-08-14T12:00:00Z"),
    status: "delivered",
    ...overrides,
  } as Message;
}

describe("serializeMessage com remetente resolvido", () => {
  it("preenche nome e telefone que não vieram na mensagem", () => {
    const result = serializeMessage(message({}), null, {
      phoneNumber: "5511988887777",
      name: "Lincoln",
    });
    expect(result.senderPhone).toBe("5511988887777");
    expect(result.senderName).toBe("Lincoln");
  });

  it("o que veio na mensagem tem prioridade sobre o cadastro", () => {
    const result = serializeMessage(
      message({ senderPhone: "5511911112222", senderName: "Nome da mensagem" }),
      null,
      { phoneNumber: "5511988887777", name: "Nome do cadastro" },
    );
    expect(result.senderPhone).toBe("5511911112222");
    expect(result.senderName).toBe("Nome da mensagem");
  });

  it("continua sem telefone quando o cadastro também não sabe", () => {
    const result = serializeMessage(message({}), null, null);
    expect(result.senderPhone).toBeNull();
  });
});

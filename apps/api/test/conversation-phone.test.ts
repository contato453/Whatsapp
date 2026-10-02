import { describe, expect, it } from "vitest";
import type { PrismaClient } from "@azvchat/database";
import { phoneFromJid, resolveConversationPhone } from "../src/lib/conversation-phone.js";

interface Fontes {
  contact?: string | null;
  profile?: string | null;
  participant?: string | null;
}

function fakePrisma(fontes: Fontes) {
  return {
    contact: {
      findFirst: async () => (fontes.contact !== undefined ? { phoneNumber: fontes.contact } : null),
    },
    personProfile: {
      findUnique: async () => (fontes.profile !== undefined ? { phoneNumber: fontes.profile } : null),
    },
    groupParticipant: {
      findFirst: async () =>
        fontes.participant !== undefined ? { phoneNumber: fontes.participant } : null,
    },
  } as unknown as PrismaClient;
}

const lid = { type: "individual", externalChatId: "123456789012345@lid", whatsappInstanceId: "i1" };

describe("resolveConversationPhone", () => {
  it("usa o próprio endereço quando ele é telefone", async () => {
    const phone = await resolveConversationPhone(fakePrisma({ contact: "5511000000000" }), "o1", {
      ...lid,
      externalChatId: "5521999998888@s.whatsapp.net",
    });
    expect(phone).toBe("5521999998888");
  });

  it("nunca devolve os dígitos do LID", async () => {
    expect(phoneFromJid("123456789012345@lid")).toBeNull();
    expect(await resolveConversationPhone(fakePrisma({}), "o1", lid)).toBeNull();
  });

  it("conversa @lid: contato, depois registro da pessoa, depois grupo", async () => {
    expect(
      await resolveConversationPhone(
        fakePrisma({ contact: "5521911112222", profile: "5521933334444", participant: "5521955556666" }),
        "o1",
        lid,
      ),
    ).toBe("5521911112222");
    expect(
      await resolveConversationPhone(
        fakePrisma({ contact: null, profile: "+55 (21) 93333-4444", participant: "5521955556666" }),
        "o1",
        lid,
      ),
    ).toBe("5521933334444");
    expect(
      await resolveConversationPhone(fakePrisma({ participant: "5521955556666" }), "o1", lid),
    ).toBe("5521955556666");
  });

  it("grupo não tem telefone", async () => {
    expect(
      await resolveConversationPhone(fakePrisma({ contact: "5521911112222" }), "o1", {
        ...lid,
        type: "group",
      }),
    ).toBeNull();
  });
});

import { describe, expect, it } from "vitest";
import type { PrismaClient } from "@azvchat/database";
import {
  resolveCallerIdentity,
  type CallConversationRef,
} from "../src/lib/call-identity.js";

/**
 * A ordem de resolução do nome de quem liga, degrau a degrau (regra A3):
 * conversa individual → contato da agenda → participante de grupo → nada.
 * E a regra inegociável: chamada por "@lid" sem telefone conhecido devolve
 * telefone VAZIO — os dígitos do LID não são número discável.
 */

interface FakeRows {
  contact?: {
    name: string | null;
    pushName: string | null;
    phoneNumber: string | null;
  } | null;
  participations?: Array<{
    id: string;
    customName: string | null;
    name: string | null;
    phoneNumber: string;
    avatarUrl: string | null;
    group: { name: string; conversationId: string | null };
  }>;
}

function fakePrisma(rows: FakeRows): PrismaClient {
  return {
    contact: { findFirst: async () => rows.contact ?? null },
    groupParticipant: { findMany: async () => rows.participations ?? [] },
  } as unknown as PrismaClient;
}

function conversation(overrides: Partial<CallConversationRef> = {}): CallConversationRef {
  return {
    id: "conv-1",
    title: "19675832402083@lid",
    customTitle: null,
    externalChatId: "19675832402083@lid",
    hasAvatar: false,
    ...overrides,
  };
}

const baseInput = {
  whatsappInstanceId: "inst-1",
  callerExternalId: "19675832402083@lid",
  callerPhone: null,
  isGroup: false,
};

describe("resolveCallerIdentity — ordem das fontes de nome", () => {
  it("a. a conversa individual vence: customTitle antes de title", async () => {
    const identity = await resolveCallerIdentity(fakePrisma({}), {
      ...baseInput,
      conversation: conversation({ title: "Marina", customTitle: "Marina Contabilidade" }),
    });
    expect(identity.name).toBe("Marina Contabilidade");
  });

  it("a. o title da conversa vale quando é nome de verdade", async () => {
    const identity = await resolveCallerIdentity(
      fakePrisma({ contact: { name: "Da agenda", pushName: null, phoneNumber: null } }),
      { ...baseInput, conversation: conversation({ title: "Marina" }) },
    );
    expect(identity.name).toBe("Marina");
  });

  it("b. sem nome na conversa, cai para o contato da agenda", async () => {
    const identity = await resolveCallerIdentity(
      fakePrisma({ contact: { name: "Marina Agenda", pushName: "Mah", phoneNumber: null } }),
      { ...baseInput, conversation: conversation() },
    );
    expect(identity.name).toBe("Marina Agenda");
  });

  it("c. sem agenda, cai para o participante de grupo (customName antes de name)", async () => {
    const identity = await resolveCallerIdentity(
      fakePrisma({
        participations: [
          {
            id: "part-1",
            customName: "Marina do Cliente X",
            name: "Mah",
            phoneNumber: "",
            avatarUrl: null,
            group: { name: "Cliente X — Fiscal", conversationId: "conv-g1" },
          },
        ],
      }),
      { ...baseInput, conversation: conversation() },
    );
    expect(identity.name).toBe("Marina do Cliente X");
    expect(identity.groups).toEqual([
      { conversationId: "conv-g1", name: "Cliente X — Fiscal" },
    ]);
  });

  it("d. nenhuma fonte conhece: nome nulo, sem inventar nada", async () => {
    const identity = await resolveCallerIdentity(fakePrisma({}), {
      ...baseInput,
      conversation: conversation(),
    });
    expect(identity.name).toBeNull();
    expect(identity.groups).toEqual([]);
    expect(identity.avatar).toBeNull();
  });

  it("o title que é o próprio JID (ou só os dígitos dele) NÃO vira nome", async () => {
    // É o título que a conversa ganha quando nasce de uma chamada de
    // desconhecido — exatamente o que não pode ir para a tela.
    for (const title of ["19675832402083@lid", "19675832402083"]) {
      const identity = await resolveCallerIdentity(fakePrisma({}), {
        ...baseInput,
        conversation: conversation({ title }),
      });
      expect(identity.name).toBeNull();
    }
  });

  it("nome salvo só com espaço conta como sem nome", async () => {
    const identity = await resolveCallerIdentity(
      fakePrisma({ contact: { name: "   ", pushName: " ", phoneNumber: null } }),
      { ...baseInput, conversation: conversation() },
    );
    expect(identity.name).toBeNull();
  });
});

describe("resolveCallerIdentity — telefone", () => {
  it("chamada por LID sem telefone conhecido devolve telefone vazio", async () => {
    const identity = await resolveCallerIdentity(
      fakePrisma({ contact: { name: "Marina", pushName: null, phoneNumber: null } }),
      { ...baseInput, conversation: conversation() },
    );
    expect(identity.name).toBe("Marina");
    // Os dígitos "19675832402083" do LID nunca podem virar este campo.
    expect(identity.phone).toBeNull();
  });

  it("usa o telefone do JID quando ele é @s.whatsapp.net", async () => {
    const identity = await resolveCallerIdentity(fakePrisma({}), {
      ...baseInput,
      callerExternalId: "5511999998888@s.whatsapp.net",
      callerPhone: "5511999998888",
      conversation: conversation({
        title: "5511999998888",
        externalChatId: "5511999998888@s.whatsapp.net",
      }),
    });
    expect(identity.phone).toBe("5511999998888");
  });

  it("completa o telefone pelo cadastro quando o JID não o traz", async () => {
    const identity = await resolveCallerIdentity(
      fakePrisma({
        participations: [
          {
            id: "part-1",
            customName: null,
            name: "Mah",
            phoneNumber: "5511977776666",
            avatarUrl: null,
            group: { name: "Cliente X", conversationId: null },
          },
        ],
      }),
      { ...baseInput, conversation: conversation() },
    );
    expect(identity.phone).toBe("5511977776666");
  });
});

describe("resolveCallerIdentity — grupo e foto", () => {
  it("chamada de grupo identifica o grupo, sem apontar pessoa nem telefone", async () => {
    const identity = await resolveCallerIdentity(fakePrisma({}), {
      whatsappInstanceId: "inst-1",
      callerExternalId: "19675832402083@lid",
      callerPhone: null,
      isGroup: true,
      conversation: conversation({
        title: "Cliente X — Geral",
        externalChatId: "120363012345678@g.us",
        hasAvatar: true,
      }),
    });
    expect(identity.name).toBe("Cliente X — Geral");
    expect(identity.phone).toBeNull();
    expect(identity.groups).toEqual([]);
    expect(identity.avatar).toEqual({ source: "conversation", id: "conv-1" });
  });

  it("a foto da conversa vem antes da foto do participante", async () => {
    const identity = await resolveCallerIdentity(
      fakePrisma({
        participations: [
          {
            id: "part-1",
            customName: null,
            name: null,
            phoneNumber: "",
            avatarUrl: "chave-no-storage",
            group: { name: "Cliente X", conversationId: null },
          },
        ],
      }),
      { ...baseInput, conversation: conversation({ hasAvatar: true }) },
    );
    expect(identity.avatar).toEqual({ source: "conversation", id: "conv-1" });
  });

  it("sem foto na conversa, usa a do participante", async () => {
    const identity = await resolveCallerIdentity(
      fakePrisma({
        participations: [
          {
            id: "part-1",
            customName: null,
            name: null,
            phoneNumber: "",
            avatarUrl: "chave-no-storage",
            group: { name: "Cliente X", conversationId: null },
          },
        ],
      }),
      { ...baseInput, conversation: conversation() },
    );
    expect(identity.avatar).toEqual({ source: "participant", id: "part-1" });
  });
});

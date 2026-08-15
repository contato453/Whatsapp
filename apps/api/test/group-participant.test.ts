import { describe, expect, it } from "vitest";
import type { GroupParticipant } from "@azvchat/database";
import {
  PARTICIPANT_CLIENT_ROLES,
  PARTICIPANT_CLIENT_ROLE_COLORS,
  PARTICIPANT_CLIENT_ROLE_LABELS,
} from "@azvchat/shared";
import { serializeGroupParticipant } from "../src/lib/serialize.js";

function participant(overrides: Partial<GroupParticipant> = {}): GroupParticipant {
  return {
    id: "p-1",
    groupId: "g-1",
    externalContactId: "5511999999999@s.whatsapp.net",
    phoneNumber: "5511999999999",
    name: null,
    customName: null,
    clientRole: null,
    isAdmin: false,
    isSuperAdmin: false,
    avatarUrl: null,
    avatarCheckedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

describe("serializeGroupParticipant (cadeia de exibição do nome)", () => {
  it("customName vence todas as outras fontes — é a decisão da equipe, e o sync nunca a toca", () => {
    const dto = serializeGroupParticipant(
      participant({ customName: "Dra. Marina (fiscal)", name: "Marina" }),
      { contact: { phoneNumber: "5511999999999", name: "Marina Souza" }, pushName: "Mari" },
    );
    expect(dto.name).toBe("Dra. Marina (fiscal)");
    // O nome de origem continua saindo para a tela de edição mostrar a referência.
    expect(dto.whatsappName).toBe("Marina");
  });

  it("sem nome nenhum em nenhuma fonte, o nome sai nulo e a tela cai no telefone", () => {
    const dto = serializeGroupParticipant(participant());
    expect(dto.name).toBeNull();
    expect(dto.phoneNumber).toBe("5511999999999");
  });

  it("participante @lid sem telefone conhecido não devolve o identificador como telefone", () => {
    const dto = serializeGroupParticipant(
      participant({ externalContactId: "123456789012345@lid", phoneNumber: "" }),
    );
    expect(dto.phoneNumber).toBe("");
    expect(dto.phoneNumber).not.toContain("123456789012345");
  });

  it("telefone descoberto no cadastro de contatos completa o participante sem número", () => {
    const dto = serializeGroupParticipant(participant({ phoneNumber: "" }), {
      contact: { phoneNumber: "5511888888888", name: null },
    });
    expect(dto.phoneNumber).toBe("5511888888888");
  });

  it("isAdmin cobre também o superadmin do grupo", () => {
    expect(serializeGroupParticipant(participant({ isSuperAdmin: true })).isAdmin).toBe(true);
  });
});

describe("marcação de papel no cliente", () => {
  it("são exatamente dois valores possíveis, além de nenhuma marcação", () => {
    expect([...PARTICIPANT_CLIENT_ROLES]).toEqual(["partner", "administrative"]);
  });

  it("o serializer devolve a marcação como está, inclusive a ausência dela", () => {
    expect(serializeGroupParticipant(participant({ clientRole: "partner" })).clientRole).toBe(
      "partner",
    );
    expect(
      serializeGroupParticipant(participant({ clientRole: "administrative" })).clientRole,
    ).toBe("administrative");
    expect(serializeGroupParticipant(participant()).clientRole).toBeNull();
  });

  it("todo valor tem rótulo e cor em @azvchat/shared — o frontend não redeclara nada", () => {
    for (const papel of PARTICIPANT_CLIENT_ROLES) {
      expect(PARTICIPANT_CLIENT_ROLE_LABELS[papel]).toBeTruthy();
      expect(PARTICIPANT_CLIENT_ROLE_COLORS[papel]).toMatch(/^#[0-9a-f]{6}$/);
    }
  });

  it("a cor da marcação não colide com o âmbar do selo admin do WhatsApp", () => {
    // Selo admin usa a paleta âmbar do Tailwind (amber-700 = #b45309).
    const ambarDoSeloAdmin = "#b45309";
    for (const papel of PARTICIPANT_CLIENT_ROLES) {
      expect(PARTICIPANT_CLIENT_ROLE_COLORS[papel]).not.toBe(ambarDoSeloAdmin);
    }
  });
});

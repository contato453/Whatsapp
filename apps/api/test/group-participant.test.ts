import { describe, expect, it } from "vitest";
import type { GroupParticipant } from "@azvchat/database";
import {
  PARTICIPANT_CLIENT_ROLES,
  PARTICIPANT_CLIENT_ROLE_COLORS,
  PARTICIPANT_CLIENT_ROLE_LABELS,
  PARTICIPANT_WITHOUT_NAME_LABEL,
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
  it("(a) customName vence todas as outras fontes — o sync nunca o toca", () => {
    const dto = serializeGroupParticipant(
      participant({ customName: "Dra. Marina (fiscal)", name: "Mari" }),
      { contact: { phoneNumber: "5511999999999", name: "Marina Souza" }, pushName: "Mari" },
    );
    expect(dto.name).toBe("Dra. Marina (fiscal)");
    // O nome de origem continua saindo para a tela de edição mostrar a referência.
    expect(dto.whatsappName).toBe("Marina Souza");
    expect(dto.hasKnownName).toBe(true);
  });

  it("(b) sem customName, o nome da agenda do número conectado vence o pushName", () => {
    const dto = serializeGroupParticipant(participant({ name: "Mari 💅" }), {
      contact: { phoneNumber: "5511999999999", name: "Marina Souza" },
    });
    expect(dto.name).toBe("Marina Souza");
  });

  it("(c) sem agenda, vale o pushName gravado no participante", () => {
    const dto = serializeGroupParticipant(participant({ name: "Mari 💅" }), {
      contact: { phoneNumber: "5511999999999", name: null },
    });
    expect(dto.name).toBe("Mari 💅");
  });

  it("(c) o pushName da última mensagem cobre quem escreveu antes da gravação existir", () => {
    const dto = serializeGroupParticipant(participant(), { pushName: "Mari 💅" });
    expect(dto.name).toBe("Mari 💅");
  });

  it("(d) sem nome em fonte alguma, cai no telefone formatado", () => {
    const dto = serializeGroupParticipant(participant());
    expect(dto.name).toBe("+55 11 99999-9999");
    expect(dto.hasKnownName).toBe(false);
    // A tela não repete a mesma informação nas duas linhas.
    expect(dto.nameIsPhone).toBe(true);
  });

  it("(e) participante @lid sem telefone cai no rótulo neutro, nunca no LID cru", () => {
    const dto = serializeGroupParticipant(
      participant({ externalContactId: "123456789012345@lid", phoneNumber: "" }),
    );
    expect(dto.name).toBe(PARTICIPANT_WITHOUT_NAME_LABEL);
    expect(dto.name).not.toContain("123456789012345");
    expect(dto.name).not.toContain("lid");
    expect(dto.phoneNumber).toBe("");
    expect(dto.nameIsPhone).toBe(false);
  });

  it("a ordem inteira, degrau a degrau, retirando a fonte mais forte de cada vez", () => {
    const fontes = {
      contact: { phoneNumber: "5511999999999", name: "Marina Souza" },
      pushName: "Mari",
    };
    expect(
      serializeGroupParticipant(participant({ customName: "Marina (sócia)", name: "Mari" }), fontes)
        .name,
    ).toBe("Marina (sócia)");
    expect(serializeGroupParticipant(participant({ name: "Mari" }), fontes).name).toBe(
      "Marina Souza",
    );
    expect(
      serializeGroupParticipant(participant({ name: "Mari" }), { pushName: "Mari" }).name,
    ).toBe("Mari");
    expect(serializeGroupParticipant(participant()).name).toBe("+55 11 99999-9999");
    expect(serializeGroupParticipant(participant({ phoneNumber: "" })).name).toBe(
      PARTICIPANT_WITHOUT_NAME_LABEL,
    );
  });

  it("telefone descoberto no cadastro de contatos completa o participante sem número", () => {
    const dto = serializeGroupParticipant(participant({ phoneNumber: "" }), {
      contact: { phoneNumber: "5511888888888", name: null },
    });
    expect(dto.phoneNumber).toBe("5511888888888");
    expect(dto.name).toBe("+55 11 88888-8888");
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

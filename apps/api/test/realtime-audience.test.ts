import { describe, expect, it } from "vitest";
import { conversationAudience, instanceAudience } from "../src/realtime/socket.js";

const ORG = "org-1";
const CHIP = "chip-a";

describe("conversationAudience (quem recebe evento de conversa)", () => {
  it("conversa sem responsável vai para a sala de livres do departamento", () => {
    expect(
      conversationAudience(ORG, {
        whatsappInstanceId: CHIP,
        departmentId: "dep-1",
        assignedUserId: null,
      }),
    ).toEqual(["org:org-1", "sup:chip-a:dep-1", "free:chip-a:dep-1"]);
  });

  it("conversa atribuída vai só para o responsável, não para os demais usuários", () => {
    const rooms = conversationAudience(ORG, {
      whatsappInstanceId: CHIP,
      departmentId: "dep-1",
      assignedUserId: "user-9",
    });
    expect(rooms).toEqual(["org:org-1", "sup:chip-a:dep-1", "mine:chip-a:dep-1:user-9"]);
    expect(rooms).not.toContain("free:chip-a:dep-1");
  });

  it("supervisor do departamento recebe nos dois casos", () => {
    const livre = conversationAudience(ORG, {
      whatsappInstanceId: CHIP,
      departmentId: "dep-1",
      assignedUserId: null,
    });
    const atribuida = conversationAudience(ORG, {
      whatsappInstanceId: CHIP,
      departmentId: "dep-1",
      assignedUserId: "user-9",
    });
    expect(livre).toContain("sup:chip-a:dep-1");
    expect(atribuida).toContain("sup:chip-a:dep-1");
  });

  it("departamentos diferentes nunca compartilham sala", () => {
    const dep1 = conversationAudience(ORG, {
      whatsappInstanceId: CHIP,
      departmentId: "dep-1",
      assignedUserId: null,
    });
    const dep2 = conversationAudience(ORG, {
      whatsappInstanceId: CHIP,
      departmentId: "dep-2",
      assignedUserId: null,
    });
    expect(dep1.filter((room) => room !== "org:org-1")).not.toEqual(
      expect.arrayContaining(dep2.filter((room) => room !== "org:org-1")),
    );
  });

  it("números diferentes nunca compartilham sala", () => {
    const chipA = conversationAudience(ORG, {
      whatsappInstanceId: "chip-a",
      departmentId: "dep-1",
      assignedUserId: null,
    });
    const chipB = conversationAudience(ORG, {
      whatsappInstanceId: "chip-b",
      departmentId: "dep-1",
      assignedUserId: null,
    });
    expect(chipA).not.toEqual(expect.arrayContaining(["sup:chip-b:dep-1"]));
    expect(chipB).not.toEqual(expect.arrayContaining(["sup:chip-a:dep-1"]));
  });

  it("conversa sem departamento cai no balde 'none'", () => {
    expect(
      conversationAudience(ORG, {
        whatsappInstanceId: CHIP,
        departmentId: null,
        assignedUserId: null,
      }),
    ).toEqual(["org:org-1", "sup:chip-a:none", "free:chip-a:none"]);
  });
});

describe("instanceAudience (evento do número, não da conversa)", () => {
  it("alcança quem tem o número, sem recorte de departamento", () => {
    expect(instanceAudience(ORG, CHIP)).toEqual(["org:org-1", "instance:chip-a"]);
  });
});

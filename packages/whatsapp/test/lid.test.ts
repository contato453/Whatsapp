import { describe, expect, it } from "vitest";
import { extractSender, isLidJid, phoneFromJid } from "../src/qrcode/normalize.js";

/**
 * O WhatsApp passou a usar JIDs "@lid" (identificadores internos anônimos)
 * para participantes de grupo. Os dígitos deles NÃO são telefone e não
 * podem vazar para a interface como se fossem.
 */
describe("identificadores internos (@lid)", () => {
  it("reconhece um JID @lid", () => {
    expect(isLidJid("248141869793281@lid")).toBe(true);
    expect(isLidJid("5511988887777@s.whatsapp.net")).toBe(false);
  });

  it("não extrai telefone de um @lid", () => {
    expect(phoneFromJid("248141869793281@lid")).toBeNull();
    expect(phoneFromJid("5511988887777@s.whatsapp.net")).toBe("5511988887777");
    expect(phoneFromJid("120363000000000001@g.us")).toBeNull();
  });

  it("remetente em grupo com @lid fica sem telefone (em vez de número falso)", () => {
    const result = extractSender(
      {
        remoteJid: "120363000000000001@g.us",
        participant: "248141869793281@lid",
        fromMe: false,
      },
      "5511988887777@s.whatsapp.net",
    );
    expect(result.senderExternalId).toBe("248141869793281@lid");
    expect(result.senderPhone).toBeNull();
  });

  it("usa participant_pn como telefone quando o participante é um @lid", () => {
    const result = extractSender(
      {
        remoteJid: "120363000000000001@g.us",
        participant: "248141869793281@lid",
        participantPn: "5511977776666@s.whatsapp.net",
        fromMe: false,
      } as Parameters<typeof extractSender>[0],
      "5511988887777@s.whatsapp.net",
    );
    // O identificador continua sendo o @lid — é por ele que o WhatsApp
    // endereça o participante — mas o telefone exibido é o real.
    expect(result.senderExternalId).toBe("248141869793281@lid");
    expect(result.senderPhone).toBe("5511977776666");
  });

  it("usa sender_pn em conversa individual anônima", () => {
    const result = extractSender(
      {
        remoteJid: "248141869793281@lid",
        senderPn: "5511977776666@s.whatsapp.net",
        fromMe: false,
      } as Parameters<typeof extractSender>[0],
      "5511988887777@s.whatsapp.net",
    );
    expect(result.senderPhone).toBe("5511977776666");
  });

  it("remetente em grupo com JID de telefone mantém o número", () => {
    const result = extractSender(
      {
        remoteJid: "120363000000000001@g.us",
        participant: "5511977776666@s.whatsapp.net",
        fromMe: false,
      },
      "5511988887777@s.whatsapp.net",
    );
    expect(result.senderPhone).toBe("5511977776666");
  });
});

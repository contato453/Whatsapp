import { describe, expect, it } from "vitest";
import type { WAMessage } from "@whiskeysockets/baileys";
import type { NormalizedMessage } from "@azvchat/shared";
import { QrCodeWhatsAppProvider } from "../src/qrcode/qrcode-provider.js";

/**
 * BUG: mensagens que chegam com a instância em `reconnecting`/`qr_required`
 * não tinham segunda chance de entrar no AZVCHAT. O motivo era este: o
 * WhatsApp reenvia, no PRÓPRIO evento `messaging-history.set`, as mensagens
 * recentes que o aparelho perdeu enquanto estava fora do ar — mas o
 * provider só lia `chats` e `contacts` daquele evento, e o campo
 * `messages` era descartado por inteiro, sem log nenhum.
 *
 * `handleHistoryMessages` fecha esse buraco: as mensagens do histórico
 * passam pelo MESMO `handleIncomingMessage` do recebimento ao vivo, então
 * viram o mesmo evento "message" normalizado — quem deduplica é a
 * ingestão, por `(conversationId, externalMessageId)`, e não o provider.
 */

function textHistoryMessage(id: string, text: string, timestampSeconds = 1_700_000_000): WAMessage {
  return {
    key: { remoteJid: "5511999998888@s.whatsapp.net", id, fromMe: false },
    message: { conversation: text },
    messageTimestamp: timestampSeconds,
    pushName: "Cliente",
  } as WAMessage;
}

interface HistoryBackfillHarness {
  handleHistoryMessages(instanceId: string, messages: WAMessage[]): Promise<void>;
}

describe("backfill de histórico (messaging-history.set)", () => {
  it("mensagens do histórico viram o mesmo evento normalizado do recebimento ao vivo", async () => {
    const provider = new QrCodeWhatsAppProvider({ sessionDir: "/tmp/azvchat-test-sessions" });
    const received: NormalizedMessage[] = [];
    provider.on("message", (message) => received.push(message));

    await (provider as unknown as HistoryBackfillHarness).handleHistoryMessages("inst-1", [
      textHistoryMessage("wamid-hist-1", "mensagem perdida na desconexão"),
      textHistoryMessage("wamid-hist-2", "segunda mensagem perdida"),
    ]);

    expect(received).toHaveLength(2);
    expect(received.map((m) => m.externalMessageId)).toEqual(["wamid-hist-1", "wamid-hist-2"]);
    expect(received[0]?.content).toBe("mensagem perdida na desconexão");
    expect(received[0]?.instanceId).toBe("inst-1");
  });

  it("uma mensagem malformada no lote não derruba as demais", async () => {
    const provider = new QrCodeWhatsAppProvider({ sessionDir: "/tmp/azvchat-test-sessions" });
    const received: NormalizedMessage[] = [];
    provider.on("message", (message) => received.push(message));

    const malformed = null as unknown as WAMessage;

    await expect(
      (provider as unknown as HistoryBackfillHarness).handleHistoryMessages("inst-1", [
        textHistoryMessage("wamid-hist-1", "antes da quebrada"),
        malformed,
        textHistoryMessage("wamid-hist-2", "depois da quebrada"),
      ]),
    ).resolves.toBeUndefined();

    expect(received.map((m) => m.externalMessageId)).toEqual(["wamid-hist-1", "wamid-hist-2"]);
  });

  it("lote vazio não emite nada nem loga início/fim", async () => {
    const provider = new QrCodeWhatsAppProvider({ sessionDir: "/tmp/azvchat-test-sessions" });
    const received: NormalizedMessage[] = [];
    provider.on("message", (message) => received.push(message));

    await (provider as unknown as HistoryBackfillHarness).handleHistoryMessages("inst-1", []);

    expect(received).toHaveLength(0);
  });
});

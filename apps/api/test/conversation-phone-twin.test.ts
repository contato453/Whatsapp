import { describe, expect, it } from "vitest";
import type { Logger } from "pino";
import { brazilPhoneVariants } from "@azvchat/shared";
import { MessageIngestService } from "../src/services/message-ingest.js";
import type { MediaStorage } from "../src/lib/media-storage.js";
import { MemoryPrisma } from "./helpers/memory-prisma.js";

/**
 * BUG (relato do Comercial, workshop): o lead preenche o site, o sistema
 * manda a mensagem do ingresso pela API de integração e, quando o lead
 * RESPONDE, aparece uma SEGUNDA conversa no AZVCHAT — a mesma pessoa em duas
 * abas, o histórico partido ao meio.
 *
 * Causa raiz: a conversa é casada por `(número conectado, externalChatId)` ao
 * pé da letra. O envio abre a conversa no endereço montado a partir do que o
 * lead DIGITOU ("55 + DDD + 9 + número"), e a resposta volta pelo endereço que
 * o WhatsApp usa de verdade para aquela conta: o número SEM o nono dígito
 * (conta antiga, comum fora de SP) ou o identificador anônimo `@lid`. Dois
 * endereços diferentes, duas conversas.
 */

const ORG = "org-1";
const INSTANCE = "instance-1";

const logger = { info() {}, warn() {}, error() {}, debug() {} } as unknown as Logger;
const storage = {} as MediaStorage;

function setup() {
  const db = new MemoryPrisma();
  db.seed("organization", { id: ORG, name: "Azevedo" });
  db.seed("whatsAppInstance", {
    id: INSTANCE,
    organizationId: ORG,
    name: "CHIP COMERCIAL EP",
    departmentId: null,
    defaultAssigneeId: null,
    isBackup: false,
  });
  const ingest = new MessageIngestService(db.client(), storage, logger);
  return { db, ingest };
}

function inbound(externalChatId: string, senderPhone: string | null, id = "msg-in-1") {
  return {
    instanceId: INSTANCE,
    externalChatId,
    externalMessageId: id,
    chatType: "individual" as const,
    chatName: null,
    direction: "inbound" as const,
    type: "text" as const,
    content: "Oi, recebi o ingresso",
    senderExternalId: externalChatId,
    senderName: "Lead Teste",
    senderPhone,
    quotedExternalMessageId: null,
    mentionedExternalIds: [],
    timestamp: new Date(),
    media: null,
  };
}

/** O que a API de integração (e o disparo) faz para um telefone digitado. */
async function sendFromForm(ingest: MessageIngestService, phone: string) {
  return ingest.ensureConversation(
    {
      instanceId: INSTANCE,
      externalChatId: `${phone}@s.whatsapp.net`,
      isGroup: false,
      callerName: null,
      callerPhone: phone,
    },
    ORG,
  );
}

describe("brazilPhoneVariants", () => {
  it("celular de 9 dígitos também é procurado sem o nono dígito", () => {
    expect(brazilPhoneVariants("5531999998888")).toEqual(["5531999998888", "553199998888"]);
  });

  it("celular de 8 dígitos também é procurado com o nono dígito", () => {
    expect(brazilPhoneVariants("553199998888")).toEqual(["553199998888", "5531999998888"]);
  });

  it("fixo nunca ganha variação — juntaria duas pessoas", () => {
    expect(brazilPhoneVariants("553132221111")).toEqual(["553132221111"]);
  });

  it("número estrangeiro fica como veio", () => {
    expect(brazilPhoneVariants("14155550123")).toEqual(["14155550123"]);
  });
});

describe("resposta do lead cai na MESMA conversa do envio automático", () => {
  it("resposta pelo número sem o nono dígito não abre segunda conversa", async () => {
    const { db, ingest } = setup();
    const enviada = await sendFromForm(ingest, "5531999998888");

    const result = await ingest.ingest(inbound("553199998888@s.whatsapp.net", "553199998888"), {
      organizationId: ORG,
    });

    expect(result?.conversationId).toBe(enviada.id);
    expect(db.rows("conversation")).toHaveLength(1);
    // A conversa passa a usar o endereço que o WhatsApp usa de verdade: a
    // próxima mensagem casa direto, sem depender da busca pelo telefone.
    expect(db.rows("conversation")[0]?.externalChatId).toBe("553199998888@s.whatsapp.net");
  });

  it("resposta pelo @lid, com o telefone vindo no webhook, não abre segunda conversa", async () => {
    const { db, ingest } = setup();
    const enviada = await sendFromForm(ingest, "5531999998888");

    const result = await ingest.ingest(inbound("123456789012345@lid", "5531999998888"), {
      organizationId: ORG,
    });

    expect(result?.conversationId).toBe(enviada.id);
    expect(db.rows("conversation")).toHaveLength(1);
    expect(db.rows("conversation")[0]?.externalChatId).toBe("123456789012345@lid");
  });

  it("depois de casada, o próximo envio do site vai para a mesma conversa", async () => {
    const { db, ingest } = setup();
    await sendFromForm(ingest, "5531999998888");
    await ingest.ingest(inbound("123456789012345@lid", "5531999998888"), { organizationId: ORG });

    const segundoEnvio = await sendFromForm(ingest, "5531999998888");

    expect(db.rows("conversation")).toHaveLength(1);
    expect(segundoEnvio.externalChatId).toBe("123456789012345@lid");
  });

  it("lead que escreveu primeiro (sem o nono dígito) recebe o envio do site na conversa dele", async () => {
    const { db, ingest } = setup();
    const organica = await ingest.ingest(inbound("553199998888@s.whatsapp.net", "553199998888"), {
      organizationId: ORG,
    });

    const enviada = await sendFromForm(ingest, "5531999998888");

    expect(enviada.id).toBe(organica?.conversationId);
    expect(db.rows("conversation")).toHaveLength(1);
  });

  it("conversa que já tem resposta do cliente NÃO é renomeada (evita trocar de endereço a cada mensagem)", async () => {
    const { db, ingest } = setup();
    await ingest.ingest(inbound("5531999998888@s.whatsapp.net", "5531999998888", "msg-a"), {
      organizationId: ORG,
    });
    await ingest.ingest(inbound("123456789012345@lid", "5531999998888", "msg-b"), { organizationId: ORG });

    expect(db.rows("conversation").map((row) => row.externalChatId).sort()).toEqual([
      "123456789012345@lid",
      "5531999998888@s.whatsapp.net",
    ]);
  });

  it("número diferente continua sendo outra conversa", async () => {
    const { db, ingest } = setup();
    await sendFromForm(ingest, "5531999998888");
    await ingest.ingest(inbound("553188887777@s.whatsapp.net", "553188887777"), { organizationId: ORG });

    expect(db.rows("conversation")).toHaveLength(2);
  });

  it("contato antigo pelo @lid recebe o envio do site na conversa dele, mesmo sem o telefone no Contact", async () => {
    // O caso que escapou do conserto acima (relato de 31/10/2026): a conversa
    // `@lid` já existia ANTES — nasceu antes do `rememberLidPhone`, ou chegou
    // por outro caminho —, então o telefone só estava nas mensagens. O envio
    // pelo telefone digitado não achava o `@lid` e abria outra conversa.
    const { db, ingest } = setup();
    db.seed("conversation", {
      id: "conv-antiga",
      organizationId: ORG,
      whatsappInstanceId: INSTANCE,
      externalChatId: "123456789012345@lid",
      type: "individual",
      title: "Lead Antigo",
      status: "open",
      lastMessageAt: new Date("2026-09-07T02:00:00Z"),
    });

    await ingest.ingest(inbound("123456789012345@lid", "5531999998888", "msg-nova"), { organizationId: ORG });
    const enviada = await sendFromForm(ingest, "5531999998888");

    expect(enviada.id).toBe("conv-antiga");
    expect(db.rows("conversation")).toHaveLength(1);
  });

  it("@lid sem telefone conhecido continua abrindo conversa própria (não adivinha)", async () => {
    const { db, ingest } = setup();
    await sendFromForm(ingest, "5531999998888");
    await ingest.ingest(inbound("123456789012345@lid", null), { organizationId: ORG });

    expect(db.rows("conversation")).toHaveLength(2);
  });
});

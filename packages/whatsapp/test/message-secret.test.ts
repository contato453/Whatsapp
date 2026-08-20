import { describe, expect, it } from "vitest";
import { createCipheriv, createHmac, randomBytes } from "node:crypto";
import { proto } from "@whiskeysockets/baileys";
import {
  decryptEditedText,
  extractMessageSecret,
  extractSecretEncryptedEdit,
} from "../src/qrcode/message-secret.js";

/**
 * Edição CIFRADA, que é como o WhatsApp passou a entregar a correção que o
 * cliente faz no celular.
 *
 * O teste cifra com o MESMO esquema que o WhatsApp usa e confere que a
 * função abre. É a única forma de trancar isso sem um telefone de verdade:
 * a chave sai de quatro campos concatenados, e trocar qualquer um deles faz
 * o AES-GCM recusar em silêncio — falha que na produção aparece como "a
 * edição não chegou", sem nada vermelho em lugar nenhum.
 */

const ORIGINAL_ID = "3EB0C4A5F2D1";
const AUTOR = "5521999998888@s.whatsapp.net";
const USE_CASE = "Message Edit";

/** Mesma derivação do WhatsApp: HKDF-SHA256 sem sal, uma única expansão. */
function derivarChave(segredo: Buffer, info: Buffer): Buffer {
  const prk = createHmac("sha256", Buffer.alloc(32)).update(segredo).digest();
  return createHmac("sha256", prk)
    .update(Buffer.concat([info, Buffer.from([1])]))
    .digest()
    .subarray(0, 32);
}

function cifrarEdicao(texto: string, segredo: Buffer, autor: string, editor: string) {
  const info = Buffer.concat([
    Buffer.from(ORIGINAL_ID),
    Buffer.from(autor),
    Buffer.from(editor),
    Buffer.from(USE_CASE),
  ]);
  const chave = derivarChave(segredo, info);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", chave, iv);
  const conteudo = proto.Message.encode({ conversation: texto }).finish();
  const corpo = Buffer.concat([cipher.update(conteudo), cipher.final()]);
  return { encPayload: Buffer.concat([corpo, cipher.getAuthTag()]), encIv: iv };
}

describe("edição cifrada", () => {
  it("abre o texto novo com o segredo da mensagem original", () => {
    const segredo = randomBytes(32);
    const { encPayload, encIv } = cifrarEdicao("CNPJ 11.222.333/0001-44", segredo, AUTOR, AUTOR);
    const texto = decryptEditedText({
      encPayload,
      encIv,
      messageSecret: segredo,
      targetExternalMessageId: ORIGINAL_ID,
      originalSenderJid: AUTOR,
      editorJid: AUTOR,
    });
    expect(texto).toBe("CNPJ 11.222.333/0001-44");
  });

  it("segredo errado não abre, e não explode", () => {
    const { encPayload, encIv } = cifrarEdicao("texto", randomBytes(32), AUTOR, AUTOR);
    expect(
      decryptEditedText({
        encPayload,
        encIv,
        messageSecret: randomBytes(32),
        targetExternalMessageId: ORIGINAL_ID,
        originalSenderJid: AUTOR,
        editorJid: AUTOR,
      }),
    ).toBeNull();
  });

  it("cada um dos quatro campos da derivação importa", () => {
    // Trocar qualquer um produz chave diferente. O teste existe porque o
    // sintoma de errar a ordem é idêntico ao de não receber nada.
    const segredo = randomBytes(32);
    const { encPayload, encIv } = cifrarEdicao("texto", segredo, AUTOR, AUTOR);
    const base = {
      encPayload,
      encIv,
      messageSecret: segredo,
      targetExternalMessageId: ORIGINAL_ID,
      originalSenderJid: AUTOR,
      editorJid: AUTOR,
    };
    expect(decryptEditedText({ ...base, targetExternalMessageId: "outro" })).toBeNull();
    expect(decryptEditedText({ ...base, originalSenderJid: "5511@s.whatsapp.net" })).toBeNull();
    expect(decryptEditedText({ ...base, editorJid: "5511@s.whatsapp.net" })).toBeNull();
  });

  it("abre também quando quem edita não é quem mandou", () => {
    const segredo = randomBytes(32);
    const editor = "5521777776666@s.whatsapp.net";
    const { encPayload, encIv } = cifrarEdicao("corrigido", segredo, AUTOR, editor);
    expect(
      decryptEditedText({
        encPayload,
        encIv,
        messageSecret: segredo,
        targetExternalMessageId: ORIGINAL_ID,
        originalSenderJid: AUTOR,
        editorJid: editor,
      }),
    ).toBe("corrigido");
  });
});

describe("reconhecimento do envelope", () => {
  const envelope = (secretEncType: number) =>
    ({
      secretEncryptedMessage: {
        targetMessageKey: { id: ORIGINAL_ID, remoteJid: AUTOR, fromMe: false },
        encPayload: new Uint8Array([1, 2, 3]),
        encIv: new Uint8Array([4, 5, 6]),
        secretEncType,
      },
    }) as proto.IMessage;

  it("reconhece a edição de MENSAGEM (tipo 2)", () => {
    const achado = extractSecretEncryptedEdit(envelope(2));
    expect(achado?.targetExternalMessageId).toBe(ORIGINAL_ID);
    expect(achado?.targetFromMe).toBe(false);
  });

  it("edição de EVENTO (tipo 1) não é conversa, e fica de fora", () => {
    expect(extractSecretEncryptedEdit(envelope(1))).toBeNull();
  });

  it("mensagem comum não é envelope", () => {
    expect(extractSecretEncryptedEdit({ conversation: "oi" } as proto.IMessage)).toBeNull();
    expect(extractSecretEncryptedEdit(null)).toBeNull();
  });
});

describe("extractMessageSecret", () => {
  it("devolve o segredo em base64", () => {
    const segredo = new Uint8Array([1, 2, 3, 4]);
    expect(
      extractMessageSecret({ messageContextInfo: { messageSecret: segredo } } as proto.IMessage),
    ).toBe(Buffer.from(segredo).toString("base64"));
  });

  it("mensagem sem segredo devolve nulo", () => {
    expect(extractMessageSecret({ conversation: "oi" } as proto.IMessage)).toBeNull();
    expect(extractMessageSecret(null)).toBeNull();
  });
});

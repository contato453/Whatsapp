import { createDecipheriv, createHmac } from "node:crypto";
import { proto } from "@whiskeysockets/baileys";
import { extractContent } from "./normalize.js";

/**
 * Abertura do envelope `secretEncryptedMessage`, que é como o WhatsApp
 * passou a entregar a EDIÇÃO feita pelo cliente.
 *
 * O mecanismo antigo mandava um `protocolMessage` com o texto novo em
 * claro. O novo manda a chave da mensagem ORIGINAL mais um payload cifrado,
 * cuja chave é derivada do `messageSecret` daquela original — o mesmo
 * esquema que o WhatsApp já usava para voto de enquete. Nenhuma versão do
 * Baileys (nem a 6, nem a 7 em teste) implementa este caso, então a
 * derivação e a decifragem moram aqui, junto com o resto do conhecimento de
 * protocolo, e nada fora deste pacote precisa saber que existem.
 *
 * Consequência que não dá para contornar: sem o `messageSecret` da mensagem
 * original não há como abrir a edição dela. Mensagem que chegou antes de
 * começarmos a guardar esse segredo continua sem edição — não é defeito,
 * é o desenho do WhatsApp.
 */

/** Rótulo do caso de uso na derivação. Cada recurso tem o seu, e trocá-lo muda a chave. */
const MESSAGE_EDIT_USE_CASE = "Message Edit";

/** O AES-GCM do WhatsApp guarda a etiqueta de autenticação nos últimos 16 bytes. */
const GCM_TAG_LENGTH = 16;

export interface SecretEncryptedEdit {
  /** Id da mensagem ORIGINAL, que é a que precisa ser atualizada. */
  targetExternalMessageId: string;
  /** Chat da mensagem original, como o WhatsApp o endereça. */
  targetRemoteJid: string | null;
  /** A original saiu daqui? Decide de quem é o JID do autor. */
  targetFromMe: boolean;
  encPayload: Uint8Array;
  encIv: Uint8Array;
}

/**
 * Reconhece o envelope de edição cifrada. Devolve null para qualquer outro
 * uso do mesmo envelope (edição de evento, por exemplo), que não tem o que
 * atualizar na Inbox.
 */
export function extractSecretEncryptedEdit(
  rawMessage: proto.IMessage | null | undefined,
): SecretEncryptedEdit | null {
  const secret = rawMessage?.secretEncryptedMessage;
  if (!secret?.encPayload || !secret.encIv) return null;
  // SecretEncType.MESSAGE_EDIT = 2. EVENT_EDIT (1) é outra coisa.
  if (secret.secretEncType !== proto.Message.SecretEncryptedMessage.SecretEncType.MESSAGE_EDIT) {
    return null;
  }
  const targetExternalMessageId = secret.targetMessageKey?.id;
  if (!targetExternalMessageId) return null;
  return {
    targetExternalMessageId,
    targetRemoteJid: secret.targetMessageKey?.remoteJid ?? null,
    targetFromMe: secret.targetMessageKey?.fromMe ?? false,
    encPayload: secret.encPayload,
    encIv: secret.encIv,
  };
}

/**
 * Deriva a chave e devolve a mensagem nova que estava cifrada.
 *
 * A derivação é HKDF-SHA256 sem sal, com o "info" montado a partir do id da
 * original, do JID de quem a mandou, do JID de quem editou e do rótulo do
 * caso de uso, nessa ordem. Errar qualquer um dos quatro produz uma chave
 * diferente, e o AES-GCM recusa: por isso a falha aqui é sempre silenciosa
 * e nunca "quase certa".
 */
export function decryptSecretEncryptedEdit(input: {
  encPayload: Uint8Array;
  encIv: Uint8Array;
  /** 32 bytes de `messageContextInfo.messageSecret` da mensagem ORIGINAL. */
  messageSecret: Uint8Array;
  targetExternalMessageId: string;
  /** JID de quem mandou a mensagem original, sem sufixo de aparelho. */
  originalSenderJid: string;
  /** JID de quem fez a edição, sem sufixo de aparelho. */
  editorJid: string;
  /** Voto de enquete leva dado autenticado; a edição, não. */
  usedAad?: boolean;
}): proto.IMessage | null {
  const info = Buffer.concat([
    Buffer.from(input.targetExternalMessageId),
    Buffer.from(input.originalSenderJid),
    Buffer.from(input.editorJid),
    Buffer.from(MESSAGE_EDIT_USE_CASE),
  ]);
  const key = hkdf(input.messageSecret, info);
  try {
    const aad = input.usedAad
      ? Buffer.from(`${input.targetExternalMessageId}\u0000${input.editorJid}`)
      : null;
    const plaintext = aesGcmDecrypt(input.encPayload, key, input.encIv, aad);
    return proto.Message.decode(plaintext);
  } catch {
    // Chave errada, payload de outro recurso ou formato novo: em qualquer
    // caso não há mensagem para aplicar. Quem chama decide o que registrar
    // — aqui não se loga, para não repetir o mesmo aviso duas vezes.
    return null;
  }
}

/**
 * HKDF-SHA256 de 32 bytes, com sal vazio. Escrito à mão porque é uma
 * extração e UMA expansão: trazer dependência para isso não se paga, e a
 * função do Node ainda não é síncrona em todas as versões que suportamos.
 */
function hkdf(ikm: Uint8Array, info: Buffer): Buffer {
  const prk = createHmac("sha256", Buffer.alloc(32)).update(ikm).digest();
  return createHmac("sha256", prk)
    .update(Buffer.concat([info, Buffer.from([1])]))
    .digest()
    .subarray(0, 32);
}

function aesGcmDecrypt(
  payload: Uint8Array,
  key: Buffer,
  iv: Uint8Array,
  aad: Buffer | null,
): Buffer {
  const data = Buffer.from(payload);
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv));
  if (aad) decipher.setAAD(aad);
  decipher.setAuthTag(data.subarray(data.length - GCM_TAG_LENGTH));
  return Buffer.concat([
    decipher.update(data.subarray(0, data.length - GCM_TAG_LENGTH)),
    decipher.final(),
  ]);
}

/**
 * Texto novo de uma edição cifrada, já pronto para a aplicação.
 *
 * Recebe CANDIDATOS de JID em vez de um valor só, e devolve qual combinação
 * funcionou. O motivo é concreto: a derivação usa o JID de quem mandou a
 * original e o de quem editou, e hoje o WhatsApp endereça a mesma pessoa ora
 * pelo telefone (`@s.whatsapp.net`), ora pelo identificador interno
 * (`@lid`) — e o que gravamos no banco nem sempre é o mesmo que ele usou na
 * chave. Errar produz uma chave diferente e o AES-GCM recusa em SILÊNCIO,
 * com o mesmo sintoma de não ter recebido nada.
 *
 * Testar é barato (um HMAC e um AES por tentativa) e não tem risco de abrir
 * errado: a etiqueta de autenticação só confere com a chave certa. Quem
 * chama registra a combinação vencedora, e é isso que permite simplificar
 * isto aqui no dia em que o WhatsApp parar de alternar os dois formatos.
 */
export interface DecryptedEdit {
  text: string;
  originalSenderJid: string;
  editorJid: string;
  usedAad: boolean;
}

export function decryptEditedText(input: {
  encPayload: Uint8Array;
  encIv: Uint8Array;
  messageSecret: Uint8Array;
  targetExternalMessageId: string;
  /** JIDs possíveis de quem mandou a original, em ordem de probabilidade. */
  originalSenderCandidates: readonly string[];
  /** JIDs possíveis de quem editou. */
  editorCandidates: readonly string[];
}): DecryptedEdit | null {
  const autores = unique(input.originalSenderCandidates);
  const editores = unique(input.editorCandidates);
  for (const originalSenderJid of autores) {
    for (const editorJid of editores) {
      // O AAD é do voto de enquete, não da edição. Ele entra na lista
      // mesmo assim porque custa uma tentativa e cobre a hipótese de o
      // WhatsApp passar a exigi-lo aqui também.
      for (const usedAad of [false, true]) {
        const message = decryptSecretEncryptedEdit({
          encPayload: input.encPayload,
          encIv: input.encIv,
          messageSecret: input.messageSecret,
          targetExternalMessageId: input.targetExternalMessageId,
          originalSenderJid,
          editorJid,
          usedAad,
        });
        const text = message ? (extractContent(message)?.content ?? null) : null;
        if (text) return { text, originalSenderJid, editorJid, usedAad };
      }
    }
  }
  return null;
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values.filter((value) => value.length > 0))];
}

/**
 * Segredo que acompanha a mensagem, em base64, quando o WhatsApp o envia.
 * É o que permite abrir a edição dela mais tarde.
 */
export function extractMessageSecret(
  rawMessage: proto.IMessage | null | undefined,
): string | null {
  const secret = rawMessage?.messageContextInfo?.messageSecret;
  if (!secret || secret.length === 0) return null;
  return Buffer.from(secret).toString("base64");
}

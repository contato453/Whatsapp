import { describe, expect, it } from "vitest";
import type { proto } from "@whiskeysockets/baileys";
import {
  extractContent,
  extractEditedContent,
  extractProtocolAction,
  isDisplayableContent,
} from "../src/qrcode/normalize.js";

/**
 * Editar e apagar NÃO são mensagem: chegam como pacote de protocolo
 * apontando para a mensagem original.
 *
 * O aparelho do cliente embrulha esse pacote em `editedMessage`, e às vezes
 * com um `message` no meio, às vezes sem. Ler `message.protocolMessage`
 * direto era o que fazia a edição escapar do teste e cair no classificador
 * de conteúdo, virando mensagem nova sem texto e sem mídia — a bolha
 * "Mídia indisponível" que a equipe via, enquanto a original seguia com o
 * texto antigo.
 */

const ORIGINAL = "wamid-original";
const asMessage = (value: unknown) => value as proto.IMessage;

describe("extractProtocolAction", () => {
  it("reconhece a edição no formato direto", () => {
    const acao = extractProtocolAction(
      asMessage({
        protocolMessage: {
          key: { id: ORIGINAL },
          type: 14,
          editedMessage: { conversation: "valor corrigido" },
          timestampMs: 1_767_225_600_000,
        },
      }),
    );
    expect(acao?.kind).toBe("edit");
    expect(acao?.targetExternalMessageId).toBe(ORIGINAL);
    expect(acao?.newContent).toBe("valor corrigido");
    expect(acao?.editedAt).toEqual(new Date(1_767_225_600_000));
  });

  it("reconhece a edição embrulhada em editedMessage.message", () => {
    const acao = extractProtocolAction(
      asMessage({
        editedMessage: {
          message: {
            protocolMessage: {
              key: { id: ORIGINAL },
              type: 14,
              editedMessage: { extendedTextMessage: { text: "CNPJ novo" } },
            },
          },
        },
      }),
    );
    expect(acao?.kind).toBe("edit");
    expect(acao?.newContent).toBe("CNPJ novo");
  });

  it("reconhece a edição embrulhada sem o `message` no meio", () => {
    // Variação que algumas versões do aplicativo mandam. Recusá-la
    // devolveria o pacote ao classificador de conteúdo, que criaria a
    // bolha lixo de novo.
    const acao = extractProtocolAction(
      asMessage({
        editedMessage: {
          protocolMessage: {
            key: { id: ORIGINAL },
            type: 14,
            editedMessage: { conversation: "corrigido" },
          },
        },
      }),
    );
    expect(acao?.kind).toBe("edit");
    expect(acao?.newContent).toBe("corrigido");
  });

  it("edição de LEGENDA traz a legenda nova, e nada de mídia", () => {
    const acao = extractProtocolAction(
      asMessage({
        protocolMessage: {
          key: { id: ORIGINAL },
          type: 14,
          editedMessage: { imageMessage: { caption: "competência 08/2026" } },
        },
      }),
    );
    expect(acao?.newContent).toBe("competência 08/2026");
  });

  it("aceita a edição mesmo quando o código do tipo é outro", () => {
    // O conteúdo novo estar presente já basta: recusar por causa do número
    // deixaria o texto velho na tela do atendente.
    const acao = extractProtocolAction(
      asMessage({
        protocolMessage: {
          key: { id: ORIGINAL },
          type: 99,
          editedMessage: { conversation: "novo" },
        },
      }),
    );
    expect(acao?.kind).toBe("edit");
  });

  it("reconhece o apagar para todos", () => {
    const acao = extractProtocolAction(
      asMessage({ protocolMessage: { key: { id: ORIGINAL }, type: 0 } }),
    );
    expect(acao?.kind).toBe("revoke");
    expect(acao?.targetExternalMessageId).toBe(ORIGINAL);
  });

  it("reconhece o apagar embrulhado (mesmo caminho da edição)", () => {
    const acao = extractProtocolAction(
      asMessage({
        editedMessage: { message: { protocolMessage: { key: { id: ORIGINAL }, type: 0 } } },
      }),
    );
    expect(acao?.kind).toBe("revoke");
  });

  it("mensagem comum não é pacote de protocolo", () => {
    expect(extractProtocolAction(asMessage({ conversation: "oi" }))).toBeNull();
    expect(extractProtocolAction(asMessage({ imageMessage: { caption: "foto" } }))).toBeNull();
    expect(extractProtocolAction(null)).toBeNull();
  });

  it("protocolo sem id de alvo não vira ação", () => {
    // Sem o id da original não há o que atualizar — e seguir daqui era
    // justamente o que criava mensagem lixo.
    expect(extractProtocolAction(asMessage({ protocolMessage: { type: 14 } }))).toBeNull();
  });

  it("outros pacotes de protocolo são ignorados", () => {
    const acao = extractProtocolAction(
      asMessage({ protocolMessage: { key: { id: ORIGINAL }, type: 3 } }),
    );
    expect(acao).toBeNull();
  });
});

describe("extractEditedContent", () => {
  it("lê o conteúdo novo que o Baileys entrega pelo messages.update", () => {
    // Nesse canal o conteúdo chega embrulhado em `editedMessage.message`,
    // e a chave já traz o id da mensagem ORIGINAL.
    expect(
      extractEditedContent(asMessage({ editedMessage: { message: { conversation: "novo" } } })),
    ).toBe("novo");
  });

  it("sem texto reconhecível devolve nulo", () => {
    expect(extractEditedContent(asMessage({}))).toBeNull();
    expect(extractEditedContent(null)).toBeNull();
  });

  it("mensagem inteira SEM o envelope de edição não é edição", () => {
    // O mesmo evento do Baileys carrega a mensagem completa no reenvio de
    // mídia. Sem exigir o envelope, a legenda da foto voltaria como uma
    // "edição" que ninguém fez.
    expect(extractEditedContent(asMessage({ imageMessage: { caption: "foto" } }))).toBeNull();
    expect(extractEditedContent(asMessage({ conversation: "oi" }))).toBeNull();
  });
});

describe("isDisplayableContent", () => {
  it("bolha sem texto, sem arquivo e de tipo desconhecido não é mensagem", () => {
    // É a última trava: qualquer formato novo do WhatsApp que caia no
    // fallback "other" para de virar a linha "Mídia indisponível".
    expect(isDisplayableContent(extractContent(asMessage({ messageContextInfo: {} })))).toBe(false);
    expect(isDisplayableContent(null)).toBe(false);
  });

  it("mensagem de verdade continua passando", () => {
    expect(isDisplayableContent(extractContent(asMessage({ conversation: "oi" })))).toBe(true);
    expect(isDisplayableContent(extractContent(asMessage({ audioMessage: {} })))).toBe(true);
    expect(isDisplayableContent(extractContent(asMessage({ stickerMessage: {} })))).toBe(true);
  });
});

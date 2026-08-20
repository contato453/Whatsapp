import { describe, expect, it } from "vitest";
import type { proto } from "@whiskeysockets/baileys";
import {
  extractContent,
  extractEditedContent,
  extractProtocolAction,
  isDisplayableContent,
  messageKeyPaths,
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

describe("aninhamento inesperado do conteúdo novo", () => {
  it("acha o texto novo mesmo em profundidade que não prevíamos", () => {
    // Não dá para prever como cada versão do aplicativo aninha o conteúdo.
    // Reconhecer o pacote e perder o texto é o pior desfecho: sem bolha
    // lixo, mas com o texto velho na tela e ninguém percebendo.
    const acao = extractProtocolAction(
      asMessage({
        editedMessage: {
          protocolMessage: {
            key: { id: ORIGINAL },
            type: 14,
            editedMessage: { message: { extendedTextMessage: { text: "Testando 5.2" } } },
          },
        },
      }),
    );
    expect(acao?.kind).toBe("edit");
    expect(acao?.newContent).toBe("Testando 5.2");
  });

  it("pacote de edição sem texto algum continua sem conteúdo", () => {
    const acao = extractProtocolAction(
      asMessage({ protocolMessage: { key: { id: ORIGINAL }, type: 14, editedMessage: {} } }),
    );
    expect(acao?.kind).toBe("edit");
    expect(acao?.newContent).toBeNull();
  });
});

describe("busca profunda (invólucro que não conhecíamos)", () => {
  // O caso real que escapou em produção: o pacote de edição vinha dentro de
  // uma chave que não estava na lista de invólucros conhecidos. Sem ele, a
  // edição não virava bolha lixo (a trava de conteúdo pegava) mas também
  // não era aplicada, e o atendente seguia lendo o texto velho.
  const embrulhado = asMessage({
    algumInvolucroNovo: {
      message: {
        protocolMessage: {
          key: { id: ORIGINAL },
          type: 14,
          editedMessage: { conversation: "CNPJ corrigido" },
        },
      },
    },
  });

  it("o teste normal NÃO reconhece — a lista de invólucros é uma aposta", () => {
    expect(extractProtocolAction(embrulhado)).toBeNull();
  });

  it("a busca profunda reconhece e traz o texto novo", () => {
    const acao = extractProtocolAction(embrulhado, { deep: true });
    expect(acao?.kind).toBe("edit");
    expect(acao?.targetExternalMessageId).toBe(ORIGINAL);
    expect(acao?.newContent).toBe("CNPJ corrigido");
  });

  it("mensagem comum não vira protocolo nem na busca profunda", () => {
    expect(extractProtocolAction(asMessage({ conversation: "oi" }), { deep: true })).toBeNull();
    expect(
      extractProtocolAction(asMessage({ imageMessage: { caption: "foto" } }), { deep: true }),
    ).toBeNull();
  });
});

describe("messageKeyPaths", () => {
  it("devolve os caminhos das chaves, e nenhum valor", () => {
    const caminhos = messageKeyPaths({
      editedMessage: { message: { protocolMessage: { key: { id: "abc" }, type: 14 } } },
    });
    expect(caminhos).toContain("editedMessage.message.protocolMessage.type");
    // O que a pessoa escreveu nunca entra: só o NOME do campo.
    expect(caminhos.join(" ")).not.toContain("abc");
  });

  it("não estoura em binário nem em objeto vazio", () => {
    expect(messageKeyPaths({ dados: new Uint8Array([1, 2, 3]) })).toEqual(["dados"]);
    expect(messageKeyPaths({})).toEqual([]);
    expect(messageKeyPaths(null)).toEqual([]);
  });
});

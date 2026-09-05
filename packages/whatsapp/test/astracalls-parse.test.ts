import { describe, expect, it } from "vitest";
import { extractEditedText, parseInboundMessage } from "../src/astracalls/parse.js";

describe("extractEditedText — edição do cliente", () => {
  it("pega o texto novo do raw quando o topo vem vazio", () => {
    // Caso do bug: data.text vazio, texto novo no raw (bolha ficava preta).
    expect(
      extractEditedText({
        edited: true,
        editedId: "X",
        text: "",
        raw: { conversation: "mensagem corrigida" },
      }),
    ).toBe("mensagem corrigida");
  });

  it("desembrulha invólucros (editedMessage/extendedTextMessage)", () => {
    expect(
      extractEditedText({
        edited: true,
        raw: { editedMessage: { message: { extendedTextMessage: { text: "novo texto" } } } },
      }),
    ).toBe("novo texto");
  });

  it("prefere o texto do topo quando existe", () => {
    expect(extractEditedText({ text: "do topo", raw: { conversation: "do raw" } })).toBe("do topo");
  });

  it("sem texto em lugar nenhum devolve string vazia (guard cuida do resto)", () => {
    expect(extractEditedText({ edited: true, raw: { protocolMessage: {} } })).toBe("");
  });
});

/**
 * O webhook `message` do AstraCalls entrega os campos mastigados no topo
 * (chat/sender/text/type) e a mensagem CRUA do whatsmeow em `raw`. Citação,
 * menções, opções de enquete e duração de áudio só existem dentro do `raw` —
 * estes testes provam que o parser os extrai (eram os bugs de responder,
 * enquete sem opções e áudio zerado).
 */

const noDownload = () => null;

describe("parseInboundMessage — extração do raw", () => {
  it("extrai a citação (reply) do contextInfo em grupo", () => {
    const msg = parseInboundMessage(
      "inst",
      {
        chat: "120363000000000000@g.us",
        id: "MSG1",
        sender: "556799999999:5@lid",
        senderPhone: "556799999999",
        type: "text",
        text: "concordo",
        timestamp: 1788183258000,
        raw: {
          extendedTextMessage: {
            text: "concordo",
            contextInfo: {
              // whatsmeow serializa com I maiúsculo — era isto que passava batido
              stanzaID: "ORIGINAL123",
              participant: "556788888888@s.whatsapp.net",
              quotedMessage: { conversation: "e aí, tudo certo?" },
            },
          },
        },
      },
      noDownload,
    );
    expect(msg).not.toBeNull();
    expect(msg?.quotedExternalMessageId).toBe("ORIGINAL123");
    expect(msg?.quotedInfo?.content).toBe("e aí, tudo certo?");
    expect(msg?.quotedInfo?.type).toBe("text");
    expect(msg?.quotedInfo?.participantExternalId).toBe("556788888888@s.whatsapp.net");
  });

  it("extrai as opções da enquete recebida", () => {
    const msg = parseInboundMessage(
      "inst",
      {
        chat: "556799999999@s.whatsapp.net",
        id: "MSG2",
        sender: "556799999999@s.whatsapp.net",
        type: "poll",
        text: "Qual dia?",
        timestamp: 1788183258000,
        raw: {
          pollCreationMessage: {
            name: "Qual dia?",
            options: [{ optionName: "Segunda" }, { optionName: "Terça" }],
          },
        },
      },
      noDownload,
    );
    expect(msg?.type).toBe("poll");
    expect(msg?.pollOptions).toEqual(["Segunda", "Terça"]);
  });

  it("extrai a duração do áudio recebido", () => {
    const msg = parseInboundMessage(
      "inst",
      {
        chat: "556799999999@s.whatsapp.net",
        id: "MSG3",
        sender: "556799999999@s.whatsapp.net",
        type: "audio",
        timestamp: 1788183258000,
        mimetype: "audio/ogg; codecs=opus",
        raw: {
          audioMessage: { seconds: 12, PTT: true },
        },
      },
      // Áudio precisa de um download para virar mídia; devolvemos um qualquer.
      () => () => Promise.resolve(Buffer.from("")),
    );
    expect(msg?.type).toBe("audio");
    expect(msg?.mediaDurationSeconds).toBe(12);
  });

  it("extrai menções do contextInfo", () => {
    const msg = parseInboundMessage(
      "inst",
      {
        chat: "120363000000000000@g.us",
        id: "MSG4",
        sender: "556799999999@s.whatsapp.net",
        type: "text",
        text: "@556788888888 olha isso",
        timestamp: 1788183258000,
        raw: {
          extendedTextMessage: {
            text: "@556788888888 olha isso",
            contextInfo: { mentionedJid: ["556788888888@s.whatsapp.net"] },
          },
        },
      },
      noDownload,
    );
    expect(msg?.mentionedExternalIds).toEqual(["556788888888@s.whatsapp.net"]);
  });

  it("pega mimeType e filename do raw quando o topo vem vazio (bug do download)", () => {
    const msg = parseInboundMessage(
      "inst",
      {
        chat: "556799999999@s.whatsapp.net",
        id: "DOC1",
        sender: "556799999999@s.whatsapp.net",
        type: "document",
        fromMe: true,
        timestamp: 1788183258000,
        // topo vazio, como chega no echo de arquivo enviado por fora
        raw: {
          documentMessage: {
            mimetype: "application/pdf",
            fileName: "contrato.pdf",
          },
        },
      },
      () => () => Promise.resolve(Buffer.from("%PDF")),
    );
    expect(msg?.media?.mimeType).toBe("application/pdf");
    expect(msg?.media?.filename).toBe("contrato.pdf");
  });

  it("mensagem simples (sem raw) não quebra e não inventa citação", () => {
    const msg = parseInboundMessage(
      "inst",
      {
        chat: "556799999999@s.whatsapp.net",
        id: "MSG5",
        sender: "556799999999@s.whatsapp.net",
        type: "text",
        text: "oi",
        timestamp: 1788183258000,
      },
      noDownload,
    );
    expect(msg?.quotedExternalMessageId).toBeNull();
    expect(msg?.quotedInfo).toBeNull();
    expect(msg?.pollOptions).toBeUndefined();
    expect(msg?.mediaDurationSeconds).toBeUndefined();
  });
});

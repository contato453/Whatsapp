import { describe, expect, it } from "vitest";
import {
  chatTypeFromJid,
  directionFromKey,
  extractContent,
  extractMentionedJids,
  extractQuotedContext,
  extractQuotedMessageId,
  extractSender,
  isGroupJid,
  isIgnorableJid,
  jidToPhone,
  stripDeviceSuffix,
  toDate,
  unwrapMessage,
} from "../src/qrcode/normalize.js";

describe("jidToPhone", () => {
  it("extrai o número de um JID individual", () => {
    expect(jidToPhone("5511999998888@s.whatsapp.net")).toBe("5511999998888");
  });

  it("remove o sufixo de dispositivo", () => {
    expect(jidToPhone("5511999998888:12@s.whatsapp.net")).toBe("5511999998888");
  });

  it("retorna null para valores vazios", () => {
    expect(jidToPhone(null)).toBeNull();
    expect(jidToPhone(undefined)).toBeNull();
    expect(jidToPhone("")).toBeNull();
  });
});

describe("stripDeviceSuffix", () => {
  it("remove o sufixo de aparelho preservando o domínio", () => {
    // O ":51" identifica o dispositivo, não a pessoa — os cadastros guardam
    // o JID limpo, e é com eles que a chamada precisa casar.
    expect(stripDeviceSuffix("19675832402083:51@lid")).toBe("19675832402083@lid");
    expect(stripDeviceSuffix("5511999998888:12@s.whatsapp.net")).toBe(
      "5511999998888@s.whatsapp.net",
    );
  });

  it("não altera JID que já está limpo", () => {
    expect(stripDeviceSuffix("19675832402083@lid")).toBe("19675832402083@lid");
    expect(stripDeviceSuffix("120363012345678@g.us")).toBe("120363012345678@g.us");
  });
});

describe("isGroupJid / chatTypeFromJid", () => {
  it("identifica grupos pelo sufixo @g.us", () => {
    expect(isGroupJid("120363012345678@g.us")).toBe(true);
    expect(isGroupJid("5511999998888@s.whatsapp.net")).toBe(false);
    expect(chatTypeFromJid("120363012345678@g.us")).toBe("group");
    expect(chatTypeFromJid("5511999998888@s.whatsapp.net")).toBe("individual");
  });
});

describe("isIgnorableJid", () => {
  it("ignora status, broadcast e newsletter", () => {
    expect(isIgnorableJid("status@broadcast")).toBe(true);
    expect(isIgnorableJid("123@newsletter")).toBe(true);
    expect(isIgnorableJid(null)).toBe(true);
    expect(isIgnorableJid("5511999998888@s.whatsapp.net")).toBe(false);
    expect(isIgnorableJid("120363012345678@g.us")).toBe(false);
  });
});

describe("unwrapMessage", () => {
  it("desembrulha mensagens efêmeras aninhadas", () => {
    const inner = { conversation: "olá" };
    const wrapped = { ephemeralMessage: { message: { viewOnceMessage: { message: inner } } } };
    expect(unwrapMessage(wrapped)).toEqual(inner);
  });

  it("retorna a própria mensagem quando não há wrapper", () => {
    const message = { conversation: "olá" };
    expect(unwrapMessage(message)).toEqual(message);
  });
});

describe("extractContent", () => {
  it("extrai texto simples", () => {
    expect(extractContent({ conversation: "bom dia" })).toEqual({
      type: "text",
      content: "bom dia",
      mimeType: null,
      filename: null,
      hasMedia: false,
    });
  });

  it("extrai texto estendido (com link/reply)", () => {
    expect(extractContent({ extendedTextMessage: { text: "veja isso" } })?.content).toBe("veja isso");
  });

  it("extrai imagem com legenda", () => {
    const result = extractContent({ imageMessage: { caption: "segue o doc", mimetype: "image/png" } });
    expect(result).toEqual({
      type: "image",
      content: "segue o doc",
      mimeType: "image/png",
      filename: null,
      hasMedia: true,
    });
  });

  it("extrai documento com nome de arquivo", () => {
    const result = extractContent({
      documentMessage: { fileName: "balanco.pdf", mimetype: "application/pdf" },
    });
    expect(result?.type).toBe("document");
    expect(result?.filename).toBe("balanco.pdf");
    expect(result?.hasMedia).toBe(true);
  });

  it("extrai áudio", () => {
    const result = extractContent({ audioMessage: { mimetype: "audio/ogg; codecs=opus" } });
    expect(result?.type).toBe("audio");
    expect(result?.hasMedia).toBe(true);
  });

  it("extrai localização", () => {
    const result = extractContent({
      locationMessage: { degreesLatitude: -23.55, degreesLongitude: -46.63 },
    });
    expect(result?.type).toBe("location");
    expect(result?.content).toContain("-23.55");
  });

  it("ignora mensagens de protocolo e reações", () => {
    expect(extractContent({ protocolMessage: {} })).toBeNull();
    expect(extractContent({ reactionMessage: { text: "👍" } })).toBeNull();
  });

  it("extrai enquete com pergunta e opções", () => {
    const result = extractContent({
      pollCreationMessage: {
        name: "Qual o melhor horário?",
        options: [{ optionName: "Manhã" }, { optionName: "Tarde" }],
      },
    } as never);
    expect(result?.type).toBe("poll");
    expect(result?.content).toBe("Qual o melhor horário?");
    expect(result?.pollOptions).toEqual(["Manhã", "Tarde"]);
  });

  it("classifica tipos desconhecidos como other", () => {
    expect(extractContent({ paymentInviteMessage: {} } as never)?.type).toBe("other");
  });

  it("retorna null para mensagem vazia", () => {
    expect(extractContent(null)).toBeNull();
    expect(extractContent(undefined)).toBeNull();
  });
});

describe("extractQuotedMessageId", () => {
  it("extrai o stanzaId da mensagem citada", () => {
    const message = {
      extendedTextMessage: { text: "resposta", contextInfo: { stanzaId: "ABC123" } },
    };
    expect(extractQuotedMessageId(message)).toBe("ABC123");
  });

  it("retorna null quando não há citação", () => {
    expect(extractQuotedMessageId({ conversation: "oi" })).toBeNull();
  });
});

describe("extractQuotedContext", () => {
  it("traz o conteúdo citado junto com o id — é ele que salva o bloco quando a original nunca foi sincronizada", () => {
    const message = {
      extendedTextMessage: {
        text: "resposta",
        contextInfo: {
          stanzaId: "ABC123",
          participant: "5511999998888@s.whatsapp.net",
          quotedMessage: { conversation: "mensagem original" },
        },
      },
    };
    expect(extractQuotedContext(message)).toEqual({
      externalMessageId: "ABC123",
      participantExternalId: "5511999998888@s.whatsapp.net",
      content: "mensagem original",
      type: "text",
    });
  });

  it("citação de mídia sai com o TIPO — citar um áudio não pode virar bloco vazio", () => {
    const message = {
      extendedTextMessage: {
        text: "sobre esse áudio",
        contextInfo: {
          stanzaId: "AUD1",
          participant: "5511988887777@s.whatsapp.net",
          quotedMessage: { audioMessage: { mimetype: "audio/ogg" } },
        },
      },
    };
    const quoted = extractQuotedContext(message);
    expect(quoted?.type).toBe("audio");
    expect(quoted?.content).toBeNull();
  });

  it("legenda da mídia citada vira o conteúdo", () => {
    const message = {
      extendedTextMessage: {
        text: "essa foto",
        contextInfo: {
          stanzaId: "IMG1",
          quotedMessage: { imageMessage: { caption: "boleto de agosto" } },
        },
      },
    };
    const quoted = extractQuotedContext(message);
    expect(quoted?.type).toBe("image");
    expect(quoted?.content).toBe("boleto de agosto");
  });

  it("remove o sufixo de aparelho do participante — o cadastro guarda o JID sem ele", () => {
    const message = {
      extendedTextMessage: {
        text: "resposta",
        contextInfo: {
          stanzaId: "LID1",
          participant: "123456789012:51@lid",
          quotedMessage: { conversation: "original" },
        },
      },
    };
    expect(extractQuotedContext(message)?.participantExternalId).toBe("123456789012@lid");
  });

  it("citação sem quotedMessage no payload ainda traz o id, com tipo genérico", () => {
    const message = {
      extendedTextMessage: { text: "resposta", contextInfo: { stanzaId: "SEM1" } },
    };
    expect(extractQuotedContext(message)).toEqual({
      externalMessageId: "SEM1",
      participantExternalId: null,
      content: null,
      type: "other",
    });
  });

  it("mensagem sem citação devolve null", () => {
    expect(extractQuotedContext({ conversation: "oi" })).toBeNull();
    expect(extractQuotedContext(null)).toBeNull();
  });
});

describe("extractMentionedJids", () => {
  it("lê a lista de marcados do contextInfo — não do texto", () => {
    // Quem notifica é esta lista. O "@5511..." escrito na frase é só o que o
    // aplicativo usa para desenhar o destaque.
    const message = {
      extendedTextMessage: {
        text: "@5511999998888 confere?",
        contextInfo: { mentionedJid: ["5511999998888@s.whatsapp.net"] },
      },
    };
    expect(extractMentionedJids(message)).toEqual(["5511999998888@s.whatsapp.net"]);
  });

  it("mantém o identificador interno como veio — LID não é telefone", () => {
    const message = {
      extendedTextMessage: { text: "oi", contextInfo: { mentionedJid: ["123456789012@lid"] } },
    };
    expect(extractMentionedJids(message)).toEqual(["123456789012@lid"]);
  });

  it("mensagem sem marcação devolve lista vazia", () => {
    expect(extractMentionedJids({ conversation: "@ninguem" })).toEqual([]);
    expect(extractMentionedJids(null)).toEqual([]);
  });

  it("descarta o que não é conversa de gente (status, broadcast)", () => {
    const message = {
      imageMessage: {
        caption: "foto",
        contextInfo: { mentionedJid: ["status@broadcast", "5511999998888@s.whatsapp.net"] },
      },
    };
    expect(extractMentionedJids(message)).toEqual(["5511999998888@s.whatsapp.net"]);
  });
});

describe("directionFromKey", () => {
  it("fromMe = outbound, senão inbound", () => {
    expect(directionFromKey({ fromMe: true })).toBe("outbound");
    expect(directionFromKey({ fromMe: false })).toBe("inbound");
    expect(directionFromKey(null)).toBe("inbound");
  });
});

describe("extractSender", () => {
  const ownJid = "5511988887777@s.whatsapp.net";

  it("em grupos usa o participant como remetente", () => {
    const result = extractSender(
      {
        remoteJid: "120363012345678@g.us",
        participant: "5511999998888@s.whatsapp.net",
        fromMe: false,
      },
      ownJid,
    );
    expect(result.senderExternalId).toBe("5511999998888@s.whatsapp.net");
    expect(result.senderPhone).toBe("5511999998888");
  });

  it("em conversa individual usa o próprio chat", () => {
    const result = extractSender(
      { remoteJid: "5511999998888@s.whatsapp.net", fromMe: false },
      ownJid,
    );
    expect(result.senderExternalId).toBe("5511999998888@s.whatsapp.net");
  });

  it("mensagens próprias usam o JID conectado", () => {
    const result = extractSender(
      { remoteJid: "120363012345678@g.us", fromMe: true },
      ownJid,
    );
    expect(result.senderExternalId).toBe(ownJid);
    expect(result.senderPhone).toBe("5511988887777");
  });
});

describe("toDate", () => {
  it("converte segundos em Date", () => {
    expect(toDate(1700000000).toISOString()).toBe("2023-11-14T22:13:20.000Z");
  });

  it("converte Long-like em Date", () => {
    expect(toDate({ toString: () => "1700000000" }).getTime()).toBe(1700000000000);
  });

  it("retorna data atual para valores inválidos", () => {
    const before = Date.now();
    const result = toDate(null).getTime();
    expect(result).toBeGreaterThanOrEqual(before - 1000);
  });
});

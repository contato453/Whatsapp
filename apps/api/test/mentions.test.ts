import { describe, expect, it } from "vitest";
import {
  MENTION_MAX_PER_MESSAGE,
  activeMentions,
  buildOutboundMention,
  insertMention,
  isMentionable,
  mentionDigits,
  mentionJid,
  mentionTrigger,
  type DraftMention,
} from "@azvchat/shared";
import { mentionsSchema, resolveMentionTargets } from "../src/lib/mentions.js";
import { AppError } from "../src/lib/errors.js";

/**
 * A marcação de participantes tem um risco central: menção NÃO é formatação
 * de texto. O que notifica é a lista de identificadores que viaja ao lado do
 * texto — se ela se separar do que está escrito, a mensagem sai bonita e não
 * chama ninguém, ou pior, chama quem não aparece na frase.
 *
 * Estes testes fixam os dois lados: a mecânica do composer (pura, no shared)
 * e a conferência da API, que é quem impede marcar um número que não está no
 * grupo.
 */

function pessoa(label: string, telefone: string, externalId = `${telefone}@s.whatsapp.net`): DraftMention {
  return { label, token: `@${telefone}`, externalIds: [externalId] };
}

describe("mentionTrigger — quando o '@' abre o seletor", () => {
  it("abre no começo da mensagem", () => {
    expect(mentionTrigger("@ma", 3)).toEqual({ start: 0, query: "ma" });
  });

  it("abre depois de espaço e de quebra de linha", () => {
    expect(mentionTrigger("bom dia @jo", 11)).toEqual({ start: 8, query: "jo" });
    expect(mentionTrigger("linha\n@jo", 9)).toEqual({ start: 6, query: "jo" });
  });

  it("NÃO abre no meio de palavra — e-mail continua sendo e-mail", () => {
    expect(mentionTrigger("contato@escritorio.com", 22)).toBeNull();
    expect(mentionTrigger("contato@", 8)).toBeNull();
  });

  it("espaço depois do '@' fecha o seletor e deixa o caractere como texto", () => {
    expect(mentionTrigger("@ ", 2)).toBeNull();
    expect(mentionTrigger("@jo silva", 9)).toBeNull();
  });

  it("olha só o que está ANTES do cursor", () => {
    // O cursor voltou para o meio do texto: o "@" da frente não conta.
    expect(mentionTrigger("oi @ma tudo bem", 6)).toEqual({ start: 3, query: "ma" });
    expect(mentionTrigger("oi @ma tudo bem", 15)).toBeNull();
  });
});

describe("insertMention", () => {
  it("troca a consulta pelo rótulo e devolve o cursor depois dele", () => {
    const trigger = mentionTrigger("bom dia @jo", 11);
    expect(trigger).not.toBeNull();
    const result = insertMention("bom dia @jo", trigger!, "@João Silva");
    expect(result.text).toBe("bom dia @João Silva ");
    expect(result.caret).toBe(result.text.length);
  });

  it("preserva o que vem depois do cursor", () => {
    const trigger = mentionTrigger("@jo, pode ver?", 3);
    const result = insertMention("@jo, pode ver?", trigger!, "@João");
    expect(result.text).toBe("@João , pode ver?");
  });
});

describe("activeMentions — o backspace desmarca", () => {
  const joao = pessoa("@João", "5511999998888");
  const maria = pessoa("@Maria", "5511777776666");

  it("mantém quem continua escrito no texto", () => {
    expect(activeMentions("@João e @Maria, vejam", [joao, maria])).toEqual([joao, maria]);
  });

  it("apagar o rótulo tira o identificador da lista", () => {
    // Sem isto o WhatsApp notificaria alguém que não aparece na mensagem.
    expect(activeMentions("@Jo e @Maria, vejam", [joao, maria])).toEqual([maria]);
    expect(activeMentions("mensagem sem marcação", [joao, maria])).toEqual([]);
  });

  it("rótulo que contém outro rótulo não conta duas vezes", () => {
    const joaoSilva = pessoa("@João Silva", "5511555554444");
    // "@João" está dentro de "@João Silva": só a marcação longa está viva.
    expect(activeMentions("olha @João Silva", [joao, joaoSilva])).toEqual([joaoSilva]);
  });

  it("a mesma pessoa marcada duas vezes continua marcada duas vezes", () => {
    expect(activeMentions("@João e de novo @João", [joao, joao])).toEqual([joao, joao]);
  });
});

describe("buildOutboundMention — o que sai para o WhatsApp", () => {
  const joao = pessoa("@João", "5511999998888");
  const maria = pessoa("@Maria", "5511777776666");

  it("troca o rótulo pelo número e devolve os identificadores", () => {
    const result = buildOutboundMention("@João, confere?", [joao]);
    expect(result.text).toBe("@5511999998888, confere?");
    expect(result.externalIds).toEqual(["5511999998888@s.whatsapp.net"]);
  });

  it("leva várias pessoas na mesma mensagem", () => {
    const result = buildOutboundMention("@João e @Maria, vejam", [joao, maria]);
    expect(result.text).toBe("@5511999998888 e @5511777776666, vejam");
    expect(result.externalIds).toHaveLength(2);
  });

  it("'@todos' fica literal no texto — quem marca todo mundo é a lista", () => {
    const todos: DraftMention = {
      label: "@todos",
      token: "@todos",
      externalIds: ["a@s.whatsapp.net", "b@s.whatsapp.net"],
    };
    const result = buildOutboundMention("@todos, reunião às 15h", [todos]);
    expect(result.text).toBe("@todos, reunião às 15h");
    expect(result.externalIds).toEqual(["a@s.whatsapp.net", "b@s.whatsapp.net"]);
  });

  it("marcação apagada não vai junto — nem no texto, nem na lista", () => {
    const result = buildOutboundMention("mudei de ideia", [joao, maria]);
    expect(result.text).toBe("mudei de ideia");
    expect(result.externalIds).toEqual([]);
  });

  it("texto colado com '@' escrito na mão não vira marcação", () => {
    // Menção só nasce da escolha na lista: sem entrada em `mentions`, o
    // texto é só texto — ninguém é notificado.
    const result = buildOutboundMention("mandei para @Joao ontem", []);
    expect(result.externalIds).toEqual([]);
    expect(result.text).toBe("mandei para @Joao ontem");
  });
});

describe("identificadores", () => {
  it("mentionJid monta o JID a partir do telefone", () => {
    expect(mentionJid("5511999998888")).toBe("5511999998888@s.whatsapp.net");
  });

  it("mentionDigits extrai os dígitos de qualquer JID", () => {
    expect(mentionDigits("5511999998888@s.whatsapp.net")).toBe("5511999998888");
    expect(mentionDigits("123456789012@lid")).toBe("123456789012");
    expect(mentionDigits("5511999998888:12@s.whatsapp.net")).toBe("5511999998888");
  });

  it("sem telefone conhecido a pessoa não é mencionável", () => {
    // Participante só com "@lid": o número dele não é telefone, e mandar o
    // LID como marcação não notifica ninguém.
    expect(isMentionable({ phoneNumber: "" })).toBe(false);
    expect(isMentionable({ phoneNumber: null })).toBe(false);
    expect(isMentionable({ phoneNumber: "5511999998888" })).toBe(true);
  });
});

describe("mentionsSchema — validação de entrada", () => {
  it("aceita lista de identificadores", () => {
    expect(mentionsSchema.parse(["5511999998888@s.whatsapp.net"])).toHaveLength(1);
  });

  it("recusa o que não é lista de texto", () => {
    expect(() => mentionsSchema.parse("5511999998888@s.whatsapp.net")).toThrow();
    expect(() => mentionsSchema.parse([123])).toThrow();
    expect(() => mentionsSchema.parse([""])).toThrow();
  });

  it("recusa acima do teto de menções por mensagem", () => {
    const demais = Array.from({ length: MENTION_MAX_PER_MESSAGE + 1 }, (_, i) => `${i}@s.whatsapp.net`);
    expect(() => mentionsSchema.parse(demais)).toThrow();
  });
});

describe("resolveMentionTargets — só participantes DESTA conversa", () => {
  const participantes = [
    { externalContactId: "5511999998888@s.whatsapp.net", phoneNumber: "5511999998888" },
    { externalContactId: "123456789012@lid", phoneNumber: "5511777776666" },
    { externalContactId: "999888777666@lid", phoneNumber: "" },
  ];

  it("converte o participante no JID que vai no contextInfo", () => {
    expect(resolveMentionTargets("group", ["5511999998888@s.whatsapp.net"], participantes)).toEqual({
      jids: ["5511999998888@s.whatsapp.net"],
      dropped: 0,
    });
  });

  it("participante endereçado por '@lid' é marcado pelo telefone conhecido", () => {
    expect(resolveMentionTargets("group", ["123456789012@lid"], participantes).jids).toEqual([
      "5511777776666@s.whatsapp.net",
    ]);
  });

  it("NUNCA marca número que não está no grupo", () => {
    // A régua central: ninguém pode notificar quem não participa da conversa.
    // O pedido é descartado (a mensagem ainda sai), mas o número não entra.
    const resultado = resolveMentionTargets(
      "group",
      ["5511000000000@s.whatsapp.net", "5511999998888@s.whatsapp.net"],
      participantes,
    );
    expect(resultado.jids).toEqual(["5511999998888@s.whatsapp.net"]);
    expect(resultado.dropped).toBe(1);
  });

  it("participante que saiu do grupo não derruba a mensagem inteira", () => {
    const resultado = resolveMentionTargets("group", ["ex-membro@s.whatsapp.net"], participantes);
    expect(resultado.jids).toEqual([]);
    expect(resultado.dropped).toBe(1);
  });

  it("participante sem telefone conhecido é descartado, não marcado", () => {
    const resultado = resolveMentionTargets("group", ["999888777666@lid"], participantes);
    expect(resultado.jids).toEqual([]);
    expect(resultado.dropped).toBe(1);
  });

  it("recusa marcação em conversa individual", () => {
    // Aqui não é corrida de participante: é pedido que não faz sentido.
    try {
      resolveMentionTargets("individual", ["5511999998888@s.whatsapp.net"], participantes);
      throw new Error("deveria ter recusado");
    } catch (err) {
      expect(err).toBeInstanceOf(AppError);
      expect((err as AppError).statusCode).toBe(400);
      expect((err as AppError).code).toBe("mentions_not_allowed");
    }
  });

  it("lista vazia não é marcação nenhuma — nem em conversa individual", () => {
    expect(resolveMentionTargets("individual", [], participantes)).toEqual({ jids: [], dropped: 0 });
  });

  it("a mesma pessoa marcada duas vezes vira um identificador só", () => {
    const dobrado = ["5511999998888@s.whatsapp.net", "5511999998888@s.whatsapp.net"];
    expect(resolveMentionTargets("group", dobrado, participantes).jids).toHaveLength(1);
  });
});

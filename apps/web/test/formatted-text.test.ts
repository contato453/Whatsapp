import { describe, expect, it } from "vitest";
import {
  makeMentionResolver,
  splitLinkParts,
  splitMentionParts,
} from "@/components/inbox/formatted-text";

/**
 * A detecção de link roda sobre o que o CLIENTE escreveu — qualquer pessoa
 * que mande mensagem ao escritório. As regras aqui são de segurança tanto
 * quanto de conveniência: só http/https vira link, e a saída são partes
 * estruturadas (nunca HTML) que o componente transforma em nós React.
 */
describe("splitLinkParts", () => {
  it("transforma URL http/https em link, preservando o texto ao redor", () => {
    expect(splitLinkParts("veja https://exemplo.com agora")).toEqual([
      { kind: "text", value: "veja " },
      { kind: "link", href: "https://exemplo.com", label: "https://exemplo.com" },
      { kind: "text", value: " agora" },
    ]);
    expect(splitLinkParts("http://exemplo.com/x?y=1")).toEqual([
      { kind: "link", href: "http://exemplo.com/x?y=1", label: "http://exemplo.com/x?y=1" },
    ]);
  });

  it("prefixa https em URL escrita como www.", () => {
    expect(splitLinkParts("acesse www.exemplo.com.br hoje")).toEqual([
      { kind: "text", value: "acesse " },
      { kind: "link", href: "https://www.exemplo.com.br", label: "www.exemplo.com.br" },
      { kind: "text", value: " hoje" },
    ]);
  });

  it("mensagem que é só um link vira uma única parte de link", () => {
    expect(splitLinkParts("https://exemplo.com.br/boleto/123")).toEqual([
      {
        kind: "link",
        href: "https://exemplo.com.br/boleto/123",
        label: "https://exemplo.com.br/boleto/123",
      },
    ]);
  });

  it("não adivinha link em texto que só tem ponto", () => {
    expect(splitLinkParts("chegou ontem.hoje não")).toEqual([
      { kind: "text", value: "chegou ontem.hoje não" },
    ]);
    // "www." sem um segundo ponto de domínio também não é link.
    expect(splitLinkParts("digite www.exemplo e confirme")).toEqual([
      { kind: "text", value: "digite www.exemplo e confirme" },
    ]);
  });

  it("nunca linkifica javascript:, data:, file: ou outros esquemas", () => {
    for (const payload of [
      "javascript:alert(1)",
      "clique javascript:alert(1) aqui",
      "data:text/html,<script>alert(1)</script>",
      "file:///etc/passwd",
      "ftp://servidor/arquivo",
    ]) {
      const parts = splitLinkParts(payload);
      expect(parts.every((part) => part.kind === "text")).toBe(true);
    }
  });

  it("vários links na mesma mensagem viram todos clicáveis", () => {
    const parts = splitLinkParts("veja https://a.com e também www.b.com.br ok");
    expect(parts.filter((part) => part.kind === "link")).toEqual([
      { kind: "link", href: "https://a.com", label: "https://a.com" },
      { kind: "link", href: "https://www.b.com.br", label: "www.b.com.br" },
    ]);
  });

  it("pontuação final da frase fica fora da URL", () => {
    expect(splitLinkParts("acesse https://exemplo.com.")).toEqual([
      { kind: "text", value: "acesse " },
      { kind: "link", href: "https://exemplo.com", label: "https://exemplo.com" },
      { kind: "text", value: "." },
    ]);
    // Parêntese que fecha um aparte não pertence à URL...
    expect(splitLinkParts("(veja https://exemplo.com)")).toEqual([
      { kind: "text", value: "(veja " },
      { kind: "link", href: "https://exemplo.com", label: "https://exemplo.com" },
      { kind: "text", value: ")" },
    ]);
    // ...mas parêntese balanceado dentro da URL permanece.
    const wiki = splitLinkParts("https://pt.wikipedia.org/wiki/Imposto_(Brasil)");
    expect(wiki).toEqual([
      {
        kind: "link",
        href: "https://pt.wikipedia.org/wiki/Imposto_(Brasil)",
        label: "https://pt.wikipedia.org/wiki/Imposto_(Brasil)",
      },
    ]);
  });

  it("só o esquema, sem endereço, não é link", () => {
    expect(splitLinkParts("https://")).toEqual([{ kind: "text", value: "https://" }]);
  });
});

/**
 * Exibição da marcação. O texto gravado traz o NÚMERO ("@5511999998888"),
 * porque é essa a forma que o WhatsApp entende — quem diz que aquilo é
 * marcação de verdade é a lista de identificadores da mensagem, nunca o
 * texto. Aqui se fixam as duas pontas: o que vira nome e o que continua
 * sendo texto comum.
 */
describe("splitMentionParts / makeMentionResolver", () => {
  const nomes = new Map([
    ["5511999998888", "João Silva"],
    ["123456789012", "Marina"],
  ]);

  it("troca o número marcado pelo nome do participante", () => {
    const resolve = makeMentionResolver(["5511999998888@s.whatsapp.net"], nomes);
    expect(splitMentionParts("bom dia @5511999998888, confere?", resolve)).toEqual([
      { kind: "text", value: "bom dia " },
      { kind: "mention", label: "@João Silva" },
      { kind: "text", value: ", confere?" },
    ]);
  });

  it("número escrito na mão NÃO vira marcação — só o que está na lista", () => {
    const resolve = makeMentionResolver([], nomes);
    expect(splitMentionParts("ligue para @5511999998888", resolve)).toEqual([
      { kind: "text", value: "ligue para @5511999998888" },
    ]);
  });

  it("marcado sem cadastro aparece com o telefone formatado, nunca com o JID", () => {
    // Quem saiu do grupo continua marcado na mensagem antiga.
    const resolve = makeMentionResolver(["5511777776666@s.whatsapp.net"], nomes);
    const parts = splitMentionParts("@5511777776666 saiu", resolve);
    expect(parts[0]).toEqual({ kind: "mention", label: "@+55 11 77777-6666" });
  });

  it("identificador interno conhecido vira nome", () => {
    const resolve = makeMentionResolver(["123456789012@lid"], nomes);
    expect(splitMentionParts("@123456789012 pode ver", resolve)[0]).toEqual({
      kind: "mention",
      label: "@Marina",
    });
  });

  it("identificador interno DESCONHECIDO nunca é exibido como telefone", () => {
    const resolve = makeMentionResolver(["999888777666@lid"], nomes);
    // Sem cadastro, o trecho fica como veio: o número do LID não é telefone
    // de ninguém e formatá-lo seria inventar um contato.
    expect(splitMentionParts("@999888777666 ok", resolve)).toEqual([
      { kind: "text", value: "@999888777666 ok" },
    ]);
  });

  it("'@todos' só destaca quando a mensagem marcou alguém de verdade", () => {
    const comMarcacao = makeMentionResolver(["5511999998888@s.whatsapp.net"], nomes);
    expect(splitMentionParts("@todos, reunião", comMarcacao)[0]).toEqual({
      kind: "mention",
      label: "@todos",
    });
    const semMarcacao = makeMentionResolver([], nomes);
    expect(splitMentionParts("@todos, reunião", semMarcacao)).toEqual([
      { kind: "text", value: "@todos, reunião" },
    ]);
  });

  it("'@' no meio de palavra continua sendo e-mail", () => {
    const resolve = makeMentionResolver(["5511999998888@s.whatsapp.net"], nomes);
    expect(splitMentionParts("nota@5511999998888", resolve)).toEqual([
      { kind: "text", value: "nota@5511999998888" },
    ]);
  });
});

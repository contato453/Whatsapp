import { Fragment } from "react";
import {
  MENTION_ALL_LABEL,
  formatPhone,
  mentionDigits,
  parseWhatsAppBlocks,
  parseWhatsAppText,
  type FormattedSegment,
} from "@azvchat/shared";

/**
 * Renderiza o texto com a formatação do WhatsApp (*negrito*, _itálico_,
 * ~tachado~, ```mono```, lista numerada, lista com marcadores e citação) e
 * transforma URLs em links clicáveis.
 *
 * São DOIS níveis, e eles não se misturam: negrito e companhia são de TRECHO
 * (um par de marcadores em volta do texto) e saem de `parseWhatsAppText`;
 * lista e citação são de LINHA (um prefixo por linha) e saem de
 * `parseWhatsAppBlocks`. Sem o segundo, a barra de formatação do composer
 * produziria "> " e "1. " que ninguém interpreta — e a bolha mostraria o
 * símbolo cru no lugar da lista.
 *
 * Sem a formatação os marcadores apareceriam crus na conversa — tanto na
 * assinatura do atendente quanto no que o cliente escreve. Sem os links, o
 * atendente teria que copiar a URL para outra aba na mão.
 *
 * A linkificação produz NÓS REACT (texto e <a>), nunca string de HTML: o
 * conteúdo vem de fora, de qualquer pessoa que mande mensagem ao escritório,
 * e montar HTML a partir dele (dangerouslySetInnerHTML) seria porta de XSS.
 * O padrão só casa http/https explícito ou host começando em "www." —
 * javascript:, data:, file: e afins jamais viram link, por construção.
 */

export type LinkPart =
  | { kind: "text"; value: string }
  | { kind: "link"; href: string; label: string };

// http/https explícito, ou "www." seguido de pelo menos mais um ponto de
// domínio — "chegou ontem.hoje não" fica de fora porque texto com ponto não
// tem o prefixo www. nem esquema.
const URL_PATTERN = /\bhttps?:\/\/[^\s]+|\bwww\.[\p{L}0-9-]+(?:\.[\p{L}0-9-]+)+(?:[/?#][^\s]*)?/giu;

/**
 * Pontuação final é quase sempre da frase, não da URL ("veja https://x.com.").
 * Parêntese fechando só sai quando não tem par aberto dentro da própria URL.
 */
function trimTrailingPunctuation(url: string): string {
  let result = url;
  while (result.length > 0) {
    const last = result[result.length - 1] as string;
    if (".,;:!?…\"'".includes(last)) {
      result = result.slice(0, -1);
      continue;
    }
    if (
      last === ")" &&
      (result.match(/\(/g)?.length ?? 0) < (result.match(/\)/g)?.length ?? 0)
    ) {
      result = result.slice(0, -1);
      continue;
    }
    break;
  }
  return result;
}

/** Separa o texto em trechos comuns e links — puro, para o teste cobrir. */
export function splitLinkParts(text: string): LinkPart[] {
  const parts: LinkPart[] = [];
  let cursor = 0;
  for (const match of text.matchAll(URL_PATTERN)) {
    const raw = trimTrailingPunctuation(match[0]);
    // Sobrou só o esquema (ex.: "https://.")? Não é link.
    if (!/^https?:\/\/./i.test(raw) && !/^www\./i.test(raw)) continue;
    const start = match.index;
    if (start > cursor) parts.push({ kind: "text", value: text.slice(cursor, start) });
    // URL sem esquema abre com https — http cru seria rebaixar de graça.
    const href = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
    parts.push({ kind: "link", href, label: raw });
    cursor = start + raw.length;
  }
  if (cursor < text.length) parts.push({ kind: "text", value: text.slice(cursor) });
  return parts;
}

/**
 * Marcação ("@") dentro do texto.
 *
 * O que chega gravado na mensagem é o número — "@5511999998888" —, porque é
 * essa a forma que o WhatsApp entende. Quem diz que aquilo é marcação de
 * verdade não é o texto, e sim a lista de identificadores do
 * `metadata.mentions`: número digitado na mão pelo atendente continua sendo
 * número. Por isso o resolvedor devolve `null` para tudo que não está na
 * lista, e a linha segue como texto comum.
 */
export type MentionResolver = (token: string) => string | null;

export type MentionPart =
  | { kind: "text"; value: string }
  | { kind: "mention"; label: string };

/** "@" seguido de dígitos (telefone) ou do coletivo "@todos". */
const MENTION_PATTERN = /@(\d{6,20}|todos)\b/giu;

/** Separa o texto em trechos comuns e marcações — puro, para o teste cobrir. */
export function splitMentionParts(text: string, resolve: MentionResolver): MentionPart[] {
  const parts: MentionPart[] = [];
  let cursor = 0;
  for (const match of text.matchAll(MENTION_PATTERN)) {
    const start = match.index;
    // Mesma regra do composer: "@" colado em letra ou número é e-mail ou
    // continuação de palavra, nunca marcação.
    const previous = start > 0 ? (text[start - 1] as string) : "";
    if (previous && /[\p{L}\p{N}]/u.test(previous)) continue;
    const label = resolve((match[1] as string).toLowerCase());
    if (!label) continue;
    if (start > cursor) parts.push({ kind: "text", value: text.slice(cursor, start) });
    parts.push({ kind: "mention", label });
    cursor = start + match[0].length;
  }
  if (cursor < text.length) parts.push({ kind: "text", value: text.slice(cursor) });
  return parts;
}

/**
 * Monta o resolvedor de uma mensagem a partir do que ela marcou e do cadastro
 * de participantes do grupo.
 *
 * Quem saiu do grupo (ou nunca teve cadastro) aparece com o telefone
 * formatado — nunca o JID cru. Identificador interno ("@lid") não vira
 * telefone em hipótese alguma: o número dele não é número de ninguém, então
 * o trecho fica exatamente como veio, sem virar marcação.
 */
export function makeMentionResolver(
  mentioned: string[],
  names: Map<string, string>,
): MentionResolver {
  if (mentioned.length === 0) return () => null;
  const marked = new Map<string, boolean>();
  for (const jid of mentioned) marked.set(mentionDigits(jid), jid.endsWith("@lid"));
  return (token) => {
    if (token === "todos") return MENTION_ALL_LABEL;
    const isLid = marked.get(token);
    if (isLid === undefined) return null;
    const name = names.get(token);
    if (name) return `@${name}`;
    return isLid ? null : `@${formatPhone(token)}`;
  };
}

/** Link longo é truncado só na exibição; o href e o title levam a URL inteira. */
const LINK_DISPLAY_LIMIT = 60;

function renderLinks(value: string): React.ReactNode {
  const parts = splitLinkParts(value);
  if (parts.length === 1 && parts[0]?.kind === "text") return value;
  return parts.map((part, index) => {
    if (part.kind === "text") return <Fragment key={index}>{part.value}</Fragment>;
    const label =
      part.label.length > LINK_DISPLAY_LIMIT
        ? `${part.label.slice(0, LINK_DISPLAY_LIMIT)}…`
        : part.label;
    return (
      <a
        key={index}
        href={part.href}
        // target _blank exige noopener noreferrer SEMPRE: sem eles a página
        // aberta recebe window.opener e pode redirecionar esta aba para uma
        // cópia falsa do login — e phishing chega justamente por mensagem.
        target="_blank"
        rel="noopener noreferrer"
        title={part.href}
        // Herda a cor da bolha (branca na saída, escura na entrada); o
        // sublinhado marca o link sem depender só de cor.
        className="break-all font-medium underline underline-offset-2 hover:opacity-80"
      >
        {label}
      </a>
    );
  });
}

/**
 * Marcação primeiro, link depois: um "@5511..." nunca é URL, e resolver a
 * marcação antes evita que o número entre no caminho da linkificação.
 */
function renderTextWithLinks(value: string, resolve: MentionResolver): React.ReactNode {
  const parts = splitMentionParts(value, resolve);
  if (parts.length === 1 && parts[0]?.kind === "text") return renderLinks(value);
  return parts.map((part, index) =>
    part.kind === "text" ? (
      <Fragment key={index}>{renderLinks(part.value)}</Fragment>
    ) : (
      <span
        key={index}
        // Destaque leve: a bolha já tem cor própria (branca na saída), então
        // o realce vem do peso e de um fundo translúcido, não de cor fixa.
        className="rounded bg-black/10 px-0.5 font-semibold"
      >
        {part.label}
      </span>
    ),
  );
}

function renderSegments(
  segments: FormattedSegment[],
  linkify: boolean,
  resolveMention: MentionResolver,
): React.ReactNode {
  return segments.map((segment, index) => {
    if (segment.type === "text") {
      return (
        <Fragment key={index}>
          {linkify ? renderTextWithLinks(segment.value, resolveMention) : segment.value}
        </Fragment>
      );
    }
    // Dentro do monoespaçado o cliente está mostrando texto literal — nada de
    // link ali; o trecho continua exatamente como foi escrito.
    const children = renderSegments(
      segment.children,
      linkify && segment.mark !== "mono",
      resolveMention,
    );
    switch (segment.mark) {
      case "bold":
        return <strong key={index}>{children}</strong>;
      case "italic":
        return <em key={index}>{children}</em>;
      case "strike":
        return <s key={index}>{children}</s>;
      case "mono":
        return (
          <code key={index} className="rounded bg-black/5 px-1 font-mono text-[0.9em]">
            {children}
          </code>
        );
    }
  });
}

/** Sem resolvedor (nota, prévia, mensagem sem marcação) nada vira marcação. */
const NO_MENTIONS: MentionResolver = () => null;

function renderInline(value: string, resolveMention: MentionResolver): React.ReactNode {
  return renderSegments(parseWhatsAppText(value), true, resolveMention);
}

export function FormattedText({
  text,
  className,
  resolveMention = NO_MENTIONS,
}: {
  text: string;
  className?: string;
  /** Decide quais "@" desta mensagem são marcação de verdade. */
  resolveMention?: MentionResolver;
}) {
  const blocos = parseWhatsAppBlocks(text);
  // Caso comum (mensagem sem lista nem citação): continua sendo UM parágrafo,
  // exatamente como antes. Trocar para <div> aqui mudaria a caixa de toda
  // bolha do sistema por causa de um recurso que a maioria das mensagens não
  // usa.
  const unico = blocos.length === 1 ? blocos[0] : undefined;
  if (!unico || unico.type === "paragraph") {
    return <p className={className}>{renderInline(unico?.value ?? text, resolveMention)}</p>;
  }
  return (
    <div className={className}>
      {blocos.map((bloco, index) => {
        if (bloco.type === "paragraph") {
          return <p key={index}>{renderInline(bloco.value, resolveMention)}</p>;
        }
        if (bloco.type === "quote") {
          return (
            <blockquote
              key={index}
              // Preto translúcido em vez de cor fixa: as duas bolhas têm fundo
              // claro (branca na entrada, verde do WhatsApp na saída), e um
              // cinza fechado sumiria numa delas.
              className="my-0.5 border-l-2 border-black/20 pl-2 opacity-90"
            >
              {renderInline(bloco.value, resolveMention)}
            </blockquote>
          );
        }
        const Lista = bloco.ordered ? "ol" : "ul";
        return (
          <Lista key={index} className="my-0.5 space-y-0.5">
            {bloco.items.map((item, posicao) => (
              <li key={posicao} className="flex gap-1.5">
                {/* O marcador vai num <span> próprio, e não no `list-style`:
                    assim a numeração é a que a pessoa escreveu (e que o
                    cliente vai ver no celular dela), não a que o navegador
                    inventa. */}
                <span className="shrink-0 tabular-nums opacity-70">{item.marker}</span>
                <span className="min-w-0 flex-1">
                  {renderInline(item.value, resolveMention)}
                </span>
              </li>
            ))}
          </Lista>
        );
      })}
    </div>
  );
}

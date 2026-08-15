import { Fragment } from "react";
import { parseWhatsAppText, type FormattedSegment } from "@azvchat/shared";

/**
 * Renderiza o texto com a formatação do WhatsApp (*negrito*, _itálico_,
 * ~tachado~, ```mono```) e transforma URLs em links clicáveis.
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

/** Link longo é truncado só na exibição; o href e o title levam a URL inteira. */
const LINK_DISPLAY_LIMIT = 60;

function renderTextWithLinks(value: string): React.ReactNode {
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

function renderSegments(segments: FormattedSegment[], linkify: boolean): React.ReactNode {
  return segments.map((segment, index) => {
    if (segment.type === "text") {
      return (
        <Fragment key={index}>
          {linkify ? renderTextWithLinks(segment.value) : segment.value}
        </Fragment>
      );
    }
    // Dentro do monoespaçado o cliente está mostrando texto literal — nada de
    // link ali; o trecho continua exatamente como foi escrito.
    const children = renderSegments(segment.children, linkify && segment.mark !== "mono");
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

export function FormattedText({ text, className }: { text: string; className?: string }) {
  return <p className={className}>{renderSegments(parseWhatsAppText(text), true)}</p>;
}

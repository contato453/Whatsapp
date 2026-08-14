import { Fragment } from "react";
import { parseWhatsAppText, type FormattedSegment } from "@azvchat/shared";

/**
 * Renderiza o texto com a formatação do WhatsApp (*negrito*, _itálico_,
 * ~tachado~, ```mono```).
 *
 * Sem isso os marcadores apareceriam crus na conversa — tanto na
 * assinatura do atendente quanto no que o cliente escreve.
 */

function renderSegments(segments: FormattedSegment[]): React.ReactNode {
  return segments.map((segment, index) => {
    if (segment.type === "text") {
      return <Fragment key={index}>{segment.value}</Fragment>;
    }
    const children = renderSegments(segment.children);
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
  return <p className={className}>{renderSegments(parseWhatsAppText(text))}</p>;
}

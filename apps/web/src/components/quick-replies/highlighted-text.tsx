import type { HighlightSegment } from "@/lib/quick-reply-search";

/**
 * Trechos casados viram `<mark>`, nunca HTML montado a partir do conteúdo:
 * o texto da resposta é cadastro livre, e `dangerouslySetInnerHTML` sobre
 * ele seria abrir a porta para o que estiver escrito lá dentro.
 */
export function HighlightedText({ segments }: { segments: HighlightSegment[] }) {
  return (
    <>
      {segments.map((segment, index) =>
        segment.highlighted ? (
          <mark key={index} className="rounded-sm bg-amber-200 px-0.5 text-slate-900">
            {segment.text}
          </mark>
        ) : (
          segment.text
        ),
      )}
    </>
  );
}

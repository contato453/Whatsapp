/**
 * Formatação de texto do WhatsApp.
 *
 * O WhatsApp não usa Markdown: marca negrito com *asteriscos*, itálico com
 * _sublinhados_, tachado com ~tis~ e monoespaçado com ```três crases```.
 *
 * Isso vale nos dois sentidos: para escrever formatado (a assinatura do
 * atendente sai em negrito) e para exibir formatado o que o cliente
 * escreveu — sem isso os marcadores aparecem crus na conversa.
 */

export type FormatMark = "bold" | "italic" | "strike" | "mono";

export type FormattedSegment =
  | { type: "text"; value: string }
  | { type: "mark"; mark: FormatMark; children: FormattedSegment[] };

const MARKS: Record<string, FormatMark> = {
  "*": "bold",
  _: "italic",
  "~": "strike",
};

/** Envolve o texto no marcador de negrito do WhatsApp. */
export function bold(text: string): string {
  return `*${text}*`;
}

/**
 * Marcador só vale em borda de palavra — "2*3" e "a_b_c" continuam texto
 * comum, como no WhatsApp.
 */
function isBoundary(char: string | undefined): boolean {
  if (char === undefined) return true;
  return !/[\p{L}\p{N}]/u.test(char);
}

/**
 * Procura o fechamento de um marcador a partir de `from`.
 * Devolve -1 quando não há fechamento válido — nesse caso o marcador é
 * texto comum, e não o início de uma formatação.
 */
function findClosing(text: string, marker: string, from: number): number {
  for (let i = from; i < text.length; i += 1) {
    if (text[i] !== marker) continue;
    // Conteúdo vazio ou terminando em espaço não fecha: "* *" é literal.
    const previous = text[i - 1];
    if (i === from || previous === undefined || /\s/.test(previous)) continue;
    if (!isBoundary(text[i + 1])) continue;
    return i;
  }
  return -1;
}

/** Converte o texto em segmentos, resolvendo formatações aninhadas. */
export function parseWhatsAppText(text: string): FormattedSegment[] {
  const segments: FormattedSegment[] = [];
  let buffer = "";

  const flush = (): void => {
    if (buffer.length > 0) {
      segments.push({ type: "text", value: buffer });
      buffer = "";
    }
  };

  let index = 0;
  while (index < text.length) {
    const char = text[index] as string;

    // Monoespaçado tem precedência: dentro dele nada mais é interpretado.
    if (text.startsWith("```", index)) {
      const end = text.indexOf("```", index + 3);
      if (end > index + 3) {
        flush();
        segments.push({
          type: "mark",
          mark: "mono",
          children: [{ type: "text", value: text.slice(index + 3, end) }],
        });
        index = end + 3;
        continue;
      }
    }

    const mark = MARKS[char];
    if (mark && isBoundary(text[index - 1]) && !/\s/.test(text[index + 1] ?? " ")) {
      const closing = findClosing(text, char, index + 1);
      if (closing > index + 1) {
        flush();
        segments.push({
          type: "mark",
          mark,
          children: parseWhatsAppText(text.slice(index + 1, closing)),
        });
        index = closing + 1;
        continue;
      }
    }

    buffer += char;
    index += 1;
  }

  flush();
  return segments;
}

/** Texto puro, sem os marcadores — usado em prévias e buscas. */
export function stripWhatsAppFormatting(text: string): string {
  return parseWhatsAppText(text)
    .map(function render(segment): string {
      return segment.type === "text" ? segment.value : segment.children.map(render).join("");
    })
    .join("");
}

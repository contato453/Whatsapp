/**
 * Busca de respostas rápidas no cliente.
 *
 * A busca cobre atalho, título E CONTEÚDO de propósito: a pessoa lembra da
 * palavra que está no MEIO do texto ("certificado"), não do atalho decorado
 * (/alteracaocnpj) nem sempre do título. Se a busca só olhasse atalho e
 * título, a resposta mais fácil de lembrar seria justamente a mais difícil
 * de achar — e é para resolver isso que a busca existe.
 *
 * Quando o casamento acontece no conteúdo, o item abre EXPANDIDO com o texto
 * inteiro (nunca truncado) e o destaque marca a palavra exatamente onde ela
 * está no texto real. Isso substitui recortar uma "janela" ao redor do
 * termo: janela tem tamanho arbitrário e cortaria a frase no meio em texto
 * longo, enquanto mostrar o texto inteiro sempre traz o trecho certo à vista
 * sem mais um clique, e sem essa costura.
 */

export interface HighlightSegment {
  text: string;
  highlighted: boolean;
}

export interface QuickReplyMatch {
  shortcut: HighlightSegment[];
  title: HighlightSegment[];
  content: HighlightSegment[];
  /** Alguma palavra buscada caiu dentro do conteúdo — decide abrir expandido. */
  matchedContent: boolean;
}

/** Sem acento e em minúsculas, igual à mesma régua já usada na busca de menção. */
function fold(text: string): string {
  return text.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase();
}

/**
 * Quebra a busca em palavras, ignorando acento/maiúscula e a barra que a
 * pessoa às vezes digita por hábito — ela está pensando no atalho ("/nota"),
 * não numa palavra separada, e a barra no início não pode atrapalhar.
 */
export function quickReplySearchTerms(query: string): string[] {
  const trimmed = query.trim();
  const semBarraInicial = trimmed.startsWith("/") ? trimmed.slice(1) : trimmed;
  return fold(semBarraInicial)
    .split(/\s+/)
    .filter((term) => term.length > 0);
}

/**
 * Dobra o texto preservando, para cada caractere da versão dobrada, de qual
 * caractere ORIGINAL ele veio. É o que permite achar a posição do termo
 * ignorando acento e ainda destacar a grafia real cadastrada — sem isso,
 * "certificação" e "certificacao" teriam índices que não batem mais depois
 * de tirar o acento.
 */
function foldWithMap(text: string): { chars: string[]; folded: string; sourceIndex: number[] } {
  const chars = Array.from(text);
  let folded = "";
  const sourceIndex: number[] = [];
  chars.forEach((char, index) => {
    for (const piece of fold(char)) {
      folded += piece;
      sourceIndex.push(index);
    }
  });
  return { chars, folded, sourceIndex };
}

function toSegments(chars: string[], mask: boolean[]): HighlightSegment[] {
  if (chars.length === 0) return [{ text: "", highlighted: false }];
  const segments: HighlightSegment[] = [];
  let start = 0;
  for (let i = 1; i <= chars.length; i += 1) {
    if (i === chars.length || mask[i] !== mask[start]) {
      segments.push({ text: chars.slice(start, i).join(""), highlighted: mask[start] });
      start = i;
    }
  }
  return segments;
}

/** Marca em cada caractere original se ele faz parte de algum termo buscado. */
function highlightField(
  text: string,
  terms: string[],
): { segments: HighlightSegment[]; matchedTerms: Set<string> } {
  const { chars, folded, sourceIndex } = foldWithMap(text);
  const mask = new Array<boolean>(chars.length).fill(false);
  const matchedTerms = new Set<string>();
  for (const term of terms) {
    let from = 0;
    for (;;) {
      const at = folded.indexOf(term, from);
      if (at === -1) break;
      matchedTerms.add(term);
      for (let i = at; i < at + term.length; i += 1) mask[sourceIndex[i]] = true;
      from = at + term.length;
    }
  }
  return { segments: toSegments(chars, mask), matchedTerms };
}

/**
 * Casa uma resposta contra os termos buscados. `null` quando alguma palavra
 * não apareceu em NENHUM dos três campos — é E entre as palavras, OU entre
 * os campos: cada palavra pode ter casado num campo diferente ("recibo" no
 * título e "pagamento" no conteúdo ainda acha a resposta).
 */
export function matchQuickReply(
  reply: { shortcut: string; title?: string | null; content: string },
  terms: string[],
): QuickReplyMatch | null {
  const shortcut = highlightField(reply.shortcut, terms);
  const title = highlightField(reply.title ?? "", terms);
  const content = highlightField(reply.content, terms);

  if (terms.length > 0) {
    const distintos = new Set(terms);
    const cobertos = new Set([...shortcut.matchedTerms, ...title.matchedTerms, ...content.matchedTerms]);
    if (cobertos.size < distintos.size) return null;
  }

  return {
    shortcut: shortcut.segments,
    title: title.segments,
    content: content.segments,
    matchedContent: content.matchedTerms.size > 0,
  };
}

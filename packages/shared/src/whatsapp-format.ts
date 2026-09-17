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

/**
 * Um par de marcadores encontrado no texto, com as posições absolutas.
 *
 * `start`/`end` cobrem o par inteiro (marcador de abertura ao de fechamento);
 * `contentStart`/`contentEnd`, só o texto de dentro. A barra do composer usa
 * isso para saber se a seleção já está dentro de um trecho formatado.
 */
export interface MarkSpan {
  mark: FormatMark;
  start: number;
  end: number;
  contentStart: number;
  contentEnd: number;
}

/**
 * Varredura única, usada pelos dois consumidores: quem quer os segmentos para
 * exibir (`parseWhatsAppText`) e quem quer as posições dos marcadores
 * (`markSpans`). Duas varreduras separadas discordariam sobre o que é
 * formatação de verdade, e a barra passaria a remover marcador que a bolha
 * mostra cru.
 */
function scan(
  text: string,
  base: number,
  spans: MarkSpan[] | null,
): FormattedSegment[] {
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
        spans?.push({
          mark: "mono",
          start: base + index,
          end: base + end + 3,
          contentStart: base + index + 3,
          contentEnd: base + end,
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
          children: scan(text.slice(index + 1, closing), base + index + 1, spans),
        });
        spans?.push({
          mark,
          start: base + index,
          end: base + closing + 1,
          contentStart: base + index + 1,
          contentEnd: base + closing,
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

/** Converte o texto em segmentos, resolvendo formatações aninhadas. */
export function parseWhatsAppText(text: string): FormattedSegment[] {
  return scan(text, 0, null);
}

/** Todos os pares de marcadores do texto, aninhados inclusive. */
export function markSpans(text: string): MarkSpan[] {
  const spans: MarkSpan[] = [];
  scan(text, 0, spans);
  return spans;
}

/** Texto puro, sem os marcadores — usado em prévias e buscas. */
export function stripWhatsAppFormatting(text: string): string {
  return parseWhatsAppText(text)
    .map(function render(segment): string {
      return segment.type === "text" ? segment.value : segment.children.map(render).join("");
    })
    .join("");
}

/* ------------------------------------------------------------------ *
 * Barra de formatação do composer
 * ------------------------------------------------------------------ */

/**
 * O que a barra flutuante do composer sabe aplicar.
 *
 * SÃO DOIS COMPORTAMENTOS DIFERENTES, e confundi-los é o erro fácil aqui:
 *
 * - negrito, itálico, tachado e monoespaçado ENVOLVEM a seleção inteira com
 *   um marcador de cada lado, porque no WhatsApp a formatação de trecho é um
 *   par que abre e fecha em volta do texto;
 * - lista numerada, lista com marcadores e citação PREFIXAM CADA LINHA, porque
 *   ali o marcador é de linha, não de trecho. Tratar lista como "envolver"
 *   produziria "1. primeira\nsegunda\nterceira 1." — uma lista quebrada, com
 *   um item só e um número solto no fim.
 *
 * O botão ALTERNA: clicar em negrito sobre um texto que já está em negrito
 * REMOVE a marcação em vez de empilhar outra. Sem isso, dois cliques virariam
 * "**texto**", que o WhatsApp não entende como negrito duplo — ele mostra os
 * asteriscos sobrando na tela do cliente, e quem escreveu só descobre depois
 * de enviar.
 */
export type ComposerFormat =
  | "bold"
  | "italic"
  | "strike"
  | "mono"
  | "ordered_list"
  | "bullet_list"
  | "quote";

/** Estado do campo: o texto inteiro e onde está a seleção. */
export interface ComposerSelection {
  text: string;
  start: number;
  end: number;
}

const WRAP_MARKERS: Record<"bold" | "italic" | "strike" | "mono", string> = {
  bold: "*",
  italic: "_",
  strike: "~",
  mono: "```",
};

/** Formatação de trecho (envolve) vs. formatação de linha (prefixa). */
export function isWrapFormat(
  format: ComposerFormat,
): format is "bold" | "italic" | "strike" | "mono" {
  return format === "bold" || format === "italic" || format === "strike" || format === "mono";
}

/**
 * Trecho já formatado que CONTÉM a seleção, com as posições no texto inteiro.
 *
 * É o que permite selecionar uma palavra no meio de um trecho já em negrito e
 * o botão remover a marcação existente em vez de abrir um segundo par de
 * asteriscos no meio do primeiro — que corromperia a marcação de fora.
 */
function enclosingSpan(
  text: string,
  start: number,
  end: number,
  mark: FormatMark,
): MarkSpan | null {
  let melhor: MarkSpan | null = null;
  for (const span of markSpans(text)) {
    if (span.mark !== mark) continue;
    if (span.contentStart > start || span.contentEnd < end) continue;
    // O mais interno vence: é o par que de fato envolve a seleção.
    if (!melhor || span.contentStart > melhor.contentStart) melhor = span;
  }
  return melhor;
}

function applyWrap(
  selection: ComposerSelection,
  mark: "bold" | "italic" | "strike" | "mono",
): ComposerSelection | null {
  const { text } = selection;
  let start = selection.start;
  let end = selection.end;
  // Espaço nas bordas fica FORA do marcador: "* texto *" não é negrito no
  // WhatsApp (marcador colado em espaço não fecha), e arrastar o mouse quase
  // sempre pega o espaço depois da palavra.
  while (start < end && /\s/.test(text[start] as string)) start += 1;
  while (end > start && /\s/.test(text[end - 1] as string)) end -= 1;
  if (start >= end) return null;

  const marker = WRAP_MARKERS[mark];
  const size = marker.length;
  const inner = text.slice(start, end);

  // A seleção já pegou os marcadores junto (texto colado de outra conversa,
  // ou a pessoa selecionou o trecho inteiro): tira em vez de duplicar.
  if (inner.length > size * 2 && inner.startsWith(marker) && inner.endsWith(marker)) {
    const conteudo = inner.slice(size, -size);
    return {
      text: text.slice(0, start) + conteudo + text.slice(end),
      start,
      end: start + conteudo.length,
    };
  }

  // A seleção está DENTRO de um trecho já formatado: alterna removendo o par
  // de fora, e não abrindo um par novo no meio dele.
  const span = enclosingSpan(text, start, end, mark);
  if (span) {
    const conteudo = text.slice(span.contentStart, span.contentEnd);
    return {
      text: text.slice(0, span.start) + conteudo + text.slice(span.end),
      start: start - size,
      end: end - size,
    };
  }

  return {
    text: text.slice(0, start) + marker + inner + marker + text.slice(end),
    // A seleção segue o CONTEÚDO, não o par de marcadores: assim o próximo
    // clique (itálico em cima do negrito) envolve o mesmo trecho de novo, e
    // clicar no mesmo botão cai no caminho de remoção logo acima.
    start: start + size,
    end: end + size,
  };
}

/** O que uma linha já carrega de marcador de linha. */
interface LinePrefix {
  indent: string;
  quote: boolean;
  list: "ordered" | "bullet" | null;
  content: string;
}

// Indentação, citação opcional e, por último, o marcador de lista. O espaço
// depois do marcador é obrigatório: "-10 graus" é texto, "- item" é lista.
const LINE_PREFIX_PATTERN = /^([ \t]*)(>[ \t]+)?(?:(\d+)[.)][ \t]+|([-*•])[ \t]+)?/;

function splitLinePrefix(line: string): LinePrefix {
  const match = LINE_PREFIX_PATTERN.exec(line);
  if (!match) return { indent: "", quote: false, list: null, content: line };
  const [prefixo, indent = "", quote, numero, marcador] = match;
  return {
    indent,
    quote: Boolean(quote),
    list: numero ? "ordered" : marcador ? "bullet" : null,
    content: line.slice(prefixo.length),
  };
}

function buildLine(parts: LinePrefix, position: number): string {
  const lista =
    parts.list === "ordered" ? `${position}. ` : parts.list === "bullet" ? "- " : "";
  return `${parts.indent}${parts.quote ? "> " : ""}${lista}${parts.content}`;
}

function applyLinePrefix(
  selection: ComposerSelection,
  format: "ordered_list" | "bullet_list" | "quote",
): ComposerSelection | null {
  const { text } = selection;
  // Marcador de linha vale para a LINHA INTEIRA: a seleção é esticada até as
  // bordas dela, senão prefixar um pedaço do meio colocaria "- " no lugar
  // errado. Seleção que termina exatamente na quebra não puxa a linha
  // seguinte junto.
  const blockStart = text.lastIndexOf("\n", Math.max(selection.start - 1, 0)) + 1;
  const refEnd =
    selection.end > blockStart && text[selection.end - 1] === "\n"
      ? selection.end - 1
      : selection.end;
  const quebra = text.indexOf("\n", refEnd);
  const blockEnd = quebra === -1 ? text.length : quebra;
  const linhas = text.slice(blockStart, blockEnd).split("\n");
  const partes = linhas.map(splitLinePrefix);
  const comConteudo = partes.filter((parte) => parte.content.trim().length > 0);
  if (comConteudo.length === 0) return null;

  // Já está tudo com esta marcação? Então o clique REMOVE — é o alternar.
  const jaAplicado =
    format === "quote"
      ? comConteudo.every((parte) => parte.quote)
      : comConteudo.every(
          (parte) => parte.list === (format === "ordered_list" ? "ordered" : "bullet"),
        );

  let posicao = 0;
  const reescritas = partes.map((parte, index) => {
    const linha = linhas[index] as string;
    // Linha em branco no meio da seleção continua em branco: marcador em
    // linha vazia vira item fantasma na tela do cliente.
    if (parte.content.trim().length === 0) return linha;
    const proxima: LinePrefix =
      format === "quote"
        ? { ...parte, quote: !jaAplicado }
        : {
            ...parte,
            // Trocar de um tipo de lista para o outro SUBSTITUI o marcador —
            // empilhar "1. - item" não é lista em lugar nenhum.
            list: jaAplicado ? null : format === "ordered_list" ? "ordered" : "bullet",
          };
    // Renumera do começo: selecionar linhas soltas e numerar produziria
    // "3. 7. 9." se a numeração viesse do que estava escrito.
    if (proxima.list === "ordered") posicao += 1;
    return buildLine(proxima, posicao);
  });

  const bloco = reescritas.join("\n");
  return {
    text: text.slice(0, blockStart) + bloco + text.slice(blockEnd),
    // A seleção passa a cobrir o bloco inteiro reescrito: dá para aplicar
    // citação em cima da lista sem selecionar tudo de novo.
    start: blockStart,
    end: blockStart + bloco.length,
  };
}

/**
 * Aplica (ou remove) uma formatação sobre a seleção do composer.
 *
 * Puro de propósito, como as regras de menção: o teste cobre a regra sem
 * navegador, e o componente só cuida de onde a barra aparece.
 *
 * Devolve `null` quando não há o que fazer (seleção vazia ou só com espaço),
 * e nesse caso o campo fica exatamente como estava.
 */
export function applyComposerFormat(
  selection: ComposerSelection,
  format: ComposerFormat,
): ComposerSelection | null {
  if (selection.end <= selection.start) return null;
  if (isWrapFormat(format)) return applyWrap(selection, format);
  return applyLinePrefix(selection, format);
}

/** Se a seleção já está com esta formatação — é o botão aceso na barra. */
export function isComposerFormatActive(
  selection: ComposerSelection,
  format: ComposerFormat,
): boolean {
  if (selection.end <= selection.start) return false;
  const { text } = selection;
  if (isWrapFormat(format)) {
    let start = selection.start;
    let end = selection.end;
    while (start < end && /\s/.test(text[start] as string)) start += 1;
    while (end > start && /\s/.test(text[end - 1] as string)) end -= 1;
    if (start >= end) return false;
    const marker = WRAP_MARKERS[format];
    const inner = text.slice(start, end);
    if (inner.length > marker.length * 2 && inner.startsWith(marker) && inner.endsWith(marker)) {
      return true;
    }
    return enclosingSpan(text, start, end, format) !== null;
  }
  const blockStart = text.lastIndexOf("\n", Math.max(selection.start - 1, 0)) + 1;
  const refEnd =
    selection.end > blockStart && text[selection.end - 1] === "\n"
      ? selection.end - 1
      : selection.end;
  const quebra = text.indexOf("\n", refEnd);
  const blockEnd = quebra === -1 ? text.length : quebra;
  const partes = text
    .slice(blockStart, blockEnd)
    .split("\n")
    .map(splitLinePrefix)
    .filter((parte) => parte.content.trim().length > 0);
  if (partes.length === 0) return false;
  if (format === "quote") return partes.every((parte) => parte.quote);
  return partes.every(
    (parte) => parte.list === (format === "ordered_list" ? "ordered" : "bullet"),
  );
}

/* ------------------------------------------------------------------ *
 * Blocos de linha (lista e citação) para a exibição
 * ------------------------------------------------------------------ */

/**
 * O texto da mensagem em blocos de LINHA.
 *
 * Negrito e companhia são formatação de trecho e saem de `parseWhatsAppText`;
 * lista e citação são de linha, e sem este passo apareceriam na bolha como os
 * símbolos crus que a pessoa digitou ("> " no começo de cada linha). Botão que
 * produz símbolo que ninguém interpreta é pior do que não ter botão.
 */
export type WhatsAppBlock =
  | { type: "paragraph"; value: string }
  | { type: "quote"; value: string }
  | { type: "list"; ordered: boolean; items: { marker: string; value: string }[] };

interface ListaAberta {
  ordered: boolean;
  items: { marker: string; value: string }[];
}

export function parseWhatsAppBlocks(text: string): WhatsAppBlock[] {
  const blocos: WhatsAppBlock[] = [];
  let paragrafo: string[] = [];
  let citacao: string[] = [];
  let lista: ListaAberta | null = null;
  // Dentro de ``` nada é marcador de linha: o trecho monoespaçado pode ter
  // várias linhas, e quebrá-lo aqui faria o fechamento nunca ser encontrado.
  let dentroDeMono = false;

  const fecharParagrafo = (): void => {
    if (paragrafo.length > 0) {
      blocos.push({ type: "paragraph", value: paragrafo.join("\n") });
      paragrafo = [];
    }
  };
  const fecharCitacao = (): void => {
    if (citacao.length > 0) {
      blocos.push({ type: "quote", value: citacao.join("\n") });
      citacao = [];
    }
  };
  const fecharLista = (): void => {
    if (lista) {
      blocos.push({ type: "list", ordered: lista.ordered, items: lista.items });
      lista = null;
    }
  };
  const fecharTudo = (): void => {
    fecharParagrafo();
    fecharCitacao();
    fecharLista();
  };

  for (const linha of text.split("\n")) {
    const crases = linha.split("```").length - 1;
    if (dentroDeMono) {
      paragrafo.push(linha);
      if (crases % 2 === 1) dentroDeMono = false;
      continue;
    }
    if (crases % 2 === 1) {
      fecharCitacao();
      fecharLista();
      paragrafo.push(linha);
      dentroDeMono = true;
      continue;
    }

    const parte = splitLinePrefix(linha);
    if (parte.content.trim().length === 0) {
      fecharTudo();
      paragrafo.push(linha);
      continue;
    }
    if (parte.quote) {
      fecharParagrafo();
      fecharLista();
      // Marcador de lista dentro da citação continua sendo texto da citação:
      // aninhar lista dentro de citação não é coisa que o WhatsApp desenhe.
      citacao.push(linha.slice(linha.indexOf(">") + 1).trimStart());
      continue;
    }
    fecharCitacao();
    if (parte.list) {
      const ordered = parte.list === "ordered";
      if (lista && lista.ordered !== ordered) fecharLista();
      fecharParagrafo();
      const atual: ListaAberta = lista ?? { ordered, items: [] };
      const numero = /^[ \t]*(\d+)/.exec(linha)?.[1];
      atual.items.push({
        marker: ordered ? `${numero ?? atual.items.length + 1}.` : "•",
        value: parte.content,
      });
      lista = atual;
      continue;
    }
    fecharLista();
    paragrafo.push(linha);
  }

  fecharTudo();
  return blocos;
}

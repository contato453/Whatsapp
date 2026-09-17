"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  Bold,
  Italic,
  Code,
  List,
  ListOrdered,
  Quote,
  Strikethrough,
  type LucideIcon,
} from "lucide-react";
import {
  applyComposerFormat,
  isComposerFormatActive,
  type ComposerFormat,
} from "@azvchat/shared";
import { Button } from "@/components/ui";
import { cn } from "@/lib/utils";

/**
 * Barra de formatação flutuante do composer, no mesmo espírito da que o
 * WhatsApp Web mostra ao selecionar uma palavra.
 *
 * Ela existe porque a equipe escreve orientação técnica para cliente o dia
 * inteiro e hoje precisa digitar os símbolos na mão — ou simplesmente não
 * formata, e a mensagem chega num bloco só.
 *
 * Duas decisões que não são detalhe:
 *
 * 1. O campo continua sendo um TEXTAREA e a mensagem continua sendo texto
 *    puro com os símbolos do WhatsApp (`*negrito*`). Editor rico exigiria
 *    biblioteca nova e uma conversão de ida e volta entre HTML e a marcação —
 *    e é justamente nessa conversão que a menção ("@") e as variáveis da
 *    resposta rápida se perderiam sem ninguém perceber.
 * 2. A escrita no campo passa por `document.execCommand("insertText")` quando
 *    o navegador aceita: é o que mantém o Ctrl+Z NATIVO funcionando. Trocar o
 *    valor só pelo estado do React apaga a pilha de desfazer do campo, e a
 *    pessoa que formatou por engano perderia o texto inteiro para voltar.
 */

interface BotaoFormato {
  format: ComposerFormat;
  label: string;
  icon: LucideIcon;
  hint?: string;
}

const BOTOES: BotaoFormato[] = [
  { format: "bold", label: "Negrito", icon: Bold, hint: "Ctrl+B" },
  { format: "italic", label: "Itálico", icon: Italic, hint: "Ctrl+I" },
  { format: "strike", label: "Tachado", icon: Strikethrough },
  { format: "mono", label: "Monoespaçado", icon: Code },
  { format: "ordered_list", label: "Lista numerada", icon: ListOrdered },
  { format: "bullet_list", label: "Lista com marcadores", icon: List },
  { format: "quote", label: "Citação", icon: Quote },
];

/** Distância entre a barra e a linha selecionada. */
const GAP = 8;
/** Folga mínima até a borda da janela — a barra nunca encosta nela. */
const MARGIN = 8;

interface Posicao {
  top: number;
  left: number;
}

/**
 * Onde a seleção está NA JANELA.
 *
 * Textarea não expõe a posição do texto, então a medida sai de um clone
 * invisível com os mesmos estilos: nele o trecho antes da seleção vira um
 * `<span>`, e a posição dele é a posição da seleção. É a técnica de sempre
 * para caret em campo simples, e evita trazer biblioteca só para isso.
 */
function medirSelecao(field: HTMLTextAreaElement): DOMRect | null {
  const documento = field.ownerDocument;
  const espelho = documento.createElement("div");
  const estilo = window.getComputedStyle(field);
  for (const propriedade of Array.from(estilo)) {
    espelho.style.setProperty(propriedade, estilo.getPropertyValue(propriedade));
  }
  espelho.style.position = "absolute";
  espelho.style.visibility = "hidden";
  espelho.style.pointerEvents = "none";
  espelho.style.whiteSpace = "pre-wrap";
  espelho.style.overflowWrap = "break-word";
  espelho.style.height = "auto";
  // A largura é a do CONTEÚDO: o espelho mantém a borda e o padding copiados
  // do campo, e com `border-box` a mesma medida deixaria o texto quebrar mais
  // cedo do que quebra de verdade — a barra apontaria a linha errada.
  espelho.style.boxSizing = "content-box";
  espelho.style.width = `${
    field.clientWidth -
    parseFloat(estilo.paddingLeft || "0") -
    parseFloat(estilo.paddingRight || "0")
  }px`;
  espelho.style.top = "0";
  espelho.style.left = "-9999px";

  const antes = documento.createTextNode(field.value.slice(0, field.selectionStart));
  const alvo = documento.createElement("span");
  // Sem conteúdo o span não tem altura: seleção terminando em quebra de
  // linha mediria zero e a barra iria para o canto da tela.
  alvo.textContent = field.value.slice(field.selectionStart, field.selectionEnd) || ".";
  espelho.append(antes, alvo);
  documento.body.appendChild(espelho);

  const campo = field.getBoundingClientRect();
  const dentro = alvo.getBoundingClientRect();
  const base = espelho.getBoundingClientRect();
  espelho.remove();

  return new DOMRect(
    campo.left + (dentro.left - base.left),
    campo.top + (dentro.top - base.top) - field.scrollTop,
    dentro.width,
    dentro.height,
  );
}

export function FormatToolbar({
  fieldRef,
  value,
  disabled = false,
  suppressed = false,
  onFormat,
}: {
  fieldRef: React.RefObject<HTMLTextAreaElement | null>;
  /** O texto atual do campo — recalcula a barra a cada tecla. */
  value: string;
  disabled?: boolean;
  /**
   * Com o seletor de "/" ou de "@" aberto a barra não aparece: os dois já
   * ocupam o espaço acima do composer e disputam as mesmas teclas.
   */
  suppressed?: boolean;
  onFormat: (format: ComposerFormat) => void;
}) {
  const barraRef = useRef<HTMLDivElement | null>(null);
  const [selecao, setSelecao] = useState<{ start: number; end: number } | null>(null);
  const [posicao, setPosicao] = useState<Posicao | null>(null);
  const [dispensada, setDispensada] = useState(false);

  const visivel = !disabled && !suppressed && !dispensada && selecao !== null;

  /** Lê a seleção do campo; vazia (ou só espaço) não abre a barra. */
  const lerSelecao = useCallback(() => {
    const field = fieldRef.current;
    // Campo sem foco não tem seleção que interesse: é o "clicar fora" que
    // fecha a barra. O clique nos botões dela não cai aqui porque o
    // `mousedown` deles impede a perda de foco.
    if (!field || field.ownerDocument.activeElement !== field) {
      setSelecao(null);
      return;
    }
    const { selectionStart: start, selectionEnd: end } = field;
    if (start === null || end === null || end <= start) {
      setSelecao(null);
      return;
    }
    if (field.value.slice(start, end).trim().length === 0) {
      setSelecao(null);
      return;
    }
    setSelecao({ start, end });
  }, [fieldRef]);

  useEffect(() => {
    const documento = document;
    // `selectionchange` cobre teclado e mouse de uma vez; `mouseup` fecha o
    // caso de soltar o botão fora do campo, em que o evento não dispara.
    const aoMudar = (): void => lerSelecao();
    documento.addEventListener("selectionchange", aoMudar);
    documento.addEventListener("mouseup", aoMudar);
    return () => {
      documento.removeEventListener("selectionchange", aoMudar);
      documento.removeEventListener("mouseup", aoMudar);
    };
  }, [lerSelecao]);

  // Texto novo (tecla, resposta rápida inserida, rascunho restaurado) desfaz
  // a dispensa: é outra seleção, não a que a pessoa fechou com Esc.
  useEffect(() => {
    setDispensada(false);
    lerSelecao();
  }, [value, lerSelecao]);

  useEffect(() => {
    if (!visivel) return;
    const aoTeclar = (event: KeyboardEvent): void => {
      if (event.key === "Escape") setDispensada(true);
    };
    const aoClicar = (event: MouseEvent): void => {
      const alvo = event.target as Node | null;
      if (!alvo) return;
      if (barraRef.current?.contains(alvo)) return;
      if (fieldRef.current?.contains(alvo)) return;
      setDispensada(true);
    };
    document.addEventListener("keydown", aoTeclar);
    document.addEventListener("mousedown", aoClicar);
    return () => {
      document.removeEventListener("keydown", aoTeclar);
      document.removeEventListener("mousedown", aoClicar);
    };
  }, [visivel, fieldRef]);

  /**
   * A barra é `fixed` para nunca ser cortada pelo scroll da conversa nem pelo
   * `overflow` das colunas da Inbox. Em troca, a posição precisa ser refeita
   * quando a página rola ou a janela muda de tamanho.
   */
  const reposicionar = useCallback(() => {
    const field = fieldRef.current;
    const barra = barraRef.current;
    if (!field || !barra) return;
    const alvo = medirSelecao(field);
    if (!alvo) return;
    const largura = barra.offsetWidth;
    const altura = barra.offsetHeight;
    let top = alvo.top - altura - GAP;
    // Seleção colada no topo da janela: a barra desce, em vez de sair da
    // área visível (onde ninguém a alcançaria).
    if (top < MARGIN) top = alvo.bottom + GAP;
    const maximo = window.innerHeight - altura - MARGIN;
    if (top > maximo) top = Math.max(MARGIN, maximo);
    const centro = alvo.left + alvo.width / 2 - largura / 2;
    const left = Math.min(
      Math.max(centro, MARGIN),
      Math.max(MARGIN, window.innerWidth - largura - MARGIN),
    );
    setPosicao({ top, left });
  }, [fieldRef]);

  // Enquanto a posição não foi medida a barra fica invisível (`opacity-0`),
  // senão ela piscaria no canto superior esquerdo antes de assentar.
  useEffect(() => {
    if (!visivel) {
      setPosicao(null);
      return;
    }
    reposicionar();
  }, [visivel, selecao, reposicionar]);

  useEffect(() => {
    if (!visivel) return;
    const aoMover = (): void => reposicionar();
    window.addEventListener("scroll", aoMover, true);
    window.addEventListener("resize", aoMover);
    return () => {
      window.removeEventListener("scroll", aoMover, true);
      window.removeEventListener("resize", aoMover);
    };
  }, [visivel, reposicionar]);

  if (!visivel || !selecao) return null;

  const estado = { text: value, start: selecao.start, end: selecao.end };

  return (
    <div
      ref={barraRef}
      role="toolbar"
      aria-label="Formatação da mensagem"
      style={{
        top: posicao?.top ?? -9999,
        left: posicao?.left ?? -9999,
        // Em tela estreita a barra quebra em duas linhas em vez de estourar
        // para fora da janela.
        maxWidth: `calc(100vw - ${MARGIN * 2}px)`,
      }}
      className={cn(
        "fixed z-40 flex flex-wrap items-center gap-0.5 rounded-xl border border-slate-200 bg-white p-1 shadow-lg",
        posicao ? "opacity-100" : "opacity-0",
      )}
    >
      {BOTOES.map((botao) => {
        const ativo = isComposerFormatActive(estado, botao.format);
        const Icone = botao.icon;
        return (
          <Button
            key={botao.format}
            type="button"
            variant="ghost"
            size="sm"
            aria-pressed={ativo}
            title={botao.hint ? `${botao.label} (${botao.hint})` : botao.label}
            // `preventDefault` no mousedown mantém o foco (e a seleção) no
            // campo: sem ele o clique tira o foco e não há o que formatar.
            onMouseDown={(event) => {
              event.preventDefault();
              onFormat(botao.format);
            }}
            className={cn("h-8 w-8 px-0", ativo && "bg-brand-50 text-brand-700")}
          >
            <Icone className="h-4 w-4" />
            <span className="sr-only">{botao.label}</span>
          </Button>
        );
      })}
    </div>
  );
}

/**
 * Aplica a formatação no campo e devolve o texto resultante (ou `null` quando
 * não havia o que fazer). Quem grava o rascunho continua sendo o composer —
 * aqui só se escreve no campo e se recoloca a seleção.
 */
export function applyFormatToField(
  field: HTMLTextAreaElement,
  format: ComposerFormat,
): string | null {
  const { selectionStart: start, selectionEnd: end, value } = field;
  const resultado = applyComposerFormat({ text: value, start, end }, format);
  if (!resultado || resultado.text === value) return null;

  // Reescreve só o trecho que mudou, pelo caminho que alimenta a pilha de
  // desfazer do navegador. Comparar as pontas evita reescrever a mensagem
  // inteira quando só uma palavra ganhou dois asteriscos.
  let inicio = 0;
  while (
    inicio < value.length &&
    inicio < resultado.text.length &&
    value[inicio] === resultado.text[inicio]
  ) {
    inicio += 1;
  }
  let fimAntigo = value.length;
  let fimNovo = resultado.text.length;
  while (
    fimAntigo > inicio &&
    fimNovo > inicio &&
    value[fimAntigo - 1] === resultado.text[fimNovo - 1]
  ) {
    fimAntigo -= 1;
    fimNovo -= 1;
  }

  field.focus();
  field.setSelectionRange(inicio, fimAntigo);
  const trecho = resultado.text.slice(inicio, fimNovo);
  let escreveu = false;
  try {
    // Depreciado, mas é o único caminho que preserva o Ctrl+Z do campo. Em
    // navegador que recuse, o composer grava pelo estado do React e só o
    // desfazer nativo deixa de valer.
    escreveu = document.execCommand("insertText", false, trecho);
  } catch {
    escreveu = false;
  }
  if (!escreveu) field.value = resultado.text;
  field.setSelectionRange(resultado.start, resultado.end);
  return resultado.text;
}

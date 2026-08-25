"use client";

import { useCallback, useLayoutEffect, useRef } from "react";

/**
 * Tolerância, em pixels, para considerar que a pessoa está "no fim" da
 * janela. O valor exato de `scrollHeight - scrollTop - clientHeight` quase
 * nunca bate 0 por arredondamento de layout entre navegadores.
 */
const BOTTOM_THRESHOLD_PX = 48;

/**
 * Decide e aplica a posição de rolagem da janela de mensagens da Inbox.
 *
 * A regra é uma só, decidida pela casa: toda ABERTURA de conversa cola no
 * fim, sempre — não existe (e não deve nascer) âncora em mensagem não lida
 * nem retomada da posição de uma visita anterior. Verificado no código: essa
 * âncora nunca existiu aqui; o defeito real era outro (ver abaixo), e esta
 * decisão fecha a porta para alguém reintroduzir a ideia depois.
 *
 * O QUE CAUSAVA O DEFEITO: a rolagem para o fim reagia só ao tamanho da
 * lista de mensagens, mas a janela onde ela mora só existe no DOM depois que
 * o DETALHE da conversa (mais pesado — notas, participantes, fixados)
 * termina de carregar, e os dois pedidos disputam uma corrida. Quando as
 * mensagens chegavam primeiro (o caso comum), a rolagem rodava contra um
 * alvo que ainda não existia, não fazia nada, e nada a chamava de novo
 * quando a janela finalmente montava — a tela ficava "onde caiu" (no topo).
 *
 * A CORREÇÃO usa `ref` de callback em vez de efeito amarrado a uma variável
 * de "pronto": o instante em que o contêiner aparece no DOM já é o gatilho
 * de rolagem, então não importa qual dos dois pedidos (detalhe ou
 * mensagens) chega primeiro — o alvo, quando existe, sempre recebe a
 * rolagem. `useLayoutEffect` cobre o caso de a janela já existir e só a
 * mensagem chegar depois (a outra ordem da corrida).
 *
 * FICAR "PRESO AO FIM" é um estado, não um evento único: nasce `true` a
 * cada conversa aberta (inclusive reabrindo uma já visitada — sem retomar
 * posição), some quando a pessoa rola para cima com a própria mão, e volta
 * a valer se ela rolar de volta perto do fim. É esse estado que decide se
 * mensagem nova (ou mídia que termina de carregar e empurra a bolha) puxa a
 * tela ou não: só puxa para quem já estava lá.
 */
export function useMessageScroll(conversationId: string | undefined, itemCount: number) {
  const containerNodeRef = useRef<HTMLDivElement | null>(null);
  const contentObserverRef = useRef<ResizeObserver | null>(null);
  const stuckRef = useRef(true);
  const openedForRef = useRef<string | undefined>(undefined);

  // Nova conversa (ou primeira abertura): a próxima rolagem parte sempre
  // presa ao fim. Mutar o ref direto no corpo do componente, comparando com
  // a última conversa vista, é o mesmo padrão já usado em
  // `use-unread-counts.ts` — não dispara re-render e é idempotente.
  if (openedForRef.current !== conversationId) {
    openedForRef.current = conversationId;
    stuckRef.current = true;
  }

  const scrollToBottom = useCallback(() => {
    const el = containerNodeRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, []);

  /** Anexado ao contêiner que rola. É o gatilho da abertura: dispara no
   *  instante em que a janela aparece no DOM, sem esperar efeito nenhum. */
  const containerRef = useCallback(
    (node: HTMLDivElement | null) => {
      containerNodeRef.current = node;
      if (node && stuckRef.current) {
        node.scrollTop = node.scrollHeight;
      }
    },
    [],
  );

  /** Anexado ao bloco que envolve as bolhas (altura de conteúdo, e não a
   *  altura fixa do contêiner, que `overflow-y-auto` não denuncia). Mídia
   *  que termina de baixar depois do texto (imagem, vídeo — ver o `porquê`
   *  em `message-bubble.tsx`) muda essa altura sem mudar `itemCount`; sem
   *  observá-la, a conversa abre certa e escorrega meio segundo depois. */
  const contentRef = useCallback((node: HTMLDivElement | null) => {
    contentObserverRef.current?.disconnect();
    contentObserverRef.current = null;
    if (node && typeof ResizeObserver !== "undefined") {
      const observer = new ResizeObserver(() => {
        if (stuckRef.current) scrollToBottom();
      });
      observer.observe(node);
      contentObserverRef.current = observer;
    }
  }, [scrollToBottom]);

  // Cobre a outra ordem da corrida (janela já montada, mensagem chega
  // depois) e mensagem nova chegando durante o uso — sempre condicionado a
  // `stuckRef`, nunca incondicional: é o que impede a tela de pular para
  // quem está lendo um trecho antigo.
  useLayoutEffect(() => {
    if (stuckRef.current) scrollToBottom();
  }, [itemCount, conversationId, scrollToBottom]);

  /** No `onScroll` do contêiner: só a própria pessoa, rolando com a mão,
   *  decide se continua presa ao fim. */
  const onScroll = useCallback(() => {
    const el = containerNodeRef.current;
    if (!el) return;
    stuckRef.current = el.scrollHeight - el.scrollTop - el.clientHeight <= BOTTOM_THRESHOLD_PX;
  }, []);

  /** Chamado pelos saltos da busca (`.../messages/around`) antes de trocar
   *  a janela de mensagens carregada: aquele caminho ancora numa mensagem
   *  específica, nunca no fim, e sem isso a troca da lista faria o efeito
   *  acima (achando que a pessoa está presa ao fim) brigar com o
   *  `scrollIntoView` da busca. */
  const suspendStick = useCallback(() => {
    stuckRef.current = false;
  }, []);

  return { containerRef, contentRef, onScroll, suspendStick };
}

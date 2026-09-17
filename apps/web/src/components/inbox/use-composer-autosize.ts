"use client";

import { useEffect, useRef } from "react";

/**
 * O campo de mensagem cresce sozinho conforme o texto, e ainda aceita ser
 * esticado na mão pela alça do canto.
 *
 * ARRASTOU, MANDA QUEM ARRASTOU. É a regra que faz as duas coisas conviverem:
 * no instante em que a pessoa estica o campo, o crescimento automático
 * DESLIGA para aquele campo. Sem isso, a altura escolhida na mão sumiria na
 * tecla seguinte — o automático recalcularia tudo e a pessoa veria o campo
 * "voltando sozinho", que é o tipo de defeito que ninguém sabe descrever e
 * todo mundo culpa o sistema.
 *
 * O automático volta quando o rascunho é enviado (o campo esvazia) ou quando
 * se troca de conversa: aí é outra mensagem, e a altura de antes não tem mais
 * relação com o que vai ser escrito.
 *
 * Nada disso é preferência gravada: é estado de um campo em uma aba, como a
 * posição do cursor. Guardar em `User` ou no `localStorage` seria transformar
 * um arrasto de meio segundo em cadastro.
 */

/**
 * Teto do crescimento automático, em pixels (cerca de 10 linhas). Daqui para
 * cima o texto rola por dentro, senão uma mensagem longa comeria a conversa
 * inteira e a pessoa perderia de vista o que o cliente escreveu.
 */
const MAX_AUTO_HEIGHT = 240;

export function useComposerAutosize(
  fieldRef: React.RefObject<HTMLTextAreaElement | null>,
  /** O texto atual — é o que dispara o recálculo a cada tecla. */
  value: string,
  /** Conversa aberta: trocar de conversa devolve o campo ao automático. */
  resetKey: string | null | undefined,
): void {
  const manualRef = useRef(false);
  /** A última altura que NÓS escrevemos, para separar do que a pessoa arrastou. */
  const alturaRef = useRef<number | null>(null);
  const larguraRef = useRef<number | null>(null);

  useEffect(() => {
    const field = fieldRef.current;
    if (!field) return;

    const ajustar = (): void => {
      if (manualRef.current) return;
      // "auto" antes de medir: sem zerar, o `scrollHeight` nunca diminui e o
      // campo só cresceria, nunca encolheria ao apagar texto.
      field.style.height = "auto";
      const alvo = Math.min(field.scrollHeight, MAX_AUTO_HEIGHT);
      field.style.height = `${alvo}px`;
      alturaRef.current = field.offsetHeight;
      larguraRef.current = field.offsetWidth;
    };

    ajustar();

    // ResizeObserver é o único jeito de saber que a pessoa usou a alça: o
    // arrasto não dispara evento nenhum de React, ele escreve direto no
    // style do elemento.
    const observer = new ResizeObserver(() => {
      const atual = fieldRef.current;
      if (!atual) return;
      // Mudou de LARGURA (janela, painel lateral, barra recolhida)? O texto
      // reflui e a altura calculada envelhece — recalcula, e isso não é
      // arrasto. O rAF evita o aviso de laço do próprio observer.
      if (larguraRef.current !== null && atual.offsetWidth !== larguraRef.current) {
        larguraRef.current = atual.offsetWidth;
        if (!manualRef.current) window.requestAnimationFrame(ajustar);
        return;
      }
      if (manualRef.current) return;
      // Altura diferente da que escrevemos = veio da alça.
      if (alturaRef.current !== null && Math.abs(atual.offsetHeight - alturaRef.current) > 1) {
        manualRef.current = true;
      }
    });
    observer.observe(field);
    return () => observer.disconnect();
  }, [fieldRef, value]);

  // Enviou (o campo esvaziou) ou trocou de conversa: o automático volta e a
  // altura esticada é descartada.
  useEffect(() => {
    if (value !== "") return;
    manualRef.current = false;
    const field = fieldRef.current;
    if (field) field.style.height = "";
  }, [fieldRef, value]);

  useEffect(() => {
    manualRef.current = false;
    const field = fieldRef.current;
    if (field) field.style.height = "";
  }, [fieldRef, resetKey]);
}

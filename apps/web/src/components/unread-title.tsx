"use client";

import { useEffect, useRef, useState } from "react";
import { RealtimeEvents } from "@azvchat/shared";
import { useAuth } from "@/lib/auth-context";
import { useSocket } from "@/lib/socket-context";
import type { MessageDto } from "@/lib/types";

/**
 * Ritmo do piscar. Um segundo e pouco é o suficiente para o olho pegar o
 * movimento na barra de abas sem o título virar estroboscópio.
 */
const BLINK_MS = 1_200;

/**
 * Título da aba piscando com quantas conversas receberam mensagem enquanto
 * a aba esteve fora de foco.
 *
 * Existe pelo mesmo motivo do som, e cobre o caso que o som não cobre: fone
 * tirado, som em "Nenhum", volume do sistema no mudo. A barra de abas fica
 * visível o tempo todo, mesmo com o navegador atrás do editor de planilha.
 *
 * Conta **conversas**, não mensagens: dez mensagens do mesmo grupo são um
 * assunto só, e "(1)" descreve melhor o que espera a pessoa do que "(10)".
 *
 * O número é do que chegou desde que a aba perdeu o foco, não o
 * `unreadCount` do banco — saber esse exigiria uma consulta nova a cada
 * carregamento, e o aviso aqui é sobre o que aconteceu enquanto ninguém
 * olhava. Voltar o foco zera: o objetivo do piscar é trazer a pessoa de
 * volta, e quem voltou já tem a lista da Inbox com a contagem de verdade.
 */
export function UnreadTitle() {
  const socket = useSocket();
  const { user } = useAuth();
  const [count, setCount] = useState(0);
  const conversationsRef = useRef<Set<string>>(new Set());
  const baseTitleRef = useRef<string>("");

  // Título original, capturado uma vez: nenhuma rota do sistema define
  // metadata própria, então ele é o mesmo em todas as telas.
  useEffect(() => {
    baseTitleRef.current = document.title;
  }, []);

  useEffect(() => {
    if (!socket || !user) return undefined;
    const onMessageNew = (payload: { message: MessageDto }) => {
      // Mesmo gatilho do som: só o que chegou de fora, e só dentro do
      // recorte de acesso que o socket já entrega a esta pessoa.
      if (payload.message.direction !== "inbound") return;
      // Aba em foco não pisca: a pessoa está aqui, e título piscando na
      // frente de quem já está olhando é só barulho.
      if (document.hasFocus()) return;
      const seen = conversationsRef.current;
      if (seen.has(payload.message.conversationId)) return;
      seen.add(payload.message.conversationId);
      setCount(seen.size);
    };
    socket.on(RealtimeEvents.MessageNew, onMessageNew);
    return () => {
      socket.off(RealtimeEvents.MessageNew, onMessageNew);
    };
  }, [socket, user]);

  // Voltou o foco: o aviso cumpriu o papel e sai de cena.
  useEffect(() => {
    const clear = () => {
      conversationsRef.current.clear();
      setCount(0);
    };
    window.addEventListener("focus", clear);
    return () => window.removeEventListener("focus", clear);
  }, []);

  // Sair do sistema não pode deixar a aba piscando na tela de login.
  useEffect(() => {
    if (user) return;
    conversationsRef.current.clear();
    setCount(0);
  }, [user]);

  useEffect(() => {
    const base = baseTitleRef.current;
    if (count === 0) {
      if (base) document.title = base;
      return undefined;
    }
    // Contador na frente do título, como fazem Gmail e WhatsApp Web: é a
    // parte que sobrevive quando a aba está estreita e o texto é cortado.
    const alert = `(${count}) ${base}`;
    // Primeiro quadro imediato: esperar o intervalo atrasaria o aviso em
    // mais de um segundo justamente na mensagem que motivou o piscar.
    document.title = alert;
    let showingAlert = true;
    const timer = window.setInterval(() => {
      showingAlert = !showingAlert;
      document.title = showingAlert ? alert : base;
    }, BLINK_MS);
    return () => {
      window.clearInterval(timer);
      if (base) document.title = base;
    };
  }, [count]);

  return null;
}

"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";
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
 * Título da aba piscando com quantas conversas receberam mensagem que
 * ninguém foi ver ainda.
 *
 * Existe pelo mesmo motivo do som, e cobre o caso que o som não cobre: fone
 * tirado, som em "Nenhum", volume do sistema no mudo. A barra de abas fica
 * visível o tempo todo, mesmo com o navegador atrás do editor de planilha.
 *
 * Conta **conversas**, não mensagens: dez mensagens do mesmo grupo são um
 * assunto só, e "(1)" descreve melhor o que espera a pessoa do que "(10)".
 *
 * O número é do que chegou desde a última passada pela Inbox, não o
 * `unreadCount` do banco — saber esse exigiria consulta nova a cada
 * carregamento para dizer o que a lista da Inbox já diz.
 */
export function UnreadTitle() {
  const socket = useSocket();
  const { user } = useAuth();
  const pathname = usePathname();
  const [count, setCount] = useState(0);
  const conversationsRef = useRef<Set<string>>(new Set());
  const baseTitleRef = useRef<string>("");
  const pathnameRef = useRef(pathname);

  const clear = useCallback(() => {
    conversationsRef.current.clear();
    setCount(0);
  }, []);

  /**
   * Estar na Inbox com a aba em foco é o único jeito de a pessoa realmente
   * ver o que chegou. Sem exigir o foco, a aba esquecida na Inbox em segundo
   * plano — que é justamente o caso mais comum — nunca acumularia nada.
   */
  const isWatchingInbox = useCallback(
    () => document.hasFocus() && pathnameRef.current.startsWith("/inbox"),
    [],
  );

  // Título original, capturado uma vez: nenhuma rota do sistema define
  // metadata própria, então ele é o mesmo em todas as telas.
  useEffect(() => {
    baseTitleRef.current = document.title;
  }, []);

  // Abrir a Inbox zera. Trocar de tela para o Dashboard, não: o aviso
  // continua até a pessoa ir olhar as conversas.
  useEffect(() => {
    pathnameRef.current = pathname;
    if (isWatchingInbox()) clear();
  }, [pathname, clear, isWatchingInbox]);

  // Voltar para a aba já parada na Inbox conta como ter ido olhar.
  useEffect(() => {
    const onFocus = () => {
      if (isWatchingInbox()) clear();
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [clear, isWatchingInbox]);

  useEffect(() => {
    if (!socket || !user) return undefined;
    const onMessageNew = (payload: { message: MessageDto }) => {
      // Mesmo gatilho do som: só o que chegou de fora, e só dentro do
      // recorte de acesso que o socket já entrega a esta pessoa.
      if (payload.message.direction !== "inbound") return;
      // Olhando a Inbox agora não acumula: a conversa sobe na lista com o
      // badge de não lidas na frente da pessoa, o título seria redundante.
      if (isWatchingInbox()) return;
      const seen = conversationsRef.current;
      if (seen.has(payload.message.conversationId)) return;
      seen.add(payload.message.conversationId);
      setCount(seen.size);
    };
    socket.on(RealtimeEvents.MessageNew, onMessageNew);
    return () => {
      socket.off(RealtimeEvents.MessageNew, onMessageNew);
    };
  }, [socket, user, isWatchingInbox]);

  // Sair do sistema não pode deixar a aba piscando na tela de login.
  useEffect(() => {
    if (!user) clear();
  }, [user, clear]);

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

"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { RealtimeEvents, type ConversationReadPayload } from "@azvchat/shared";
import { useSocket } from "@/lib/socket-context";
import {
  bumpUnreadCount,
  setUnreadCount,
  type UnreadCounts,
} from "@/lib/unread";

/**
 * Contadores de não lidas desta pessoa, vivos.
 *
 * Fica fora do `inbox-shell` porque é estado com regra própria: o mapa vem
 * da lista, sobe sozinho quando chega mensagem e só zera pelo evento
 * `conversation:read` — que a API manda para a sala pessoal, e por isso
 * chega também na SEGUNDA ABA da mesma pessoa (marcar lido num lugar reflete
 * no outro), sem nunca tocar na tela de mais ninguém.
 *
 * O `ref` existe porque os manipuladores de socket do shell precisam do
 * valor atual sem entrar na lista de dependências do efeito — senão os
 * listeners seriam reassinados a cada mensagem recebida.
 */
export function useUnreadCounts(): {
  counts: UnreadCounts;
  countsRef: React.RefObject<UnreadCounts>;
  replaceAll: (counts: UnreadCounts) => void;
  bump: (conversationId: string) => void;
  set: (conversationId: string, count: number) => void;
} {
  const socket = useSocket();
  const [counts, setCounts] = useState<UnreadCounts>({});
  const countsRef = useRef<UnreadCounts>(counts);
  countsRef.current = counts;

  const replaceAll = useCallback((next: UnreadCounts) => setCounts(next), []);
  const bump = useCallback(
    (conversationId: string) => setCounts((current) => bumpUnreadCount(current, conversationId)),
    [],
  );
  const set = useCallback(
    (conversationId: string, count: number) =>
      setCounts((current) => setUnreadCount(current, conversationId, count)),
    [],
  );

  useEffect(() => {
    if (!socket) return;
    const onRead = (payload: ConversationReadPayload) =>
      set(payload.conversationId, payload.unreadCount);
    socket.on(RealtimeEvents.ConversationRead, onRead);
    return () => {
      socket.off(RealtimeEvents.ConversationRead, onRead);
    };
  }, [socket, set]);

  return { counts, countsRef, replaceAll, bump, set };
}

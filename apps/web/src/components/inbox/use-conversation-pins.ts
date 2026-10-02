"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  RealtimeEvents,
  type ConversationPinMap,
  type ConversationPinsPayload,
} from "@azvchat/shared";
import { useSocket } from "@/lib/socket-context";

/**
 * As conversas que ESTA pessoa fixou no topo da lista, vivas.
 *
 * Fica fora do `inbox-shell` pelo mesmo motivo do contador de não lidas: é
 * estado pessoal com regra própria. O mapa vem semeado pela resposta da
 * lista e daí em diante quem o mantém em dia é `conversation:pins`, que a
 * API manda para a sala PESSOAL — e por isso fixar numa aba reflete na
 * segunda aba da mesma pessoa, sem nunca reordenar a lista de mais ninguém.
 */
export function useConversationPins(): {
  pinned: ConversationPinMap;
  pinnedRef: React.RefObject<ConversationPinMap>;
  replaceAll: (next: ConversationPinMap) => void;
  remove: (conversationId: string) => void;
} {
  const socket = useSocket();
  const [pinned, setPinned] = useState<ConversationPinMap>({});
  const pinnedRef = useRef<ConversationPinMap>(pinned);
  pinnedRef.current = pinned;

  const replaceAll = useCallback((next: ConversationPinMap) => setPinned(next), []);
  // Arquivar desafixa no servidor para todo mundo; a tela só acompanha, sem
  // esperar o próximo carregamento da lista.
  const remove = useCallback(
    (conversationId: string) =>
      setPinned((current) => {
        if (current[conversationId] === undefined) return current;
        const next = { ...current };
        delete next[conversationId];
        return next;
      }),
    [],
  );

  useEffect(() => {
    if (!socket) return;
    const onPins = (payload: ConversationPinsPayload) => replaceAll(payload.pinned);
    socket.on(RealtimeEvents.ConversationPins, onPins);
    return () => {
      socket.off(RealtimeEvents.ConversationPins, onPins);
    };
  }, [socket, replaceAll]);

  return { pinned, pinnedRef, replaceAll, remove };
}

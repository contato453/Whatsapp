"use client";

import { useCallback, useEffect, useState } from "react";
import {
  RealtimeEvents,
  hasConversationAutomation,
  type ConversationAutomationDto,
  type ConversationAutomationPayload,
} from "@azvchat/shared";
import { useSocket } from "@/lib/socket-context";

export type ConversationAutomationMap = Record<string, ConversationAutomationDto>;

/**
 * Quais conversas estão no automático agora (IA ou fluxo), vivas.
 *
 * Fica fora do `inbox-shell` pelo mesmo motivo do contador de não lidas:
 * é estado com regra própria, e aquele arquivo já passa de 2.000 linhas. O
 * mapa vem semeado pela resposta da lista — uma consulta para a página
 * inteira — e daí em diante quem o mantém em dia é `conversation:automation`,
 * que chega para TODA conversa visível, e não só para a aberta: o chip
 * precisa acender no card de quem nem clicou nele.
 */
export function useConversationAutomation(): {
  automation: ConversationAutomationMap;
  replaceAll: (next: ConversationAutomationMap) => void;
} {
  const socket = useSocket();
  const [automation, setAutomation] = useState<ConversationAutomationMap>({});

  const replaceAll = useCallback(
    (next: ConversationAutomationMap) => setAutomation(next ?? {}),
    [],
  );

  useEffect(() => {
    if (!socket) return;
    const onAutomation = (payload: ConversationAutomationPayload) => {
      setAutomation((current) => {
        // Estado vazio SAI do mapa em vez de virar linha nula: ausência já
        // significa "nada automático aqui" (é assim que a lista chega), e
        // guardar o encerrado faria o mapa crescer com o dia de trabalho.
        if (!hasConversationAutomation(payload.automation)) {
          if (!current[payload.conversationId]) return current;
          const next = { ...current };
          delete next[payload.conversationId];
          return next;
        }
        return { ...current, [payload.conversationId]: payload.automation };
      });
    };
    socket.on(RealtimeEvents.ConversationAutomation, onAutomation);
    return () => {
      socket.off(RealtimeEvents.ConversationAutomation, onAutomation);
    };
  }, [socket]);

  return { automation, replaceAll };
}

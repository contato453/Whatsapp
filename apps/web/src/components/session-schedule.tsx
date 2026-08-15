"use client";

import { useEffect, useState } from "react";
import { Clock } from "lucide-react";
import {
  loginScheduleWarning,
  RealtimeEvents,
  type SessionClosedPayload,
  type SessionClosingPayload,
} from "@azvchat/shared";
import { LOGIN_REASON_SCHEDULE, setToken } from "@/lib/api";
import { useSocket } from "@/lib/socket-context";

/**
 * Aviso de fechamento do horário de uso, e saída quando ele chega.
 *
 * A API manda os dois eventos só para quem a restrição alcança (quem não é
 * supervisor, com a restrição ligada), então aqui não se decide nada sobre
 * papel: quem recebeu, é com quem é. Repetir a regra no frontend só criaria
 * uma segunda versão dela para ficar desatualizada.
 *
 * O aviso chega de novo a cada minuto e a contagem vem pronta do servidor —
 * a aba não mantém relógio próprio, que erraria justamente quando o
 * navegador dorme o timer da aba em segundo plano.
 */
export function SessionSchedule() {
  const socket = useSocket();
  const [closing, setClosing] = useState<SessionClosingPayload | null>(null);

  useEffect(() => {
    if (!socket) return;

    const onClosing = (payload: SessionClosingPayload) => setClosing(payload);
    const onClosed = (payload: SessionClosedPayload) => {
      // A sessão já não vale no servidor; aqui é só não deixar a tela
      // congelada mostrando conversa que ninguém mais pode responder.
      setToken(null);
      window.location.href = `/login?motivo=${LOGIN_REASON_SCHEDULE}&aviso=${encodeURIComponent(
        payload.message,
      )}`;
    };

    socket.on(RealtimeEvents.SessionClosing, onClosing);
    socket.on(RealtimeEvents.SessionClosed, onClosed);
    return () => {
      socket.off(RealtimeEvents.SessionClosing, onClosing);
      socket.off(RealtimeEvents.SessionClosed, onClosed);
    };
  }, [socket]);

  if (!closing) return null;

  return (
    <div
      role="status"
      className="pointer-events-none fixed inset-x-0 top-0 z-50 flex justify-center px-4 py-3"
    >
      <div className="pointer-events-auto flex items-center gap-2.5 rounded-full border border-amber-200 bg-amber-50 px-4 py-2 text-sm font-medium text-amber-800 shadow-lg">
        <Clock className="h-4 w-4 shrink-0" />
        <span>
          {loginScheduleWarning(closing.minutesLeft)} Encerra às {closing.closesAt}. Salve o que
          estiver fazendo.
        </span>
      </div>
    </div>
  );
}

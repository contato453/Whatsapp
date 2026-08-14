"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { PhoneCall, Video, X } from "lucide-react";
import { RealtimeEvents, type CallIncomingPayload } from "@azvchat/shared";
import { useAuth } from "@/lib/auth-context";
import { useSocket } from "@/lib/socket-context";

/** Uma chamada toca por cerca de 30s; o aviso fica um pouco mais. */
const ALERT_TTL_MS = 45_000;

interface CallAlert extends CallIncomingPayload {
  key: string;
}

/**
 * Aviso de chamada recebida, visível em qualquer tela do sistema.
 *
 * O sistema não atende nem rejeita a ligação — o telefone continua tocando
 * normalmente. Este aviso existe para o atendente saber na hora.
 */
export function CallAlerts() {
  const socket = useSocket();
  const { user } = useAuth();
  const router = useRouter();
  const [alerts, setAlerts] = useState<CallAlert[]>([]);

  const dismiss = useCallback((key: string) => {
    setAlerts((current) => current.filter((alert) => alert.key !== key));
  }, []);

  useEffect(() => {
    if (!socket || !user) return;
    const onCall = (payload: CallIncomingPayload) => {
      // Com responsável definido, avisa só quem responde pela conversa.
      // Sem responsável, avisa todo mundo para a ligação não passar em branco.
      if (payload.assignedUserId && payload.assignedUserId !== user.id) return;
      const key = `${payload.conversationId}:${payload.at}`;
      setAlerts((current) =>
        current.some((alert) => alert.key === key) ? current : [...current, { ...payload, key }],
      );
      window.setTimeout(() => dismiss(key), ALERT_TTL_MS);

      // Aviso do sistema operacional quando a aba está em segundo plano.
      if (typeof Notification !== "undefined" && Notification.permission === "granted") {
        new Notification(`Chamada de ${payload.callerName ?? payload.conversationTitle}`, {
          body: "Ligação tocando no WhatsApp agora.",
          tag: key,
        });
      }
    };
    socket.on(RealtimeEvents.CallIncoming, onCall);
    return () => {
      socket.off(RealtimeEvents.CallIncoming, onCall);
    };
  }, [socket, user, dismiss]);

  // Pede a permissão uma vez; se negada, o aviso na tela continua valendo.
  useEffect(() => {
    if (typeof Notification !== "undefined" && Notification.permission === "default") {
      void Notification.requestPermission().catch(() => undefined);
    }
  }, []);

  if (alerts.length === 0) return null;

  return (
    <div className="pointer-events-none fixed bottom-4 right-4 z-[60] flex flex-col gap-2">
      {alerts.map((alert) => (
        <div
          key={alert.key}
          className="pointer-events-auto flex w-80 items-start gap-3 rounded-xl border border-emerald-200 bg-white p-3 shadow-lg"
        >
          <div className="flex h-9 w-9 shrink-0 animate-pulse items-center justify-center rounded-full bg-emerald-100 text-emerald-700">
            {alert.isVideo ? <Video className="h-4 w-4" /> : <PhoneCall className="h-4 w-4" />}
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold text-slate-900">
              {alert.isVideo ? "Chamada de vídeo" : "Chamada"} recebida
            </p>
            <p className="truncate text-xs text-slate-600">
              {alert.callerName ?? alert.conversationTitle}
              {alert.callerPhone && <span className="text-slate-400"> · +{alert.callerPhone}</span>}
            </p>
            {alert.isGroup && (
              <p className="truncate text-[11px] text-slate-400">no grupo {alert.conversationTitle}</p>
            )}
            <button
              onClick={() => {
                dismiss(alert.key);
                router.push(`/inbox/${alert.conversationId}`);
              }}
              className="mt-1.5 text-xs font-medium text-brand-600 hover:text-brand-700"
            >
              Abrir conversa
            </button>
          </div>
          <button
            onClick={() => dismiss(alert.key)}
            aria-label="Dispensar aviso"
            className="rounded-lg p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      ))}
    </div>
  );
}

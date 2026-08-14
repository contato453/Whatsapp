"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { PhoneCall, Video } from "lucide-react";
import { RealtimeEvents, type CallIncomingPayload } from "@azvchat/shared";
import { useAuth } from "@/lib/auth-context";
import { useSocket } from "@/lib/socket-context";
import { formatPhone } from "@/lib/utils";
import { Button } from "@/components/ui";

/** Uma chamada toca por cerca de 30s; o aviso fica um pouco mais. */
const ALERT_TTL_MS = 45_000;

interface CallAlert extends CallIncomingPayload {
  key: string;
}

/**
 * Aviso de chamada recebida, em pop-up no centro da tela.
 *
 * O sistema não atende nem rejeita a ligação — o telefone continua tocando
 * normalmente. Este aviso existe para o atendente saber na hora, e por isso
 * interrompe: uma ligação tocando tem cerca de 30 segundos de vida.
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

  /** Uma chamada por vez: as seguintes entram assim que esta sair. */
  const alert = alerts[0];

  useEffect(() => {
    if (!alert) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") dismiss(alert.key);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [alert, dismiss]);

  if (!alert) return null;

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-slate-900/40 p-4">
      <div className="w-full max-w-sm rounded-2xl bg-white p-6 text-center shadow-2xl">
        <div className="mx-auto flex h-16 w-16 animate-pulse items-center justify-center rounded-full bg-emerald-100 text-emerald-700">
          {alert.isVideo ? <Video className="h-7 w-7" /> : <PhoneCall className="h-7 w-7" />}
        </div>

        <p className="mt-4 text-lg font-bold text-slate-900">
          {alert.isVideo ? "Chamada de vídeo" : "Chamada"} recebida
        </p>
        <p className="mt-1 truncate text-sm font-medium text-slate-700">
          {alert.callerName ?? alert.conversationTitle}
        </p>
        {/* Sem telefone quando o WhatsApp não informa — melhor vazio que falso */}
        {alert.callerPhone && (
          <p className="text-sm text-slate-500">{formatPhone(alert.callerPhone)}</p>
        )}
        {alert.isGroup && (
          <p className="mt-0.5 truncate text-xs text-slate-400">
            no grupo {alert.conversationTitle}
          </p>
        )}

        <p className="mt-3 text-xs text-slate-400">
          A ligação está tocando no celular. O sistema não atende nem recusa.
        </p>

        <div className="mt-5 flex gap-2">
          <Button
            className="flex-1 justify-center"
            onClick={() => {
              dismiss(alert.key);
              router.push(`/inbox/${alert.conversationId}`);
            }}
          >
            Abrir conversa
          </Button>
          <Button
            variant="outline"
            className="flex-1 justify-center"
            onClick={() => dismiss(alert.key)}
          >
            Dispensar
          </Button>
        </div>

        {alerts.length > 1 && (
          <p className="mt-3 text-xs text-slate-400">
            +{alerts.length - 1}{" "}
            {alerts.length - 1 === 1 ? "outra chamada" : "outras chamadas"} tocando
          </p>
        )}
      </div>
    </div>
  );
}

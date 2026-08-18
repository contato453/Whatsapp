"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { PhoneCall, Video } from "lucide-react";
import { RealtimeEvents, type CallIncomingPayload } from "@azvchat/shared";
import { useAuth } from "@/lib/auth-context";
import { useSocket } from "@/lib/socket-context";
import { formatPhone } from "@/lib/utils";
import { Avatar, Badge, Button } from "@/components/ui";
import { ConversationAvatar, ParticipantAvatar } from "@/components/inbox/conversation-avatar";

/** Uma chamada toca por cerca de 30s; o aviso fica um pouco mais. */
const ALERT_TTL_MS = 45_000;

/** Rótulo neutro quando nenhuma fonte conhece quem liga — nunca o LID cru. */
const UNKNOWN_CALLER_LABEL = "Contato não identificado";

interface CallAlert extends CallIncomingPayload {
  key: string;
}

/**
 * Quem a tela nomeia: em chamada de grupo é o grupo; em individual, o nome
 * que a API já resolveu. A tela NUNCA decide identidade — o backend manda
 * pronto, e sem nome o rótulo é neutro: exibir o identificador interno
 * ("...@lid") como se fosse telefone faria alguém tentar ligar de volta.
 */
function alertTitle(alert: CallAlert): string {
  if (alert.isGroup) return alert.conversationTitle;
  return alert.callerName ?? UNKNOWN_CALLER_LABEL;
}

/** Foto de quem liga, pela fonte que a API indicou; iniciais quando não há. */
function AlertAvatar({ alert }: { alert: CallAlert }) {
  const sizing = "h-16 w-16 text-lg";
  // Sem identidade, iniciais enganariam ("CN" de "Contato não identificado"):
  // o Avatar cai no "?" quando o nome é vazio.
  const name = alert.isGroup ? alert.conversationTitle : (alert.callerName ?? "");
  if (alert.callerAvatar?.source === "conversation") {
    return (
      <ConversationAvatar
        conversationId={alert.callerAvatar.id}
        name={name}
        hasAvatar
        size="lg"
        className={sizing}
      />
    );
  }
  if (alert.callerAvatar?.source === "participant") {
    return (
      <ParticipantAvatar
        participantId={alert.callerAvatar.id}
        name={name}
        hasAvatar
        size="lg"
        className={sizing}
      />
    );
  }
  return <Avatar name={name} size="lg" className={sizing} />;
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
      // Durante um deploy a aba nova pode receber evento de uma API ainda
      // antiga, sem os campos de identidade. Normalizar aqui garante que o
      // aviso SEMPRE aparece — perder a chamada é pior que perder o detalhe.
      const alert: CallAlert = {
        ...payload,
        callerName: payload.callerName ?? null,
        callerPhone: payload.callerPhone ?? null,
        callerGroups: payload.callerGroups ?? [],
        callerAvatar: payload.callerAvatar ?? null,
        instanceName: payload.instanceName ?? null,
        key,
      };
      setAlerts((current) =>
        current.some((entry) => entry.key === key) ? current : [...current, alert],
      );
      window.setTimeout(() => dismiss(key), ALERT_TTL_MS);

      // Aviso do sistema operacional quando a aba está em segundo plano.
      if (typeof Notification !== "undefined" && Notification.permission === "granted") {
        const who = payload.isGroup
          ? payload.conversationTitle
          : (payload.callerName ?? UNKNOWN_CALLER_LABEL);
        new Notification(`Chamada de ${who}`, {
          body: payload.instanceName
            ? `Ligação tocando no número ${payload.instanceName}.`
            : "Ligação tocando no WhatsApp agora.",
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

  // Quando a pessoa só é conhecida por UM grupo, oferecemos abri-lo; com
  // vários, a escolha é de quem atende — o aviso só informa.
  const singleGroup =
    !alert.isGroup && alert.callerGroups.length === 1 && alert.callerGroups[0]?.conversationId
      ? alert.callerGroups[0]
      : null;

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-slate-900/40 p-4">
      <div className="w-full max-w-sm rounded-2xl bg-white p-6 text-center shadow-2xl">
        <p className="flex items-center justify-center gap-2 text-sm font-semibold text-emerald-700">
          <span className="flex h-8 w-8 animate-pulse items-center justify-center rounded-full bg-emerald-100">
            {alert.isVideo ? <Video className="h-4 w-4" /> : <PhoneCall className="h-4 w-4" />}
          </span>
          {alert.isVideo ? "Chamada de vídeo recebida" : "Chamada recebida"}
        </p>

        <div className="mx-auto mt-4 w-fit">
          <AlertAvatar alert={alert} />
        </div>

        <p className="mt-3 truncate text-lg font-bold text-slate-900">{alertTitle(alert)}</p>
        {alert.isGroup && <p className="text-xs text-slate-500">Chamada em grupo</p>}
        {/* Telefone só quando é real: chamada por "@lid" sem número conhecido
            chega sem telefone, e é assim mesmo — melhor linha nenhuma do que
            uma sequência que alguém vai tentar discar. */}
        {alert.callerPhone && (
          <p className="text-sm text-slate-500">{formatPhone(alert.callerPhone)}</p>
        )}
        {!alert.isGroup && alert.callerGroups.length > 0 && (
          <p className="mt-1 truncate text-xs text-slate-500">
            Participa do grupo <span className="font-medium">{alert.callerGroups[0]?.name}</span>
            {alert.callerGroups.length > 1 &&
              ` e de mais ${alert.callerGroups.length - 1} ${
                alert.callerGroups.length - 1 === 1 ? "grupo" : "grupos"
              }`}
          </p>
        )}

        {/* O chip diz a quem a ligação se destinava — decisivo com vários números. */}
        {alert.instanceName && (
          <div className="mt-2">
            <Badge>Recebida no número {alert.instanceName}</Badge>
          </div>
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
        {singleGroup && (
          <button
            type="button"
            className="mt-3 text-xs font-medium text-brand-700 hover:underline"
            onClick={() => {
              dismiss(alert.key);
              router.push(`/inbox/${singleGroup.conversationId}`);
            }}
          >
            Abrir o grupo {singleGroup.name}
          </button>
        )}

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

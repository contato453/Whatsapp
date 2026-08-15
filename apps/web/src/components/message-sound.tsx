"use client";

import { useEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import { BellOff, X } from "lucide-react";
import { RealtimeEvents } from "@azvchat/shared";
import { useAuth } from "@/lib/auth-context";
import { useSocket } from "@/lib/socket-context";
import {
  onNotificationAudioBlocked,
  playNotificationSound,
  resumeNotificationAudio,
  unlockNotificationAudio,
} from "@/lib/notification-sound";
import type { ConversationDto, MessageDto } from "@/lib/types";
import { Button } from "@/components/ui";

/**
 * Intervalo mínimo entre dois avisos. Sem ele, um grupo com dez mensagens
 * seguidas viraria dez toques em rajada — o que faz o atendente desligar o
 * som e voltar ao problema que este recurso veio resolver. A mensagem
 * suprimida não entra em fila: um aviso já diz o que precisava ser dito.
 */
const MIN_INTERVAL_MS = 2_000;

/**
 * Som discreto quando chega mensagem recebida, em qualquer tela do sistema.
 *
 * Não escuta sala nenhuma além das que o socket já entrega ao usuário e não
 * faz consulta à API: é reação a um `message:new` que ele receberia de todo
 * jeito, dentro do recorte de acesso dele.
 *
 * Limitação conhecida: com duas abas abertas, as duas tocam. Sincronizar
 * entre abas (BroadcastChannel ou leader election) exigiria estado
 * compartilhado que nada mais aqui precisa — fica para quando incomodar.
 */
export function MessageSound() {
  const socket = useSocket();
  const { user } = useAuth();
  const pathname = usePathname();
  const [blocked, setBlocked] = useState(false);
  const lastPlayedAtRef = useRef(0);
  const openConversationRef = useRef<string | null>(null);

  const sound = user?.notificationSound ?? "none";
  const volume = user?.notificationVolume ?? "medium";
  // Com "Nenhum" nada é inicializado: nem contexto de áudio, nem os
  // ouvintes de destravamento. O custo em runtime é zero.
  const enabled = Boolean(user) && sound !== "none";

  // Conversa aberta agora, lida da rota. Em ref para o handler do socket não
  // ser reinscrito a cada navegação da Inbox.
  useEffect(() => {
    const match = /^\/inbox\/([^/]+)/.exec(pathname ?? "");
    openConversationRef.current = match?.[1] ?? null;
  }, [pathname]);

  /**
   * Chrome e Safari seguram o áudio até haver interação na página. Sem
   * destravar no primeiro clique ou tecla, o som não sai na primeira aba do
   * dia e o recurso parece defeito.
   */
  useEffect(() => {
    if (!enabled) return undefined;
    const unlock = () => unlockNotificationAudio();
    window.addEventListener("pointerdown", unlock, { once: true });
    window.addEventListener("keydown", unlock, { once: true });
    return () => {
      window.removeEventListener("pointerdown", unlock);
      window.removeEventListener("keydown", unlock);
    };
  }, [enabled]);

  // Aba muito tempo em segundo plano faz o navegador suspender o contexto:
  // religa ao voltar, sem tocar nada do que passou enquanto ela dormia.
  useEffect(() => {
    if (!enabled) return undefined;
    const resume = () => {
      if (document.visibilityState === "visible") resumeNotificationAudio();
    };
    document.addEventListener("visibilitychange", resume);
    window.addEventListener("focus", resume);
    return () => {
      document.removeEventListener("visibilitychange", resume);
      window.removeEventListener("focus", resume);
    };
  }, [enabled]);

  // Bloqueio persistente do navegador: um aviso por sessão, sem modal.
  useEffect(() => {
    if (!enabled) return undefined;
    return onNotificationAudioBlocked(() => setBlocked(true));
  }, [enabled]);

  useEffect(() => {
    if (!socket || !enabled) return undefined;
    const onMessageNew = (payload: { conversation?: ConversationDto; message: MessageDto }) => {
      // O gatilho é a direção, não o tipo: mídia sem texto e aviso de
      // chamada tocam igual. O que a equipe envia nunca toca.
      if (payload.message.direction !== "inbound") return;
      // Conversa arquivada não toca: o chip de backup recebe mensagem o dia
      // inteiro, e cada uma viraria um aviso de algo que ninguém vai atender.
      if (payload.conversation?.archivedAt) return;
      // Aba em foco E conversa aberta: a pessoa está olhando para a mensagem.
      if (
        document.hasFocus() &&
        payload.message.conversationId === openConversationRef.current
      ) {
        return;
      }
      const now = Date.now();
      if (now - lastPlayedAtRef.current < MIN_INTERVAL_MS) return;
      lastPlayedAtRef.current = now;
      playNotificationSound(sound, volume);
    };
    socket.on(RealtimeEvents.MessageNew, onMessageNew);
    return () => {
      socket.off(RealtimeEvents.MessageNew, onMessageNew);
    };
  }, [socket, enabled, sound, volume]);

  if (!blocked) return null;

  return (
    <div className="fixed bottom-4 right-4 z-50 flex max-w-xs items-start gap-2 rounded-xl border border-slate-200 bg-white p-3 shadow-lg">
      <BellOff className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
      <p className="text-xs leading-relaxed text-slate-600">
        O navegador bloqueou o som de notificação. Clique em qualquer lugar da página para
        liberar.
      </p>
      <Button
        variant="ghost"
        size="sm"
        aria-label="Fechar aviso"
        className="-mr-1 -mt-1 shrink-0"
        onClick={() => setBlocked(false)}
      >
        <X className="h-3.5 w-3.5" />
      </Button>
    </div>
  );
}

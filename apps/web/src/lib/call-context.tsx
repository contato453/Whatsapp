"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { RealtimeEvents, type CallIncomingPayload, type CallStatusPayload } from "@azvchat/shared";
import { callsApi } from "@/lib/api";
import { useSocket } from "@/lib/socket-context";
import { CallPanel } from "@/components/inbox/call-panel";

/**
 * Discador de voz — controlador único de UMA chamada ativa.
 *
 * O áudio é WebRTC DIRETO (UDP) entre o navegador e o servidor do AstraCalls;
 * este contexto cuida da máquina de estados + do RTCPeerConnection e proxia a
 * troca de SDP pela nossa API (a chave do AstraCalls nunca chega aqui). O
 * handshake é NÃO-TRICKLE (espera o ICE terminar antes de mandar a oferta),
 * espelhando o cliente oficial do AstraCalls.
 */

export type CallUiStatus = "starting" | "ringing" | "in-call" | "ended";

export interface ActiveCall {
  conversationId: string;
  callId: string | null;
  title: string;
  direction: "in" | "out";
  status: CallUiStatus;
  error: string | null;
  connectedAt: number | null;
}

interface CallContextValue {
  call: ActiveCall | null;
  muted: boolean;
  remoteStream: MediaStream | null;
  startOutbound: (opts: { conversationId: string; title: string }) => void;
  answerIncoming: (payload: CallIncomingPayload) => void;
  toggleMute: () => void;
  hangup: () => void;
}

const CallContext = createContext<CallContextValue | null>(null);

export function useCall(): CallContextValue {
  const ctx = useContext(CallContext);
  if (!ctx) throw new Error("useCall precisa do CallProvider");
  return ctx;
}

export function CallProvider({ children }: { children: React.ReactNode }) {
  const socket = useSocket();
  const [call, setCall] = useState<ActiveCall | null>(null);
  const [muted, setMuted] = useState(false);
  const [remoteStream, setRemoteStream] = useState<MediaStream | null>(null);

  // Recursos vivos da chamada — fora do estado do React porque a limpeza tem
  // que rodar mesmo em erro/desmontagem, sem esperar re-render.
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const micRef = useRef<MediaStream | null>(null);
  const callRef = useRef<ActiveCall | null>(null);
  callRef.current = call;

  const cleanupMedia = useCallback(() => {
    pcRef.current?.close();
    pcRef.current = null;
    micRef.current?.getTracks().forEach((t) => t.stop());
    micRef.current = null;
    setRemoteStream(null);
    setMuted(false);
  }, []);

  /** Encerra no provider (se já houver callId) e limpa tudo. */
  const hangup = useCallback(() => {
    const current = callRef.current;
    cleanupMedia();
    if (current?.callId) {
      const action = current.status === "ringing" && current.direction === "in" ? "reject" : "end";
      const fn = action === "reject" ? callsApi.reject : callsApi.end;
      void fn(current.conversationId, current.callId).catch(() => undefined);
    }
    setCall((c) => (c ? { ...c, status: "ended", error: c.error } : null));
    // Some da tela depois de um instante, para o "Encerrada" ser visto.
    window.setTimeout(() => setCall(null), 1500);
  }, [cleanupMedia]);

  /**
   * Handshake WebRTC comum às duas direções: captura o microfone, monta a
   * oferta, espera o ICE e troca o SDP pela nossa API. Devolve true no sucesso.
   */
  const establishWebRtc = useCallback(
    async (conversationId: string, callId: string): Promise<boolean> => {
      try {
        const mic = await navigator.mediaDevices.getUserMedia({ audio: true });
        micRef.current = mic;
        const pc = new RTCPeerConnection({ iceServers: [] });
        pcRef.current = pc;
        mic.getAudioTracks().forEach((track) => pc.addTrack(track, mic));
        pc.addTransceiver("audio", { direction: "recvonly" });
        pc.ontrack = (event) => {
          if (event.streams[0]) setRemoteStream(event.streams[0]);
        };
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        await new Promise<void>((resolve) => {
          if (pc.iceGatheringState === "complete") return resolve();
          const onChange = () => {
            if (pc.iceGatheringState === "complete") {
              pc.removeEventListener("icegatheringstatechange", onChange);
              resolve();
            }
          };
          pc.addEventListener("icegatheringstatechange", onChange);
        });
        const { sdp_answer } = await callsApi.webrtc(
          conversationId,
          callId,
          pc.localDescription?.sdp ?? "",
        );
        await pc.setRemoteDescription({ type: "answer", sdp: sdp_answer });
        return true;
      } catch (err) {
        const message =
          err instanceof DOMException && err.name === "NotAllowedError"
            ? "Permissão de microfone negada."
            : "Falha ao conectar o áudio.";
        cleanupMedia();
        setCall((c) => (c ? { ...c, status: "ended", error: message } : null));
        window.setTimeout(() => setCall(null), 2500);
        return false;
      }
    },
    [cleanupMedia],
  );

  const startOutbound = useCallback(
    ({ conversationId, title }: { conversationId: string; title: string }) => {
      if (callRef.current) return; // uma chamada por vez
      setCall({
        conversationId,
        callId: null,
        title,
        direction: "out",
        status: "starting",
        error: null,
        connectedAt: null,
      });
      void (async () => {
        try {
          const { callId } = await callsApi.start(conversationId, false);
          setCall((c) => (c ? { ...c, callId, status: "ringing" } : null));
          // Prepara o áudio já; a conversa começa quando o outro lado atende
          // (evento call:status "accepted"), mas o caminho de mídia fica pronto.
          await establishWebRtc(conversationId, callId);
        } catch (err) {
          const message =
            typeof err === "object" && err && "message" in err
              ? String((err as { message: unknown }).message)
              : "Não foi possível iniciar a chamada.";
          cleanupMedia();
          setCall((c) => (c ? { ...c, status: "ended", error: message } : null));
          window.setTimeout(() => setCall(null), 2500);
        }
      })();
    },
    [establishWebRtc, cleanupMedia],
  );

  const answerIncoming = useCallback(
    (payload: CallIncomingPayload) => {
      if (callRef.current) return;
      setCall({
        conversationId: payload.conversationId,
        callId: payload.callId,
        title: payload.isGroup ? payload.conversationTitle : (payload.callerName ?? payload.conversationTitle),
        direction: "in",
        status: "starting",
        error: null,
        connectedAt: null,
      });
      void (async () => {
        try {
          await callsApi.accept(payload.conversationId, payload.callId);
          const ok = await establishWebRtc(payload.conversationId, payload.callId);
          if (ok) {
            setCall((c) => (c ? { ...c, status: "in-call", connectedAt: Date.now() } : null));
          }
        } catch {
          cleanupMedia();
          setCall((c) => (c ? { ...c, status: "ended", error: "Falha ao atender." } : null));
          window.setTimeout(() => setCall(null), 2500);
        }
      })();
    },
    [establishWebRtc, cleanupMedia],
  );

  const toggleMute = useCallback(() => {
    const mic = micRef.current;
    if (!mic) return;
    const next = !muted;
    mic.getAudioTracks().forEach((track) => (track.enabled = !next));
    setMuted(next);
  }, [muted]);

  // O outro lado atendeu / desligou: só chega por este evento (a nossa tela não
  // adivinha o estado do celular do cliente).
  useEffect(() => {
    if (!socket) return;
    const onStatus = (payload: CallStatusPayload) => {
      const current = callRef.current;
      if (!current || current.callId !== payload.callId) return;
      if (payload.status === "accepted") {
        setCall((c) => (c && !c.connectedAt ? { ...c, status: "in-call", connectedAt: Date.now() } : c));
      } else if (
        payload.status === "ended" ||
        payload.status === "rejected" ||
        payload.status === "missed"
      ) {
        // `ended` = o outro lado desligou depois de atender. Sem tratar isto, a
        // tela continuava contando minutos de uma chamada que já acabou.
        cleanupMedia();
        setCall((c) => (c ? { ...c, status: "ended" } : null));
        window.setTimeout(() => setCall(null), 1500);
      }
    };
    socket.on(RealtimeEvents.CallStatus, onStatus);
    return () => {
      socket.off(RealtimeEvents.CallStatus, onStatus);
    };
  }, [socket, cleanupMedia]);

  // Segurança: solta o microfone se o componente sair de cena.
  useEffect(() => () => cleanupMedia(), [cleanupMedia]);

  const value = useMemo<CallContextValue>(
    () => ({ call, muted, remoteStream, startOutbound, answerIncoming, toggleMute, hangup }),
    [call, muted, remoteStream, startOutbound, answerIncoming, toggleMute, hangup],
  );

  return (
    <CallContext.Provider value={value}>
      {children}
      {call && <CallPanel />}
    </CallContext.Provider>
  );
}

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
import {
  RealtimeEvents,
  type CallEndReason,
  type CallIncomingPayload,
  type CallStatusPayload,
} from "@azvchat/shared";
import { ApiError, callsApi } from "@/lib/api";
import { CallTonePlayer } from "@/lib/call-tones";
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
  /** Instante em que começou a chamar (saída), para o "há quanto tempo". */
  ringingSince: number | null;
  /** O provedor confirmou que o aparelho do cliente está tocando. */
  remoteRinging: boolean;
  /** Por que terminou, para o painel dizer em português. */
  endReason: CallEndReason | null;
}

/**
 * Uma chamada por vez POR ABA: o botão de ligar fica desabilitado enquanto há
 * chamada no painel. Duas abas da mesma pessoa não se conhecem (não há
 * sincronização entre abas), então cada uma pode ter a sua — quem decide se o
 * número aguenta duas ao mesmo tempo é o WhatsApp.
 */

/** Quanto tempo o painel fica com o motivo na tela antes de sumir. */
const END_VISIBLE_MS = 1500;
const END_REASON_VISIBLE_MS = 6000;

/** Motivo quando o servidor não mandou um (versão anterior, evento sem motivo). */
function fallbackReason(status: CallStatusPayload["status"]): CallEndReason {
  if (status === "ended") return "completed";
  if (status === "rejected") return "rejected";
  return "no_answer";
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
  const mutedRef = useRef(false);
  mutedRef.current = muted;
  const tonesRef = useRef<CallTonePlayer | null>(null);
  /** O outro lado já mandou som de verdade (retorno do provedor ou voz). */
  const remoteSoundRef = useRef(false);
  /** O cliente atendeu (saída). Ref, e não estado, porque o "atendida" pode
   * chegar antes de o WebRTC terminar de montar o microfone. */
  const answeredRef = useRef(false);
  const hideTimerRef = useRef<number | null>(null);

  const tones = useCallback((): CallTonePlayer => {
    if (!tonesRef.current) tonesRef.current = new CallTonePlayer();
    return tonesRef.current;
  }, []);

  /**
   * Microfone da chamada de SAÍDA só abre quando o cliente atende. Antes disso
   * não há ninguém do outro lado, e é assim que nada da discagem (nem o tom
   * local que o microfone captaria do alto-falante) sobe para o provedor e
   * para a gravação.
   */
  const setMicLive = useCallback((live: boolean) => {
    micRef.current?.getAudioTracks().forEach((track) => (track.enabled = live && !mutedRef.current));
  }, []);

  const scheduleHide = useCallback((ms: number) => {
    if (hideTimerRef.current !== null) window.clearTimeout(hideTimerRef.current);
    hideTimerRef.current = window.setTimeout(() => {
      hideTimerRef.current = null;
      setCall(null);
    }, ms);
  }, []);

  const cleanupMedia = useCallback(() => {
    pcRef.current?.close();
    pcRef.current = null;
    micRef.current?.getTracks().forEach((t) => t.stop());
    micRef.current = null;
    tonesRef.current?.unwatch();
    setRemoteStream(null);
    setMuted(false);
  }, []);

  /**
   * Fim da chamada com motivo: cala o retorno, toca o aviso de ocupado ou de
   * número inexistente quando o provedor não mandou o próprio, e deixa o
   * motivo na tela tempo suficiente para ser lido.
   */
  const finishWithReason = useCallback(
    (reason: CallEndReason, error: string | null = null) => {
      const current = callRef.current;
      const player = tones();
      player.stop();
      if (current?.direction === "out" && !remoteSoundRef.current) {
        if (reason === "busy") player.playBusy();
        else if (reason === "not_found") player.playNotFound();
      }
      cleanupMedia();
      setCall((c) => (c ? { ...c, status: "ended", endReason: reason, error: error ?? c.error } : null));
      scheduleHide(reason === "completed" || reason === "canceled" ? END_VISIBLE_MS : END_REASON_VISIBLE_MS);
      console.info("[call] encerrada", { callId: current?.callId ?? null, reason });
    },
    [cleanupMedia, scheduleHide, tones],
  );

  /** Encerra no provider (se já houver callId) e limpa tudo. */
  const hangup = useCallback(() => {
    const current = callRef.current;
    if (!current || current.status === "ended") {
      tonesRef.current?.stop();
      setCall(null);
      return;
    }
    if (current.callId) {
      const action = current.status === "ringing" && current.direction === "in" ? "reject" : "end";
      const fn = action === "reject" ? callsApi.reject : callsApi.end;
      void fn(current.conversationId, current.callId).catch(() => undefined);
    }
    // Desligar antes de o cliente atender é "cancelada por nós", não perdida
    // do cliente. O registro no banco segue o mesmo motivo (o provider sabe
    // quem pediu o encerramento).
    const reason: CallEndReason =
      current.direction === "out" && current.status !== "in-call" ? "canceled" : "completed";
    finishWithReason(reason);
  }, [finishWithReason]);

  /**
   * Handshake WebRTC comum às duas direções: captura o microfone, monta a
   * oferta, espera o ICE e troca o SDP pela nossa API. Devolve true no sucesso.
   */
  const establishWebRtc = useCallback(
    async (conversationId: string, callId: string, outbound = false): Promise<boolean> => {
      try {
        const mic = await navigator.mediaDevices.getUserMedia({ audio: true });
        micRef.current = mic;
        const pc = new RTCPeerConnection({ iceServers: [] });
        pcRef.current = pc;
        mic.getAudioTracks().forEach((track) => pc.addTrack(track, mic));
        if (outbound) setMicLive(answeredRef.current);
        pc.addTransceiver("audio", { direction: "recvonly" });
        // O áudio remoto vai para o alto-falante NA PRIMEIRA TRILHA, e não no
        // atendimento: qualquer som que o outro lado mande antes de atender
        // (retorno de chamada) precisa ser ouvido, e ligar o player só no
        // "atendida" o descartaria. Na saída, o mesmo stream é escutado para
        // calar o tom local assim que vier som de verdade de lá.
        pc.ontrack = (event) => {
          const stream = event.streams[0];
          if (!stream) return;
          setRemoteStream(stream);
          if (outbound && !answeredRef.current) {
            tones().watchRemoteAudio(stream, (level) => {
              remoteSoundRef.current = true;
              tones().stop();
              console.info("[call] som remoto antes do atendimento: tom local desligado", {
                callId,
                level: Number(level.toFixed(3)),
              });
              // Rede de segurança: se o "atendida" não chegar pelo socket, o
              // microfone não pode ficar fechado numa conversa que começou.
              window.setTimeout(() => {
                const c = callRef.current;
                if (c && c.callId === callId && c.status === "ringing") {
                  console.warn("[call] atendimento não confirmado; microfone aberto pelo som remoto", { callId });
                  setMicLive(true);
                }
              }, 3000);
            });
          }
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
        // Na saída, a chamada já foi discada: encerra no provedor para o
        // telefone do cliente não continuar tocando sem ninguém do lado de cá.
        if (outbound) void callsApi.end(conversationId, callId).catch(() => undefined);
        tonesRef.current?.stop();
        cleanupMedia();
        setCall((c) => (c ? { ...c, status: "ended", endReason: "failed", error: message } : null));
        scheduleHide(END_REASON_VISIBLE_MS);
        return false;
      }
    },
    [cleanupMedia, scheduleHide, setMicLive, tones],
  );

  const startOutbound = useCallback(
    ({ conversationId, title }: { conversationId: string; title: string }) => {
      if (callRef.current && callRef.current.status !== "ended") return; // uma chamada por vez
      if (hideTimerRef.current !== null) window.clearTimeout(hideTimerRef.current);
      remoteSoundRef.current = false;
      answeredRef.current = false;
      setCall({
        conversationId,
        callId: null,
        title,
        direction: "out",
        status: "starting",
        error: null,
        connectedAt: null,
        ringingSince: null,
        remoteRinging: false,
        endReason: null,
      });
      void (async () => {
        let callId: string;
        try {
          ({ callId } = await callsApi.start(conversationId, false));
        } catch (err) {
          // Recusa ANTES de tocar: número sem WhatsApp, formato inválido ou
          // falha do provedor. A frase vem pronta da API; o código decide o tom.
          const code = err instanceof ApiError ? err.code : undefined;
          const reason: CallEndReason = code === "call_not_found" ? "not_found" : "failed";
          const message =
            typeof err === "object" && err && "message" in err
              ? String((err as { message: unknown }).message)
              : "Não foi possível iniciar a chamada.";
          console.info("[call] discagem recusada", { code: code ?? null, reason });
          finishWithReason(reason, message);
          return;
        }
        // O cliente pode ter desligado o painel enquanto discava.
        if (!callRef.current || callRef.current.status === "ended") {
          void callsApi.end(conversationId, callId).catch(() => undefined);
          return;
        }
        setCall((c) => (c ? { ...c, callId, status: "ringing", ringingSince: Date.now() } : null));
        console.info("[call] discada", { callId });
        // Retorno local até o cliente atender (ou até o provedor mandar som).
        if (!answeredRef.current) tones().startRingback();
        await establishWebRtc(conversationId, callId, true);
      })();
    },
    [establishWebRtc, finishWithReason, tones],
  );

  const answerIncoming = useCallback(
    (payload: CallIncomingPayload) => {
      if (callRef.current && callRef.current.status !== "ended") return;
      if (hideTimerRef.current !== null) window.clearTimeout(hideTimerRef.current);
      tonesRef.current?.stop();
      setCall({
        conversationId: payload.conversationId,
        callId: payload.callId,
        title: payload.isGroup ? payload.conversationTitle : (payload.callerName ?? payload.conversationTitle),
        direction: "in",
        status: "starting",
        error: null,
        connectedAt: null,
        ringingSince: null,
        remoteRinging: false,
        endReason: null,
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
          scheduleHide(2500);
        }
      })();
    },
    [establishWebRtc, cleanupMedia, scheduleHide],
  );

  const toggleMute = useCallback(() => {
    const mic = micRef.current;
    if (!mic) return;
    const next = !muted;
    mutedRef.current = next;
    // Na saída ainda não atendida o microfone continua fechado; o botão só
    // guarda a escolha para quando o cliente atender.
    const c = callRef.current;
    const live = !(c?.direction === "out" && c.status !== "in-call");
    mic.getAudioTracks().forEach((track) => (track.enabled = live && !next));
    setMuted(next);
  }, [muted]);

  // O outro lado atendeu / desligou: só chega por este evento (a nossa tela não
  // adivinha o estado do celular do cliente).
  useEffect(() => {
    if (!socket) return;
    const onStatus = (payload: CallStatusPayload) => {
      const current = callRef.current;
      if (!current || current.callId !== payload.callId) return;
      console.info("[call] status", {
        callId: payload.callId,
        status: payload.status,
        endReason: payload.endReason ?? null,
        remoteRinging: payload.remoteRinging ?? false,
      });
      if (current.status === "ended") return;
      if (payload.status === "accepted") {
        // Atendeu: o retorno cala NA HORA, antes de qualquer voz.
        answeredRef.current = true;
        tonesRef.current?.stop();
        tonesRef.current?.unwatch();
        setMicLive(true);
        setCall((c) => (c && !c.connectedAt ? { ...c, status: "in-call", connectedAt: Date.now() } : c));
      } else if (payload.status === "ringing") {
        if (payload.remoteRinging) setCall((c) => (c ? { ...c, remoteRinging: true } : c));
      } else if (
        payload.status === "ended" ||
        payload.status === "rejected" ||
        payload.status === "missed"
      ) {
        // `ended` = o outro lado desligou depois de atender. Sem tratar isto, a
        // tela continuava contando minutos de uma chamada que já acabou.
        finishWithReason(payload.endReason ?? fallbackReason(payload.status));
      }
    };
    socket.on(RealtimeEvents.CallStatus, onStatus);
    return () => {
      socket.off(RealtimeEvents.CallStatus, onStatus);
    };
  }, [socket, finishWithReason, setMicLive]);

  // Segurança: solta o microfone e cala os tons se o componente sair de cena.
  useEffect(
    () => () => {
      cleanupMedia();
      tonesRef.current?.dispose();
      if (hideTimerRef.current !== null) window.clearTimeout(hideTimerRef.current);
    },
    [cleanupMedia],
  );

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

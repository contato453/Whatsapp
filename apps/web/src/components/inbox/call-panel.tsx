"use client";

import { useEffect, useRef, useState } from "react";
import { Mic, MicOff, Phone, PhoneOff } from "lucide-react";
import { Avatar, Button } from "@/components/ui";
import { useCall, type CallUiStatus } from "@/lib/call-context";

/** Rótulo do estado da chamada, do ponto de vista de quem está na tela. */
function statusLabel(status: CallUiStatus, direction: "in" | "out", elapsed: string): string {
  switch (status) {
    case "starting":
      return direction === "out" ? "Iniciando…" : "Atendendo…";
    case "ringing":
      return "Chamando…";
    case "in-call":
      return elapsed;
    case "ended":
      return "Encerrada";
  }
}

/**
 * Painel flutuante da chamada ativa. Puramente visual: o áudio e a máquina de
 * estados vivem no CallProvider. Contém o <audio> escondido que toca o outro
 * lado. Uma chamada por vez.
 */
export function CallPanel() {
  const { call, muted, remoteStream, toggleMute, hangup } = useCall();
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [elapsed, setElapsed] = useState("00:00");

  // Liga o stream remoto ao elemento de áudio assim que ele chega.
  useEffect(() => {
    if (audioRef.current && remoteStream) {
      audioRef.current.srcObject = remoteStream;
    }
  }, [remoteStream]);

  // Cronômetro só depois que conecta.
  useEffect(() => {
    if (!call?.connectedAt) return;
    const tick = () => {
      const secs = Math.floor((Date.now() - (call.connectedAt ?? Date.now())) / 1000);
      const mm = String(Math.floor(secs / 60)).padStart(2, "0");
      const ss = String(secs % 60).padStart(2, "0");
      setElapsed(`${mm}:${ss}`);
    };
    tick();
    const id = window.setInterval(tick, 1000);
    return () => window.clearInterval(id);
  }, [call?.connectedAt]);

  if (!call) return null;

  return (
    <div className="fixed bottom-4 right-4 z-[70] w-72 rounded-2xl bg-slate-900 p-5 text-center text-white shadow-2xl motion-safe:animate-in">
      <audio ref={audioRef} autoPlay className="hidden" />
      <div className="mx-auto w-fit">
        <Avatar name={call.title} size="lg" className="h-16 w-16 text-lg" />
      </div>
      <p className="mt-3 truncate text-base font-semibold">{call.title}</p>
      <p className="mt-1 text-sm text-slate-300">
        {statusLabel(call.status, call.direction, elapsed)}
      </p>
      {call.error && <p className="mt-1 text-xs text-rose-300">{call.error}</p>}

      <div className="mt-5 flex items-center justify-center gap-4">
        <button
          type="button"
          onClick={toggleMute}
          disabled={call.status === "ended"}
          className={`flex h-11 w-11 items-center justify-center rounded-full transition ${
            muted ? "bg-white text-slate-900" : "bg-white/15 text-white hover:bg-white/25"
          } disabled:opacity-40`}
          aria-label={muted ? "Ativar microfone" : "Silenciar microfone"}
          title={muted ? "Ativar microfone" : "Silenciar microfone"}
        >
          {muted ? <MicOff className="h-5 w-5" /> : <Mic className="h-5 w-5" />}
        </button>
        <button
          type="button"
          onClick={hangup}
          className="flex h-14 w-14 items-center justify-center rounded-full bg-rose-600 text-white transition hover:bg-rose-700"
          aria-label="Encerrar chamada"
          title="Encerrar chamada"
        >
          <PhoneOff className="h-6 w-6" />
        </button>
      </div>
    </div>
  );
}

/**
 * Botão de ligar para o cabeçalho da conversa. Só aparece em conversa
 * INDIVIDUAL com telefone — grupo não liga. Enquanto uma chamada está ativa,
 * fica desabilitado (uma por vez).
 */
export function CallButton({
  conversationId,
  title,
  disabled,
}: {
  conversationId: string;
  title: string;
  disabled?: boolean;
}) {
  const { call, startOutbound } = useCall();
  const busy = call !== null;
  return (
    <Button
      variant="outline"
      size="sm"
      disabled={disabled || busy}
      onClick={() => startOutbound({ conversationId, title })}
      title={busy ? "Já há uma chamada em andamento" : "Ligar"}
    >
      <Phone className="h-4 w-4" />
      <span className="hidden sm:inline">Ligar</span>
    </Button>
  );
}

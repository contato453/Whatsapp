"use client";

import { useEffect, useRef, useState } from "react";
import { Mic, MicOff, Phone, PhoneOff } from "lucide-react";
import { Avatar, Button } from "@/components/ui";
import { CALL_END_REASON_DESCRIPTIONS, CALL_END_REASON_LABELS } from "@azvchat/shared";
import { useCall, type ActiveCall } from "@/lib/call-context";

function formatElapsed(ms: number): string {
  const secs = Math.max(0, Math.floor(ms / 1000));
  return `${String(Math.floor(secs / 60)).padStart(2, "0")}:${String(secs % 60).padStart(2, "0")}`;
}

/**
 * Estado da chamada em TEXTO, do ponto de vista de quem está na tela. É a
 * informação que a equipe sentia falta na discagem: sem ela, não dava para
 * saber se estava chamando, ocupado ou se o número nem existia.
 */
function statusText(call: ActiveCall): { label: string; tone: "neutral" | "ok" | "warn" | "bad" } {
  if (call.status === "ended") {
    if (call.endReason) {
      const tone = call.endReason === "completed" || call.endReason === "canceled" ? "neutral" : "bad";
      return { label: CALL_END_REASON_LABELS[call.endReason], tone };
    }
    return { label: "Encerrada", tone: "neutral" };
  }
  if (call.status === "in-call") return { label: "Atendida", tone: "ok" };
  if (call.direction === "in") return { label: "Atendendo…", tone: "neutral" };
  if (call.status === "starting") return { label: "Discando…", tone: "neutral" };
  return { label: call.remoteRinging ? "Tocando no aparelho do cliente…" : "Chamando…", tone: "warn" };
}

const TONE_CLASS: Record<"neutral" | "ok" | "warn" | "bad", string> = {
  neutral: "bg-white/10 text-white",
  ok: "bg-emerald-500/20 text-emerald-200",
  warn: "bg-amber-400/20 text-amber-100",
  bad: "bg-rose-500/25 text-rose-100",
};

/**
 * Painel flutuante da chamada ativa. Puramente visual: o áudio e a máquina de
 * estados vivem no CallProvider. Contém o <audio> escondido que toca o outro
 * lado. Uma chamada por vez.
 */
export function CallPanel() {
  const { call, muted, remoteStream, toggleMute, hangup } = useCall();
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [elapsed, setElapsed] = useState("00:00");

  // Liga o stream remoto ao elemento de áudio ASSIM QUE ele chega, e não no
  // atendimento: é isso que deixa ouvir qualquer som que o outro lado mande
  // antes de atender. `play()` explícito porque o autoplay pode ser recusado;
  // falhar aqui não derruba a chamada.
  useEffect(() => {
    const el = audioRef.current;
    if (el && remoteStream) {
      el.srcObject = remoteStream;
      void el.play().catch((err: unknown) => {
        console.warn("[call] o navegador recusou tocar o áudio remoto", String(err));
      });
    }
  }, [remoteStream]);

  // Cronômetro: enquanto chama, conta desde que começou a chamar (para quem
  // espera saber há quanto tempo); depois de atender, a duração da conversa.
  const since = call?.connectedAt ?? (call?.status === "ringing" ? call.ringingSince : null);
  useEffect(() => {
    if (!since) return;
    const tick = () => setElapsed(formatElapsed(Date.now() - since));
    tick();
    const id = window.setInterval(tick, 1000);
    return () => window.clearInterval(id);
  }, [since]);

  if (!call) return null;
  const status = statusText(call);
  const showClock = call.status === "in-call" || (call.status === "ringing" && call.ringingSince);
  const detail =
    call.status === "ended"
      ? call.error ?? (call.endReason ? CALL_END_REASON_DESCRIPTIONS[call.endReason] : null)
      : call.error;

  return (
    <div className="fixed bottom-4 right-4 z-[70] w-72 rounded-2xl bg-slate-900 p-5 text-center text-white shadow-2xl motion-safe:animate-in">
      <audio ref={audioRef} autoPlay className="hidden" />
      <div className="mx-auto w-fit">
        <Avatar name={call.title} size="lg" className="h-16 w-16 text-lg" />
      </div>
      <p className="mt-3 truncate text-base font-semibold">{call.title}</p>
      <p
        role="status"
        aria-live="polite"
        className={`mx-auto mt-2 w-fit rounded-full px-3 py-1 text-sm font-semibold ${TONE_CLASS[status.tone]}`}
      >
        {status.label}
      </p>
      {showClock && <p className="mt-1 text-sm tabular-nums text-slate-300">{elapsed}</p>}
      {detail && <p className="mt-2 text-xs text-slate-300">{detail}</p>}

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
          aria-label={call.status === "ended" ? "Fechar" : "Encerrar chamada"}
          className="flex h-14 w-14 items-center justify-center rounded-full bg-rose-600 text-white transition hover:bg-rose-700"
          title={call.status === "ended" ? "Fechar" : "Encerrar chamada"}
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
  const busy = call !== null && call.status !== "ended";
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

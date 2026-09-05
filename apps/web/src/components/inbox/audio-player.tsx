"use client";

import { useEffect, useRef, useState } from "react";
import { AlertCircle, Loader2, Pause, Play } from "lucide-react";
import { cn } from "@/lib/utils";

const SPEEDS = [1, 1.5, 2] as const;

function formatSeconds(value: number): string {
  if (!Number.isFinite(value)) return "0:00";
  const minutes = Math.floor(value / 60);
  const seconds = Math.floor(value % 60);
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

/**
 * Player de áudio com controle de velocidade — essencial para ouvir
 * áudios longos de clientes em ritmo acelerado.
 */
export function AudioPlayer({
  src: srcProp,
  load,
  outbound,
  durationSeconds,
}: {
  /** URL pronta do áudio. Use `load` quando o binário só deve ser baixado ao tocar. */
  src?: string;
  /**
   * Carrega o áudio sob demanda e devolve a URL do blob. Quando presente e
   * `src` ausente, o player só baixa o arquivo no primeiro play — é como a
   * gravação de chamada aparece na lista sem baixar tudo de uma vez.
   */
  load?: () => Promise<string>;
  outbound: boolean;
  /**
   * Duração conhecida (do WhatsApp), em segundos. Serve de reserva quando o
   * navegador não consegue ler a duração do arquivo — é o caso do OGG/Opus da
   * nota de voz, que chegava com a barra e o tempo zerados sem isto.
   */
  durationSeconds?: number;
}) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState<(typeof SPEEDS)[number]>(1);
  const [progress, setProgress] = useState(0);
  const [duration, setDuration] = useState(0);
  // Fonte resolvida: o `src` direto, ou o que o `load` baixou no primeiro play.
  const [src, setSrc] = useState<string | null>(srcProp ?? null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState(false);
  // Play pedido antes de a fonte existir — dispara sozinho quando ela chega.
  const wantPlay = useRef(false);
  // URL que ESTE player criou (via load): revoga ao desmontar. `src` vindo de
  // fora é do chamador, e revogá-lo cortaria o áudio de quem o passou.
  const ownedUrl = useRef<string | null>(null);

  useEffect(() => {
    if (srcProp) setSrc(srcProp);
  }, [srcProp]);

  useEffect(() => {
    return () => {
      if (ownedUrl.current) URL.revokeObjectURL(ownedUrl.current);
    };
  }, []);

  async function ensureSrc(): Promise<void> {
    if (src || !load || loading) return;
    setLoading(true);
    setLoadError(false);
    try {
      const url = await load();
      ownedUrl.current = url;
      setSrc(url);
    } catch {
      setLoadError(true);
      wantPlay.current = false;
    } finally {
      setLoading(false);
    }
  }

  // Assim que a fonte fica pronta e havia um play pendente, toca.
  useEffect(() => {
    if (src && wantPlay.current) {
      wantPlay.current = false;
      const audio = audioRef.current;
      if (audio) {
        audio.playbackRate = speed;
        void audio.play();
      }
    }
  }, [src, speed]);

  // O `duration` do elemento vence quando é um número real; senão vale o que o
  // WhatsApp informou. OGG/Opus costuma reportar 0 ou Infinity até o fim do
  // download, e é aí que a reserva segura a barra e o tempo total.
  const effectiveDuration =
    Number.isFinite(duration) && duration > 0 ? duration : durationSeconds ?? 0;
  // Enquanto não toca, mostramos o TOTAL (como no WhatsApp); ao tocar, o
  // tempo decorrido.
  const displayed = progress > 0 ? progress : effectiveDuration;

  useEffect(() => {
    const audio = audioRef.current;
    if (audio) audio.playbackRate = speed;
  }, [speed]);

  function toggle() {
    // Ainda não baixou (gravação de chamada): baixa agora e toca ao terminar.
    if (!src) {
      wantPlay.current = true;
      void ensureSrc();
      return;
    }
    const audio = audioRef.current;
    if (!audio) return;
    if (audio.paused) {
      audio.playbackRate = speed;
      void audio.play();
    } else {
      audio.pause();
    }
  }

  function cycleSpeed() {
    const index = SPEEDS.indexOf(speed);
    setSpeed(SPEEDS[(index + 1) % SPEEDS.length] ?? 1);
  }

  return (
    <div className="flex min-w-[220px] items-center gap-2">
      {src && (
        <audio
          ref={audioRef}
          src={src}
          preload="metadata"
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
          onEnded={() => setPlaying(false)}
          onTimeUpdate={(event) => setProgress(event.currentTarget.currentTime)}
          onLoadedMetadata={(event) => setDuration(event.currentTarget.duration)}
          className="hidden"
        />
      )}
      <button
        onClick={toggle}
        disabled={loading}
        className={cn(
          "flex h-8 w-8 shrink-0 items-center justify-center rounded-full transition-colors",
          loadError
            ? "bg-rose-100 text-rose-600 hover:bg-rose-200"
            : outbound
              ? "bg-white/60 hover:bg-white/90"
              : "bg-slate-100 hover:bg-slate-200",
        )}
        aria-label={loadError ? "Tentar de novo" : playing ? "Pausar" : "Reproduzir"}
        title={loadError ? "Falha ao carregar — tocar de novo" : undefined}
      >
        {loading ? (
          <Loader2 className="h-4 w-4 animate-spin" />
        ) : loadError ? (
          <AlertCircle className="h-4 w-4" />
        ) : playing ? (
          <Pause className="h-4 w-4" />
        ) : (
          <Play className="h-4 w-4" />
        )}
      </button>

      <input
        type="range"
        min={0}
        max={effectiveDuration || 0}
        step={0.1}
        value={progress}
        onChange={(event) => {
          const audio = audioRef.current;
          if (audio) {
            audio.currentTime = Number(event.target.value);
            setProgress(Number(event.target.value));
          }
        }}
        className={cn(
          "h-1 flex-1 cursor-pointer appearance-none rounded-full",
          outbound ? "bg-black/10 accent-brand-600" : "bg-slate-200 accent-brand-600",
        )}
      />

      <span className={cn("shrink-0 text-[10px] tabular-nums", outbound ? "text-chat-sent-meta" : "text-slate-400")}>
        {formatSeconds(displayed)}
      </span>

      <button
        onClick={cycleSpeed}
        title="Velocidade de reprodução"
        className={cn(
          "shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-semibold transition-colors",
          outbound
            ? "bg-white/60 text-slate-700 hover:bg-white/90"
            : "bg-slate-100 text-slate-600 hover:bg-slate-200",
        )}
      >
        {speed}x
      </button>
    </div>
  );
}

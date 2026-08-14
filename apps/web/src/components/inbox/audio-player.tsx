"use client";

import { useEffect, useRef, useState } from "react";
import { Pause, Play } from "lucide-react";
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
export function AudioPlayer({ src, outbound }: { src: string; outbound: boolean }) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState<(typeof SPEEDS)[number]>(1);
  const [progress, setProgress] = useState(0);
  const [duration, setDuration] = useState(0);

  useEffect(() => {
    const audio = audioRef.current;
    if (audio) audio.playbackRate = speed;
  }, [speed]);

  function toggle() {
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
      <button
        onClick={toggle}
        className={cn(
          "flex h-8 w-8 shrink-0 items-center justify-center rounded-full transition-colors",
          outbound ? "bg-white/20 hover:bg-white/30" : "bg-slate-100 hover:bg-slate-200",
        )}
        aria-label={playing ? "Pausar" : "Reproduzir"}
      >
        {playing ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
      </button>

      <input
        type="range"
        min={0}
        max={duration || 0}
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
          outbound ? "bg-white/30 accent-white" : "bg-slate-200 accent-brand-600",
        )}
      />

      <span className={cn("shrink-0 text-[10px] tabular-nums", outbound ? "text-white/70" : "text-slate-400")}>
        {formatSeconds(progress)}
      </span>

      <button
        onClick={cycleSpeed}
        title="Velocidade de reprodução"
        className={cn(
          "shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-semibold transition-colors",
          outbound
            ? "bg-white/20 text-white hover:bg-white/30"
            : "bg-slate-100 text-slate-600 hover:bg-slate-200",
        )}
      >
        {speed}x
      </button>
    </div>
  );
}

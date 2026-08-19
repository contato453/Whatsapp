"use client";

import { useEffect, useRef, useState } from "react";
import { Mic, Send, Trash2 } from "lucide-react";
import { cn } from "@/lib/utils";

type State = "idle" | "recording" | "review";

function formatDuration(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(seconds % 60).padStart(2, "0")}`;
}

/**
 * Gravação de áudio pelo navegador (MediaRecorder).
 *
 * Cada navegador grava num formato: Chrome e Edge entregam WebM/Opus, o
 * Safari entrega MP4/AAC e só o Firefox entrega OGG/Opus, que é o que o
 * WhatsApp exige numa mensagem de voz. Nada disso é decidido aqui: quem
 * normaliza é a API, olhando os bytes do arquivo (ver
 * `lib/outbound-audio.ts`). Converter no navegador daria um resultado
 * diferente por máquina e por versão, e o nome do arquivo abaixo é só um
 * rótulo, nunca a fonte da verdade sobre o formato.
 */
export function AudioRecorder({
  disabled,
  onSend,
  onActiveChange,
}: {
  disabled?: boolean;
  onSend: (file: File) => Promise<void> | void;
  /**
   * Avisa quando há gravação em andamento ou áudio em revisão. O composer usa
   * para desligar o arrastar/colar arquivo: com a prévia de anexo aberta por
   * cima da gravação, os dois disputariam o mesmo Enter.
   */
  onActiveChange?: (active: boolean) => void;
}) {
  const [state, setState] = useState<State>("idle");
  const [seconds, setSeconds] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const blobRef = useRef<Blob | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);

  useEffect(() => {
    onActiveChange?.(state !== "idle");
  }, [state, onActiveChange]);

  useEffect(() => {
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
      recorderRef.current?.stream.getTracks().forEach((track) => track.stop());
      if (previewUrl) URL.revokeObjectURL(previewUrl);
    };
  }, [previewUrl]);

  async function startRecording() {
    setError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const recorder = new MediaRecorder(stream);
      chunksRef.current = [];
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) chunksRef.current.push(event.data);
      };
      recorder.onstop = () => {
        const blob = new Blob(chunksRef.current, { type: recorder.mimeType || "audio/webm" });
        blobRef.current = blob;
        setPreviewUrl(URL.createObjectURL(blob));
        stream.getTracks().forEach((track) => track.stop());
        setState("review");
      };
      recorder.start();
      recorderRef.current = recorder;
      setSeconds(0);
      setState("recording");
      timerRef.current = setInterval(() => setSeconds((value) => value + 1), 1000);
    } catch {
      setError("Permita o acesso ao microfone para gravar áudios.");
    }
  }

  function stopRecording() {
    if (timerRef.current) clearInterval(timerRef.current);
    recorderRef.current?.stop();
  }

  function discard() {
    if (timerRef.current) clearInterval(timerRef.current);
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    setPreviewUrl(null);
    blobRef.current = null;
    chunksRef.current = [];
    setSeconds(0);
    setState("idle");
  }

  async function send() {
    const blob = blobRef.current;
    if (!blob) return;
    const extension = blob.type.includes("ogg") ? "ogg" : "webm";
    const file = new File([blob], `audio-${Date.now()}.${extension}`, { type: blob.type });
    await onSend(file);
    discard();
  }

  if (state === "idle") {
    return (
      <div className="relative">
        <button
          type="button"
          onClick={() => void startRecording()}
          disabled={disabled}
          title="Gravar áudio"
          className="mb-1 rounded-lg p-2 text-slate-600 transition-colors hover:bg-slate-100 disabled:opacity-50"
        >
          <Mic className="h-4 w-4" />
        </button>
        {error && (
          <p className="absolute bottom-full left-0 mb-1 w-56 rounded bg-red-50 p-1.5 text-[11px] text-red-600">
            {error}
          </p>
        )}
      </div>
    );
  }

  if (state === "recording") {
    return (
      <div className="mb-1 flex items-center gap-2 rounded-lg bg-red-50 px-2.5 py-1.5">
        <span className="h-2 w-2 animate-pulse rounded-full bg-red-500" />
        <span className="text-xs font-medium tabular-nums text-red-700">
          {formatDuration(seconds)}
        </span>
        <button
          type="button"
          onClick={discard}
          title="Cancelar"
          className="rounded p-1 text-slate-400 hover:text-red-600"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          onClick={stopRecording}
          className="rounded-full bg-red-600 px-2.5 py-1 text-[11px] font-medium text-white hover:bg-red-700"
        >
          Parar
        </button>
      </div>
    );
  }

  return (
    <div className={cn("mb-1 flex items-center gap-2 rounded-lg bg-slate-100 px-2 py-1.5")}>
      {previewUrl && <audio controls src={previewUrl} className="h-8 max-w-[180px]" />}
      <button
        type="button"
        onClick={discard}
        title="Descartar"
        className="rounded p-1 text-slate-400 hover:text-red-600"
      >
        <Trash2 className="h-3.5 w-3.5" />
      </button>
      <button
        type="button"
        onClick={() => void send()}
        disabled={disabled}
        title="Enviar áudio"
        className="flex items-center gap-1 rounded-full bg-brand-550 px-2.5 py-1 text-[11px] font-medium text-white hover:bg-brand-600 disabled:opacity-50"
      >
        <Send className="h-3 w-3" /> Enviar
      </button>
    </div>
  );
}

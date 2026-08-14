"use client";

import { useEffect, useState } from "react";
import { Check, CheckCheck, Clock, Download, FileText, MapPin, User, XCircle } from "lucide-react";
import { fetchMediaBlobUrl } from "@/lib/api";
import { cn } from "@/lib/utils";
import type { MessageDto } from "@/lib/types";

function StatusIcon({ status }: { status: MessageDto["status"] }) {
  if (status === "pending") return <Clock className="h-3 w-3" />;
  if (status === "sent") return <Check className="h-3 w-3" />;
  if (status === "delivered") return <CheckCheck className="h-3 w-3" />;
  if (status === "read") return <CheckCheck className="h-3 w-3 text-sky-300" />;
  return <XCircle className="h-3 w-3 text-red-300" />;
}

/** Cor determinística por remetente para distinguir participantes do grupo. */
const SENDER_COLORS = ["#4f46e5", "#0891b2", "#16a34a", "#d97706", "#dc2626", "#9333ea", "#0284c7", "#ca8a04"];
function senderColor(key: string): string {
  let hash = 0;
  for (let i = 0; i < key.length; i++) hash = (hash * 31 + key.charCodeAt(i)) | 0;
  return SENDER_COLORS[Math.abs(hash) % SENDER_COLORS.length] ?? "#4f46e5";
}

function MediaContent({ message }: { message: MessageDto }) {
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const isVisual = message.type === "image" || message.type === "sticker";
  const isAudio = message.type === "audio";
  const isVideo = message.type === "video";

  useEffect(() => {
    if (!message.hasMedia) return;
    let objectUrl: string | null = null;
    let cancelled = false;
    if (isVisual || isAudio || isVideo) {
      fetchMediaBlobUrl(message.id)
        .then((blobUrl) => {
          if (cancelled) {
            URL.revokeObjectURL(blobUrl);
            return;
          }
          objectUrl = blobUrl;
          setUrl(blobUrl);
        })
        .catch(() => setFailed(true));
    }
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [message.id, message.hasMedia, isVisual, isAudio, isVideo]);

  if (!message.hasMedia) {
    return (
      <p className="text-xs italic opacity-70">
        {message.type === "image" ? "Imagem indisponível" : "Mídia indisponível"}
      </p>
    );
  }

  async function download() {
    try {
      const blobUrl = await fetchMediaBlobUrl(message.id);
      const anchor = document.createElement("a");
      anchor.href = blobUrl;
      anchor.download = message.filename ?? `arquivo-${message.id.slice(0, 8)}`;
      anchor.click();
      setTimeout(() => URL.revokeObjectURL(blobUrl), 10_000);
    } catch {
      setFailed(true);
    }
  }

  if (isVisual) {
    if (failed) return <p className="text-xs italic opacity-70">Falha ao carregar imagem</p>;
    if (!url) return <div className="h-40 w-52 animate-pulse rounded-lg bg-slate-200/60" />;
    return <img src={url} alt="Imagem" className="max-h-72 max-w-full rounded-lg" />;
  }
  if (isAudio) {
    if (failed) return <p className="text-xs italic opacity-70">Falha ao carregar áudio</p>;
    if (!url) return <div className="h-10 w-56 animate-pulse rounded-lg bg-slate-200/60" />;
    return <audio controls src={url} className="max-w-full" />;
  }
  if (isVideo) {
    if (failed) return <p className="text-xs italic opacity-70">Falha ao carregar vídeo</p>;
    if (!url) return <div className="h-40 w-52 animate-pulse rounded-lg bg-slate-200/60" />;
    return <video controls src={url} className="max-h-72 max-w-full rounded-lg" />;
  }
  // Documentos e demais tipos: cartão com download
  return (
    <button
      onClick={download}
      className="flex items-center gap-2.5 rounded-lg bg-black/5 px-3 py-2 text-left transition-colors hover:bg-black/10"
    >
      <FileText className="h-8 w-8 shrink-0 opacity-60" />
      <div className="min-w-0">
        <p className="truncate text-sm font-medium">{message.filename ?? "Documento"}</p>
        <p className="flex items-center gap-1 text-xs opacity-60">
          <Download className="h-3 w-3" /> Baixar
        </p>
      </div>
    </button>
  );
}

export function MessageBubble({
  message,
  isGroup,
  showSender,
}: {
  message: MessageDto;
  isGroup: boolean;
  showSender: boolean;
}) {
  const outbound = message.direction === "outbound";
  const senderKey = message.senderExternalId ?? message.senderPhone ?? "?";
  const senderLabel =
    message.senderName ?? (message.senderPhone ? `+${message.senderPhone}` : "Desconhecido");

  return (
    <div className={cn("flex", outbound ? "justify-end" : "justify-start")}>
      <div
        className={cn(
          "max-w-[75%] rounded-2xl px-3.5 py-2 shadow-sm",
          outbound
            ? "rounded-br-md bg-brand-600 text-white"
            : "rounded-bl-md border border-slate-200 bg-white text-slate-900",
        )}
      >
        {/* Identificação obrigatória do participante em grupos */}
        {isGroup && !outbound && showSender && (
          <p
            className="mb-0.5 flex items-center gap-1 text-xs font-semibold"
            style={{ color: senderColor(senderKey) }}
          >
            <User className="h-3 w-3" />
            {senderLabel}
            {message.senderPhone && message.senderName && (
              <span className="font-normal opacity-60">+{message.senderPhone}</span>
            )}
          </p>
        )}
        {outbound && message.senderName && showSender && (
          <p className="mb-0.5 text-xs font-semibold text-white/80">{message.senderName}</p>
        )}

        {message.type === "location" ? (
          <p className="flex items-center gap-1.5 text-sm">
            <MapPin className="h-4 w-4" /> {message.content ?? "Localização"}
          </p>
        ) : message.type === "text" ? (
          <p className="whitespace-pre-wrap break-words text-sm">{message.content}</p>
        ) : (
          <div className="space-y-1.5">
            <MediaContent message={message} />
            {message.content && (
              <p className="whitespace-pre-wrap break-words text-sm">{message.content}</p>
            )}
          </div>
        )}

        <p
          className={cn(
            "mt-1 flex items-center justify-end gap-1 text-[10px]",
            outbound ? "text-white/70" : "text-slate-400",
          )}
        >
          {new Date(message.timestamp).toLocaleTimeString("pt-BR", {
            hour: "2-digit",
            minute: "2-digit",
          })}
          {outbound && <StatusIcon status={message.status} />}
        </p>
      </div>
    </div>
  );
}

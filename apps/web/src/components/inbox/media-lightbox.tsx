"use client";

import { useEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, Download, X } from "lucide-react";
import { fetchMediaBlobUrl } from "@/lib/api";
import { mediaDownloadName, triggerBlobDownload } from "@/lib/media-download";
import { formatPhone } from "@/lib/utils";
import { Spinner } from "@/components/ui";
import type { MessageDto } from "@/lib/types";

/**
 * Visualização de mídia em tela cheia (imagem, vídeo e figurinha).
 *
 * A mídia é servida somente autenticada: nada aqui aponta `src` direto para a
 * URL da API — o binário vem pelo mesmo fetch com Authorization das bolhas
 * (`fetchMediaBlobUrl`) e vira blob temporário, revogado a cada troca de item
 * e no fechamento. Sem a revogação, a memória cresceria a cada mídia aberta
 * ao longo do dia.
 *
 * A navegação (setas) anda só pelas mídias já carregadas na janela de
 * mensagens da conversa aberta — nunca busca mais mensagens do servidor.
 */
export function MediaLightbox({
  messages,
  index,
  onClose,
  onNavigate,
}: {
  /** Somente mídias visuais (image, video, sticker) não apagadas, na ordem da conversa. */
  messages: MessageDto[];
  index: number;
  onClose: () => void;
  onNavigate: (index: number) => void;
}) {
  const message = messages[index] ?? null;
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [downloadFailed, setDownloadFailed] = useState(false);

  // Trava a rolagem do fundo enquanto aberta e devolve o foco a quem abriu ao
  // fechar — sem isso a pessoa que navegava por teclado se perde na página.
  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    containerRef.current?.focus();
    return () => {
      document.body.style.overflow = previousOverflow;
      opener?.focus();
    };
  }, []);

  // Busca o blob do item atual pelo caminho autenticado; revoga o anterior a
  // cada troca e no unmount.
  const messageId = message?.id ?? null;
  useEffect(() => {
    setUrl(null);
    setFailed(false);
    setDownloadFailed(false);
    if (!messageId) return;
    let objectUrl: string | null = null;
    let cancelled = false;
    fetchMediaBlobUrl(messageId)
      .then((blobUrl) => {
        if (cancelled) {
          URL.revokeObjectURL(blobUrl);
          return;
        }
        objectUrl = blobUrl;
        setUrl(blobUrl);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [messageId]);

  if (!message) return null;

  const hasPrevious = index > 0;
  const hasNext = index < messages.length - 1;
  const isVideo = message.type === "video";
  // Baixar figurinha não faz sentido no dia a dia do atendimento.
  const canDownload = message.type !== "sticker";

  const outbound = message.direction === "outbound";
  const senderLabel = outbound
    ? (message.senderName ?? "Você")
    : (message.senderName ?? (message.senderPhone ? formatPhone(message.senderPhone) : "Desconhecido"));
  const sentAt = new Date(message.timestamp);

  async function handleDownload() {
    if (!message) return;
    setDownloadFailed(false);
    // O blob exibido já está na memória: reusar evita baixar o arquivo de novo.
    if (url) {
      triggerBlobDownload(url, mediaDownloadName(message));
      return;
    }
    setDownloading(true);
    try {
      const blobUrl = await fetchMediaBlobUrl(message.id);
      triggerBlobDownload(blobUrl, mediaDownloadName(message));
      setTimeout(() => URL.revokeObjectURL(blobUrl), 10_000);
    } catch {
      // O 401 já redirecionou para o login dentro do client; o que sobra aqui
      // é mídia que sumiu do storage ou falha de rede.
      setDownloadFailed(true);
    } finally {
      setDownloading(false);
    }
  }

  function handleKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape") {
      event.stopPropagation();
      onClose();
      return;
    }
    if (event.key === "ArrowLeft" && hasPrevious) {
      event.preventDefault();
      onNavigate(index - 1);
      return;
    }
    if (event.key === "ArrowRight" && hasNext) {
      event.preventDefault();
      onNavigate(index + 1);
      return;
    }
    // Foco preso dentro do diálogo: Tab na última volta para a primeira.
    if (event.key === "Tab") {
      const focusables = containerRef.current?.querySelectorAll<HTMLElement>(
        "button:not([disabled]), video, [href], [tabindex]:not([tabindex='-1'])",
      );
      if (!focusables || focusables.length === 0) return;
      const first = focusables[0] as HTMLElement;
      const last = focusables[focusables.length - 1] as HTMLElement;
      if (event.shiftKey && (document.activeElement === first || document.activeElement === containerRef.current)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }
  }

  const stop = (event: React.MouseEvent) => event.stopPropagation();

  return (
    <div
      ref={containerRef}
      role="dialog"
      aria-modal="true"
      aria-label="Visualização de mídia em tela cheia"
      tabIndex={-1}
      onKeyDown={handleKeyDown}
      onClick={onClose}
      className="fixed inset-0 z-[70] flex flex-col bg-slate-950/95 outline-none"
    >
      {/* Barra superior: baixar e fechar */}
      <div className="flex shrink-0 items-center justify-end gap-2 p-3" onClick={stop}>
        {canDownload && (
          <button
            onClick={() => void handleDownload()}
            disabled={downloading}
            title="Baixar mídia"
            aria-label="Baixar mídia"
            className="flex items-center gap-1.5 rounded-full bg-white/10 px-3 py-2 text-sm text-white transition-colors hover:bg-white/20 disabled:opacity-60"
          >
            {downloading ? <Spinner className="h-4 w-4 border-white/30 border-t-white" /> : <Download className="h-4 w-4" />}
            {downloading ? "Baixando..." : "Baixar"}
          </button>
        )}
        <button
          onClick={onClose}
          title="Fechar"
          aria-label="Fechar visualização"
          className="rounded-full bg-white/10 p-2 text-white transition-colors hover:bg-white/20"
        >
          <X className="h-5 w-5" />
        </button>
      </div>

      {downloadFailed && (
        <p className="shrink-0 pb-1 text-center text-xs text-red-300" onClick={stop}>
          Falha ao baixar o arquivo. Tente novamente.
        </p>
      )}

      {/* Área central: a mídia no tamanho natural quando couber, ajustada à
          tela quando maior — object-contain preserva a proporção sempre. */}
      <div className="relative flex min-h-0 flex-1 items-center justify-center px-14 py-2">
        {failed ? (
          <p className="text-sm text-white/80" onClick={stop}>
            Não foi possível carregar esta mídia.
          </p>
        ) : !url ? (
          <div className="flex flex-col items-center gap-3" onClick={stop}>
            <Spinner className="h-8 w-8 border-white/30 border-t-white" />
            {/* Sem range request na API, o vídeo chega inteiro antes de tocar. */}
            {isVideo && <p className="text-xs text-white/60">Carregando vídeo...</p>}
          </div>
        ) : isVideo ? (
          <video
            controls
            src={url}
            onClick={stop}
            className="max-h-full max-w-full rounded-lg"
          />
        ) : (
          <img
            src={url}
            alt={message.type === "sticker" ? "Figurinha ampliada" : "Imagem ampliada"}
            onClick={stop}
            className="max-h-full max-w-full rounded-lg object-contain"
          />
        )}

        {hasPrevious && (
          <button
            onClick={(event) => {
              event.stopPropagation();
              onNavigate(index - 1);
            }}
            title="Mídia anterior"
            aria-label="Mídia anterior"
            className="absolute left-3 top-1/2 -translate-y-1/2 rounded-full bg-white/10 p-2 text-white transition-colors hover:bg-white/20"
          >
            <ChevronLeft className="h-6 w-6" />
          </button>
        )}
        {hasNext && (
          <button
            onClick={(event) => {
              event.stopPropagation();
              onNavigate(index + 1);
            }}
            title="Próxima mídia"
            aria-label="Próxima mídia"
            className="absolute right-3 top-1/2 -translate-y-1/2 rounded-full bg-white/10 p-2 text-white transition-colors hover:bg-white/20"
          >
            <ChevronRight className="h-6 w-6" />
          </button>
        )}
      </div>

      {/* Rodapé: quem enviou e quando, no formato da bolha (hh:mm) mais a
          data — aqui não há separador de dia para situar a pessoa. */}
      <div className="shrink-0 p-3 text-center" onClick={stop}>
        <p className="text-sm font-medium text-white">{senderLabel}</p>
        <p className="text-xs text-white/60">
          {sentAt.toLocaleDateString("pt-BR")}{" · "}
          {sentAt.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })}
          {messages.length > 1 && <span>{" · "}{index + 1} de {messages.length}</span>}
        </p>
      </div>
    </div>
  );
}

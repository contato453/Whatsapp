"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  Ban,
  BarChart3,
  Check,
  CheckCheck,
  Clock,
  Copy,
  CornerUpLeft,
  Download,
  FileText,
  Forward,
  MapPin,
  Maximize2,
  MoreVertical,
  Pencil,
  Phone,
  PhoneMissed,
  Smile,
  Trash2,
  User,
  Video,
  XCircle,
} from "lucide-react";
import { fetchMediaBlobUrl } from "@/lib/api";
import { documentKindLabel, downloadMessageMedia } from "@/lib/media-download";
import { cn, formatPhone } from "@/lib/utils";
import type { MessageDto } from "@/lib/types";
import { Spinner } from "@/components/ui";
import { AudioPlayer } from "./audio-player";
import { FormattedText } from "./formatted-text";

/** Emojis oferecidos no acesso rápido de reação. */
export const QUICK_REACTIONS = ["👍", "❤️", "😂", "😮", "😢", "🙏"] as const;

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

function MediaContent({
  message,
  outbound,
  onOpenMedia,
}: {
  message: MessageDto;
  outbound: boolean;
  /** Abre a lightbox de tela cheia — quem gerencia é a Inbox. */
  onOpenMedia?: (message: MessageDto) => void;
}) {
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [downloadFailed, setDownloadFailed] = useState(false);
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
    setDownloadFailed(false);
    setDownloading(true);
    try {
      // Mesmo caminho autenticado da exibição — link comum não envia o
      // header Authorization, então o navegador só salva depois do fetch.
      await downloadMessageMedia(message);
    } catch {
      // O 401 já redirecionou para o login dentro do client; o que sobra é
      // arquivo que sumiu do storage ou falha de rede.
      setDownloadFailed(true);
    } finally {
      setDownloading(false);
    }
  }

  if (isVisual) {
    if (failed) return <p className="text-xs italic opacity-70">Falha ao carregar imagem</p>;
    if (!url) return <div className="h-40 w-52 animate-pulse rounded-lg bg-slate-200/60" />;
    return (
      <button
        type="button"
        onClick={() => onOpenMedia?.(message)}
        aria-label={message.type === "sticker" ? "Ampliar figurinha" : "Ampliar imagem"}
        className="block cursor-zoom-in"
      >
        <img src={url} alt="Imagem" className="max-h-72 max-w-full rounded-lg" />
      </button>
    );
  }
  if (isAudio) {
    if (failed) return <p className="text-xs italic opacity-70">Falha ao carregar áudio</p>;
    if (!url) return <div className="h-10 w-56 animate-pulse rounded-lg bg-slate-200/60" />;
    return <AudioPlayer src={url} outbound={outbound} />;
  }
  if (isVideo) {
    if (failed) return <p className="text-xs italic opacity-70">Falha ao carregar vídeo</p>;
    if (!url) return <div className="h-40 w-52 animate-pulse rounded-lg bg-slate-200/60" />;
    return (
      <div className="relative">
        <video controls src={url} className="max-h-72 max-w-full rounded-lg" />
        {/* O clique no vídeo fica com os controles nativos; ampliar ganha
            botão próprio para não disputar o play. */}
        <button
          type="button"
          onClick={() => onOpenMedia?.(message)}
          title="Ampliar vídeo"
          aria-label="Ampliar vídeo"
          className="absolute right-1.5 top-1.5 rounded-full bg-slate-900/60 p-1.5 text-white transition-colors hover:bg-slate-900/80"
        >
          <Maximize2 className="h-3.5 w-3.5" />
        </button>
      </div>
    );
  }
  // Documentos e demais tipos: cartão com o que existe (nome e tipo — tamanho
  // não é gravado pela ingestão) e botão de baixar com estado próprio.
  const kindLabel = documentKindLabel(message.mimeType);
  return (
    <div className="w-full min-w-0 rounded-lg bg-black/5 px-3 py-2">
      <div className="flex items-center gap-2.5">
        <FileText className="h-8 w-8 shrink-0 opacity-60" />
        <div className="min-w-0 flex-1">
          {/* Nome longo sem espaços (bem comum em anexo) não pode empurrar a
              bolha para fora da tela: corta com reticências; o nome inteiro
              fica acessível ao passar o mouse. */}
          <p className="truncate text-sm font-medium" title={message.filename ?? "Documento"}>
            {message.filename ?? "Documento"}
          </p>
          {kindLabel && (
            <p className="truncate text-xs opacity-60" title={kindLabel}>
              {kindLabel}
            </p>
          )}
        </div>
      </div>
      <button
        type="button"
        onClick={() => void download()}
        disabled={downloading}
        className="mt-1.5 flex items-center gap-1.5 text-xs font-medium underline-offset-2 transition-opacity hover:underline disabled:opacity-60"
      >
        {downloading ? (
          <Spinner
            className={cn("h-3 w-3", outbound ? "border-white/40 border-t-white" : undefined)}
          />
        ) : (
          <Download className="h-3 w-3" />
        )}
        {downloading ? "Baixando..." : "Baixar"}
      </button>
      {downloadFailed && (
        <p className="mt-1 text-xs italic opacity-80">Falha ao baixar o arquivo. Tente novamente.</p>
      )}
    </div>
  );
}

/** Agrupa reações iguais para exibir "👍 2". */
function groupReactions(message: MessageDto) {
  const map = new Map<string, { count: number; names: string[]; mine: boolean }>();
  for (const reaction of message.reactions) {
    const entry = map.get(reaction.emoji) ?? { count: 0, names: [], mine: false };
    entry.count += 1;
    if (reaction.senderName) entry.names.push(reaction.senderName);
    if (reaction.fromMe) entry.mine = true;
    map.set(reaction.emoji, entry);
  }
  return [...map.entries()];
}

export function MessageBubble({
  message,
  isGroup,
  showSender,
  onReact,
  onReply,
  onForward,
  onEdit,
  onDelete,
  onOpenMedia,
  senderAvatar,
}: {
  message: MessageDto;
  isGroup: boolean;
  showSender: boolean;
  onReact: (message: MessageDto, emoji: string) => void;
  onReply: (message: MessageDto) => void;
  onForward: (message: MessageDto) => void;
  onEdit: (message: MessageDto) => void;
  onDelete: (message: MessageDto) => void;
  /** Clique em imagem/vídeo/figurinha — abre a lightbox de tela cheia. */
  onOpenMedia?: (message: MessageDto) => void;
  /** Foto de quem enviou — exibida ao lado das mensagens recebidas */
  senderAvatar?: ReactNode;
}) {
  const outbound = message.direction === "outbound";
  const senderKey = message.senderExternalId ?? message.senderPhone ?? "?";
  const senderLabel =
    message.senderName ?? (message.senderPhone ? formatPhone(message.senderPhone) : "Desconhecido");
  const [menuOpen, setMenuOpen] = useState(false);
  const [emojiOpen, setEmojiOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const reactions = groupReactions(message);

  useEffect(() => {
    if (!menuOpen && !emojiOpen) return;
    const close = (event: MouseEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) {
        setMenuOpen(false);
        setEmojiOpen(false);
      }
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [menuOpen, emojiOpen]);

  return (
    <div
      ref={containerRef}
      className={cn("group relative flex items-end gap-1", outbound ? "justify-end" : "justify-start")}
    >
      {/* Foto de quem enviou (mensagens recebidas); espaçador nas seguintes
          do mesmo remetente para manter o alinhamento das bolhas. */}
      {!outbound && (
        <div className="mb-0.5 w-8 shrink-0">{showSender ? senderAvatar : null}</div>
      )}

      {/* Ações aparecem ao passar o mouse */}
      {outbound && (
        <MessageActions
          side="left"
          message={message}
          menuOpen={menuOpen}
          emojiOpen={emojiOpen}
          setMenuOpen={setMenuOpen}
          setEmojiOpen={setEmojiOpen}
          onReact={onReact}
          onReply={onReply}
          onForward={onForward}
          onEdit={onEdit}
          onDelete={onDelete}
        />
      )}

      <div
        className={cn(
          "max-w-[75%] overflow-hidden rounded-2xl px-3.5 py-2 shadow-sm",
          outbound
            ? "rounded-br-md bg-brand-600 text-white"
            : "rounded-bl-md border border-slate-200 bg-white text-slate-900",
        )}
      >
        {/* Identificação do participante em grupos (quando identificável) */}
        {isGroup && !outbound && showSender && (message.senderName || message.senderPhone) && (
          <p
            className="mb-0.5 flex items-center gap-1 text-xs font-semibold"
            style={{ color: senderColor(senderKey) }}
          >
            <User className="h-3 w-3" />
            {senderLabel}
            {message.senderPhone && message.senderName && (
              <span className="font-normal opacity-60">{formatPhone(message.senderPhone)}</span>
            )}
          </p>
        )}
        {outbound && message.senderName && showSender && (
          <p className="mb-0.5 text-xs font-semibold text-white/80">{message.senderName}</p>
        )}

        {/* Pré-visualização da mensagem citada */}
        {message.quoted && (
          <div
            className={cn(
              "mb-1.5 border-l-2 py-0.5 pl-2 text-xs",
              outbound ? "border-white/50 text-white/80" : "border-brand-400 text-slate-500",
            )}
          >
            <p className="font-semibold">{message.quoted.senderName ?? "Mensagem"}</p>
            <p className="line-clamp-2">
              {message.quoted.content ?? `[${message.quoted.type}]`}
            </p>
          </div>
        )}

        {message.deletedAt ? (
          <p
            className={cn(
              "flex items-center gap-1.5 text-sm italic",
              outbound ? "text-white/70" : "text-slate-400",
            )}
          >
            <Ban className="h-3.5 w-3.5" /> Esta mensagem foi apagada
          </p>
        ) : message.type === "call" ? (
          <p
            className={cn(
              "flex items-center gap-1.5 text-sm",
              message.metadata?.callStatus === "missed" ||
                message.metadata?.callStatus === "rejected"
                ? "text-red-600"
                : "text-slate-700",
            )}
          >
            {message.metadata?.isVideo ? (
              <Video className="h-4 w-4" />
            ) : message.metadata?.callStatus === "missed" ||
              message.metadata?.callStatus === "rejected" ? (
              <PhoneMissed className="h-4 w-4" />
            ) : (
              <Phone className="h-4 w-4" />
            )}
            {message.content ?? "Chamada"}
          </p>
        ) : message.type === "poll" ? (
          <div className="space-y-1.5">
            <p className="flex items-center gap-1.5 text-sm font-medium">
              <BarChart3 className="h-4 w-4" /> {message.content ?? "Enquete"}
            </p>
            <div className="space-y-1">
              {(message.metadata?.pollOptions ?? []).map((option, index) => (
                <div
                  key={index}
                  className={cn(
                    "rounded-md border px-2 py-1 text-xs",
                    outbound ? "border-white/30 bg-white/10" : "border-slate-200 bg-slate-50",
                  )}
                >
                  {option}
                </div>
              ))}
            </div>
            <p className={cn("text-[10px]", outbound ? "text-white/60" : "text-slate-400")}>
              Os votos aparecem no WhatsApp dos participantes
            </p>
          </div>
        ) : message.type === "location" ? (
          <p className="flex items-center gap-1.5 text-sm">
            <MapPin className="h-4 w-4" /> {message.content ?? "Localização"}
          </p>
        ) : message.type === "text" ? (
          <FormattedText
            text={message.content ?? ""}
            className="whitespace-pre-wrap break-words text-sm"
          />
        ) : (
          <div className="space-y-1.5">
            <MediaContent message={message} outbound={outbound} onOpenMedia={onOpenMedia} />
            {message.content && (
              <FormattedText
                text={message.content}
                className="whitespace-pre-wrap break-words text-sm"
              />
            )}
          </div>
        )}

        <p
          className={cn(
            "mt-1 flex items-center justify-end gap-1 text-[10px]",
            outbound ? "text-white/70" : "text-slate-400",
          )}
        >
          {message.editedAt && !message.deletedAt && <span className="italic">editada</span>}
          {new Date(message.timestamp).toLocaleTimeString("pt-BR", {
            hour: "2-digit",
            minute: "2-digit",
          })}
          {outbound && !message.deletedAt && <StatusIcon status={message.status} />}
        </p>

        {/* Reações */}
        {reactions.length > 0 && (
          <div className="mt-1 flex flex-wrap gap-1">
            {reactions.map(([emoji, info]) => (
              <button
                key={emoji}
                onClick={() => onReact(message, info.mine ? "" : emoji)}
                title={info.names.join(", ")}
                className={cn(
                  "flex items-center gap-0.5 rounded-full border px-1.5 py-0.5 text-[11px] transition-colors",
                  info.mine
                    ? "border-brand-400 bg-brand-50 text-brand-700"
                    : outbound
                      ? "border-white/30 bg-white/15 text-white"
                      : "border-slate-200 bg-slate-50 text-slate-600",
                )}
              >
                <span>{emoji}</span>
                {info.count > 1 && <span className="font-medium">{info.count}</span>}
              </button>
            ))}
          </div>
        )}
      </div>

      {!outbound && (
        <MessageActions
          side="right"
          message={message}
          menuOpen={menuOpen}
          emojiOpen={emojiOpen}
          setMenuOpen={setMenuOpen}
          setEmojiOpen={setEmojiOpen}
          onReact={onReact}
          onReply={onReply}
          onForward={onForward}
          onEdit={onEdit}
          onDelete={onDelete}
        />
      )}
    </div>
  );
}

function MessageActions({
  side,
  message,
  menuOpen,
  emojiOpen,
  setMenuOpen,
  setEmojiOpen,
  onReact,
  onReply,
  onForward,
  onEdit,
  onDelete,
}: {
  side: "left" | "right";
  message: MessageDto;
  menuOpen: boolean;
  emojiOpen: boolean;
  setMenuOpen: (value: boolean) => void;
  setEmojiOpen: (value: boolean) => void;
  onReact: (message: MessageDto, emoji: string) => void;
  onReply: (message: MessageDto) => void;
  onForward: (message: MessageDto) => void;
  onEdit: (message: MessageDto) => void;
  onDelete: (message: MessageDto) => void;
}) {
  const outbound = message.direction === "outbound";
  const canEdit = outbound && message.type === "text" && !message.deletedAt;
  const canDelete = outbound && !message.deletedAt;

  if (message.deletedAt) return null;

  return (
    <div
      className={cn(
        "relative flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100",
        (menuOpen || emojiOpen) && "opacity-100",
      )}
    >
      <button
        onClick={() => {
          setEmojiOpen(!emojiOpen);
          setMenuOpen(false);
        }}
        title="Reagir"
        className="rounded-full p-1 text-slate-400 hover:bg-slate-200 hover:text-slate-600"
      >
        <Smile className="h-4 w-4" />
      </button>
      <button
        onClick={() => {
          setMenuOpen(!menuOpen);
          setEmojiOpen(false);
        }}
        title="Mais ações"
        className="rounded-full p-1 text-slate-400 hover:bg-slate-200 hover:text-slate-600"
      >
        <MoreVertical className="h-4 w-4" />
      </button>

      {emojiOpen && (
        <div
          className={cn(
            "absolute bottom-full z-20 mb-1 flex gap-0.5 rounded-full border border-slate-200 bg-white p-1 shadow-lg",
            side === "left" ? "left-0" : "right-0",
          )}
        >
          {QUICK_REACTIONS.map((emoji) => (
            <button
              key={emoji}
              onClick={() => {
                onReact(message, emoji);
                setEmojiOpen(false);
              }}
              className="rounded-full px-1 text-lg transition-transform hover:scale-125"
            >
              {emoji}
            </button>
          ))}
        </div>
      )}

      {menuOpen && (
        <div
          className={cn(
            "absolute bottom-full z-20 mb-1 w-44 overflow-hidden rounded-lg border border-slate-200 bg-white py-1 shadow-lg",
            side === "left" ? "left-0" : "right-0",
          )}
        >
          <button
            onClick={() => {
              onReply(message);
              setMenuOpen(false);
            }}
            className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-slate-700 hover:bg-slate-50"
          >
            <CornerUpLeft className="h-3.5 w-3.5" /> Responder
          </button>
          <button
            onClick={() => {
              onForward(message);
              setMenuOpen(false);
            }}
            className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-slate-700 hover:bg-slate-50"
          >
            <Forward className="h-3.5 w-3.5" /> Encaminhar
          </button>
          {message.content && (
            <button
              onClick={() => {
                void navigator.clipboard.writeText(message.content ?? "");
                setMenuOpen(false);
              }}
              className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-slate-700 hover:bg-slate-50"
            >
              <Copy className="h-3.5 w-3.5" /> Copiar texto
            </button>
          )}
          {canEdit && (
            <button
              onClick={() => {
                onEdit(message);
                setMenuOpen(false);
              }}
              className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-slate-700 hover:bg-slate-50"
            >
              <Pencil className="h-3.5 w-3.5" /> Editar
            </button>
          )}
          {canDelete && (
            <button
              onClick={() => {
                onDelete(message);
                setMenuOpen(false);
              }}
              className="flex w-full items-center gap-2 border-t border-slate-100 px-3 py-1.5 text-left text-xs text-red-600 hover:bg-red-50"
            >
              <Trash2 className="h-3.5 w-3.5" /> Apagar para todos
            </button>
          )}
        </div>
      )}
    </div>
  );
}

"use client";

import { useEffect, useState } from "react";
import { ChevronLeft, ChevronRight, Pin, PinOff, StickyNote, User } from "lucide-react";
import type { PinnedItemDto } from "@/lib/types";
import { cn } from "@/lib/utils";
import { splitLinkParts } from "./formatted-text";

/**
 * Rótulo por tipo quando a mensagem fixada não é texto — a faixa mostra o
 * TIPO e a legenda, nunca a mídia inteira (uma foto ocupando o topo da
 * conversa inteira derrotaria o próprio propósito da faixa).
 */
const TYPE_LABELS: Record<string, string> = {
  image: "Imagem",
  audio: "Áudio",
  video: "Vídeo",
  document: "Documento",
  sticker: "Figurinha",
  location: "Localização",
  contact: "Contato",
  poll: "Enquete",
  call: "Chamada",
  other: "Mensagem",
};

/** Texto (ou legenda) mais o rótulo do tipo, para a mensagem não-texto. */
function pinnedText(item: PinnedItemDto): { text: string; senderName: string | null } {
  if (item.kind === "note") {
    return { text: item.note?.content ?? "", senderName: item.note?.user?.name ?? null };
  }
  const message = item.message;
  if (!message) return { text: "", senderName: null };
  const senderName =
    message.senderName ?? (message.direction === "outbound" ? "Você" : null);
  if (message.type === "text") return { text: message.content ?? "", senderName };
  const label = TYPE_LABELS[message.type] ?? "Mensagem";
  return { text: message.content ? `${label} — ${message.content}` : label, senderName };
}

/** Nós React (nunca HTML) — mesma regra de `formatted-text.tsx`: o
 * conteúdo é de fora e vira link só quando é http/https ou "www.". */
function LinkifiedPreview({ text }: { text: string }) {
  const parts = splitLinkParts(text);
  return (
    <>
      {parts.map((part, index) =>
        part.kind === "link" ? (
          <a
            key={index}
            href={part.href}
            target="_blank"
            rel="noopener noreferrer"
            onClick={(event) => event.stopPropagation()}
            className="underline decoration-dotted underline-offset-2 hover:decoration-solid"
          >
            {part.label}
          </a>
        ) : (
          <span key={index}>{part.value}</span>
        ),
      )}
    </>
  );
}

/**
 * Faixa fixa no topo da janela de mensagens. Some por completo (não ocupa
 * espaço) quando não há nada fixado — é por isso que quem chama só desenha
 * este componente quando `items.length > 0`.
 *
 * Fica ACIMA da área rolável de mensagens, em fluxo normal de documento: o
 * separador de data da conversa não é `position: sticky`/`fixed` (é só um
 * selo centralizado dentro da rolagem), então não existe disputa de
 * empilhamento entre os dois — a faixa nunca fica por cima nem por baixo do
 * separador porque eles nunca ocupam a mesma camada.
 */
export function PinnedBanner({
  items,
  canManage,
  onJump,
  onUnpin,
}: {
  items: PinnedItemDto[];
  /** Mesma chave (`message.pin`) que decide o botão no menu da bolha —
   * esconder e recusar andam sempre juntos. */
  canManage: boolean;
  onJump: (item: PinnedItemDto) => void;
  onUnpin: (item: PinnedItemDto) => void;
}) {
  const [index, setIndex] = useState(0);

  // Fixar uma quarta ou desafixar a atual pode encolher a lista: sem isto o
  // índice ficaria apontando para fora do array e a faixa mostraria vazio.
  useEffect(() => {
    if (index >= items.length && items.length > 0) setIndex(items.length - 1);
  }, [items.length, index]);

  if (items.length === 0) return null;
  const current = items[Math.min(index, items.length - 1)] as PinnedItemDto;
  const { text, senderName } = pinnedText(current);
  const isNote = current.kind === "note";

  return (
    <div
      className={cn(
        "flex items-center gap-2 border-b px-4 py-2",
        isNote ? "border-amber-200 bg-amber-50" : "border-slate-200 bg-brand-50",
      )}
    >
      {isNote ? (
        <StickyNote className="h-4 w-4 shrink-0 text-amber-600" />
      ) : (
        <Pin className="h-4 w-4 shrink-0 text-brand-600" />
      )}

      <button
        type="button"
        onClick={() => onJump(current)}
        className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
        title="Ir até a mensagem fixada"
      >
        {isNote && (
          <span className="shrink-0 text-[10px] font-semibold uppercase tracking-wide text-amber-700">
            Nota interna ·
          </span>
        )}
        {senderName && (
          <span className="flex shrink-0 items-center gap-0.5 text-[11px] font-medium text-slate-500">
            <User className="h-3 w-3" />
            {senderName}
          </span>
        )}
        {/* A faixa trunca em UMA linha sem quebrar o layout: overflow
            escondido + reticências, com o conteúdo (texto e link) fluindo
            como inline dentro de um bloco só. */}
        <span className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap text-sm text-slate-700">
          {text ? (
            <LinkifiedPreview text={text} />
          ) : (
            <span className="italic text-slate-400">Sem conteúdo</span>
          )}
        </span>
      </button>

      {items.length > 1 && (
        <div className="flex shrink-0 items-center gap-0.5 text-slate-400">
          <button
            type="button"
            onClick={() => setIndex((value) => (value - 1 + items.length) % items.length)}
            className="rounded p-0.5 hover:bg-black/5 hover:text-slate-600"
            title="Fixada anterior"
          >
            <ChevronLeft className="h-3.5 w-3.5" />
          </button>
          <span className="text-[11px] tabular-nums">
            {index + 1} de {items.length}
          </span>
          <button
            type="button"
            onClick={() => setIndex((value) => (value + 1) % items.length)}
            className="rounded p-0.5 hover:bg-black/5 hover:text-slate-600"
            title="Próxima fixada"
          >
            <ChevronRight className="h-3.5 w-3.5" />
          </button>
        </div>
      )}

      {canManage && (
        <button
          type="button"
          onClick={() => onUnpin(current)}
          className="shrink-0 rounded p-1 text-slate-400 hover:bg-black/5 hover:text-red-600"
          title="Desafixar"
        >
          <PinOff className="h-4 w-4" />
        </button>
      )}
    </div>
  );
}

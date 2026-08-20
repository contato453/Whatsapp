"use client";

import { Pencil, Pin, PinOff, StickyNote, Trash2 } from "lucide-react";
import { canManageInternalNote } from "@azvchat/shared";
import { api } from "@/lib/api";
import { cn, formatDateTime } from "@/lib/utils";
import type { NoteDto } from "@/lib/types";
import { useAuth } from "@/lib/auth-context";

/**
 * Nota interna — nunca vai para o WhatsApp.
 *
 * A mesma nota aparece em dois lugares da tela de Conversas: intercalada no
 * chat (cartão amarelo) e no bloco "Notas internas" do painel lateral. Editar
 * e excluir vivem aqui, e não em cada lugar, porque botão duplicado é regra
 * duplicada: bastaria alguém mexer só no cartão para o painel continuar
 * oferecendo o lápis a quem a API recusa.
 *
 * Não há evento de socket novo: quem edita ou exclui recarrega o detalhe da
 * conversa, e os dois lugares leem a MESMA lista (`detail.notes`) — o cartão e
 * o item do painel mudam juntos, na hora, sem recarregar a página. A criação
 * continua chegando pelo `note:new`, como antes.
 */

/**
 * Botões de fixar/desafixar, editar e excluir. Um só desenho para os dois
 * lugares — `canManage` e `canPin` são chaves INDEPENDENTES (a de nota é
 * "é sua, ou você é supervisor/admin"; a de fixar é o catálogo
 * `message.pin`), então cada bloco de botões aparece por conta própria.
 */
function InternalNoteActions({
  note,
  canManage,
  pinned,
  canPin,
  onEdit,
  onDelete,
  onPin,
  onUnpin,
  className,
}: {
  note: NoteDto;
  canManage: boolean;
  pinned: boolean;
  canPin: boolean;
  onEdit: (note: NoteDto) => void;
  onDelete: (note: NoteDto) => void;
  onPin: (note: NoteDto) => void;
  onUnpin: (note: NoteDto) => void;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "absolute right-1 top-1 flex gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100",
        className,
      )}
    >
      {canPin &&
        (pinned ? (
          <button
            type="button"
            onClick={() => onUnpin(note)}
            title="Desafixar nota"
            className="rounded p-1 text-amber-600/70 hover:bg-amber-100 hover:text-amber-800"
          >
            <PinOff className="h-3 w-3" />
          </button>
        ) : (
          <button
            type="button"
            onClick={() => onPin(note)}
            title="Fixar nota no topo da conversa"
            className="rounded p-1 text-amber-600/70 hover:bg-amber-100 hover:text-amber-800"
          >
            <Pin className="h-3 w-3" />
          </button>
        ))}
      {canManage && (
        <>
          <button
            type="button"
            onClick={() => onEdit(note)}
            title="Editar nota"
            className="rounded p-1 text-amber-600/70 hover:bg-amber-100 hover:text-amber-800"
          >
            <Pencil className="h-3 w-3" />
          </button>
          <button
            type="button"
            onClick={() => onDelete(note)}
            title="Apagar nota"
            className="rounded p-1 text-amber-600/70 hover:bg-red-50 hover:text-red-600"
          >
            <Trash2 className="h-3 w-3" />
          </button>
        </>
      )}
    </div>
  );
}

/**
 * Decide se ESTE usuário pode mexer nesta nota. A regra é a de
 * `@azvchat/shared`, a mesma que a API aplica na rota — o hook existe só para
 * a tela não repetir a leitura da sessão em cada lugar.
 */
export function useCanManageNote(): (note: NoteDto) => boolean {
  const { user: me, can } = useAuth();
  // A MESMA chave que a API confere. Resolvida uma vez: o histórico repete
  // a checagem por nota.
  const canManageOthers = can("note.delete_other");
  return (note: NoteDto) =>
    canManageInternalNote({
      authorId: note.user?.id ?? null,
      actorId: me?.id ?? null,
      canManageOthers,
    });
}

/** Cartão amarelo intercalado no chat. */
export function InternalNoteBubble({
  note,
  canManage,
  pinned,
  canPin,
  onEdit,
  onDelete,
  onPin,
  onUnpin,
}: {
  note: NoteDto;
  canManage: boolean;
  pinned: boolean;
  canPin: boolean;
  onEdit: (note: NoteDto) => void;
  onDelete: (note: NoteDto) => void;
  onPin: (note: NoteDto) => void;
  onUnpin: (note: NoteDto) => void;
}) {
  return (
    <div className="group flex justify-center py-1">
      <div className="relative max-w-[80%] rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 shadow-sm">
        <p className="mb-0.5 flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide text-amber-700">
          <StickyNote className="h-3 w-3" /> Nota interna
          {pinned && <Pin className="h-3 w-3" aria-label="Nota fixada" />}
        </p>
        <p className="whitespace-pre-wrap break-words text-sm text-slate-700">{note.content}</p>
        <p className="mt-1 text-[10px] text-amber-600/80">
          {note.user?.name ?? "—"} ·{" "}
          {new Date(note.createdAt).toLocaleString("pt-BR", {
            day: "2-digit",
            month: "2-digit",
            hour: "2-digit",
            minute: "2-digit",
          })}
        </p>
        {(canManage || canPin) && (
          <InternalNoteActions
            note={note}
            canManage={canManage}
            pinned={pinned}
            canPin={canPin}
            onEdit={onEdit}
            onDelete={onDelete}
            onPin={onPin}
            onUnpin={onUnpin}
          />
        )}
      </div>
    </div>
  );
}

/**
 * Item do bloco "Notas internas" do painel lateral. Mesmo conteúdo do cartão
 * em corpo menor; os botões são literalmente os mesmos. O `pr-12` só entra
 * quando há botão, senão o texto ficaria estreito à toa.
 */
export function InternalNotePanelItem({
  note,
  canManage,
  pinned,
  canPin,
  onEdit,
  onDelete,
  onPin,
  onUnpin,
}: {
  note: NoteDto;
  canManage: boolean;
  pinned: boolean;
  canPin: boolean;
  onEdit: (note: NoteDto) => void;
  onDelete: (note: NoteDto) => void;
  onPin: (note: NoteDto) => void;
  onUnpin: (note: NoteDto) => void;
}) {
  return (
    <div
      className={cn(
        "group relative rounded-lg border-l-2 border-amber-400 bg-amber-50 p-2.5",
        (canManage || canPin) && "pr-12",
      )}
    >
      <p className="flex items-center gap-1 whitespace-pre-wrap break-words text-xs text-slate-700">
        {note.content}
        {pinned && <Pin className="h-3 w-3 shrink-0 text-amber-600" aria-label="Nota fixada" />}
      </p>
      <p className="mt-1 text-[10px] text-slate-400">
        {note.user?.name ?? "—"} · {formatDateTime(note.createdAt)}
      </p>
      {(canManage || canPin) && (
        <InternalNoteActions
          note={note}
          canManage={canManage}
          pinned={pinned}
          canPin={canPin}
          onEdit={onEdit}
          onDelete={onDelete}
          onPin={onPin}
          onUnpin={onUnpin}
        />
      )}
    </div>
  );
}

export interface InternalNoteHandlers {
  edit: (note: NoteDto) => void;
  delete: (note: NoteDto) => void;
}

/**
 * Editar e excluir nota: uma implementação só, usada pelo cartão do chat e
 * pelo item do painel. `onChanged` é o mesmo `loadDetail` que a conversa já
 * usa — é ele que faz os dois lugares refletirem a mudança na hora.
 */
export function internalNoteActions(
  conversationId: string | undefined,
  onChanged: () => void,
): InternalNoteHandlers {
  async function edit(note: NoteDto) {
    if (!conversationId) return;
    const next = window.prompt("Editar nota interna:", note.content);
    if (next === null) return;
    const content = next.trim();
    if (!content || content === note.content) return;
    try {
      await api.patch(`/conversations/${conversationId}/notes/${note.id}`, { content });
      onChanged();
    } catch (err) {
      window.alert(err instanceof Error ? err.message : "Falha ao editar nota");
    }
  }

  async function remove(note: NoteDto) {
    if (!conversationId) return;
    if (!window.confirm("Apagar esta nota interna?")) return;
    try {
      await api.delete(`/conversations/${conversationId}/notes/${note.id}`);
      onChanged();
    } catch (err) {
      window.alert(err instanceof Error ? err.message : "Falha ao apagar nota");
    }
  }

  return {
    edit: (note) => void edit(note),
    delete: (note) => void remove(note),
  };
}

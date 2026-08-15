"use client";

import { useState } from "react";
import { Archive, ArchiveRestore } from "lucide-react";
import { conversationArchiveApi } from "@/lib/api";
import { formatDateTime } from "@/lib/utils";
import type { ConversationDto } from "@/lib/types";
import { Button } from "@/components/ui";

/**
 * Faixa discreta no topo do chat de uma conversa arquivada, com o botão de
 * desarquivar ali mesmo. Fica fora do inbox-shell de propósito: o shell já é
 * o maior arquivo do projeto e esta faixa é autocontida.
 *
 * A conversa arquivada abre e responde normalmente (é assim que se lê o
 * histórico achado pela busca) — responder NÃO desarquiva.
 */
export function ArchivedBanner({
  conversation,
  onUnarchived,
}: {
  conversation: ConversationDto;
  onUnarchived: () => void;
}) {
  const [busy, setBusy] = useState(false);
  if (!conversation.archivedAt) return null;

  async function unarchive() {
    setBusy(true);
    try {
      await conversationArchiveApi.unarchive(conversation.id);
      onUnarchived();
    } catch (err) {
      window.alert(err instanceof Error ? err.message : "Falha ao desarquivar");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-slate-300 bg-slate-100 px-4 py-2">
      <Archive className="h-3.5 w-3.5 shrink-0 text-slate-500" />
      <p className="min-w-0 flex-1 text-xs text-slate-600">
        Conversa arquivada
        {conversation.archivedBy ? ` por ${conversation.archivedBy.name}` : " automaticamente"} em{" "}
        {formatDateTime(conversation.archivedAt)}. Ela não aparece na Inbox nem conta nos números
        do sistema; dá para ler e responder, e responder não desarquiva.
      </p>
      <Button size="sm" variant="outline" disabled={busy} onClick={() => void unarchive()}>
        <ArchiveRestore className="h-3.5 w-3.5" />
        {busy ? "Desarquivando..." : "Desarquivar"}
      </Button>
    </div>
  );
}

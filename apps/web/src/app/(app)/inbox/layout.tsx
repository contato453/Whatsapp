"use client";

import type { ReactNode } from "react";
import { useParams } from "next/navigation";
import { InboxShell } from "@/components/inbox/inbox-shell";

/**
 * A Inbox inteira vive neste layout, e não nas páginas, de propósito.
 *
 * No App Router, página remonta a cada navegação — o valor do segmento
 * dinâmico entra na chave da árvore —, e era exatamente isso que zerava os
 * filtros da lista: cada clique numa conversa trocava de página
 * (`/inbox` → `/inbox/<id>`), o `InboxShell` renderizado pela página era
 * desmontado e remontado, e todo `useState` dele renascia com o padrão. O
 * atendente montava o recorte e perdia tudo no primeiro clique.
 *
 * Layout preserva estado entre as navegações dos filhos, então o shell é
 * montado uma vez e a conversa aberta vira só uma prop lida da URL. Não
 * reintroduza o shell dentro das páginas: o bug voltaria na hora.
 */
export default function InboxLayout({ children }: { children: ReactNode }) {
  const params = useParams<{ conversationId?: string }>();
  const conversationId =
    typeof params.conversationId === "string" ? params.conversationId : undefined;
  return (
    <>
      <InboxShell conversationId={conversationId} />
      {children}
    </>
  );
}

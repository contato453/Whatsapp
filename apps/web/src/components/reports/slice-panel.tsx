"use client";

import { useCallback, useEffect, useState } from "react";
import { ExternalLink, Users, X } from "lucide-react";
import { CONVERSATION_STATUS_LABELS } from "@azvchat/shared";
import { reportsApi, type ReportFilters } from "@/lib/api";
import { rowLabel, type ReportSlice } from "@/lib/report-cells";
import type { ConversationDto } from "@/lib/types";
import { Button, EmptyState, Spinner } from "@/components/ui";

/**
 * Painel lateral do relatório: as conversas que formam o número da célula.
 *
 * Ele existe para responder "QUAIS conversas são essas?" sem sair da tela —
 * antes a pessoa ia até a Inbox e remontava o filtro na mão, e o filtro
 * remontado quase nunca era o mesmo recorte.
 *
 * Três coisas não são negociáveis aqui: a lista vem de `GET /conversations`
 * (a mesma rota da Inbox, com o mesmo escopo de acesso, então o painel nunca
 * mostra conversa que quem está olhando não veria lá); o total exibido é o
 * `total` que a API devolveu, não o tamanho da página carregada; e a carga é
 * sob demanda e paginada, porque uma célula sozinha pode ter centenas de
 * conversas.
 */

/** Tamanho da página. A célula grande carrega aos poucos, sem travar a tela. */
const PAGE_SIZE = 25;

export function ReportSlicePanel({
  slice,
  filters,
  onClose,
  reloadToken,
}: {
  slice: ReportSlice;
  /**
   * Os filtros da barra. Vão para a listagem junto com o recorte da célula,
   * senão o painel mostraria o recorte inteiro enquanto a célula mostra o
   * filtrado — e o número deixaria de bater com a lista.
   */
  filters: ReportFilters;
  onClose: () => void;
  /** Muda a cada "Atualizar" da tela: o painel recarrega junto. */
  reloadToken: number;
}) {
  const [conversations, setConversations] = useState<ConversationDto[]>([]);
  const [total, setTotal] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchPage = useCallback(
    async (offset: number) => {
      const data = await reportsApi.sliceConversations(slice.query, filters, offset, PAGE_SIZE);
      setTotal(data.total);
      setConversations((atual) =>
        offset === 0 ? data.conversations : [...atual, ...data.conversations],
      );
    },
    [slice.query, filters],
  );

  // Recarrega do zero quando o recorte muda ou a tela é atualizada: painel
  // exibindo o resultado de outro recorte é pior do que painel fechado.
  useEffect(() => {
    let cancelado = false;
    setLoading(true);
    setError(null);
    setConversations([]);
    setTotal(null);
    fetchPage(0)
      .catch((err: unknown) => {
        if (cancelado) return;
        setError(err instanceof Error ? err.message : "Erro ao carregar as conversas");
      })
      .finally(() => {
        if (!cancelado) setLoading(false);
      });
    return () => {
      cancelado = true;
    };
  }, [fetchPage, reloadToken]);

  // Esc fecha, como em todo painel sobreposto do sistema.
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  async function loadMore() {
    setLoadingMore(true);
    try {
      await fetchPage(conversations.length);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Erro ao carregar mais conversas");
    } finally {
      setLoadingMore(false);
    }
  }

  const carregadas = conversations.length;
  const faltam = total != null && carregadas < total;

  return (
    <>
      {/*
       * Em tela estreita o painel vira sobreposição, com um fundo escurecido
       * que também fecha ao clique: espremer uma coluna a mais ao lado de uma
       * tabela de oito colunas quebraria as duas.
       */}
      <div
        className="fixed inset-0 z-30 bg-slate-900/30 lg:hidden"
        onClick={onClose}
        aria-hidden
      />
      <aside
        className="fixed inset-y-0 right-0 z-40 flex w-full max-w-md flex-col border-l border-slate-200 bg-white shadow-xl lg:static lg:z-auto lg:h-full lg:w-96 lg:max-w-none lg:shadow-none"
        aria-label="Conversas do recorte selecionado"
      >
        <header className="flex items-start gap-2 border-b border-slate-100 p-4">
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-semibold text-slate-900">
              {rowLabel(slice.row)}
            </p>
            <p className="text-xs text-slate-500">
              {slice.columnLabel} ·{" "}
              {slice.cellValue === 1 ? "1 conversa" : `${slice.cellValue} conversas`}
            </p>
            <p className="mt-0.5 text-[11px] text-slate-400">{slice.scopeNote}</p>
          </div>
          <button
            onClick={onClose}
            className="rounded-lg p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600"
            aria-label="Fechar painel"
          >
            <X className="h-4 w-4" />
          </button>
        </header>

        <div className="thin-scroll flex-1 overflow-y-auto">
          {loading ? (
            <div className="flex justify-center py-12">
              <Spinner className="h-6 w-6" />
            </div>
          ) : error ? (
            <p className="p-4 text-sm text-red-600">{error}</p>
          ) : conversations.length === 0 ? (
            <div className="p-4">
              <EmptyState
                title="Nenhuma conversa"
                description="O recorte não devolveu conversas visíveis para você."
              />
            </div>
          ) : (
            <ul className="divide-y divide-slate-100">
              {conversations.map((conversation) => (
                <li key={conversation.id}>
                  {/*
                   * Âncora de verdade, e não `window.open`: abre em nova aba
                   * com o relatório intacto atrás, e ainda responde ao clique
                   * do meio e ao teclado.
                   */}
                  <a
                    href={`/inbox/${conversation.id}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-start gap-2 px-4 py-3 hover:bg-slate-50"
                  >
                    <div className="min-w-0 flex-1">
                      <p className="flex items-center gap-1 truncate text-sm font-medium text-slate-900">
                        {conversation.type === "group" && (
                          <Users className="h-3.5 w-3.5 shrink-0 text-slate-400" />
                        )}
                        <span className="truncate">{conversation.title}</span>
                      </p>
                      <p className="truncate text-xs text-slate-400">
                        {conversation.instanceName ?? "Sem conexão"} ·{" "}
                        {CONVERSATION_STATUS_LABELS[conversation.status]} ·{" "}
                        {formatLastMessage(conversation.lastMessageAt)}
                      </p>
                    </div>
                    <ExternalLink className="mt-0.5 h-3.5 w-3.5 shrink-0 text-slate-300" />
                  </a>
                </li>
              ))}
            </ul>
          )}
        </div>

        {total != null && conversations.length > 0 && (
          <footer className="border-t border-slate-100 p-3">
            <p className="mb-2 text-center text-[11px] text-slate-400">
              Mostrando {carregadas} de {total}
            </p>
            {faltam && (
              <Button
                variant="outline"
                size="sm"
                className="w-full"
                onClick={() => void loadMore()}
                disabled={loadingMore}
              >
                {loadingMore ? "Carregando..." : "Carregar mais"}
              </Button>
            )}
          </footer>
        )}
      </aside>
    </>
  );
}

/** "14/08 09:31" — data curta basta para ordenar a leitura. */
function formatLastMessage(iso: string | null): string {
  if (!iso) return "sem mensagem";
  return new Date(iso).toLocaleString("pt-BR", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

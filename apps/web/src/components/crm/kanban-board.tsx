"use client";

import { useState } from "react";
import { formatCurrencyBRL } from "@azvchat/shared";
import type { CrmBoardColumnDto, CrmOpportunityDto } from "@/lib/types";
import { cn } from "@/lib/utils";
import { OpportunityCard } from "./opportunity-card";

/**
 * O quadro.
 *
 * ARRASTAR É HTML5 NATIVO. Nenhuma biblioteca entrou por causa disto: o
 * comportamento que a tela precisa (pegar, passar por cima de uma coluna,
 * soltar entre dois cards) cabe em três eventos, e uma dependência de arrastar
 * traria consigo um contexto próprio, um provedor no topo da árvore e uma
 * migração a cada major.
 *
 * SOLTAR É OTIMISTA, mas nunca cego: o card se move na hora e a chamada leva
 * `fromStageId` — a etapa que ESTA tela acredita ser a atual. Se o servidor
 * discordar (outra pessoa moveu antes), ele recusa com 409 e a página
 * recarrega o quadro. Sem isso, o último arrasto venceria sempre e o primeiro
 * sumiria sem ninguém ver.
 *
 * A COLUNA MOSTRA O TOTAL DELA INTEIRA, e não a soma dos cards carregados: o
 * topo diria R$ 48.000 com R$ 120.000 de verdade lá embaixo, e é assim que um
 * painel perde a confiança da equipe.
 */
export function KanbanBoard({
  columns,
  onOpen,
  onMove,
  moving,
}: {
  columns: CrmBoardColumnDto[];
  onOpen: (opportunity: CrmOpportunityDto) => void;
  onMove: (input: {
    opportunity: CrmOpportunityDto;
    toStageId: string;
    beforeId: string | null;
    afterId: string | null;
  }) => void;
  /** Id do card em movimento — desenha o estado "salvando". */
  moving: string | null;
}) {
  const [arrastando, setArrastando] = useState<CrmOpportunityDto | null>(null);
  const [colunaAlvo, setColunaAlvo] = useState<string | null>(null);

  function soltarNaColuna(coluna: CrmBoardColumnDto, indice: number | null) {
    const card = arrastando;
    setArrastando(null);
    setColunaAlvo(null);
    if (!card) return;

    const naColuna = coluna.opportunities.filter((item) => item.id !== card.id);
    const posicao = indice === null ? naColuna.length : indice;
    // Mesma coluna e mesma posição: nada mudou, e uma chamada aqui só
    // produziria um evento de socket para todo mundo sem motivo.
    if (card.stageId === coluna.stage.id) {
      const atual = coluna.opportunities.findIndex((item) => item.id === card.id);
      if (atual === posicao || atual === posicao - 1) return;
    }
    onMove({
      opportunity: card,
      toStageId: coluna.stage.id,
      beforeId: posicao > 0 ? (naColuna[posicao - 1]?.id ?? null) : null,
      afterId: naColuna[posicao]?.id ?? null,
    });
  }

  return (
    // Rolagem horizontal na própria faixa: em tela estreita (tablet, celular)
    // as colunas continuam inteiras e legíveis em vez de espremidas até
    // ficarem inúteis. O corpo da página nunca rola de lado.
    <div className="thin-scroll flex h-full gap-3 overflow-x-auto px-4 pb-4">
      {columns.map((coluna) => (
        <section
          key={coluna.stage.id}
          onDragOver={(event) => {
            // Sem `preventDefault` o navegador recusa o "soltar" — e o card
            // volta para a origem sem explicação nenhuma.
            event.preventDefault();
            setColunaAlvo(coluna.stage.id);
          }}
          onDragLeave={() => setColunaAlvo((atual) => (atual === coluna.stage.id ? null : atual))}
          onDrop={(event) => {
            event.preventDefault();
            soltarNaColuna(coluna, null);
          }}
          className={cn(
            "flex w-72 shrink-0 flex-col rounded-xl border bg-slate-50/70",
            colunaAlvo === coluna.stage.id
              ? "border-brand-400 bg-brand-50/50"
              : "border-slate-200",
          )}
        >
          <header className="border-b border-slate-200 px-3 py-2">
            <div className="flex items-center justify-between gap-2">
              <span className="flex min-w-0 items-center gap-1.5">
                <span
                  className="h-2.5 w-2.5 shrink-0 rounded-full"
                  style={{ backgroundColor: coluna.stage.color }}
                  aria-hidden
                />
                <h2 className="truncate text-sm font-semibold text-slate-800">
                  {coluna.stage.name}
                </h2>
              </span>
              <span className="shrink-0 rounded-full bg-white px-1.5 py-0.5 text-[11px] font-medium text-slate-600">
                {coluna.totals.count}
              </span>
            </div>
            <p className="mt-0.5 text-[11px] text-slate-500">
              {formatCurrencyBRL(coluna.totals.value)}
              {coluna.totals.weightedValue !== coluna.totals.value && (
                <span className="text-slate-400">
                  {" · "}
                  {formatCurrencyBRL(coluna.totals.weightedValue)} ponderado
                </span>
              )}
            </p>
            <p className="text-[10px] text-slate-400">
              {coluna.stage.probability}% de chance
              {coluna.averageDaysInStage > 0 && ` · ${coluna.averageDaysInStage} dia(s) em média`}
            </p>
          </header>

          <div className="thin-scroll flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-2">
            {coluna.opportunities.map((oportunidade, indice) => (
              <div
                key={oportunidade.id}
                onDragOver={(event) => event.preventDefault()}
                onDrop={(event) => {
                  // O drop do CARD não pode subir para a coluna: os dois
                  // gravariam, e o segundo desfaria a posição do primeiro.
                  event.stopPropagation();
                  event.preventDefault();
                  soltarNaColuna(coluna, indice);
                }}
                className={cn(moving === oportunidade.id && "animate-pulse")}
              >
                <OpportunityCard
                  opportunity={oportunidade}
                  dragging={arrastando?.id === oportunidade.id}
                  onDragStart={() => setArrastando(oportunidade)}
                  onDragEnd={() => {
                    setArrastando(null);
                    setColunaAlvo(null);
                  }}
                  onOpen={() => onOpen(oportunidade)}
                />
              </div>
            ))}

            {coluna.opportunities.length === 0 && (
              <p className="rounded-lg border border-dashed border-slate-200 px-3 py-6 text-center text-[11px] text-slate-400">
                Nenhuma oportunidade
              </p>
            )}

            {coluna.totals.count > coluna.opportunities.length && (
              // O quadro carrega uma página por coluna: o total já está no
              // cabeçalho, e dizer o que ficou de fora evita a leitura errada
              // de "a coluna tem só isto".
              <p className="pt-1 text-center text-[10px] text-slate-400">
                +{coluna.totals.count - coluna.opportunities.length} não exibida(s) — use os
                filtros ou a lista de Oportunidades
              </p>
            )}
          </div>
        </section>
      ))}
    </div>
  );
}

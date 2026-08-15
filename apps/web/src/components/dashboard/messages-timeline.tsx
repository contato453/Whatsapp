"use client";

import { useState } from "react";
import type { DashboardTimelinePointDto } from "@/lib/types";
import { ChartCard, ChartTable, LegendKey } from "./chart-card";

/**
 * Mensagens por dia, recebidas para cima e enviadas para baixo de uma linha
 * de base.
 *
 * As duas cores são as mesmas dos cards de mensagens — quem já aprendeu que
 * verde é o cliente e azul é a equipe não reaprende aqui. O par foi conferido
 * no validador de paleta: separação ΔE 16,1 sob deuteranopia, bem acima do
 * piso, e a legenda garante a identidade sem depender só da cor.
 */
const RECEIVED_COLOR = "#16a34a";
const SENT_COLOR = "#0891b2";

/**
 * Geometria em unidades do viewBox; o SVG escala junto com o card.
 *
 * A largura é **fixa** e a fatia do dia sai dela: se o viewBox crescesse com o
 * número de dias, sete dias virariam um retrato altíssimo e trinta um friso
 * espremido — a mesma figura mudaria de forma só por trocar o período.
 */
const VIEW_WIDTH = 480;
/** Altura útil repartida entre as duas metades — ver `baseline` abaixo. */
const PLOT_HEIGHT = 150;
const AXIS_HEIGHT = 16;
const BAR_MAX_WIDTH = 14;
/** Vão em cor de superfície separando as duas barras — nada de contorno. */
const BAR_GAP = 2;

const dayFormatter = new Intl.DateTimeFormat("pt-BR", {
  day: "2-digit",
  month: "2-digit",
  timeZone: "UTC",
});
const longDayFormatter = new Intl.DateTimeFormat("pt-BR", {
  weekday: "short",
  day: "2-digit",
  month: "2-digit",
  timeZone: "UTC",
});
const numberFormatter = new Intl.NumberFormat("pt-BR");

/** "AAAA-MM-DD" é lido como data civil, sem deixar o fuso local mover o dia. */
function asDate(date: string): Date {
  return new Date(`${date}T00:00:00Z`);
}

export function MessagesTimeline({
  points,
  periodLabel,
}: {
  points: DashboardTimelinePointDto[];
  periodLabel: string;
}) {
  const [active, setActive] = useState<number | null>(null);

  const totalReceived = points.reduce((total, point) => total + point.received, 0);
  const totalSent = points.reduce((total, point) => total + point.sent, 0);
  const isEmpty = totalReceived === 0 && totalSent === 0;

  // Um dia = uma fatia; a barra nunca preenche a fatia inteira, o que sobra é ar.
  const slot = VIEW_WIDTH / Math.max(points.length, 1);
  const width = VIEW_WIDTH;
  const height = PLOT_HEIGHT + AXIS_HEIGHT;
  const barWidth = Math.max(1.5, Math.min(BAR_MAX_WIDTH, slot - 6));

  /**
   * Uma escala só para os dois lados — a mesma quantidade de pixels por
   * mensagem acima e abaixo da linha. O que muda é onde a linha fica: ela é
   * posicionada na proporção dos dois picos, para o escritório que recebe
   * muito mais do que envia não desenhar meio gráfico vazio. Duas escalas
   * seria mentira; linha deslocada é só enquadramento.
   */
  const peakReceived = Math.max(...points.map((point) => point.received), 0);
  const peakSent = Math.max(...points.map((point) => point.sent), 0);
  const perMessage = (PLOT_HEIGHT - 12) / Math.max(peakReceived + peakSent, 1);
  const baseline = Math.max(12, peakReceived * perMessage) + 6;

  /** Rótulo do eixo a cada N dias, para 30 colunas não virarem borrão. */
  const labelEvery = points.length > 20 ? 5 : points.length > 10 ? 2 : 1;

  const activePoint = active === null ? null : points[active];

  return (
    <ChartCard
      title="Mensagens por dia"
      subtitle={`Recebidas e enviadas ${periodLabel}, no fuso do escritório.`}
      legend={
        <div className="flex items-center gap-3">
          <LegendKey color={RECEIVED_COLOR} label="Recebidas" />
          <LegendKey color={SENT_COLOR} label="Enviadas" />
        </div>
      }
      empty={
        isEmpty ? (
          <p className="py-8 text-center text-xs text-slate-400">
            Nenhuma mensagem {periodLabel}.
          </p>
        ) : undefined
      }
      chart={
        <div className="relative">
          <svg
            viewBox={`0 0 ${width} ${height}`}
            // Sem altura fixa: a proporção do viewBox manda, então o card
            // acompanha a largura da coluna em vez de esticar sozinho.
            className="h-auto w-full overflow-visible"
            role="img"
            aria-label={`Mensagens por dia: ${numberFormatter.format(totalReceived)} recebidas e ${numberFormatter.format(totalSent)} enviadas ${periodLabel}.`}
          >
            {/* Linha de base sólida e discreta: é eixo, não dado. */}
            <line
              x1={0}
              y1={baseline}
              x2={width}
              y2={baseline}
              stroke="#e2e8f0"
              strokeWidth={1}
            />
            {points.map((point, index) => {
              const x = index * slot;
              const receivedHeight = point.received * perMessage;
              const sentHeight = point.sent * perMessage;
              const isActive = active === index;
              return (
                <g key={point.date}>
                  {point.received > 0 && (
                    <rect
                      x={x + (slot - barWidth) / 2}
                      y={baseline - BAR_GAP / 2 - receivedHeight}
                      width={barWidth}
                      height={receivedHeight}
                      rx={2}
                      fill={RECEIVED_COLOR}
                      opacity={active === null || isActive ? 1 : 0.35}
                    />
                  )}
                  {point.sent > 0 && (
                    <rect
                      x={x + (slot - barWidth) / 2}
                      y={baseline + BAR_GAP / 2}
                      width={barWidth}
                      height={sentHeight}
                      rx={2}
                      fill={SENT_COLOR}
                      opacity={active === null || isActive ? 1 : 0.35}
                    />
                  )}
                  {index % labelEvery === 0 && (
                    <text
                      x={x + slot / 2}
                      y={height - 4}
                      textAnchor="middle"
                      fontSize={8}
                      fill="#94a3b8"
                    >
                      {dayFormatter.format(asDate(point.date))}
                    </text>
                  )}
                  {/* Alvo do mouse e do teclado cobrindo a fatia inteira: não
                      dá para exigir acerto em cima de uma barra fina. */}
                  <rect
                    x={x}
                    y={0}
                    width={slot}
                    height={PLOT_HEIGHT}
                    fill="transparent"
                    tabIndex={0}
                    role="button"
                    aria-label={`${longDayFormatter.format(asDate(point.date))}: ${point.received} recebidas, ${point.sent} enviadas`}
                    onMouseEnter={() => setActive(index)}
                    onMouseLeave={() => setActive(null)}
                    onFocus={() => setActive(index)}
                    onBlur={() => setActive(null)}
                    className="cursor-default focus:outline-none"
                  />
                </g>
              );
            })}
          </svg>
          {activePoint && (
            <div
              className="pointer-events-none absolute top-0 z-10 -translate-x-1/2 rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-[11px] shadow-lg"
              style={{
                left: `${(((active ?? 0) + 0.5) / Math.max(points.length, 1)) * 100}%`,
              }}
            >
              <p className="font-medium text-slate-900">
                {longDayFormatter.format(asDate(activePoint.date))}
              </p>
              <p className="mt-0.5 flex items-center gap-1.5 text-slate-600">
                <span
                  className="h-2 w-2 rounded-full"
                  style={{ backgroundColor: RECEIVED_COLOR }}
                />
                {numberFormatter.format(activePoint.received)} recebidas
              </p>
              <p className="flex items-center gap-1.5 text-slate-600">
                <span className="h-2 w-2 rounded-full" style={{ backgroundColor: SENT_COLOR }} />
                {numberFormatter.format(activePoint.sent)} enviadas
              </p>
            </div>
          )}
        </div>
      }
      table={
        <ChartTable
          headers={["Dia", "Recebidas", "Enviadas", "Total"]}
          rows={points.map((point) => ({
            key: point.date,
            cells: [
              longDayFormatter.format(asDate(point.date)),
              numberFormatter.format(point.received),
              numberFormatter.format(point.sent),
              numberFormatter.format(point.received + point.sent),
            ],
          }))}
        />
      }
    />
  );
}

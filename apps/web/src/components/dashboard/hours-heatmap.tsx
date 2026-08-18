"use client";

import { useState } from "react";
import {
  DASHBOARD_HEATMAP_DAYS,
  WEEKDAY_LABELS,
  WEEKDAY_SHORT_LABELS,
  WEEKDAYS,
  type Weekday,
} from "@azvchat/shared";
import { BRAND_HEATMAP_RAMP } from "@/lib/brand";
import type { DashboardHourlyCellDto } from "@/lib/types";
import { ChartCard, ChartTable } from "./chart-card";

/**
 * Mapa de calor: em que dia e hora o cliente procura o escritório.
 *
 * Magnitude pede rampa sequencial de **um** tom só, clara para escura — arco-
 * íris aqui faria o leitor procurar significado na cor errada. A rampa é o
 * verde da marca, conferida no validador: passos monótonos, cada degrau
 * perceptível, e o mais claro ainda separa da superfície branca. Os valores
 * vêm de `lib/brand.ts`, junto com o resto da marca.
 */
const RAMP = BRAND_HEATMAP_RAMP;
/** Célula sem nenhuma mensagem: cinza de superfície, não é degrau da rampa. */
const EMPTY_COLOR = "#f1f5f9";

const HOURS = Array.from({ length: 24 }, (_, hour) => hour);
const numberFormatter = new Intl.NumberFormat("pt-BR");

/**
 * Corta a escala por quantis dos valores existentes, e não em fatias iguais
 * do máximo.
 *
 * Movimento de atendimento é torto: um pico de segunda de manhã achataria
 * todo o resto no degrau mais claro se a escala fosse linear, e o mapa
 * pareceria vazio justamente onde tem trabalho.
 */
function thresholdsOf(values: number[]): number[] {
  const sorted = [...values].filter((value) => value > 0).sort((a, b) => a - b);
  if (sorted.length === 0) return [];
  return [0.25, 0.5, 0.75].map(
    (quantile) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * quantile))] ?? 0,
  );
}

function colorFor(value: number, thresholds: number[]): string {
  if (value <= 0) return EMPTY_COLOR;
  if (thresholds.length === 0) return RAMP[RAMP.length - 1] ?? EMPTY_COLOR;
  const step = thresholds.filter((threshold) => value > threshold).length;
  return RAMP[Math.min(step, RAMP.length - 1)] ?? EMPTY_COLOR;
}

/**
 * Este é o único bloco da tela que não segue o período escolhido: hábito de
 * horário precisa de repetição para aparecer, e "hoje" mostraria um dia em
 * vez do padrão. Os filtros de número, departamento e responsável continuam
 * valendo, e o rótulo diz a janela para ninguém ler o número errado.
 */
export function HoursHeatmap({ cells }: { cells: DashboardHourlyCellDto[] }) {
  const [active, setActive] = useState<{ weekday: Weekday; hour: number } | null>(null);

  const byKey = new Map(cells.map((cell) => [`${cell.weekday}:${cell.hour}`, cell]));
  const values = cells.map((cell) => cell.received);
  const thresholds = thresholdsOf(values);
  const total = values.reduce((sum, value) => sum + value, 0);
  const busiest = cells.reduce<DashboardHourlyCellDto | null>(
    (best, cell) => (best === null || cell.received > best.received ? cell : best),
    null,
  );

  const activeCell = active ? byKey.get(`${active.weekday}:${active.hour}`) : undefined;

  return (
    <ChartCard
      title="Quando o cliente procura"
      subtitle={`Mensagens recebidas por dia da semana e hora, sempre nos últimos ${DASHBOARD_HEATMAP_DAYS} dias — este bloco não segue o filtro de período.`}
      legend={
        <div className="flex items-center gap-1.5 text-[10px] text-slate-500">
          <span>menos</span>
          {RAMP.map((color) => (
            <span
              key={color}
              className="h-2.5 w-4 rounded-sm"
              style={{ backgroundColor: color }}
            />
          ))}
          <span>mais</span>
        </div>
      }
      empty={
        total === 0 ? (
          <p className="py-8 text-center text-xs text-slate-400">
            Nenhuma mensagem recebida nos últimos {DASHBOARD_HEATMAP_DAYS} dias.
          </p>
        ) : undefined
      }
      chart={
        <div className="relative">
          <div className="thin-scroll overflow-x-auto">
            <div className="min-w-[32rem]">
              {WEEKDAYS.map((weekday) => (
                <div key={weekday} className="mb-0.5 flex items-center gap-1">
                  <span className="w-8 shrink-0 text-[10px] text-slate-500">
                    {WEEKDAY_SHORT_LABELS[weekday]}
                  </span>
                  <div className="flex flex-1 gap-0.5">
                    {HOURS.map((hour) => {
                      const cell = byKey.get(`${weekday}:${hour}`);
                      const received = cell?.received ?? 0;
                      const isActive =
                        active?.weekday === weekday && active.hour === hour;
                      return (
                        <button
                          key={hour}
                          type="button"
                          aria-label={`${WEEKDAY_LABELS[weekday]}, ${String(hour).padStart(2, "0")}h: ${received} recebidas`}
                          onMouseEnter={() => setActive({ weekday, hour })}
                          onMouseLeave={() => setActive(null)}
                          onFocus={() => setActive({ weekday, hour })}
                          onBlur={() => setActive(null)}
                          className="h-4 flex-1 rounded-sm transition-transform focus:outline-none focus-visible:ring-2 focus-visible:ring-slate-400 motion-reduce:transition-none"
                          style={{
                            backgroundColor: colorFor(received, thresholds),
                            transform: isActive ? "scale(1.35)" : undefined,
                          }}
                        />
                      );
                    })}
                  </div>
                </div>
              ))}
              <div className="mt-1 flex items-center gap-1">
                <span className="w-8 shrink-0" />
                <div className="flex flex-1 gap-0.5">
                  {HOURS.map((hour) => (
                    <span
                      key={hour}
                      className="flex-1 text-center text-[8px] tabular-nums text-slate-400"
                    >
                      {/* De duas em duas horas: 24 rótulos não cabem sem virar borrão. */}
                      {hour % 3 === 0 ? String(hour).padStart(2, "0") : ""}
                    </span>
                  ))}
                </div>
              </div>
            </div>
          </div>
          {busiest && (
            <p className="mt-2 text-[11px] text-slate-500">
              Pico: {WEEKDAY_LABELS[busiest.weekday as Weekday]} às{" "}
              {String(busiest.hour).padStart(2, "0")}h, com{" "}
              {numberFormatter.format(busiest.received)} mensagens recebidas.
            </p>
          )}
          {active && (
            <div className="pointer-events-none absolute -top-1 right-0 z-10 rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-[11px] shadow-lg">
              <p className="font-medium text-slate-900">
                {WEEKDAY_LABELS[active.weekday]}, {String(active.hour).padStart(2, "0")}h
              </p>
              <p className="text-slate-600">
                {numberFormatter.format(activeCell?.received ?? 0)} recebidas ·{" "}
                {numberFormatter.format(activeCell?.sent ?? 0)} enviadas
              </p>
            </div>
          )}
        </div>
      }
      table={
        <ChartTable
          headers={["Dia e hora", "Recebidas", "Enviadas"]}
          rows={cells.map((cell) => ({
            key: `${cell.weekday}:${cell.hour}`,
            cells: [
              `${WEEKDAY_LABELS[cell.weekday as Weekday]}, ${String(cell.hour).padStart(2, "0")}h`,
              numberFormatter.format(cell.received),
              numberFormatter.format(cell.sent),
            ],
          }))}
        />
      }
    />
  );
}

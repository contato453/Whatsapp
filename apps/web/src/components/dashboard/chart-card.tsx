"use client";

import { useState, type ReactNode } from "react";
import { BarChart3, Table2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { Card } from "@/components/ui";

/**
 * Moldura dos gráficos do dashboard.
 *
 * Todo gráfico tem um gêmeo em tabela. Cor sozinha não é canal acessível — em
 * daltonismo, impressão em cinza ou leitor de tela, a tabela é o caminho que
 * sempre funciona —, e o valor exato de um dia nunca deveria depender de
 * acertar o mouse em cima da barra.
 */
export function ChartCard({
  title,
  subtitle,
  legend,
  chart,
  table,
  empty,
}: {
  title: string;
  subtitle?: string;
  /** Identidade das séries — obrigatório a partir de duas. */
  legend?: ReactNode;
  chart: ReactNode;
  table: ReactNode;
  /** Quando não há dado nenhum, no lugar do gráfico e da tabela. */
  empty?: ReactNode;
}) {
  const [mode, setMode] = useState<"chart" | "table">("chart");

  return (
    <Card className="flex min-w-0 flex-col p-4">
      <div className="mb-3 flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold text-slate-900">{title}</h3>
          {subtitle && <p className="mt-0.5 text-[11px] text-slate-500">{subtitle}</p>}
        </div>
        <div className="flex shrink-0 items-center gap-3">
          {legend}
          {!empty && (
            <div
              className="inline-flex rounded-lg border border-slate-200 p-0.5"
              role="group"
              aria-label="Formato dos dados"
            >
              <button
                type="button"
                aria-pressed={mode === "chart"}
                onClick={() => setMode("chart")}
                title="Ver gráfico"
                className={cn(
                  "rounded-md p-1 transition-colors motion-reduce:transition-none",
                  mode === "chart"
                    ? "bg-slate-900 text-white"
                    : "text-slate-500 hover:bg-slate-100",
                )}
              >
                <BarChart3 className="h-3.5 w-3.5" />
                <span className="sr-only">Ver gráfico</span>
              </button>
              <button
                type="button"
                aria-pressed={mode === "table"}
                onClick={() => setMode("table")}
                title="Ver tabela"
                className={cn(
                  "rounded-md p-1 transition-colors motion-reduce:transition-none",
                  mode === "table"
                    ? "bg-slate-900 text-white"
                    : "text-slate-500 hover:bg-slate-100",
                )}
              >
                <Table2 className="h-3.5 w-3.5" />
                <span className="sr-only">Ver tabela</span>
              </button>
            </div>
          )}
        </div>
      </div>
      {empty ?? (mode === "chart" ? chart : table)}
    </Card>
  );
}

/** Chave de identidade de uma série: a cor mora no marcador, nunca no texto. */
export function LegendKey({ color, label }: { color: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-[11px] text-slate-600">
      <span className="h-2 w-2 rounded-full" style={{ backgroundColor: color }} />
      {label}
    </span>
  );
}

/** Tabela do gêmeo acessível — mesma moldura em todos os gráficos. */
export function ChartTable({
  headers,
  rows,
}: {
  headers: string[];
  rows: Array<{ key: string; cells: ReactNode[] }>;
}) {
  return (
    <div className="thin-scroll max-h-64 overflow-y-auto">
      <table className="w-full text-left text-xs">
        <thead className="sticky top-0 bg-white">
          <tr className="border-b border-slate-200 text-[10px] uppercase tracking-wide text-slate-400">
            {headers.map((header, index) => (
              <th
                key={header}
                scope="col"
                className={cn("py-1.5 font-medium", index > 0 && "text-right")}
              >
                {header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {rows.map((row) => (
            <tr key={row.key}>
              {row.cells.map((cell, index) => (
                <td
                  key={index}
                  className={cn(
                    "py-1.5 text-slate-700",
                    // Coluna de número alinha à direita e usa fonte tabular:
                    // é onde os dígitos precisam bater na vertical.
                    index > 0 && "text-right tabular-nums",
                  )}
                >
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

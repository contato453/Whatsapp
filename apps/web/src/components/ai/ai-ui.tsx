"use client";

import type { ReactNode, SelectHTMLAttributes } from "react";
import { formatUsdFromMicros } from "@azvchat/shared";
import { cn } from "@/lib/utils";
import { Card } from "@/components/ui";

/**
 * Peças pequenas que as telas de IA repetem. Tudo por cima do kit da casa
 * (`components/ui.tsx`) — nada aqui inventa identidade visual nova.
 */

/** `select` nativo com o mesmo visual do `Input` do kit. */
export function Select({ className, ...props }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      className={cn(
        "w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 focus:border-brand-600 focus:outline-none focus:ring-2 focus:ring-brand-500/20 disabled:cursor-not-allowed disabled:opacity-60",
        className,
      )}
      {...props}
    />
  );
}

/** Linha com caixa de seleção, rótulo e explicação — a forma das permissões. */
export function Toggle({
  checked,
  onChange,
  label,
  hint,
  disabled,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: ReactNode;
  hint?: ReactNode;
  disabled?: boolean;
}) {
  return (
    <label
      className={cn(
        "flex items-start gap-2 rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-700",
        disabled ? "opacity-60" : "cursor-pointer hover:bg-slate-50",
      )}
    >
      <input
        type="checkbox"
        className="mt-0.5 h-4 w-4 rounded border-slate-300 text-brand-600 focus:ring-brand-600"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span className="min-w-0">
        {label}
        {hint && <span className="mt-0.5 block text-xs text-slate-400">{hint}</span>}
      </span>
    </label>
  );
}

/** Bloco de formulário com título e explicação curta. */
export function Section({
  title,
  description,
  children,
  aside,
}: {
  title: string;
  description?: ReactNode;
  children: ReactNode;
  aside?: ReactNode;
}) {
  return (
    <Card className="space-y-4 p-6">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">{title}</h2>
          {description && <p className="mt-1 text-xs text-slate-400">{description}</p>}
        </div>
        {aside}
      </div>
      {children}
    </Card>
  );
}

/** Número grande com rótulo — os cards de indicadores. */
export function StatTile({ label, value, hint, tone }: { label: string; value: ReactNode; hint?: ReactNode; tone?: "default" | "warn" }) {
  return (
    <Card className={cn("p-4", tone === "warn" && "border-amber-300 bg-amber-50")}>
      <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">{label}</p>
      <p className="mt-1 text-2xl font-bold text-slate-900">{value}</p>
      {hint && <p className="mt-0.5 text-xs text-slate-400">{hint}</p>}
    </Card>
  );
}

export function formatTokens(value: number): string {
  return value.toLocaleString("pt-BR");
}

export function formatCost(micros: number | null): string {
  return formatUsdFromMicros(micros);
}

export function formatPercent(value: number | null): string {
  return value == null ? "—" : `${value}%`;
}

/** Aviso inline reutilizável (erro em vermelho, aviso em âmbar, ok em verde). */
export function Notice({ tone, children }: { tone: "error" | "warn" | "ok" | "info"; children: ReactNode }) {
  const styles = {
    error: "border-red-200 bg-red-50 text-red-700",
    warn: "border-amber-300 bg-amber-50 text-amber-800",
    ok: "border-emerald-200 bg-emerald-50 text-emerald-700",
    info: "border-slate-200 bg-slate-50 text-slate-600",
  }[tone];
  return <div className={cn("rounded-lg border px-3 py-2 text-xs", styles)}>{children}</div>;
}

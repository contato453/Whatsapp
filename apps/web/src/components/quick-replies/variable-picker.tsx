"use client";

import { useEffect, useRef, useState } from "react";
import { Braces } from "lucide-react";
import {
  quickReplyVariableToken,
  quickReplyVariablesByGroup,
  type QuickReplyVariable,
} from "@azvchat/shared";
import { cn } from "@/lib/utils";

/**
 * Menu de variáveis da resposta rápida.
 *
 * Ele é GERADO a partir do catálogo de `@azvchat/shared` — a mesma lista que
 * a API valida e que o composer resolve. Ninguém precisa decorar a sintaxe
 * nem digitar chave na mão; digitar continua funcionando para quem já sabe.
 *
 * Sem biblioteca de menu: a lista é um `div` posicionado, fechado por clique
 * fora e por `Esc`, nunca por `blur` — clicar num item tira o foco do botão
 * e fecharia a lista antes do clique chegar.
 */
export function VariablePicker({
  onInsert,
  className,
}: {
  onInsert: (variable: QuickReplyVariable) => void;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const boxRef = useRef<HTMLDivElement | null>(null);
  const grupos = quickReplyVariablesByGroup();

  useEffect(() => {
    if (!open) return;
    const onDocClick = (event: MouseEvent) => {
      if (!boxRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={boxRef} className={cn("relative", className)}>
      <button
        type="button"
        onClick={() => setOpen((current) => !current)}
        aria-expanded={open}
        className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 px-2.5 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
      >
        <Braces className="h-3.5 w-3.5" /> Inserir variável
      </button>
      {open && (
        <div className="thin-scroll absolute right-0 z-30 mt-1 max-h-80 w-80 overflow-y-auto rounded-xl border border-slate-200 bg-white shadow-lg">
          {grupos.map((grupo) => (
            <div key={grupo.group}>
              <p className="border-b border-slate-100 bg-slate-50 px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-slate-400">
                {grupo.label}
              </p>
              {grupo.variables.map((variable) => (
                <button
                  key={variable.name}
                  type="button"
                  onClick={() => {
                    onInsert(variable);
                    setOpen(false);
                  }}
                  className="block w-full px-3 py-2 text-left hover:bg-brand-50"
                >
                  <span className="flex items-baseline gap-2">
                    <span className="text-xs font-semibold text-slate-800">{variable.label}</span>
                    <span className="font-mono text-[10px] text-slate-400">
                      {quickReplyVariableToken(variable.name)}
                    </span>
                  </span>
                  <span className="block text-[11px] text-slate-500">{variable.description}</span>
                </button>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

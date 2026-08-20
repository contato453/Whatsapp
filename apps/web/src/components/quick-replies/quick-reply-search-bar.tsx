"use client";

import { Search, X } from "lucide-react";
import { Input } from "@/components/ui";

/**
 * Busca das respostas rápidas: mesma linha do filtro de departamento, com
 * botão de limpar dentro do campo — só aparece com texto digitado, para não
 * ocupar espaço parado.
 */
export function QuickReplySearchBar({
  value,
  onChange,
}: {
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <div className="relative min-w-[14rem] flex-1">
      <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
      <Input
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder="Buscar por atalho, título ou texto..."
        className="pl-8 pr-8"
        aria-label="Buscar resposta rápida"
      />
      {value.length > 0 && (
        <button
          type="button"
          onClick={() => onChange("")}
          className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-0.5 text-slate-400 hover:bg-slate-100 hover:text-slate-600"
          aria-label="Limpar busca"
        >
          <X className="h-4 w-4" />
        </button>
      )}
    </div>
  );
}

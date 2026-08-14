"use client";

import { useState } from "react";
import { ChevronDown } from "lucide-react";
import {
  CONVERSATION_STATUSES,
  CONVERSATION_STATUS_COLORS,
  CONVERSATION_STATUS_LABELS,
  type ConversationStatus,
} from "@azvchat/shared";
import { cn } from "@/lib/utils";

/**
 * Status do atendimento na barra da conversa, já editável ali mesmo.
 *
 * A cor é a informação principal — quem olha a tela precisa saber em que
 * pé está o atendimento sem ler. Por isso o próprio seletor é colorido,
 * em vez de um select cinza com o texto dentro.
 */
export function StatusSelect({
  status,
  disabled,
  onChange,
}: {
  status: ConversationStatus;
  disabled?: boolean;
  onChange: (status: ConversationStatus) => Promise<void> | void;
}) {
  const [busy, setBusy] = useState(false);
  const color = CONVERSATION_STATUS_COLORS[status];

  async function change(next: ConversationStatus) {
    if (next === status) return;
    setBusy(true);
    try {
      await onChange(next);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="relative shrink-0">
      <span
        className={cn(
          "pointer-events-none flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-semibold",
          busy && "opacity-60",
        )}
        style={{ backgroundColor: `${color}1a`, color }}
      >
        <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: color }} />
        {CONVERSATION_STATUS_LABELS[status]}
        <ChevronDown className="h-3 w-3 opacity-70" />
      </span>
      {/* O select real fica por cima, invisível: mantém o menu nativo do
          sistema (e o toque no celular) sem abrir mão do visual colorido. */}
      <select
        aria-label="Status do atendimento"
        className="absolute inset-0 cursor-pointer opacity-0 disabled:cursor-not-allowed"
        value={status}
        disabled={disabled || busy}
        onChange={(event) => void change(event.target.value as ConversationStatus)}
      >
        {CONVERSATION_STATUSES.map((option) => (
          <option key={option} value={option}>
            {CONVERSATION_STATUS_LABELS[option]}
          </option>
        ))}
      </select>
    </div>
  );
}

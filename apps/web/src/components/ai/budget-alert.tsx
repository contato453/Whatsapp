"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { TriangleAlert, X } from "lucide-react";
import { AI_BUDGET_POLICY_LABELS, RealtimeEvents, formatUsdFromMicros, type AiBudgetAlertPayload } from "@azvchat/shared";
import { useAuth } from "@/lib/auth-context";
import { useSocket } from "@/lib/socket-context";

/**
 * Aviso de orçamento de IA cruzado (50/80/90/100%). Chega pela sala da
 * organização, que só o admin ouve — então só o admin vê. Um aviso por
 * degrau por mês (o servidor garante), descartável.
 */
export function AiBudgetAlert() {
  const socket = useSocket();
  const { user } = useAuth();
  const [alert, setAlert] = useState<AiBudgetAlertPayload | null>(null);

  useEffect(() => {
    if (!socket || user?.role !== "admin") return;
    const onAlert = (payload: AiBudgetAlertPayload) => setAlert(payload);
    socket.on(RealtimeEvents.AiBudgetAlert, onAlert);
    return () => {
      socket.off(RealtimeEvents.AiBudgetAlert, onAlert);
    };
  }, [socket, user?.role]);

  if (!alert) return null;
  const budget = `US$ ${(alert.monthlyBudgetCents / 100).toFixed(2)}`;
  return (
    <div className="fixed bottom-4 right-4 z-40 max-w-sm rounded-xl border border-amber-300 bg-amber-50 p-4 shadow-lg">
      <div className="flex items-start gap-3">
        <TriangleAlert className="mt-0.5 h-5 w-5 shrink-0 text-amber-600" />
        <div className="min-w-0 flex-1 text-sm text-amber-900">
          <p className="font-semibold">Orçamento de IA: {alert.percent}% utilizado</p>
          <p className="mt-0.5 text-xs">
            Consumido {formatUsdFromMicros(alert.spentMicros)} de {budget} neste mês.
            {alert.threshold >= 100 ? ` Política em vigor: ${AI_BUDGET_POLICY_LABELS[alert.policy].toLowerCase()}.` : ""}
          </p>
          <Link href="/settings/ai?tab=usage" className="mt-1 inline-block text-xs font-medium underline">
            Ver consumo e limites
          </Link>
        </div>
        <button type="button" aria-label="Fechar" className="rounded p-0.5 text-amber-700 hover:bg-amber-100" onClick={() => setAlert(null)}>
          <X className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}

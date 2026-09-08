"use client";

import { useEffect, useState } from "react";
import { CalendarClock, Pause, Play, Workflow, X } from "lucide-react";
import { RealtimeEvents, type FollowUpUpdatedPayload } from "@azvchat/shared";
import { conversationFollowUpApi } from "@/lib/api";
import { useSocket } from "@/lib/socket-context";
import { useAuth } from "@/lib/auth-context";
import { formatDateTime } from "@/lib/utils";
import { Button } from "@/components/ui";

/**
 * Faixa discreta do follow-up ativo (seção 26 do pedido) — mesma ideia da
 * `PinnedBanner`, ao lado dela: nenhum follow-up ativo, sem faixa, sem
 * espaço ocupado. Vive fora do `inbox-shell.tsx` de propósito (aquele
 * arquivo já tem ~1300 linhas) e cuida da própria busca e do próprio
 * evento de tempo real — o shell só passa o id da conversa.
 */
export function FollowUpBanner({ conversationId }: { conversationId: string }) {
  const socket = useSocket();
  const { can } = useAuth();
  const [state, setState] = useState<FollowUpUpdatedPayload["execution"] | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let active = true;
    setState(null);
    conversationFollowUpApi
      .current(conversationId)
      .then((execution) => {
        if (!active || !execution) return;
        setState({
          id: execution.id,
          ruleId: execution.ruleId,
          ruleName: execution.ruleName ?? "",
          status: execution.status as "active" | "paused",
          currentStepOrder: execution.currentStepOrder,
          totalSteps: execution.totalSteps ?? execution.currentStepOrder,
          nextRunAt: execution.nextRunAt,
          departmentId: execution.conversation?.departmentId ?? null,
          departmentName: execution.conversation?.departmentName ?? null,
        });
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [conversationId]);

  useEffect(() => {
    if (!socket) return;
    function onUpdated(payload: FollowUpUpdatedPayload) {
      if (payload.conversationId !== conversationId) return;
      setState(payload.execution);
    }
    socket.on(RealtimeEvents.FollowUpUpdated, onUpdated);
    return () => {
      socket.off(RealtimeEvents.FollowUpUpdated, onUpdated);
    };
  }, [socket, conversationId]);

  if (!state) return null;

  const canControl = can("follow_up.control");

  async function run(action: () => Promise<unknown>) {
    setBusy(true);
    try {
      await action();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-amber-200 bg-amber-50 px-4 py-2 text-xs text-amber-900">
      <span className="flex items-center gap-1.5 font-semibold">
        <Workflow className="h-3.5 w-3.5" />
        {state.status === "paused" ? "Follow-up pausado" : "Follow-up ativo"}
      </span>
      <span>
        Regra: <span className="font-medium">{state.ruleName}</span>
      </span>
      <span>
        Etapa: {state.currentStepOrder} de {state.totalSteps}
      </span>
      {state.departmentName && <span>Departamento: {state.departmentName}</span>}
      {state.status === "active" && state.nextRunAt && (
        <span>Próxima ação: {formatDateTime(state.nextRunAt)}</span>
      )}
      {canControl && (
        <div className="ml-auto flex items-center gap-1">
          {state.status === "active" ? (
            <Button
              variant="ghost"
              size="sm"
              disabled={busy}
              title="Pausar follow-up"
              onClick={() => run(() => conversationFollowUpApi.pause(conversationId))}
            >
              <Pause className="h-3.5 w-3.5" />
            </Button>
          ) : (
            <Button
              variant="ghost"
              size="sm"
              disabled={busy}
              title="Retomar follow-up"
              onClick={() => run(() => conversationFollowUpApi.resume(conversationId))}
            >
              <Play className="h-3.5 w-3.5" />
            </Button>
          )}
          <Button
            variant="ghost"
            size="sm"
            disabled={busy}
            title="Adiar 1 hora"
            onClick={() =>
              run(() =>
                conversationFollowUpApi.postpone(
                  conversationId,
                  new Date(Date.now() + 60 * 60_000).toISOString(),
                ),
              )
            }
          >
            <CalendarClock className="h-3.5 w-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="sm"
            disabled={busy}
            title="Cancelar follow-up"
            onClick={() => run(() => conversationFollowUpApi.cancel(conversationId))}
          >
            <X className="h-3.5 w-3.5" />
          </Button>
        </div>
      )}
    </div>
  );
}

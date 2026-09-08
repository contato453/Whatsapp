"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Bot, Hand, Settings2, Square, Undo2 } from "lucide-react";
import { AI_SESSION_END_REASON_LABELS, AI_SESSION_STATUS_LABELS, type AiSessionDto } from "@azvchat/shared";
import { ApiError, aiApi, conversationAssignmentApi } from "@/lib/api";
import { useAuth } from "@/lib/auth-context";
import { formatDateTime } from "@/lib/utils";
import { Button } from "@/components/ui";

/**
 * Faixa "Atendimento por IA" no topo da conversa. Ativa: agente, mensagens,
 * tempo e os botões (assumir = a rota de atribuição de sempre, que interrompe
 * a IA; encerrar = só a IA para, a conversa fica na fila). Encerrada há
 * pouco: mostra o motivo e, por chave, "Devolver para IA".
 */
export function AiSessionBanner({ session, onChanged }: { session: AiSessionDto | null; onChanged: () => void }) {
  const { user, can } = useAuth();
  const [busy, setBusy] = useState<"takeover" | "stop" | "resume" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (session?.status !== "active") return;
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, [session?.status]);

  if (!session) return null;

  async function run(kind: "takeover" | "stop" | "resume", action: () => Promise<unknown>) {
    setBusy(kind);
    setError(null);
    try {
      await action();
      onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Falha na operação");
    } finally {
      setBusy(null);
    }
  }

  const elapsedMinutes = Math.max(0, Math.round((now - new Date(session.startedAt).getTime()) / 60_000));
  const canManage = can("ai.agent.manage");

  if (session.status === "active") {
    return (
      <div className="border-b border-indigo-200 bg-indigo-50 px-4 py-2">
        <div className="flex flex-wrap items-center gap-2">
          <Bot className="h-4 w-4 shrink-0 text-indigo-600" />
          <div className="min-w-0 flex-1 text-xs text-indigo-900">
            <span className="font-semibold uppercase tracking-wide">Atendimento por IA</span> · Agente: <strong>{session.agentName}</strong> (v{session.agentVersion}) ·
            Mensagens: {session.aiMessageCount} · Tempo: {elapsedMinutes} min
          </div>
          {can("ai.session.stop") && (
            <>
              <Button size="sm" disabled={busy !== null} onClick={() => user && void run("takeover", () => conversationAssignmentApi.assign(session.conversationId, user.id))}>
                <Hand className="h-3.5 w-3.5" /> {busy === "takeover" ? "Assumindo…" : "Assumir atendimento"}
              </Button>
              <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => void run("stop", () => aiApi.stopSession(session.conversationId))}>
                <Square className="h-3.5 w-3.5" /> {busy === "stop" ? "Encerrando…" : "Encerrar IA"}
              </Button>
            </>
          )}
          {canManage && (
            <Link href={`/settings/ai/agents/${session.agentId}`}>
              <Button size="sm" variant="ghost" title="Ver configuração do agente">
                <Settings2 className="h-3.5 w-3.5" /> Ver configuração
              </Button>
            </Link>
          )}
        </div>
        {error && <p className="mt-1 text-xs text-red-600">{error}</p>}
      </div>
    );
  }

  // Encerrada: mostra por pouco tempo (a última sessão fica no DTO), com o
  // motivo e a devolução para a IA quando a chave permite.
  const endedRecently = session.endedAt ? now - new Date(session.endedAt).getTime() < 24 * 60 * 60 * 1000 : false;
  if (!endedRecently) return null;
  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-slate-200 bg-slate-50 px-4 py-1.5 text-[11px] text-slate-600">
      <Bot className="h-3.5 w-3.5 shrink-0 text-slate-400" />
      <span className="min-w-0 flex-1">
        IA ({session.agentName}): {AI_SESSION_STATUS_LABELS[session.status]}
        {session.endReason ? ` — ${AI_SESSION_END_REASON_LABELS[session.endReason]}` : ""}
        {session.endedBy ? ` por ${session.endedBy.name}` : ""}
        {session.endedAt ? ` em ${formatDateTime(session.endedAt)}` : ""}
      </span>
      {can("ai.session.resume") && (
        <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => void run("resume", () => aiApi.resumeSession(session.conversationId))}>
          <Undo2 className="h-3.5 w-3.5" /> {busy === "resume" ? "Devolvendo…" : "Devolver para IA"}
        </Button>
      )}
      {error && <span className="text-red-600">{error}</span>}
    </div>
  );
}

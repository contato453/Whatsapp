"use client";

import { useEffect, useRef, useState } from "react";
import { Bot, Bug, RotateCcw, Send, User } from "lucide-react";
import { AI_TOOL_LABELS, type AiChatTurn, type AiTestDebugDto, type AiToolName } from "@azvchat/shared";
import { ApiError, aiApi } from "@/lib/api";
import { Button, Textarea } from "@/components/ui";
import { formatCost, formatTokens, Notice } from "./ai-ui";

/**
 * Testador do agente: conversa simulada com o MESMO prompt, as mesmas
 * ferramentas e as mesmas recusas do atendimento real — sem WhatsApp e sem
 * gravar nada na conversa. O consumo é real e entra no log como "Testador".
 *
 * O estado (dados coletados) viaja de ida e volta a cada turno: o servidor
 * não guarda a simulação.
 */
export function AgentTester({ agentId, agentName, dirty }: { agentId: string; agentName: string; dirty: boolean }) {
  const [transcript, setTranscript] = useState<AiChatTurn[]>([]);
  const [state, setState] = useState<Record<string, unknown> | null>(null);
  const [debugOn, setDebugOn] = useState(false);
  const [debugs, setDebugs] = useState<Array<{ index: number; debug: AiTestDebugDto }>>([]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ended, setEnded] = useState<"transferred" | "resolved" | null>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: "end" });
  }, [transcript.length, busy]);

  async function send() {
    const content = draft.trim();
    if (!content || busy || ended) return;
    const next: AiChatTurn[] = [...transcript, { role: "customer", content }];
    setTranscript(next);
    setDraft("");
    setBusy(true);
    setError(null);
    try {
      const result = await aiApi.testAgent(agentId, { transcript: next, state, debug: debugOn });
      setState(result.state);
      if (result.reply) setTranscript([...next, { role: "assistant", content: result.reply }]);
      if (result.debug) setDebugs((current) => [...current, { index: next.length, debug: result.debug as AiTestDebugDto }]);
      setEnded(result.ended);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Falha ao consultar a IA");
    } finally {
      setBusy(false);
    }
  }

  function reset() {
    setTranscript([]);
    setState(null);
    setDebugs([]);
    setEnded(null);
    setError(null);
  }

  const collected = (state as { collected?: Record<string, string> } | null)?.collected ?? {};
  const toolLabel = (name: string) => AI_TOOL_LABELS[name as AiToolName] ?? name;

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b border-slate-200 px-4 py-2">
        <div>
          <p className="text-sm font-semibold text-slate-900">Testar agente</p>
          <p className="text-[11px] text-slate-400">Cliente simulado · nada sai pelo WhatsApp</p>
        </div>
        <div className="flex items-center gap-1">
          <Button size="sm" variant={debugOn ? "secondary" : "ghost"} title="Modo debug" onClick={() => setDebugOn((value) => !value)}>
            <Bug className="h-3.5 w-3.5" /> Debug
          </Button>
          <Button size="sm" variant="ghost" title="Reiniciar" onClick={reset}>
            <RotateCcw className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>
      {dirty && (
        <div className="px-4 pt-2">
          <Notice tone="warn">Há alterações não salvas: o teste usa a versão SALVA do agente.</Notice>
        </div>
      )}
      <div className="thin-scroll min-h-0 flex-1 space-y-2 overflow-y-auto px-4 py-3">
        {transcript.length === 0 && (
          <p className="py-8 text-center text-xs text-slate-400">
            Escreva como o cliente escreveria no WhatsApp. Teste respostas, conhecimento, limites, coleta de dados e
            transferência.
          </p>
        )}
        {transcript.map((turn, index) => (
          <div key={index}>
            <div className={turn.role === "customer" ? "flex justify-start" : "flex justify-end"}>
              <div className={turn.role === "customer" ? "max-w-[85%] rounded-xl bg-white px-3 py-2 text-sm text-slate-800 shadow-sm" : "max-w-[85%] rounded-xl bg-chat-sent px-3 py-2 text-sm text-chat-sent-text shadow-sm"}>
                <p className="mb-0.5 flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide opacity-60">
                  {turn.role === "customer" ? <User className="h-3 w-3" /> : <Bot className="h-3 w-3" />}
                  {turn.role === "customer" ? "Cliente simulado" : agentName}
                </p>
                <p className="whitespace-pre-wrap">{turn.content}</p>
              </div>
            </div>
            {debugs
              .filter((entry) => entry.index === index + 1)
              .map((entry) => (
                <DebugCard key={entry.index} debug={entry.debug} toolLabel={toolLabel} />
              ))}
          </div>
        ))}
        {busy && <p className="text-xs text-slate-400">{agentName} está digitando…</p>}
        {ended && (
          <Notice tone={ended === "transferred" ? "warn" : "ok"}>
            {ended === "transferred" ? "A IA transferiu para um atendente humano. No atendimento real, o resumo iria como nota interna." : "A IA concluiu o atendimento."} Reinicie para testar de novo.
          </Notice>
        )}
        {error && <Notice tone="error">{error}</Notice>}
        <div ref={bottomRef} />
      </div>
      {Object.keys(collected).length > 0 && (
        <div className="border-t border-slate-100 px-4 py-2 text-[11px] text-slate-500">
          <span className="font-semibold uppercase tracking-wide">Dados coletados:</span>{" "}
          {Object.entries(collected)
            .map(([key, value]) => `${key} = ${value}`)
            .join(" · ")}
        </div>
      )}
      <div className="flex items-end gap-2 border-t border-slate-200 p-3">
        <Textarea
          rows={2}
          placeholder="Mensagem do cliente…"
          value={draft}
          disabled={busy || ended !== null}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              void send();
            }
          }}
        />
        <Button disabled={busy || ended !== null || !draft.trim()} onClick={() => void send()}>
          <Send className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}

function DebugCard({ debug, toolLabel }: { debug: AiTestDebugDto; toolLabel: (name: string) => string }) {
  return (
    <div className="mt-1 rounded-lg border border-dashed border-indigo-200 bg-indigo-50/60 px-3 py-2 text-[11px] text-indigo-900">
      <p className="font-semibold">
        Debug · v{debug.agentVersion} · {debug.model} · {formatTokens(debug.inputTokens)} in / {formatTokens(debug.outputTokens)} out · {formatCost(debug.costMicros)}
      </p>
      {debug.knowledgeUsed.length > 0 && (
        <p>
          Conhecimento: {debug.knowledgeUsed.map((hit) => hit.sourceTitle).join(", ")}
        </p>
      )}
      {debug.toolsExecuted.length > 0 && <p className="text-emerald-800">Executadas: {debug.toolsExecuted.map((tool) => toolLabel(tool.name)).join(", ")}</p>}
      {debug.toolsBlocked.length > 0 && (
        <p className="text-amber-800">
          Bloqueadas: {debug.toolsBlocked.map((tool) => `${toolLabel(tool.name)} (${tool.reason})`).join("; ")}
        </p>
      )}
      {debug.handoff && <p>Transferência: {debug.handoff.reason}</p>}
    </div>
  );
}

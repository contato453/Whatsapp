"use client";

import { useEffect, useState } from "react";
import { CalendarClock, Plus, Trash2, X } from "lucide-react";
import { api } from "@/lib/api";
import { formatDateTime } from "@/lib/utils";
import type { ScheduledMessageDto } from "@/lib/types";
import { Button, Field, Input, Modal, Textarea } from "@/components/ui";

// ---------------- Enquete ----------------

export function PollModal({
  open,
  onClose,
  conversationId,
  onSent,
}: {
  open: boolean;
  onClose: () => void;
  conversationId: string;
  onSent: () => void;
}) {
  const [question, setQuestion] = useState("");
  const [options, setOptions] = useState<string[]>(["", ""]);
  const [multiple, setMultiple] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setQuestion("");
      setOptions(["", ""]);
      setMultiple(false);
      setError(null);
    }
  }, [open]);

  const filled = options.map((option) => option.trim()).filter(Boolean);
  const valid = question.trim().length > 0 && filled.length >= 2;

  async function send() {
    setBusy(true);
    setError(null);
    try {
      await api.post(`/conversations/${conversationId}/polls`, {
        question: question.trim(),
        options: filled,
        selectableCount: multiple ? filled.length : 1,
      });
      onSent();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Falha ao enviar enquete");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="Criar enquete">
      <div className="space-y-4">
        <Field label="Pergunta">
          <Input
            value={question}
            onChange={(event) => setQuestion(event.target.value)}
            placeholder="Ex.: Qual o melhor horário para a reunião?"
            autoFocus
          />
        </Field>
        <div className="space-y-2">
          <span className="text-xs font-medium uppercase tracking-wide text-slate-500">Opções</span>
          {options.map((option, index) => (
            <div key={index} className="flex items-center gap-1.5">
              <Input
                value={option}
                onChange={(event) => {
                  const next = [...options];
                  next[index] = event.target.value;
                  setOptions(next);
                }}
                placeholder={`Opção ${index + 1}`}
              />
              {options.length > 2 && (
                <button
                  onClick={() => setOptions(options.filter((_, i) => i !== index))}
                  className="rounded p-1.5 text-slate-300 hover:text-red-600"
                  aria-label="Remover opção"
                >
                  <X className="h-4 w-4" />
                </button>
              )}
            </div>
          ))}
          {options.length < 12 && (
            <button
              onClick={() => setOptions([...options, ""])}
              className="flex items-center gap-1 text-xs font-medium text-brand-600 hover:text-brand-700"
            >
              <Plus className="h-3.5 w-3.5" /> Adicionar opção
            </button>
          )}
        </div>
        <label className="flex items-center gap-2 text-sm text-slate-600">
          <input
            type="checkbox"
            checked={multiple}
            onChange={(event) => setMultiple(event.target.checked)}
            className="rounded border-slate-300"
          />
          Permitir múltiplas respostas
        </label>
        {error && <p className="text-sm text-red-600">{error}</p>}
        <Button className="w-full" disabled={!valid || busy} onClick={() => void send()}>
          Enviar enquete
        </Button>
      </div>
    </Modal>
  );
}

// ---------------- Agendamento ----------------

/** Valor mínimo para o input datetime-local (agora + 5 minutos). */
function defaultScheduleValue(): string {
  const date = new Date(Date.now() + 5 * 60_000 - new Date().getTimezoneOffset() * 60_000);
  return date.toISOString().slice(0, 16);
}

export function ScheduleModal({
  open,
  onClose,
  conversationId,
  initialContent,
}: {
  open: boolean;
  onClose: () => void;
  conversationId: string;
  initialContent?: string;
}) {
  const [content, setContent] = useState("");
  const [when, setWhen] = useState(defaultScheduleValue());
  const [items, setItems] = useState<ScheduledMessageDto[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = () => {
    api
      .get<{ scheduledMessages: ScheduledMessageDto[] }>(
        `/conversations/${conversationId}/scheduled-messages`,
      )
      .then((data) => setItems(data.scheduledMessages))
      .catch(() => undefined);
  };

  useEffect(() => {
    if (open) {
      setContent(initialContent ?? "");
      setWhen(defaultScheduleValue());
      setError(null);
      load();
    }
    // `load` é estável na prática (depende só de conversationId)
  }, [open, conversationId, initialContent]);

  async function schedule() {
    setBusy(true);
    setError(null);
    try {
      // datetime-local vem no fuso local; convertemos para ISO/UTC.
      const scheduledFor = new Date(when).toISOString();
      await api.post(`/conversations/${conversationId}/scheduled-messages`, {
        content: content.trim(),
        scheduledFor,
      });
      setContent("");
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Falha ao agendar");
    } finally {
      setBusy(false);
    }
  }

  async function cancel(id: string) {
    await api.delete(`/scheduled-messages/${id}`).catch(() => undefined);
    load();
  }

  const STATUS_LABEL: Record<string, string> = {
    pending: "Agendada",
    sent: "Enviada",
    failed: "Falhou",
    canceled: "Cancelada",
  };

  return (
    <Modal open={open} onClose={onClose} title="Agendar mensagem" wide>
      <div className="space-y-4">
        <Field label="Mensagem">
          <Textarea
            rows={3}
            value={content}
            onChange={(event) => setContent(event.target.value)}
            placeholder="Texto que será enviado automaticamente"
          />
        </Field>
        <Field label="Data e hora do envio">
          <Input type="datetime-local" value={when} onChange={(event) => setWhen(event.target.value)} />
        </Field>
        {error && <p className="text-sm text-red-600">{error}</p>}
        <Button
          className="w-full"
          disabled={busy || content.trim().length === 0}
          onClick={() => void schedule()}
        >
          <CalendarClock className="h-4 w-4" /> Agendar
        </Button>

        {items.length > 0 && (
          <div className="space-y-2 border-t border-slate-100 pt-3">
            <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">
              Agendamentos desta conversa
            </p>
            <div className="thin-scroll max-h-52 space-y-1.5 overflow-y-auto">
              {items.map((item) => (
                <div
                  key={item.id}
                  className="flex items-start gap-2 rounded-lg border border-slate-200 px-2.5 py-2"
                >
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-xs text-slate-700">{item.content}</p>
                    <p className="text-[11px] text-slate-400">
                      {formatDateTime(item.scheduledFor)} · {STATUS_LABEL[item.status] ?? item.status}
                      {item.error ? ` · ${item.error.slice(0, 60)}` : ""}
                    </p>
                  </div>
                  {item.status === "pending" && (
                    <button
                      onClick={() => void cancel(item.id)}
                      className="rounded p-1 text-slate-300 hover:text-red-600"
                      title="Cancelar agendamento"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
}

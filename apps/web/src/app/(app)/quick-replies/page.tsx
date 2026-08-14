"use client";

import { useCallback, useEffect, useState } from "react";
import { Pencil, Plus, Trash2, Zap } from "lucide-react";
import { api } from "@/lib/api";
import type { QuickReplyDto } from "@/lib/types";
import { Button, Card, EmptyState, Field, Input, Modal, Spinner, Textarea } from "@/components/ui";

const EMPTY_FORM = { shortcut: "", title: "", content: "" };

export default function QuickRepliesPage() {
  const [replies, setReplies] = useState<QuickReplyDto[] | null>(null);
  const [editing, setEditing] = useState<QuickReplyDto | "new" | null>(null);
  const [form, setForm] = useState(EMPTY_FORM);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    api
      .get<{ quickReplies: QuickReplyDto[] }>("/quick-replies")
      .then((data) => setReplies(data.quickReplies));
  }, []);
  useEffect(load, [load]);

  function openNew() {
    setForm(EMPTY_FORM);
    setError(null);
    setEditing("new");
  }

  function openEdit(reply: QuickReplyDto) {
    setForm({ shortcut: reply.shortcut, title: reply.title ?? "", content: reply.content });
    setError(null);
    setEditing(reply);
  }

  async function save() {
    setBusy(true);
    setError(null);
    const payload = {
      shortcut: form.shortcut.trim().toLowerCase(),
      title: form.title.trim() || undefined,
      content: form.content.trim(),
    };
    try {
      if (editing === "new") {
        await api.post("/quick-replies", payload);
      } else if (editing) {
        await api.patch(`/quick-replies/${editing.id}`, payload);
      }
      setEditing(null);
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Erro ao salvar");
    } finally {
      setBusy(false);
    }
  }

  async function remove(reply: QuickReplyDto) {
    if (!window.confirm(`Excluir a resposta /${reply.shortcut}?`)) return;
    await api.delete(`/quick-replies/${reply.id}`);
    load();
  }

  return (
    <div className="thin-scroll h-full overflow-y-auto p-8">
      <div className="mb-2 flex items-center justify-between">
        <h1 className="text-2xl font-bold text-slate-900">Respostas rápidas</h1>
        <Button onClick={openNew}>
          <Plus className="h-4 w-4" /> Nova resposta
        </Button>
      </div>
      <p className="mb-6 text-sm text-slate-500">
        Na Inbox, digite <span className="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-xs">/</span>{" "}
        na caixa de mensagem para inserir uma resposta com uma tecla.
      </p>

      {!replies ? (
        <div className="flex justify-center py-16">
          <Spinner className="h-8 w-8" />
        </div>
      ) : replies.length === 0 ? (
        <EmptyState
          icon={<Zap className="h-12 w-12" />}
          title="Nenhuma resposta rápida cadastrada"
          description='Crie atalhos como /bomdia ou /boleto e use-os na Inbox digitando "/".'
        />
      ) : (
        <Card className="divide-y divide-slate-100">
          {replies.map((reply) => (
            <div key={reply.id} className="flex items-start gap-3 px-5 py-3.5">
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold text-brand-700">
                  /{reply.shortcut}
                  {reply.title && (
                    <span className="ml-2 font-normal text-slate-500">{reply.title}</span>
                  )}
                </p>
                <p className="mt-0.5 whitespace-pre-wrap text-sm text-slate-600">{reply.content}</p>
              </div>
              <div className="flex shrink-0 gap-1">
                <button
                  onClick={() => openEdit(reply)}
                  className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-600"
                  title="Editar"
                >
                  <Pencil className="h-4 w-4" />
                </button>
                <button
                  onClick={() => void remove(reply)}
                  className="rounded-lg p-1.5 text-slate-300 hover:bg-red-50 hover:text-red-600"
                  title="Excluir"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </div>
            </div>
          ))}
        </Card>
      )}

      <Modal
        open={editing != null}
        onClose={() => setEditing(null)}
        title={editing === "new" ? "Nova resposta rápida" : "Editar resposta rápida"}
        wide
      >
        <div className="space-y-4">
          <Field label="Atalho (sem espaços — será usado como /atalho)">
            <Input
              value={form.shortcut}
              onChange={(event) =>
                setForm({ ...form, shortcut: event.target.value.toLowerCase().replace(/[^a-z0-9_-]/g, "") })
              }
              placeholder="Ex.: bomdia"
            />
          </Field>
          <Field label="Título (opcional, ajuda a encontrar)">
            <Input
              value={form.title}
              onChange={(event) => setForm({ ...form, title: event.target.value })}
              placeholder="Ex.: Saudação da manhã"
            />
          </Field>
          <Field label="Mensagem">
            <Textarea
              rows={5}
              value={form.content}
              onChange={(event) => setForm({ ...form, content: event.target.value })}
              placeholder="Texto completo que será inserido na conversa"
            />
          </Field>
          {error && <p className="text-sm text-red-600">{error}</p>}
          <Button
            className="w-full"
            disabled={busy || form.shortcut.length === 0 || form.content.trim().length === 0}
            onClick={() => void save()}
          >
            Salvar
          </Button>
        </div>
      </Modal>
    </div>
  );
}

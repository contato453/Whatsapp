"use client";

import { useCallback, useEffect, useState } from "react";
import { Plus, Tags as TagsIcon, Trash2 } from "lucide-react";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth-context";
import type { TagDto } from "@/lib/types";
import { Badge, Button, Card, Field, Input, Modal, Spinner, EmptyState } from "@/components/ui";

export default function TagsPage() {
  const { user: me } = useAuth();
  const [tags, setTags] = useState<TagDto[] | null>(null);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({ name: "", color: "#6366f1" });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    api.get<{ tags: TagDto[] }>("/tags").then((data) => setTags(data.tags));
  }, []);
  useEffect(load, [load]);

  const canManage = me?.role === "admin" || me?.role === "supervisor";

  async function createTag() {
    setBusy(true);
    setError(null);
    try {
      await api.post("/tags", form);
      setCreating(false);
      setForm({ name: "", color: "#6366f1" });
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Erro");
    } finally {
      setBusy(false);
    }
  }

  async function remove(tag: TagDto) {
    if (!window.confirm(`Excluir a etiqueta "${tag.name}"?`)) return;
    await api.delete(`/tags/${tag.id}`);
    load();
  }

  return (
    <div className="thin-scroll h-full overflow-y-auto p-8">
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-2xl font-bold text-slate-900">Etiquetas</h1>
        {canManage && (
          <Button onClick={() => setCreating(true)}>
            <Plus className="h-4 w-4" /> Nova etiqueta
          </Button>
        )}
      </div>

      {!tags ? (
        <div className="flex justify-center py-16">
          <Spinner className="h-8 w-8" />
        </div>
      ) : tags.length === 0 ? (
        <EmptyState
          icon={<TagsIcon className="h-12 w-12" />}
          title="Nenhuma etiqueta criada"
          description="Etiquetas ajudam a classificar conversas: Urgente, Cliente VIP, Pendência..."
        />
      ) : (
        <Card className="flex flex-wrap gap-3 p-6">
          {tags.map((tag) => (
            <div key={tag.id} className="flex items-center gap-1">
              <Badge color={tag.color} className="px-3 py-1 text-sm">
                {tag.name}
              </Badge>
              {canManage && (
                <button
                  onClick={() => void remove(tag)}
                  className="rounded p-1 text-slate-300 hover:text-red-600"
                  title="Excluir"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              )}
            </div>
          ))}
        </Card>
      )}

      <Modal open={creating} onClose={() => setCreating(false)} title="Nova etiqueta">
        <div className="space-y-4">
          <Field label="Nome">
            <Input
              value={form.name}
              onChange={(event) => setForm({ ...form, name: event.target.value })}
              placeholder="Ex.: Urgente"
            />
          </Field>
          <Field label="Cor">
            <input
              type="color"
              value={form.color}
              onChange={(event) => setForm({ ...form, color: event.target.value })}
              className="h-10 w-20 cursor-pointer rounded-lg border border-slate-300"
            />
          </Field>
          {error && <p className="text-sm text-red-600">{error}</p>}
          <Button className="w-full" disabled={busy} onClick={() => void createTag()}>
            Criar etiqueta
          </Button>
        </div>
      </Modal>
    </div>
  );
}

"use client";

import { useCallback, useEffect, useState } from "react";
import { Plus, Tags as TagsIcon, Trash2 } from "lucide-react";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth-context";
import type { TagDto } from "@/lib/types";
import { Badge, Button, Card, Field, Input, Modal, Spinner, EmptyState } from "@/components/ui";
import {
  DepartmentSelect,
  departmentLabel,
  groupByDepartment,
  useMyDepartments,
} from "@/components/department-picker";

export default function TagsPage() {
  const { user: me } = useAuth();
  const departments = useMyDepartments();
  const [tags, setTags] = useState<TagDto[] | null>(null);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({ name: "", color: "#6366f1", departmentId: "" });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    api.get<{ tags: TagDto[] }>("/tags").then((data) => setTags(data.tags));
  }, []);
  useEffect(load, [load]);

  const isAdmin = me?.role === "admin";

  function openCreate() {
    // Quem não é admin já entra com o primeiro departamento dele escolhido:
    // "Geral" não é opção para ele.
    setForm({
      name: "",
      color: "#6366f1",
      departmentId: isAdmin ? "" : (departments[0]?.id ?? ""),
    });
    setError(null);
    setCreating(true);
  }

  async function createTag() {
    setBusy(true);
    setError(null);
    try {
      await api.post("/tags", {
        name: form.name,
        color: form.color,
        departmentId: form.departmentId || null,
      });
      setCreating(false);
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Erro ao criar a etiqueta");
    } finally {
      setBusy(false);
    }
  }

  async function remove(tag: TagDto) {
    if (!window.confirm(`Excluir a etiqueta "${tag.name}"?`)) return;
    try {
      await api.delete(`/tags/${tag.id}`);
      load();
    } catch (err) {
      window.alert(err instanceof Error ? err.message : "Erro ao excluir");
    }
  }

  /** Só mexe no que é do departamento dele; o geral é do admin. */
  function canManage(tag: TagDto): boolean {
    if (isAdmin) return true;
    return tag.departmentId != null && departments.some((d) => d.id === tag.departmentId);
  }

  const canCreate = isAdmin || departments.length > 0;
  const groups = tags ? groupByDepartment(tags) : [];

  return (
    <div className="thin-scroll h-full overflow-y-auto p-8">
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-2xl font-bold text-slate-900">Etiquetas</h1>
        {canCreate && (
          <Button onClick={openCreate}>
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
        <div className="space-y-4">
          {groups.map((group) => (
            <div key={group.departmentId ?? "geral"}>
              <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-400">
                {departmentLabel(group.departmentId, departments)}
              </h2>
              <Card className="flex flex-wrap gap-3 p-6">
                {group.items.map((tag) => (
                  <div key={tag.id} className="flex items-center gap-1">
                    <Badge color={tag.color} className="px-3 py-1 text-sm">
                      {tag.name}
                    </Badge>
                    {canManage(tag) && (
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
            </div>
          ))}
        </div>
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
          <Field label="Departamento">
            <DepartmentSelect
              value={form.departmentId}
              departments={departments}
              canUseGeneral={!!isAdmin}
              onChange={(value) => setForm({ ...form, departmentId: value })}
            />
          </Field>
          <p className="text-xs text-slate-400">
            A etiqueta aparece apenas para quem atua neste departamento.
            {isAdmin && " A geral aparece para todo mundo."}
          </p>
          <Field label="Cor">
            <input
              type="color"
              value={form.color}
              onChange={(event) => setForm({ ...form, color: event.target.value })}
              className="block h-10 w-20 cursor-pointer rounded-lg border border-slate-300"
            />
          </Field>
          {error && <p className="text-sm text-red-600">{error}</p>}
          <Button
            className="w-full"
            disabled={busy || (!isAdmin && !form.departmentId)}
            onClick={() => void createTag()}
          >
            Criar etiqueta
          </Button>
        </div>
      </Modal>
    </div>
  );
}

"use client";

import { useCallback, useEffect, useState } from "react";
import { Pencil, Plus, Tags as TagsIcon, Trash2 } from "lucide-react";
import { tagsApi } from "@/lib/api";
import { BRAND_NAVY } from "@/lib/brand";
import { useAuth } from "@/lib/auth-context";
import type { TagDto } from "@/lib/types";
import { Badge, Button, Card, Field, Input, Modal, Spinner, EmptyState } from "@/components/ui";
import {
  DepartmentBadges,
  DepartmentCheckboxes,
  canManageScopedItem,
  useMyDepartments,
} from "@/components/department-picker";

/**
 * Cor inicial de uma etiqueta nova: azul-marinho da marca, não o verde — a
 * etiqueta convive com o selo de status na conversa, e verde ali disputaria a
 * leitura com "Aberto". A cor escolhida no cadastro é dado do usuário e não
 * muda; isto é só o valor de partida do formulário.
 */
const EMPTY_FORM = {
  name: "",
  color: BRAND_NAVY,
  isGeneral: false,
  departmentIds: [] as string[],
};

export default function TagsPage() {
  const { user: me, can } = useAuth();
  const departments = useMyDepartments();
  const [tags, setTags] = useState<TagDto[] | null>(null);
  const [editing, setEditing] = useState<TagDto | "new" | null>(null);
  const [form, setForm] = useState(EMPTY_FORM);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    tagsApi.list().then(setTags);
  }, []);
  useEffect(load, [load]);

  const isAdmin = me?.role === "admin";

  function openCreate() {
    // Quem não é admin já entra com o primeiro departamento dele marcado:
    // "vale para todos" não é opção para ele.
    setForm({
      ...EMPTY_FORM,
      departmentIds: isAdmin ? [] : departments[0] ? [departments[0].id] : [],
    });
    setError(null);
    setEditing("new");
  }

  function openEdit(tag: TagDto) {
    setForm({
      name: tag.name,
      color: tag.color,
      isGeneral: tag.isGeneral,
      departmentIds: tag.departments.map((department) => department.id),
    });
    setError(null);
    setEditing(tag);
  }

  /**
   * Ligar "vale para todos" limpa a seleção, desligar volta ao vazio: são os
   * dois únicos estados que a API aceita.
   */
  function toggleGeneral(isGeneral: boolean) {
    setForm((current) => ({ ...current, isGeneral, departmentIds: [] }));
  }

  async function save() {
    setBusy(true);
    setError(null);
    const payload = {
      name: form.name.trim(),
      color: form.color,
      isGeneral: form.isGeneral,
      departmentIds: form.isGeneral ? [] : form.departmentIds,
    };
    try {
      if (editing === "new") {
        await tagsApi.create(payload);
      } else if (editing) {
        await tagsApi.update(editing.id, payload);
      }
      setEditing(null);
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Erro ao salvar a etiqueta");
    } finally {
      setBusy(false);
    }
  }

  async function remove(tag: TagDto) {
    if (!window.confirm(`Excluir a etiqueta "${tag.name}"?`)) return;
    try {
      await tagsApi.remove(tag.id);
      load();
    } catch (err) {
      window.alert(err instanceof Error ? err.message : "Erro ao excluir");
    }
  }

  const canCreate = can("tag.manage") && (isAdmin || departments.length > 0);
  const invalidTarget = !form.isGeneral && form.departmentIds.length === 0;

  return (
    <div className="thin-scroll h-full overflow-y-auto p-8">
      <div className="mb-2 flex items-center justify-between">
        <h1 className="text-2xl font-bold text-slate-900">Etiquetas</h1>
        {canCreate && (
          <Button onClick={openCreate}>
            <Plus className="h-4 w-4" /> Nova etiqueta
          </Button>
        )}
      </div>
      <p className="mb-6 text-sm text-slate-500">
        Uma etiqueta pode valer para vários departamentos ao mesmo tempo, ou para todos.
      </p>

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
        <Card className="divide-y divide-slate-100">
          {tags.map((tag) => (
            <div key={tag.id} className="flex items-center gap-3 px-5 py-3.5">
              <Badge color={tag.color} className="px-3 py-1 text-sm">
                {tag.name}
              </Badge>
              <div className="flex min-w-0 flex-1 flex-wrap gap-1">
                <DepartmentBadges item={tag} />
              </div>
              {canManageScopedItem(tag, !!isAdmin, departments) && (
                <div className="flex shrink-0 gap-1">
                  {/* Editar e excluir são chaves separadas no catálogo:
                      excluir tira a etiqueta de todas as conversas em que ela
                      estiver, e não se desfaz com um clique. */}
                  {can("tag.manage") && (
                    <button
                      onClick={() => openEdit(tag)}
                      className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-600"
                      title="Editar"
                    >
                      <Pencil className="h-4 w-4" />
                    </button>
                  )}
                  {can("tag.delete") && (
                    <button
                      onClick={() => void remove(tag)}
                      className="rounded-lg p-1.5 text-slate-300 hover:bg-red-50 hover:text-red-600"
                      title="Excluir"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  )}
                </div>
              )}
            </div>
          ))}
        </Card>
      )}

      <Modal
        open={editing != null}
        onClose={() => setEditing(null)}
        title={editing === "new" ? "Nova etiqueta" : "Editar etiqueta"}
      >
        <div className="space-y-4">
          <Field label="Nome">
            <Input
              value={form.name}
              onChange={(event) => setForm({ ...form, name: event.target.value })}
              placeholder="Ex.: Urgente"
            />
          </Field>

          {isAdmin && (
            <label className="flex cursor-pointer items-center gap-2 text-sm text-slate-700">
              <input
                type="checkbox"
                className="h-4 w-4 rounded border-slate-300 text-brand-600"
                checked={form.isGeneral}
                onChange={(event) => toggleGeneral(event.target.checked)}
              />
              Vale para todos os departamentos
            </label>
          )}

          <Field label="Departamentos">
            <DepartmentCheckboxes
              selected={form.departmentIds}
              departments={departments}
              disabled={form.isGeneral}
              onChange={(departmentIds) => setForm({ ...form, departmentIds })}
            />
          </Field>
          <p className="text-xs text-slate-400">
            {form.isGeneral
              ? "A etiqueta aparece para toda a organização."
              : "A etiqueta aparece para quem atua em qualquer um dos departamentos marcados."}
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
            disabled={busy || form.name.trim().length === 0 || invalidTarget}
            onClick={() => void save()}
          >
            {editing === "new" ? "Criar etiqueta" : "Salvar"}
          </Button>
        </div>
      </Modal>
    </div>
  );
}

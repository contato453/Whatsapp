"use client";

import { useCallback, useEffect, useState } from "react";
import { Building2, Plus, Trash2 } from "lucide-react";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth-context";
import type { DepartmentDto } from "@/lib/types";
import { Button, Card, Field, Input, Modal, Spinner } from "@/components/ui";

export default function DepartmentsPage() {
  const { user: me } = useAuth();
  const [departments, setDepartments] = useState<DepartmentDto[] | null>(null);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({ name: "", description: "", color: "#6366f1" });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    api.get<{ departments: DepartmentDto[] }>("/departments").then((data) => setDepartments(data.departments));
  }, []);
  useEffect(load, [load]);

  const canManage = me?.role === "admin" || me?.role === "supervisor";

  async function createDepartment() {
    setBusy(true);
    setError(null);
    try {
      await api.post("/departments", {
        name: form.name,
        description: form.description || undefined,
        color: form.color,
      });
      setCreating(false);
      setForm({ name: "", description: "", color: "#6366f1" });
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Erro");
    } finally {
      setBusy(false);
    }
  }

  async function remove(department: DepartmentDto) {
    if (!window.confirm(`Excluir o departamento "${department.name}"?`)) return;
    await api.delete(`/departments/${department.id}`);
    load();
  }

  return (
    <div className="thin-scroll h-full overflow-y-auto p-8">
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-2xl font-bold text-slate-900">Departamentos</h1>
        {canManage && (
          <Button onClick={() => setCreating(true)}>
            <Plus className="h-4 w-4" /> Novo departamento
          </Button>
        )}
      </div>

      {!departments ? (
        <div className="flex justify-center py-16">
          <Spinner className="h-8 w-8" />
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
          {departments.map((department) => (
            <Card key={department.id} className="flex items-start justify-between p-5">
              <div className="flex items-start gap-3">
                <div
                  className="flex h-10 w-10 items-center justify-center rounded-xl"
                  style={{
                    backgroundColor: `${department.color ?? "#6366f1"}1a`,
                    color: department.color ?? "#6366f1",
                  }}
                >
                  <Building2 className="h-5 w-5" />
                </div>
                <div>
                  <p className="font-semibold text-slate-900">{department.name}</p>
                  {department.description && (
                    <p className="text-xs text-slate-500">{department.description}</p>
                  )}
                </div>
              </div>
              {me?.role === "admin" && (
                <button
                  onClick={() => void remove(department)}
                  className="rounded-lg p-1.5 text-slate-300 hover:bg-red-50 hover:text-red-600"
                  title="Excluir"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              )}
            </Card>
          ))}
        </div>
      )}

      <Modal open={creating} onClose={() => setCreating(false)} title="Novo departamento">
        <div className="space-y-4">
          <Field label="Nome">
            <Input value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} />
          </Field>
          <Field label="Descrição (opcional)">
            <Input
              value={form.description}
              onChange={(event) => setForm({ ...form, description: event.target.value })}
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
          <Button className="w-full" disabled={busy} onClick={() => void createDepartment()}>
            Criar departamento
          </Button>
        </div>
      </Modal>
    </div>
  );
}

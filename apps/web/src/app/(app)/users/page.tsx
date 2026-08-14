"use client";

import { useCallback, useEffect, useState } from "react";
import { Plus, UserRound } from "lucide-react";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth-context";
import type { UserDto } from "@/lib/types";
import { Avatar, Badge, Button, Card, Field, Input, Modal, Spinner } from "@/components/ui";

const ROLE_LABELS: Record<string, string> = {
  admin: "Administrador",
  supervisor: "Supervisor",
  agent: "Atendente",
};

export default function UsersPage() {
  const { user: me } = useAuth();
  const [users, setUsers] = useState<UserDto[] | null>(null);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({ name: "", email: "", password: "", role: "agent" });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    api.get<{ users: UserDto[] }>("/users").then((data) => setUsers(data.users));
  }, []);
  useEffect(load, [load]);

  const isAdmin = me?.role === "admin";

  async function createUser() {
    setBusy(true);
    setError(null);
    try {
      await api.post("/users", form);
      setCreating(false);
      setForm({ name: "", email: "", password: "", role: "agent" });
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Erro ao criar usuário");
    } finally {
      setBusy(false);
    }
  }

  async function toggleStatus(user: UserDto) {
    await api.patch(`/users/${user.id}`, {
      status: user.status === "active" ? "inactive" : "active",
    });
    load();
  }

  return (
    <div className="thin-scroll h-full overflow-y-auto p-8">
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-2xl font-bold text-slate-900">Atendentes</h1>
        {isAdmin && (
          <Button onClick={() => setCreating(true)}>
            <Plus className="h-4 w-4" /> Novo usuário
          </Button>
        )}
      </div>

      {!users ? (
        <div className="flex justify-center py-16">
          <Spinner className="h-8 w-8" />
        </div>
      ) : (
        <Card className="divide-y divide-slate-100">
          {users.map((user) => (
            <div key={user.id} className="flex items-center gap-3 px-5 py-3.5">
              <Avatar name={user.name} src={user.avatarUrl} />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-semibold text-slate-900">{user.name}</p>
                <p className="truncate text-xs text-slate-500">{user.email}</p>
              </div>
              <Badge className="bg-slate-100 text-slate-600">{ROLE_LABELS[user.role] ?? user.role}</Badge>
              <Badge color={user.status === "active" ? "#16a34a" : "#94a3b8"}>
                {user.status === "active" ? "Ativo" : "Inativo"}
              </Badge>
              {isAdmin && user.id !== me?.id && (
                <Button size="sm" variant="outline" onClick={() => void toggleStatus(user)}>
                  {user.status === "active" ? "Desativar" : "Ativar"}
                </Button>
              )}
            </div>
          ))}
        </Card>
      )}

      <Modal open={creating} onClose={() => setCreating(false)} title="Novo usuário">
        <div className="space-y-4">
          <Field label="Nome">
            <Input value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} />
          </Field>
          <Field label="E-mail">
            <Input
              type="email"
              value={form.email}
              onChange={(event) => setForm({ ...form, email: event.target.value })}
            />
          </Field>
          <Field label="Senha">
            <Input
              type="password"
              value={form.password}
              onChange={(event) => setForm({ ...form, password: event.target.value })}
            />
          </Field>
          <Field label="Papel">
            <select
              className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
              value={form.role}
              onChange={(event) => setForm({ ...form, role: event.target.value })}
            >
              <option value="agent">Atendente</option>
              <option value="supervisor">Supervisor</option>
              <option value="admin">Administrador</option>
            </select>
          </Field>
          {error && <p className="text-sm text-red-600">{error}</p>}
          <Button className="w-full" disabled={busy} onClick={() => void createUser()}>
            <UserRound className="h-4 w-4" /> Criar usuário
          </Button>
        </div>
      </Modal>
    </div>
  );
}

"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Pencil, Plus, Save, Smartphone, UserRound } from "lucide-react";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth-context";
import type { InstanceDto, UserWithAccessDto } from "@/lib/types";
import { Avatar, Badge, Button, Card, Field, Input, Modal, Spinner } from "@/components/ui";

const ROLE_LABELS: Record<string, string> = {
  admin: "Administrador",
  supervisor: "Supervisor",
  agent: "Atendente",
};

interface UserForm {
  name: string;
  email: string;
  password: string;
  role: string;
  status: "active" | "inactive";
  allInstances: boolean;
  instanceIds: string[];
}

const EMPTY_FORM: UserForm = {
  name: "",
  email: "",
  password: "",
  role: "agent",
  status: "active",
  allInstances: true,
  instanceIds: [],
};

function formFromUser(user: UserWithAccessDto): UserForm {
  return {
    name: user.name,
    email: user.email,
    password: "",
    role: user.role,
    status: user.status,
    allInstances: user.whatsappInstanceIds.length === 0,
    instanceIds: user.whatsappInstanceIds,
  };
}

export default function UsersPage() {
  const { user: me } = useAuth();
  const [users, setUsers] = useState<UserWithAccessDto[] | null>(null);
  const [instances, setInstances] = useState<InstanceDto[]>([]);
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<UserWithAccessDto | null>(null);
  const [form, setForm] = useState<UserForm>(EMPTY_FORM);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    api.get<{ users: UserWithAccessDto[] }>("/users").then((data) => setUsers(data.users));
  }, []);
  useEffect(load, [load]);

  useEffect(() => {
    api
      .get<{ instances: InstanceDto[] }>("/whatsapp-instances")
      .then((data) => setInstances(data.instances))
      .catch(() => setInstances([]));
  }, []);

  const instanceNames = useMemo(
    () => new Map(instances.map((instance) => [instance.id, instance.name])),
    [instances],
  );

  const isAdmin = me?.role === "admin";

  function openCreate() {
    setForm(EMPTY_FORM);
    setError(null);
    setCreating(true);
  }

  function openEdit(user: UserWithAccessDto) {
    setForm(formFromUser(user));
    setError(null);
    setEditing(user);
  }

  function closeModals() {
    setCreating(false);
    setEditing(null);
    setError(null);
  }

  function toggleInstance(instanceId: string) {
    setForm((current) => ({
      ...current,
      instanceIds: current.instanceIds.includes(instanceId)
        ? current.instanceIds.filter((id) => id !== instanceId)
        : [...current.instanceIds, instanceId],
    }));
  }

  /** Conexões enviadas à API: lista vazia significa "todas". */
  function selectedInstanceIds(): string[] {
    if (form.allInstances || form.role === "admin") return [];
    return form.instanceIds;
  }

  async function createUser() {
    setBusy(true);
    setError(null);
    try {
      await api.post("/users", {
        name: form.name,
        email: form.email,
        password: form.password,
        role: form.role,
        whatsappInstanceIds: selectedInstanceIds(),
      });
      closeModals();
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Erro ao criar usuário");
    } finally {
      setBusy(false);
    }
  }

  async function saveUser() {
    if (!editing) return;
    setBusy(true);
    setError(null);
    try {
      await api.patch(`/users/${editing.id}`, {
        name: form.name,
        email: form.email,
        ...(form.password ? { password: form.password } : {}),
        ...(editing.id === me?.id ? {} : { role: form.role, status: form.status }),
        whatsappInstanceIds: selectedInstanceIds(),
      });
      closeModals();
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Erro ao salvar usuário");
    } finally {
      setBusy(false);
    }
  }

  async function toggleStatus(user: UserWithAccessDto) {
    await api.patch(`/users/${user.id}`, {
      status: user.status === "active" ? "inactive" : "active",
    });
    load();
  }

  const editingSelf = editing?.id === me?.id;

  const accessFields = (
    <div className="space-y-2">
      <span className="text-xs font-medium uppercase tracking-wide text-slate-500">
        Acesso aos WhatsApps
      </span>
      <label className="flex items-center gap-2 rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-700">
        <input
          type="checkbox"
          className="h-4 w-4 rounded border-slate-300 text-brand-600 focus:ring-brand-500"
          checked={form.allInstances}
          onChange={(event) => setForm({ ...form, allInstances: event.target.checked })}
        />
        Todas as conexões (inclusive as criadas no futuro)
      </label>
      {!form.allInstances && (
        <div className="thin-scroll max-h-48 space-y-1 overflow-y-auto rounded-lg border border-slate-200 p-2">
          {instances.length === 0 ? (
            <p className="px-1 py-2 text-xs text-slate-400">Nenhuma conexão cadastrada ainda.</p>
          ) : (
            instances.map((instance) => (
              <label
                key={instance.id}
                className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm text-slate-700 hover:bg-slate-50"
              >
                <input
                  type="checkbox"
                  className="h-4 w-4 rounded border-slate-300 text-brand-600 focus:ring-brand-500"
                  checked={form.instanceIds.includes(instance.id)}
                  onChange={() => toggleInstance(instance.id)}
                />
                <Smartphone className="h-3.5 w-3.5 text-slate-400" />
                <span className="truncate">{instance.name}</span>
                {instance.phoneNumber && (
                  <span className="text-xs text-slate-400">{instance.phoneNumber}</span>
                )}
              </label>
            ))
          )}
        </div>
      )}
      {!form.allInstances && form.instanceIds.length === 0 && (
        <p className="text-xs text-amber-600">
          Nenhuma conexão marcada — sem seleção, o atendente volta a enxergar todas.
        </p>
      )}
    </div>
  );

  return (
    <div className="thin-scroll h-full overflow-y-auto p-8">
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-2xl font-bold text-slate-900">Atendentes</h1>
        {isAdmin && (
          <Button onClick={openCreate}>
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
                <p className="mt-0.5 truncate text-xs text-slate-400">
                  {user.role === "admin" || user.whatsappInstanceIds.length === 0
                    ? "Acesso a todas as conexões"
                    : user.whatsappInstanceIds
                        .map((id) => instanceNames.get(id) ?? "Conexão removida")
                        .join(", ")}
                </p>
              </div>
              <Badge className="bg-slate-100 text-slate-600">{ROLE_LABELS[user.role] ?? user.role}</Badge>
              <Badge color={user.status === "active" ? "#16a34a" : "#94a3b8"}>
                {user.status === "active" ? "Ativo" : "Inativo"}
              </Badge>
              {isAdmin && (
                <Button size="sm" variant="outline" onClick={() => openEdit(user)}>
                  <Pencil className="h-3.5 w-3.5" /> Editar
                </Button>
              )}
              {isAdmin && user.id !== me?.id && (
                <Button size="sm" variant="outline" onClick={() => void toggleStatus(user)}>
                  {user.status === "active" ? "Desativar" : "Ativar"}
                </Button>
              )}
            </div>
          ))}
        </Card>
      )}

      <Modal open={creating} onClose={closeModals} title="Novo usuário">
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
          {accessFields}
          {error && <p className="text-sm text-red-600">{error}</p>}
          <Button className="w-full" disabled={busy} onClick={() => void createUser()}>
            <UserRound className="h-4 w-4" /> Criar usuário
          </Button>
        </div>
      </Modal>

      <Modal open={editing != null} onClose={closeModals} title="Editar atendente">
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
          <Field label="Nova senha (deixe em branco para manter)">
            <Input
              type="password"
              value={form.password}
              placeholder="••••••"
              onChange={(event) => setForm({ ...form, password: event.target.value })}
            />
          </Field>
          <Field label="Papel">
            <select
              className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm disabled:bg-slate-50 disabled:text-slate-400"
              value={form.role}
              disabled={editingSelf}
              onChange={(event) => setForm({ ...form, role: event.target.value })}
            >
              <option value="agent">Atendente</option>
              <option value="supervisor">Supervisor</option>
              <option value="admin">Administrador</option>
            </select>
          </Field>
          <Field label="Situação">
            <select
              className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm disabled:bg-slate-50 disabled:text-slate-400"
              value={form.status}
              disabled={editingSelf}
              onChange={(event) =>
                setForm({ ...form, status: event.target.value as "active" | "inactive" })
              }
            >
              <option value="active">Ativo</option>
              <option value="inactive">Inativo</option>
            </select>
          </Field>
          {editingSelf && (
            <p className="text-xs text-slate-400">
              Você não pode alterar o próprio papel nem se desativar.
            </p>
          )}
          {form.role === "admin" ? (
            <p className="text-xs text-slate-500">
              Administradores sempre têm acesso a todas as conexões de WhatsApp.
            </p>
          ) : (
            accessFields
          )}
          {error && <p className="text-sm text-red-600">{error}</p>}
          <Button className="w-full" disabled={busy} onClick={() => void saveUser()}>
            <Save className="h-4 w-4" /> Salvar alterações
          </Button>
        </div>
      </Modal>
    </div>
  );
}

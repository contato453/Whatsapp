"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Building2, Pencil, Plus, Save, Smartphone, UserRound } from "lucide-react";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth-context";
import type { DepartmentDto, InstanceDto, UserWithAccessDto } from "@/lib/types";
import { Avatar, Badge, Button, Card, Field, Input, Modal, Spinner } from "@/components/ui";

const ROLE_LABELS: Record<string, string> = {
  admin: "Administrador",
  supervisor: "Supervisor",
  agent: "Usuário",
};

interface UserForm {
  name: string;
  email: string;
  password: string;
  role: string;
  status: "active" | "inactive";
  instanceIds: string[];
  departmentIds: string[];
}

const EMPTY_FORM: UserForm = {
  name: "",
  email: "",
  password: "",
  role: "agent",
  status: "active",
  instanceIds: [],
  departmentIds: [],
};

function formFromUser(user: UserWithAccessDto): UserForm {
  return {
    name: user.name,
    email: user.email,
    password: "",
    role: user.role,
    status: user.status,
    instanceIds: user.whatsappInstanceIds,
    departmentIds: user.departmentIds,
  };
}

export default function UsersPage() {
  const { user: me } = useAuth();
  const [users, setUsers] = useState<UserWithAccessDto[] | null>(null);
  const [instances, setInstances] = useState<InstanceDto[]>([]);
  const [departments, setDepartments] = useState<DepartmentDto[]>([]);
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
    api
      .get<{ departments: DepartmentDto[] }>("/departments")
      .then((data) => setDepartments(data.departments))
      .catch(() => setDepartments([]));
  }, []);

  const instanceNames = useMemo(
    () => new Map(instances.map((instance) => [instance.id, instance.name])),
    [instances],
  );
  const departmentNames = useMemo(
    () => new Map(departments.map((department) => [department.id, department.name])),
    [departments],
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

  function toggleDepartment(departmentId: string) {
    setForm((current) => ({
      ...current,
      departmentIds: current.departmentIds.includes(departmentId)
        ? current.departmentIds.filter((id) => id !== departmentId)
        : [...current.departmentIds, departmentId],
    }));
  }

  /** Admin enxerga a organização inteira — não precisa de marcação. */
  function selectedInstanceIds(): string[] {
    return form.role === "admin" ? [] : form.instanceIds;
  }

  function selectedDepartmentIds(): string[] {
    return form.role === "admin" ? [] : form.departmentIds;
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
        departmentIds: selectedDepartmentIds(),
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
        departmentIds: selectedDepartmentIds(),
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

  const accessFields =
    form.role === "admin" ? (
      <p className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-500">
        Administrador enxerga todos os números e todos os departamentos.
      </p>
    ) : (
      <div className="space-y-4">
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium uppercase tracking-wide text-slate-500">
              Acesso aos WhatsApps
            </span>
            <button
              type="button"
              className="text-xs font-medium text-brand-600 hover:underline"
              onClick={() =>
                setForm((current) => ({
                  ...current,
                  instanceIds:
                    current.instanceIds.length === instances.length
                      ? []
                      : instances.map((instance) => instance.id),
                }))
              }
            >
              {form.instanceIds.length === instances.length ? "Desmarcar todos" : "Marcar todos"}
            </button>
          </div>
          <div className="thin-scroll max-h-40 space-y-1 overflow-y-auto rounded-lg border border-slate-200 p-2">
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
        </div>

        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium uppercase tracking-wide text-slate-500">
              Departamentos
            </span>
            <button
              type="button"
              className="text-xs font-medium text-brand-600 hover:underline"
              onClick={() =>
                setForm((current) => ({
                  ...current,
                  departmentIds:
                    current.departmentIds.length === departments.length
                      ? []
                      : departments.map((department) => department.id),
                }))
              }
            >
              {form.departmentIds.length === departments.length ? "Desmarcar todos" : "Marcar todos"}
            </button>
          </div>
          <div className="thin-scroll max-h-40 space-y-1 overflow-y-auto rounded-lg border border-slate-200 p-2">
            {departments.length === 0 ? (
              <p className="px-1 py-2 text-xs text-slate-400">Nenhum departamento cadastrado ainda.</p>
            ) : (
              departments.map((department) => (
                <label
                  key={department.id}
                  className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm text-slate-700 hover:bg-slate-50"
                >
                  <input
                    type="checkbox"
                    className="h-4 w-4 rounded border-slate-300 text-brand-600 focus:ring-brand-500"
                    checked={form.departmentIds.includes(department.id)}
                    onChange={() => toggleDepartment(department.id)}
                  />
                  <Building2 className="h-3.5 w-3.5 text-slate-400" />
                  <span className="truncate">{department.name}</span>
                </label>
              ))
            )}
          </div>
        </div>

        {(form.instanceIds.length === 0 || form.departmentIds.length === 0) && (
          <p className="text-xs text-amber-600">
            Sem número ou sem departamento marcado, este usuário não enxerga conversa alguma.
          </p>
        )}
        <p className="text-xs text-slate-400">
          {form.role === "supervisor"
            ? "Supervisor vê todas as conversas dos departamentos marcados, dentro dos números marcados."
            : "Usuário vê, dentro dos números e departamentos marcados, as conversas atribuídas a ele e as que ainda não têm responsável."}
        </p>
      </div>
    );

  return (
    <div className="thin-scroll h-full overflow-y-auto p-8">
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-2xl font-bold text-slate-900">Usuários</h1>
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
                  {user.role === "admin"
                    ? "Acesso total"
                    : user.whatsappInstanceIds.length === 0 || user.departmentIds.length === 0
                      ? "Sem acesso a conversas"
                      : `${user.whatsappInstanceIds
                          .map((id) => instanceNames.get(id) ?? "Conexão removida")
                          .join(", ")} · ${user.departmentIds
                          .map((id) => departmentNames.get(id) ?? "Departamento removido")
                          .join(", ")}`}
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
              <option value="agent">Usuário</option>
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

      <Modal open={editing != null} onClose={closeModals} title="Editar usuário">
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
              <option value="agent">Usuário</option>
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

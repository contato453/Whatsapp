"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowLeft, Building2, Save, Smartphone, UserRound } from "lucide-react";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth-context";
import { formatDateTime } from "@/lib/utils";
import type { DepartmentDto, InstanceDto, UserWithAccessDto } from "@/lib/types";
import { Button, Card, Field, Input, Spinner } from "@/components/ui";

/**
 * Cadastro de usuário em página própria.
 *
 * Era um modal, mas o formulário cresceu (assinatura, números e
 * departamentos) e passou a estourar a altura da janela sem rolagem.
 * Em página o conteúdo rola naturalmente e o endereço é compartilhável.
 */

interface UserForm {
  name: string;
  email: string;
  password: string;
  role: string;
  status: "active" | "inactive";
  signMessages: boolean;
  instanceIds: string[];
  departmentIds: string[];
}

const EMPTY_FORM: UserForm = {
  name: "",
  email: "",
  password: "",
  role: "agent",
  status: "active",
  signMessages: false,
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
    signMessages: user.signMessages,
    instanceIds: user.whatsappInstanceIds,
    departmentIds: user.departmentIds,
  };
}

export function UserFormPage({ userId }: { userId?: string }) {
  const router = useRouter();
  const { user: me } = useAuth();

  const [form, setForm] = useState<UserForm>(EMPTY_FORM);
  const [editing, setEditing] = useState<UserWithAccessDto | null>(null);
  const [instances, setInstances] = useState<InstanceDto[]>([]);
  const [departments, setDepartments] = useState<DepartmentDto[]>([]);
  const [loading, setLoading] = useState(userId != null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

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

  const loadUser = useCallback(async () => {
    if (!userId) return;
    try {
      const data = await api.get<{ users: UserWithAccessDto[] }>("/users");
      const found = data.users.find((user) => user.id === userId);
      if (!found) {
        setError("Usuário não encontrado.");
        return;
      }
      setEditing(found);
      setForm(formFromUser(found));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Erro ao carregar o usuário");
    } finally {
      setLoading(false);
    }
  }, [userId]);
  useEffect(() => {
    void loadUser();
  }, [loadUser]);

  const editingSelf = editing?.id === me?.id;

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
  const selectedInstanceIds = () => (form.role === "admin" ? [] : form.instanceIds);
  const selectedDepartmentIds = () => (form.role === "admin" ? [] : form.departmentIds);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      if (editing) {
        await api.patch(`/users/${editing.id}`, {
          name: form.name,
          email: form.email,
          ...(form.password ? { password: form.password } : {}),
          ...(editingSelf ? {} : { role: form.role, status: form.status }),
          signMessages: form.signMessages,
          whatsappInstanceIds: selectedInstanceIds(),
          departmentIds: selectedDepartmentIds(),
        });
      } else {
        await api.post("/users", {
          name: form.name,
          email: form.email,
          password: form.password,
          role: form.role,
          signMessages: form.signMessages,
          whatsappInstanceIds: selectedInstanceIds(),
          departmentIds: selectedDepartmentIds(),
        });
      }
      router.push("/users");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Erro ao salvar o usuário");
    } finally {
      setBusy(false);
    }
  }

  if (loading) {
    return (
      <div className="flex justify-center py-16">
        <Spinner className="h-8 w-8" />
      </div>
    );
  }

  return (
    <div className="thin-scroll h-full overflow-y-auto p-8">
      <div className="mx-auto max-w-2xl space-y-5">
        <div className="flex items-center gap-3">
          <Button variant="outline" size="sm" onClick={() => router.push("/users")}>
            <ArrowLeft className="h-4 w-4" /> Voltar
          </Button>
          <h1 className="text-2xl font-bold text-slate-900">
            {editing ? "Editar usuário" : "Novo usuário"}
          </h1>
        </div>

        <Card className="space-y-4 p-5">
          <Field label="Nome">
            <Input
              value={form.name}
              onChange={(event) => setForm({ ...form, name: event.target.value })}
            />
          </Field>
          <Field label="E-mail">
            <Input
              type="email"
              value={form.email}
              onChange={(event) => setForm({ ...form, email: event.target.value })}
            />
          </Field>
          <Field label={editing ? "Nova senha (deixe em branco para manter)" : "Senha"}>
            <Input
              type="password"
              value={form.password}
              placeholder={editing ? "••••••" : ""}
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
          {editing && (
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
          )}
          {editingSelf && (
            <p className="text-xs text-slate-400">
              Você não pode alterar o próprio papel nem se desativar.
            </p>
          )}
          {editing && (
            <p className="text-xs text-slate-400">
              Último acesso:{" "}
              {editing.lastLoginAt ? formatDateTime(editing.lastLoginAt) : "nunca entrou"}
            </p>
          )}

          <label className="flex items-start gap-2 rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-700">
            <input
              type="checkbox"
              className="mt-0.5 h-4 w-4 rounded border-slate-300 text-brand-600 focus:ring-brand-600"
              checked={form.signMessages}
              onChange={(event) => setForm({ ...form, signMessages: event.target.checked })}
            />
            <span>
              Assinar mensagens com o nome
              <span className="mt-0.5 block text-xs text-slate-400">
                O texto sai como &ldquo;{form.name || "Nome do usuário"}:&rdquo; na primeira linha,
                para o cliente saber quem está atendendo.
              </span>
            </span>
          </label>
        </Card>

        <Card className="space-y-4 p-5">
          <h2 className="text-sm font-semibold text-slate-900">Acesso às conversas</h2>
          {form.role === "admin" ? (
            <p className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-500">
              Administrador enxerga todos os números e todos os departamentos.
            </p>
          ) : (
            <>
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
                    {form.instanceIds.length === instances.length
                      ? "Desmarcar todos"
                      : "Marcar todos"}
                  </button>
                </div>
                <div className="space-y-1 rounded-lg border border-slate-200 p-2">
                  {instances.length === 0 ? (
                    <p className="px-1 py-2 text-xs text-slate-400">
                      Nenhuma conexão cadastrada ainda.
                    </p>
                  ) : (
                    instances.map((instance) => (
                      <label
                        key={instance.id}
                        className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm text-slate-700 hover:bg-slate-50"
                      >
                        <input
                          type="checkbox"
                          className="h-4 w-4 rounded border-slate-300 text-brand-600 focus:ring-brand-600"
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
                    {form.departmentIds.length === departments.length
                      ? "Desmarcar todos"
                      : "Marcar todos"}
                  </button>
                </div>
                <div className="space-y-1 rounded-lg border border-slate-200 p-2">
                  {departments.length === 0 ? (
                    <p className="px-1 py-2 text-xs text-slate-400">
                      Nenhum departamento cadastrado ainda.
                    </p>
                  ) : (
                    departments.map((department) => (
                      <label
                        key={department.id}
                        className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm text-slate-700 hover:bg-slate-50"
                      >
                        <input
                          type="checkbox"
                          className="h-4 w-4 rounded border-slate-300 text-brand-600 focus:ring-brand-600"
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
            </>
          )}
        </Card>

        {error && <p className="text-sm text-red-600">{error}</p>}

        <div className="flex gap-2 pb-4">
          <Button disabled={busy} onClick={() => void submit()}>
            {editing ? (
              <>
                <Save className="h-4 w-4" /> Salvar alterações
              </>
            ) : (
              <>
                <UserRound className="h-4 w-4" /> Criar usuário
              </>
            )}
          </Button>
          <Button variant="outline" disabled={busy} onClick={() => router.push("/users")}>
            Cancelar
          </Button>
        </div>
      </div>
    </div>
  );
}

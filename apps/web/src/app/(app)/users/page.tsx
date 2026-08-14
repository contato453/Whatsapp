"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Pencil, Plus } from "lucide-react";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth-context";
import { formatDateTime } from "@/lib/utils";
import type { DepartmentDto, InstanceDto, UserWithAccessDto } from "@/lib/types";
import { Avatar, Badge, Button, Card, Spinner } from "@/components/ui";

const ROLE_LABELS: Record<string, string> = {
  admin: "Administrador",
  supervisor: "Supervisor",
  agent: "Usuário",
};

export default function UsersPage() {
  const router = useRouter();
  const { user: me } = useAuth();
  const [users, setUsers] = useState<UserWithAccessDto[] | null>(null);
  const [instances, setInstances] = useState<InstanceDto[]>([]);
  const [departments, setDepartments] = useState<DepartmentDto[]>([]);

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

  async function toggleStatus(user: UserWithAccessDto) {
    await api.patch(`/users/${user.id}`, {
      status: user.status === "active" ? "inactive" : "active",
    });
    load();
  }

  /** Resumo do que o usuário enxerga, na segunda linha do card. */
  function accessSummary(user: UserWithAccessDto): string {
    if (user.role === "admin") return "Acesso total";
    if (user.whatsappInstanceIds.length === 0 || user.departmentIds.length === 0) {
      return "Sem acesso a conversas";
    }
    const numbers = user.whatsappInstanceIds
      .map((id) => instanceNames.get(id) ?? "Conexão removida")
      .join(", ");
    const areas = user.departmentIds
      .map((id) => departmentNames.get(id) ?? "Departamento removido")
      .join(", ");
    return `${numbers} · ${areas}`;
  }

  return (
    <div className="thin-scroll h-full overflow-y-auto p-8">
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-2xl font-bold text-slate-900">Usuários</h1>
        {isAdmin && (
          <Button onClick={() => router.push("/users/new")}>
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
                <p className="mt-0.5 truncate text-xs text-slate-400">{accessSummary(user)}</p>
              </div>

              {/* Último acesso: quem nunca entrou fica marcado, não em branco */}
              <div className="hidden w-36 shrink-0 text-right md:block">
                <p className="text-[10px] font-medium uppercase tracking-wide text-slate-400">
                  Último acesso
                </p>
                {user.lastLoginAt ? (
                  <p className="text-xs text-slate-600">{formatDateTime(user.lastLoginAt)}</p>
                ) : (
                  <p className="text-xs text-slate-400">Nunca entrou</p>
                )}
              </div>

              {user.signMessages && (
                <Badge
                  className="bg-brand-50 text-brand-700"
                  title="Mensagens saem assinadas com o nome"
                >
                  assina
                </Badge>
              )}
              <Badge className="bg-slate-100 text-slate-600">
                {ROLE_LABELS[user.role] ?? user.role}
              </Badge>
              <Badge color={user.status === "active" ? "#16a34a" : "#94a3b8"}>
                {user.status === "active" ? "Ativo" : "Inativo"}
              </Badge>
              {isAdmin && (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => router.push(`/users/${user.id}`)}
                >
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
    </div>
  );
}

"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Pencil, Plus, Users as UsersIcon } from "lucide-react";
import { USER_ROLE_LABELS } from "@azvchat/shared";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth-context";
import { formatDateTime } from "@/lib/utils";
import {
  EMPTY_USERS_FILTERS,
  readUsersFilters,
  saveUsersFilters,
  userMatchesFilters,
  type UsersFilters,
} from "@/lib/users-filters";
import type {
  DepartmentDto,
  InstanceDto,
  UserDirectoryDto,
  UserWithAccessDto,
} from "@/lib/types";

/**
 * A linha da lista em duas versões, porque `GET /users` responde diferente
 * conforme quem pergunta: o administrador recebe o cadastro completo, e quem
 * chega pela chave `user.deactivate` recebe só a agenda interna (nome,
 * papel, status, foto), sem e-mail, último acesso nem vínculos.
 *
 * Poder desativar alguém não é motivo para ver o cadastro de todo mundo —
 * a chave dá uma AÇÃO, não um recorte de dados a mais.
 */
type UserRow = UserDirectoryDto & Partial<UserWithAccessDto>;
import { Badge, Button, Card, EmptyState, Spinner } from "@/components/ui";
import { UserAvatar } from "@/components/user-avatar";
import { UsersFilterBar } from "@/components/users/users-filter-bar";

export default function UsersPage() {
  const router = useRouter();
  const { user: me, can } = useAuth();
  const [users, setUsers] = useState<UserRow[] | null>(null);
  const [instances, setInstances] = useState<InstanceDto[]>([]);
  const [departments, setDepartments] = useState<DepartmentDto[]>([]);
  /** Só depois das duas listas responderem dá para saber o que sumiu. */
  const [scopeLoaded, setScopeLoaded] = useState(false);

  const load = useCallback(() => {
    api.get<{ users: UserRow[] }>("/users").then((data) => setUsers(data.users));
  }, []);
  useEffect(load, [load]);

  useEffect(() => {
    void Promise.all([
      api
        .get<{ instances: InstanceDto[] }>("/whatsapp-instances")
        .then((data) => setInstances(data.instances))
        .catch(() => setInstances([])),
      api
        .get<{ departments: DepartmentDto[] }>("/departments")
        .then((data) => setDepartments(data.departments))
        .catch(() => setDepartments([])),
    ]).then(() => setScopeLoaded(true));
  }, []);

  /**
   * Os filtros voltam do navegador já na primeira renderização: o caminho
   * normal aqui é clicar em "Editar" e voltar, e reidratar num efeito
   * mostraria a lista inteira por um quadro antes de recortar.
   *
   * O layout só renderiza a tela com a sessão carregada, então `me` já
   * existe quando este componente monta — e a chave, como no rascunho e nos
   * filtros da Inbox, inclui o usuário: máquina compartilhada é o caso
   * normal do escritório.
   */
  const [filters, setFilters] = useState<UsersFilters>(() =>
    me ? readUsersFilters(me.id) : EMPTY_USERS_FILTERS,
  );

  const meId = me?.id ?? null;

  useEffect(() => {
    if (meId) saveUsersFilters(meId, filters);
  }, [meId, filters]);

  const instanceNames = useMemo(
    () => new Map(instances.map((instance) => [instance.id, instance.name])),
    [instances],
  );
  const departmentNames = useMemo(
    () => new Map(departments.map((department) => [department.id, department.name])),
    [departments],
  );

  // Chip ou departamento excluído depois de virar filtro volta para "todos"
  // em silêncio. Sem esta poda o seletor guardaria um id que não está mais
  // na lista de opções: o campo apareceria sem valor e a lista viria vazia
  // sem explicação nenhuma.
  useEffect(() => {
    if (!scopeLoaded) return;
    setFilters((current) => {
      const instanceId =
        current.instanceId && !instanceNames.has(current.instanceId) ? "" : current.instanceId;
      const departmentId =
        current.departmentId && !departmentNames.has(current.departmentId)
          ? ""
          : current.departmentId;
      if (instanceId === current.instanceId && departmentId === current.departmentId) {
        return current;
      }
      return { ...current, instanceId, departmentId };
    });
  }, [scopeLoaded, instanceNames, departmentNames]);

  const isAdmin = me?.role === "admin";
  // A MESMA chave que a API confere no campo `status` do PATCH. Admin passa
  // por cima dela, como em todo o catálogo.
  const podeDesativar = can("user.deactivate");

  const visibleUsers = useMemo(
    // Sem os vínculos na resposta não há o que filtrar, e a barra nem é
    // desenhada: filtrar por chip uma lista que não os conhece devolveria
    // vazio sem explicação.
    () => (users ?? []).filter((user) => (isAdmin ? userMatchesFilters(user, filters) : true)),
    [users, filters, isAdmin],
  );

  async function toggleStatus(user: UserRow) {
    await api.patch(`/users/${user.id}`, {
      status: user.status === "active" ? "inactive" : "active",
    });
    load();
  }

  /**
   * Resumo do que o usuário enxerga, na segunda linha do card. Só existe
   * para o administrador — é ele quem recebe os vínculos na resposta.
   */
  function accessSummary(user: UserRow): string {
    if (user.role === "admin") return "Acesso total";
    const instanceIds = user.whatsappInstanceIds ?? [];
    const departmentIds = user.departmentIds ?? [];
    if (instanceIds.length === 0 || departmentIds.length === 0) {
      return "Sem acesso a conversas";
    }
    const numbers = instanceIds
      .map((id) => instanceNames.get(id) ?? "Conexão removida")
      .join(", ");
    const areas = departmentIds
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
        <>
          {isAdmin && (
          <UsersFilterBar
            filters={filters}
            onChange={(patch) => setFilters((current) => ({ ...current, ...patch }))}
            onClear={() => setFilters(EMPTY_USERS_FILTERS)}
            instances={instances}
            departments={departments}
            total={users.length}
            shown={visibleUsers.length}
          />
          )}
          {visibleUsers.length === 0 ? (
            // A lista existe, o filtro é que não deixou nada passar — dizer
            // "nenhum usuário cadastrado" aqui faria a pessoa procurar um
            // problema no cadastro que não existe.
            <Card>
              <EmptyState
                icon={<UsersIcon className="h-8 w-8" />}
                title="Nenhum usuário com esses filtros"
                description="Ninguém está vinculado a essa combinação de chip, tipo de usuário e departamento."
              />
              <div className="flex justify-center pb-8">
                <Button variant="outline" size="sm" onClick={() => setFilters(EMPTY_USERS_FILTERS)}>
                  Limpar filtros
                </Button>
              </div>
            </Card>
          ) : (
            <Card className="divide-y divide-slate-100">
              {visibleUsers.map((user) => (
                <div key={user.id} className="flex items-center gap-3 px-5 py-3.5">
                  <UserAvatar userId={user.id} name={user.name} hasAvatar={user.hasAvatar} />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-semibold text-slate-900">{user.name}</p>
                    {isAdmin && (
                      <>
                        <p className="truncate text-xs text-slate-500">{user.email}</p>
                        <p className="mt-0.5 truncate text-xs text-slate-400">
                          {accessSummary(user)}
                        </p>
                      </>
                    )}
                  </div>

                  {/* Último acesso: quem nunca entrou fica marcado, não em branco */}
                  {isAdmin && (
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
                  )}

                  {/* Chip de marca no tom 100, e não no 50: ele fica colado
                      no selo "Ativo", que é verde de ESTADO sobre fundo quase
                      igual ao brand-50. Um degrau a mais de saturação mantém
                      os dois distinguíveis de relance. */}
                  {user.signMessages && (
                    <Badge
                      className="bg-brand-100 text-brand-700"
                      title="Mensagens saem assinadas com o nome"
                    >
                      assina
                    </Badge>
                  )}
                  <Badge className="bg-slate-100 text-slate-600">
                    {USER_ROLE_LABELS[user.role]}
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
                  {/* Nunca sobre um administrador para quem não é
                      administrador, e nunca sobre si mesmo: as duas recusas
                      são as mesmas que a API aplica. */}
                  {podeDesativar &&
                    user.id !== me?.id &&
                    (isAdmin || user.role !== "admin") && (
                      <Button size="sm" variant="outline" onClick={() => void toggleStatus(user)}>
                        {user.status === "active" ? "Desativar" : "Ativar"}
                      </Button>
                    )}
                </div>
              ))}
            </Card>
          )}
        </>
      )}
    </div>
  );
}

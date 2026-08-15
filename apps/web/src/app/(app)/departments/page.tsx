"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Building2, ChevronDown, Info, Pencil, Plus, Trash2, UserRound } from "lucide-react";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth-context";
import type { DepartmentDto, UserWithAccessDto } from "@/lib/types";
import { Button, Card, Field, Input, Modal, Spinner } from "@/components/ui";

interface DepartmentForm {
  name: string;
  description: string;
  color: string;
  defaultAssigneeId: string;
}

const EMPTY_FORM: DepartmentForm = {
  name: "",
  description: "",
  color: "#6366f1",
  defaultAssigneeId: "",
};

/**
 * As regras que o sistema aplica sozinho por departamento. Ficam à vista
 * porque decidem para quem cada conversa vai e quem consegue vê-la — quem
 * configura um departamento precisa saber disso antes de salvar.
 *
 * Ao mudar qualquer regra de distribuição ou de visibilidade no back-end,
 * atualize o texto aqui: esta é a documentação que a equipe realmente lê.
 */
const RULE_GROUPS: Array<{ title: string; rules: string[] }> = [
  {
    title: "Distribuição das conversas",
    rules: [
      "Toda conversa nova nasce no departamento padrão do número de WhatsApp que a recebeu.",
      "Toda vez que chegar uma mensagem nova em conversa sem responsável, ela é atribuída automaticamente ao responsável do departamento.",
      "Conversa iniciada pela equipe também recebe o responsável do departamento, para não nascer órfã na lista.",
      "Quem já assumiu uma conversa não a perde: a atribuição automática só age quando não há responsável.",
      "Responsável desativado não recebe conversa — ela fica sem dono até alguém assumir.",
      "Mensagem nova do cliente reabre a conversa concluída e tira do status de aguardando cliente.",
    ],
  },
  {
    title: "Quem enxerga o quê",
    rules: [
      "Supervisão vê todas as conversas dos departamentos dela, dentro dos números liberados no login.",
      "Usuário comum vê apenas as conversas atribuídas a ele e as que ainda estão sem responsável.",
      "O número liberado no login é condição absoluta: conversa de número fora do login não aparece, em nenhuma hipótese.",
      "Sem número ou sem departamento marcado, o usuário não enxerga conversa alguma.",
      "Conversa de número sem departamento padrão fica visível para todos que têm o número, para não sumir mensagem de cliente.",
      "Administrador enxerga a organização inteira.",
    ],
  },
  {
    title: "Transferência e registro",
    rules: [
      "Transferir de departamento libera o responsável: a conversa volta para a fila e cai no responsável do novo departamento.",
      "Toda atribuição, transferência e devolução para a fila fica registrada no histórico da conversa.",
      "Etiquetas e respostas rápidas seguem o departamento; as marcadas como gerais aparecem para todos.",
      "Departamento sem ninguém com acesso deixa as conversas sem quem as veja — o card avisa quando isso acontece.",
    ],
  },
];

function DepartmentRules() {
  const [open, setOpen] = useState(true);
  return (
    <Card className="mb-6 p-5">
      <button
        onClick={() => setOpen((value) => !value)}
        className="flex w-full items-center gap-2 text-left"
        aria-expanded={open}
      >
        <Info className="h-4 w-4 shrink-0 text-brand-600" />
        <span className="font-semibold text-slate-900">Regras dos departamentos</span>
        <span className="text-xs text-slate-400">o que o sistema faz sozinho</span>
        <ChevronDown
          className={`ml-auto h-4 w-4 shrink-0 text-slate-400 transition-transform ${open ? "rotate-180" : ""}`}
        />
      </button>
      {open && (
        <div className="mt-4 grid grid-cols-1 gap-5 md:grid-cols-2 xl:grid-cols-3">
          {RULE_GROUPS.map((group) => (
            <div key={group.title}>
              <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">
                {group.title}
              </p>
              <ul className="mt-2 space-y-1.5">
                {group.rules.map((rule) => (
                  <li key={rule} className="flex gap-2 text-xs leading-relaxed text-slate-600">
                    <span className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-brand-500" />
                    <span>{rule}</span>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

/**
 * Quem atua no departamento. Supervisor em destaque: ele enxerga todas as
 * conversas da área, enquanto o usuário comum só vê as dele e as sem dono.
 */
function DepartmentTeam({
  members,
}: {
  members: NonNullable<DepartmentDto["members"]>;
}) {
  if (members.length === 0) {
    return (
      <p className="mt-2 text-xs text-amber-600">
        Ninguém com acesso — as conversas deste departamento ficam sem quem as veja.
      </p>
    );
  }
  const supervisors = members.filter((member) => member.role === "supervisor");
  const team = members.filter((member) => member.role !== "supervisor");
  return (
    <div className="mt-2 space-y-1.5">
      {supervisors.length > 0 && (
        <div className="flex flex-wrap items-center gap-1">
          <span className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">
            Supervisão
          </span>
          {supervisors.map((member) => (
            <span
              key={member.id}
              className="rounded-full bg-brand-50 px-2 py-0.5 text-[11px] font-medium text-brand-700"
            >
              {member.name}
            </span>
          ))}
        </div>
      )}
      {team.length > 0 && (
        <div className="flex flex-wrap items-center gap-1">
          <span className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">
            Equipe
          </span>
          {team.map((member) => (
            <span
              key={member.id}
              className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] text-slate-600"
            >
              {member.name}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

export default function DepartmentsPage() {
  const { user: me } = useAuth();
  const [departments, setDepartments] = useState<DepartmentDto[] | null>(null);
  const [users, setUsers] = useState<UserWithAccessDto[]>([]);
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<DepartmentDto | null>(null);
  const [form, setForm] = useState<DepartmentForm>(EMPTY_FORM);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    api
      .get<{ departments: DepartmentDto[] }>("/departments")
      .then((data) => setDepartments(data.departments));
  }, []);
  useEffect(load, [load]);

  useEffect(() => {
    api
      .get<{ users: UserWithAccessDto[] }>("/users")
      .then((data) => setUsers(data.users))
      .catch(() => setUsers([]));
  }, []);

  const userNames = useMemo(() => new Map(users.map((user) => [user.id, user.name])), [users]);

  const canManage = me?.role === "admin" || me?.role === "supervisor";

  /**
   * Só entram na lista quem realmente enxerga o departamento — atribuir a
   * conversa a quem não tem acesso a ela deixaria o atendimento parado.
   */
  function eligibleAssignees(departmentId: string | null): UserWithAccessDto[] {
    return users.filter((user) => {
      if (user.status !== "active") return false;
      if (user.role === "admin") return true;
      return departmentId != null && user.departmentIds.includes(departmentId);
    });
  }

  function openCreate() {
    setForm(EMPTY_FORM);
    setError(null);
    setCreating(true);
  }

  function openEdit(department: DepartmentDto) {
    setForm({
      name: department.name,
      description: department.description ?? "",
      color: department.color ?? "#6366f1",
      defaultAssigneeId: department.defaultAssigneeId ?? "",
    });
    setError(null);
    setEditing(department);
  }

  function close() {
    setCreating(false);
    setEditing(null);
    setError(null);
  }

  async function save() {
    setBusy(true);
    setError(null);
    const body = {
      name: form.name,
      description: form.description || undefined,
      color: form.color,
      defaultAssigneeId: form.defaultAssigneeId || null,
    };
    try {
      if (editing) {
        await api.patch(`/departments/${editing.id}`, body);
      } else {
        await api.post("/departments", body);
      }
      close();
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Erro ao salvar o departamento");
    } finally {
      setBusy(false);
    }
  }

  async function remove(department: DepartmentDto) {
    if (!window.confirm(`Excluir o departamento "${department.name}"?`)) return;
    await api.delete(`/departments/${department.id}`);
    load();
  }

  const assignees = eligibleAssignees(editing?.id ?? null);

  const formFields = (
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
          className="block h-10 w-20 cursor-pointer rounded-lg border border-slate-300"
        />
      </Field>
      <Field label="Responsável padrão">
        <select
          className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
          value={form.defaultAssigneeId}
          onChange={(event) => setForm({ ...form, defaultAssigneeId: event.target.value })}
        >
          <option value="">Sem responsável padrão</option>
          {assignees.map((user) => (
            <option key={user.id} value={user.id}>
              {user.name}
            </option>
          ))}
        </select>
      </Field>
      <p className="text-xs text-slate-400">
        Conversas que chegarem neste departamento sem responsável são atribuídas a esta pessoa
        automaticamente. Quem já assumiu uma conversa não a perde.
      </p>
      {editing && assignees.length === 0 && (
        <p className="text-xs text-amber-600">
          Nenhum usuário tem acesso a este departamento ainda. Libere o acesso na tela de Usuários
          para poder escolher um responsável.
        </p>
      )}
      {!editing && (
        <p className="text-xs text-slate-400">
          A lista mostra apenas administradores agora; depois de criar o departamento e liberar o
          acesso aos usuários, edite-o para escolher entre eles.
        </p>
      )}
      {error && <p className="text-sm text-red-600">{error}</p>}
      <Button className="w-full" disabled={busy} onClick={() => void save()}>
        {editing ? "Salvar alterações" : "Criar departamento"}
      </Button>
    </div>
  );

  return (
    <div className="thin-scroll h-full overflow-y-auto p-8">
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-2xl font-bold text-slate-900">Departamentos</h1>
        {canManage && (
          <Button onClick={openCreate}>
            <Plus className="h-4 w-4" /> Novo departamento
          </Button>
        )}
      </div>

      <DepartmentRules />

      {!departments ? (
        <div className="flex justify-center py-16">
          <Spinner className="h-8 w-8" />
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
          {departments.map((department) => (
            <Card key={department.id} className="flex items-start justify-between p-5">
              <div className="flex min-w-0 items-start gap-3">
                <div
                  className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl"
                  style={{
                    backgroundColor: `${department.color ?? "#6366f1"}1a`,
                    color: department.color ?? "#6366f1",
                  }}
                >
                  <Building2 className="h-5 w-5" />
                </div>
                <div className="min-w-0">
                  <p className="truncate font-semibold text-slate-900">{department.name}</p>
                  {department.description && (
                    <p className="truncate text-xs text-slate-500">{department.description}</p>
                  )}
                  {/* Responsável padrão sempre visível, inclusive quando não há */}
                  <p className="mt-1 flex items-center gap-1 text-xs">
                    <UserRound className="h-3 w-3 shrink-0 text-slate-400" />
                    {department.defaultAssigneeId ? (
                      <span className="truncate text-slate-600">
                        {userNames.get(department.defaultAssigneeId) ?? "Usuário removido"}
                        <span className="ml-1 text-slate-400">· responsável</span>
                      </span>
                    ) : (
                      <span className="text-slate-400">Sem responsável padrão</span>
                    )}
                  </p>
                  <DepartmentTeam members={department.members ?? []} />
                </div>
              </div>
              <div className="flex shrink-0 gap-1">
                {canManage && (
                  <button
                    onClick={() => openEdit(department)}
                    className="rounded-lg p-1.5 text-slate-300 hover:bg-slate-100 hover:text-slate-600"
                    title="Editar"
                  >
                    <Pencil className="h-4 w-4" />
                  </button>
                )}
                {me?.role === "admin" && (
                  <button
                    onClick={() => void remove(department)}
                    className="rounded-lg p-1.5 text-slate-300 hover:bg-red-50 hover:text-red-600"
                    title="Excluir"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                )}
              </div>
            </Card>
          ))}
        </div>
      )}

      <Modal open={creating} onClose={close} title="Novo departamento">
        {formFields}
      </Modal>
      <Modal open={editing != null} onClose={close} title="Editar departamento">
        {formFields}
      </Modal>
    </div>
  );
}

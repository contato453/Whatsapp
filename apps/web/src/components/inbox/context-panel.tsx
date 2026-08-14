"use client";

import { useState } from "react";
import { CheckCircle2, RotateCcw, StickyNote, UserMinus, UserPlus, X } from "lucide-react";
import { api } from "@/lib/api";
import { formatDateTime, formatPhone } from "@/lib/utils";
import { useAuth } from "@/lib/auth-context";
import type {
  ConversationDetailDto,
  DepartmentDto,
  TagDto,
  UserDto,
} from "@/lib/types";
import { Avatar, Badge, Button, Textarea } from "@/components/ui";

const ACTION_LABELS: Record<string, string> = {
  assigned: "assumiu o atendimento",
  transferred_user: "transferiu o atendimento",
  transferred_department: "transferiu para departamento",
  unassigned: "removeu o responsável",
  resolved: "finalizou o atendimento",
  reopened: "reabriu o atendimento",
};

export function ContextPanel({
  detail,
  users,
  departments,
  tags,
  onChanged,
}: {
  detail: ConversationDetailDto;
  users: UserDto[];
  departments: DepartmentDto[];
  tags: TagDto[];
  onChanged: () => void;
}) {
  const { user: me } = useAuth();
  const conversation = detail.conversation;
  const [noteText, setNoteText] = useState("");
  const [busy, setBusy] = useState(false);

  async function run(action: () => Promise<unknown>) {
    setBusy(true);
    try {
      await action();
      onChanged();
    } finally {
      setBusy(false);
    }
  }

  const availableTags = tags.filter(
    (tag) => !conversation.tags.some((assigned) => assigned.id === tag.id),
  );

  return (
    <div className="thin-scroll flex h-full flex-col gap-5 overflow-y-auto p-4">
      {/* Dados da conversa */}
      <section>
        <div className="flex items-center gap-3">
          <Avatar name={conversation.title} src={conversation.profilePicture} size="lg" />
          <div className="min-w-0">
            <p className="truncate font-semibold text-slate-900">{conversation.title}</p>
            <p className="text-xs text-slate-500">
              {conversation.type === "group"
                ? `Grupo · ${detail.group?.participantCount ?? "?"} participantes`
                : "Conversa individual"}
            </p>
            <p className="text-xs text-slate-400">via {conversation.instanceName ?? "—"}</p>
          </div>
        </div>
        {detail.group?.description && (
          <p className="mt-2 rounded-lg bg-slate-50 p-2 text-xs text-slate-500">
            {detail.group.description}
          </p>
        )}
      </section>

      {/* Atribuição */}
      <section className="space-y-2">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-400">Atendimento</h3>
        <div className="space-y-2 text-sm">
          <div className="flex items-center justify-between">
            <span className="text-slate-500">Responsável</span>
            <select
              className="max-w-[55%] rounded-lg border border-slate-200 px-2 py-1 text-xs"
              value={conversation.assignedUser?.id ?? ""}
              disabled={busy}
              onChange={(event) => {
                const value = event.target.value;
                if (!value) {
                  void run(() => api.post(`/conversations/${conversation.id}/unassign`));
                } else {
                  void run(() => api.post(`/conversations/${conversation.id}/assign`, { userId: value }));
                }
              }}
            >
              <option value="">Sem responsável</option>
              {users.map((user) => (
                <option key={user.id} value={user.id}>
                  {user.name}
                </option>
              ))}
            </select>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-slate-500">Departamento</span>
            <select
              className="max-w-[55%] rounded-lg border border-slate-200 px-2 py-1 text-xs"
              value={conversation.department?.id ?? ""}
              disabled={busy}
              onChange={(event) => {
                const value = event.target.value;
                if (value) {
                  void run(() =>
                    api.post(`/conversations/${conversation.id}/transfer-department`, {
                      departmentId: value,
                    }),
                  );
                }
              }}
            >
              <option value="">Sem departamento</option>
              {departments.map((department) => (
                <option key={department.id} value={department.id}>
                  {department.name}
                </option>
              ))}
            </select>
          </div>
        </div>
        <div className="flex flex-wrap gap-2 pt-1">
          {!conversation.assignedUser || conversation.assignedUser.id !== me?.id ? (
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => run(() => api.post(`/conversations/${conversation.id}/assign`))}
            >
              <UserPlus className="h-3.5 w-3.5" /> Assumir
            </Button>
          ) : (
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => run(() => api.post(`/conversations/${conversation.id}/unassign`))}
            >
              <UserMinus className="h-3.5 w-3.5" /> Liberar
            </Button>
          )}
          {conversation.status !== "resolved" ? (
            <Button
              size="sm"
              variant="secondary"
              disabled={busy}
              onClick={() => run(() => api.post(`/conversations/${conversation.id}/resolve`))}
            >
              <CheckCircle2 className="h-3.5 w-3.5" /> Finalizar
            </Button>
          ) : (
            <Button
              size="sm"
              variant="secondary"
              disabled={busy}
              onClick={() => run(() => api.post(`/conversations/${conversation.id}/reopen`))}
            >
              <RotateCcw className="h-3.5 w-3.5" /> Reabrir
            </Button>
          )}
        </div>
      </section>

      {/* Etiquetas */}
      <section className="space-y-2">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-400">Etiquetas</h3>
        <div className="flex flex-wrap gap-1.5">
          {conversation.tags.map((tag) => (
            <Badge key={tag.id} color={tag.color}>
              {tag.name}
              <button
                disabled={busy}
                onClick={() =>
                  run(() => api.delete(`/conversations/${conversation.id}/tags/${tag.id}`))
                }
                className="opacity-60 hover:opacity-100"
                aria-label={`Remover ${tag.name}`}
              >
                <X className="h-3 w-3" />
              </button>
            </Badge>
          ))}
          {conversation.tags.length === 0 && (
            <p className="text-xs text-slate-400">Nenhuma etiqueta.</p>
          )}
        </div>
        {availableTags.length > 0 && (
          <select
            className="w-full rounded-lg border border-slate-200 px-2 py-1.5 text-xs"
            value=""
            disabled={busy}
            onChange={(event) => {
              const value = event.target.value;
              if (value) {
                void run(() => api.post(`/conversations/${conversation.id}/tags/${value}`));
              }
            }}
          >
            <option value="">+ Adicionar etiqueta</option>
            {availableTags.map((tag) => (
              <option key={tag.id} value={tag.id}>
                {tag.name}
              </option>
            ))}
          </select>
        )}
      </section>

      {/* Participantes do grupo */}
      {detail.group && (
        <section className="space-y-2">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-400">
            Participantes ({detail.group.participantCount})
          </h3>
          <div className="thin-scroll max-h-48 space-y-1.5 overflow-y-auto">
            {detail.group.participants.map((participant) => (
              <div key={participant.id} className="flex items-center gap-2 text-xs">
                <Avatar name={participant.name ?? participant.phoneNumber} size="sm" className="h-6 w-6 text-[9px]" />
                <span className="min-w-0 flex-1 truncate text-slate-700">
                  {participant.name ?? formatPhone(participant.phoneNumber)}
                </span>
                {participant.isAdmin && <Badge className="bg-amber-50 text-amber-700">admin</Badge>}
              </div>
            ))}
            {detail.group.participants.length === 0 && (
              <p className="text-xs text-slate-400">Participantes ainda não sincronizados.</p>
            )}
          </div>
        </section>
      )}

      {/* Notas internas */}
      <section className="space-y-2">
        <h3 className="flex items-center gap-1 text-xs font-semibold uppercase tracking-wide text-slate-400">
          <StickyNote className="h-3.5 w-3.5" /> Notas internas
        </h3>
        <div className="space-y-2">
          {detail.notes.map((note) => (
            <div key={note.id} className="rounded-lg border-l-2 border-amber-400 bg-amber-50 p-2.5">
              <p className="whitespace-pre-wrap text-xs text-slate-700">{note.content}</p>
              <p className="mt-1 text-[10px] text-slate-400">
                {note.user?.name ?? "—"} · {formatDateTime(note.createdAt)}
              </p>
            </div>
          ))}
        </div>
        <Textarea
          rows={2}
          value={noteText}
          onChange={(event) => setNoteText(event.target.value)}
          placeholder="Nota visível só para a equipe (não vai para o WhatsApp)"
          className="text-xs"
        />
        <Button
          size="sm"
          variant="secondary"
          disabled={busy || noteText.trim().length === 0}
          onClick={() =>
            run(async () => {
              await api.post(`/conversations/${conversation.id}/notes`, { content: noteText.trim() });
              setNoteText("");
            })
          }
        >
          Adicionar nota
        </Button>
      </section>

      {/* Histórico de responsáveis */}
      <section className="space-y-2">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-400">Histórico</h3>
        <div className="space-y-1.5">
          {detail.assignmentHistory.map((entry) => (
            <p key={entry.id} className="text-[11px] leading-snug text-slate-500">
              <span className="font-medium text-slate-700">{entry.performedBy?.name ?? "Sistema"}</span>{" "}
              {ACTION_LABELS[entry.action] ?? entry.action}
              <span className="text-slate-400"> · {formatDateTime(entry.createdAt)}</span>
            </p>
          ))}
          {detail.assignmentHistory.length === 0 && (
            <p className="text-xs text-slate-400">Nenhuma movimentação registrada.</p>
          )}
        </div>
      </section>
    </div>
  );
}

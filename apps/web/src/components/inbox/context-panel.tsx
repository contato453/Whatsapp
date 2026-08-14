"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { MessageSquare, RefreshCw, StickyNote, X } from "lucide-react";
import { CONVERSATION_STATUSES, CONVERSATION_STATUS_LABELS } from "@azvchat/shared";
import { api, invalidateConversationAvatar } from "@/lib/api";
import { cn, formatDateTime, formatPhone } from "@/lib/utils";
import type {
  ConversationDetailDto,
  DepartmentDto,
  TagDto,
  UserDirectoryDto,
} from "@/lib/types";
import { Badge, Button, Textarea } from "@/components/ui";
import { ConversationAvatar, ParticipantAvatar } from "./conversation-avatar";

const ACTION_LABELS: Record<string, string> = {
  assigned: "assumiu o atendimento",
  transferred_user: "transferiu o atendimento",
  transferred_department: "transferiu para departamento",
  unassigned: "removeu o responsável",
  resolved: "concluiu o atendimento",
  reopened: "reabriu o atendimento",
};

/**
 * Descrição do grupo recolhida em 3 linhas. Descrições longas empurram o
 * atendimento e a lista de participantes para fora da tela, então o texto
 * completo fica atrás de um "ver mais".
 */
function GroupDescription({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(false);
  const [overflows, setOverflows] = useState(false);
  const ref = useRef<HTMLParagraphElement | null>(null);

  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    // Só oferece o botão quando o texto realmente passa das 3 linhas —
    // medido no elemento, para não depender de contagem de caracteres.
    const check = () => setOverflows(node.scrollHeight > node.clientHeight + 1);
    check();
    const observer = new ResizeObserver(check);
    observer.observe(node);
    return () => observer.disconnect();
  }, [text]);

  return (
    <div className="mt-2 rounded-lg bg-slate-50 p-2">
      <p
        ref={ref}
        className={cn("whitespace-pre-wrap text-xs text-slate-500", !expanded && "line-clamp-3")}
      >
        {text}
      </p>
      {(overflows || expanded) && (
        <button
          type="button"
          onClick={() => setExpanded((value) => !value)}
          className="mt-1 text-xs font-medium text-brand-600 hover:underline"
        >
          {expanded ? "ver menos" : "ver mais"}
        </button>
      )}
    </div>
  );
}

export function ContextPanel({
  detail,
  users,
  departments,
  tags,
  onChanged,
}: {
  detail: ConversationDetailDto;
  users: UserDirectoryDto[];
  departments: DepartmentDto[];
  tags: TagDto[];
  onChanged: () => void;
}) {
  const router = useRouter();
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

  // Código do cadastro: editado localmente e salvo ao sair do campo.
  const [reference, setReference] = useState(conversation.externalReference ?? "");
  useEffect(() => {
    setReference(conversation.externalReference ?? "");
  }, [conversation.id, conversation.externalReference]);

  /**
   * Abre a conversa individual com o participante — o "chamar no privado".
   * A conversa é criada na hora se ainda não existir.
   */
  async function openDirect(participantId: string) {
    setBusy(true);
    try {
      const data = await api.post<{ conversationId: string }>(
        `/group-participants/${participantId}/conversation`,
      );
      router.push(`/inbox/${data.conversationId}`);
    } catch (err) {
      window.alert(err instanceof Error ? err.message : "Não foi possível abrir a conversa");
    } finally {
      setBusy(false);
    }
  }

  async function saveReference() {
    const value = reference.trim();
    if (value === (conversation.externalReference ?? "")) return;
    await run(() =>
      api.patch(`/conversations/${conversation.id}/reference`, {
        externalReference: value.length > 0 ? value : null,
      }),
    );
  }

  const availableTags = tags.filter(
    (tag) => !conversation.tags.some((assigned) => assigned.id === tag.id),
  );

  /**
   * A lista de usuários só traz gente ativa. Se o responsável atual foi
   * desativado, ele entra como opção mesmo assim — sem isso o seletor
   * mostraria "Sem responsável" numa conversa que tem dono.
   */
  const assignable = conversation.assignedUser
    ? users.some((item) => item.id === conversation.assignedUser?.id)
      ? users
      : [...users, conversation.assignedUser]
    : users;

  return (
    <div className="thin-scroll flex h-full flex-col gap-5 overflow-y-auto p-4">
      {/* Dados da conversa */}
      <section>
        <div className="flex items-center gap-3">
          <ConversationAvatar
            conversationId={conversation.id}
            name={conversation.title}
            hasAvatar={conversation.hasAvatar}
            size="lg"
          />
          <div className="min-w-0 flex-1">
            <p className="truncate font-semibold text-slate-900">{conversation.title}</p>
            <p className="text-xs text-slate-500">
              {conversation.type === "group"
                ? `Grupo · ${detail.group?.participantCount ?? "?"} participantes`
                : "Conversa individual"}
            </p>
            <p className="text-xs text-slate-400">via {conversation.instanceName ?? "—"}</p>
          </div>
          <button
            title="Atualizar fotos (conversa e participantes)"
            disabled={busy}
            onClick={() =>
              run(async () => {
                await api.post(`/conversations/${conversation.id}/avatar/refresh`);
                invalidateConversationAvatar(conversation.id);
              })
            }
            className="rounded-lg p-1.5 text-slate-300 hover:bg-slate-100 hover:text-slate-600"
          >
            <RefreshCw className="h-3.5 w-3.5" />
          </button>
        </div>
        {detail.group?.description && <GroupDescription text={detail.group.description} />}
      </section>

      {/* Atribuição */}
      <section className="space-y-2">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-400">Atendimento</h3>
        <div className="space-y-2 text-sm">
          <div className="flex items-center justify-between">
            <span className="text-slate-500">Status</span>
            <select
              className="max-w-[55%] rounded-lg border border-slate-200 px-2 py-1 text-xs"
              value={conversation.status}
              disabled={busy}
              onChange={(event) =>
                void run(() =>
                  api.post(`/conversations/${conversation.id}/status`, {
                    status: event.target.value,
                  }),
                )
              }
            >
              {CONVERSATION_STATUSES.map((status) => (
                <option key={status} value={status}>
                  {CONVERSATION_STATUS_LABELS[status]}
                </option>
              ))}
            </select>
          </div>
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
              {assignable.map((user) => (
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
          {/* Código do cadastro da empresa/grupo no escritório */}
          <div className="flex items-center justify-between">
            <span className="text-slate-500">Cadastro</span>
            <input
              className="max-w-[55%] rounded-lg border border-slate-200 px-2 py-1 text-xs font-semibold uppercase tracking-wide text-amber-800 placeholder:font-normal placeholder:normal-case placeholder:tracking-normal placeholder:text-slate-400"
              value={reference}
              maxLength={40}
              placeholder="EMPRESA 001"
              disabled={busy}
              onChange={(event) => setReference(event.target.value)}
              onBlur={() => void saveReference()}
              onKeyDown={(event) => {
                if (event.key === "Enter") event.currentTarget.blur();
                if (event.key === "Escape") setReference(conversation.externalReference ?? "");
              }}
            />
          </div>
        </div>
        {/* Sem botões de "Assumir" e "Concluir": o responsável é trocado no
            seletor logo acima e o status, na barra da conversa. Dois caminhos
            para a mesma ação só criam dúvida sobre qual usar. */}
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
                <ParticipantAvatar
                  participantId={participant.id}
                  name={participant.name ?? participant.phoneNumber}
                  hasAvatar={participant.hasAvatar}
                  className="h-7 w-7 text-[9px]"
                />
                <div className="min-w-0 flex-1">
                  {/* Nome quando conhecido; o telefone aparece logo abaixo */}
                  <p className="truncate text-slate-700">
                    {participant.name || formatPhone(participant.phoneNumber) || "Participante"}
                  </p>
                  {participant.name && participant.phoneNumber && (
                    <p className="truncate text-[11px] text-slate-400">
                      {formatPhone(participant.phoneNumber)}
                    </p>
                  )}
                </div>
                {participant.isAdmin && <Badge className="bg-amber-50 text-amber-700">admin</Badge>}
                {/* Sem telefone conhecido não há para onde abrir a conversa */}
                {participant.phoneNumber && (
                  <button
                    title={`Conversar no privado com ${participant.name || formatPhone(participant.phoneNumber)}`}
                    disabled={busy}
                    onClick={() => void openDirect(participant.id)}
                    className="flex shrink-0 items-center gap-1 rounded-lg border border-slate-200 px-1.5 py-1 text-[11px] text-slate-600 hover:bg-slate-50 hover:text-brand-700 disabled:opacity-50"
                  >
                    <MessageSquare className="h-3 w-3" /> Conversar
                  </button>
                )}
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

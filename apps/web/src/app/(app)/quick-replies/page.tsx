"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ChevronRight,
  Clock,
  Image as ImageIcon,
  Mic,
  Paperclip,
  Pencil,
  Plus,
  Trash2,
  Video,
  X,
  Zap,
} from "lucide-react";
import {
  QUICK_REPLY_MEDIA_TYPE_LABELS,
  quickReplyMediaTypeFromMime,
  type QuickReplyMediaType,
} from "@azvchat/shared";
import { quickRepliesApi } from "@/lib/api";
import { useAuth } from "@/lib/auth-context";
import { cn, formatDateTime } from "@/lib/utils";
import type { QuickReplyDto } from "@/lib/types";
import { Button, Card, EmptyState, Field, Input, Modal, Spinner, Textarea } from "@/components/ui";
import {
  DepartmentBadges,
  DepartmentCheckboxes,
  appliesToConversation,
  canManageScopedItem,
  useMyDepartments,
} from "@/components/department-picker";

const EMPTY_FORM = {
  shortcut: "",
  title: "",
  content: "",
  isGeneral: false,
  departmentIds: [] as string[],
};

const MEDIA_ICONS: Record<QuickReplyMediaType, typeof ImageIcon> = {
  image: ImageIcon,
  audio: Mic,
  video: Video,
};

/** Selo compacto do anexo — a lista precisa mostrar de relance que a resposta carrega mídia. */
function MediaBadge({ type }: { type: QuickReplyMediaType }) {
  const Icon = MEDIA_ICONS[type];
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-600">
      <Icon className="h-3 w-3" />
      {QUICK_REPLY_MEDIA_TYPE_LABELS[type]}
    </span>
  );
}

export default function QuickRepliesPage() {
  const { user: me } = useAuth();
  const departments = useMyDepartments();
  const [replies, setReplies] = useState<QuickReplyDto[] | null>(null);
  const [editing, setEditing] = useState<QuickReplyDto | "new" | null>(null);
  const [form, setForm] = useState(EMPTY_FORM);
  // Anexo fora do `form`: File não sobrevive a JSON e o upload é uma
  // chamada separada, depois que o texto foi salvo.
  const [mediaFile, setMediaFile] = useState<File | null>(null);
  const [mediaRemoved, setMediaRemoved] = useState(false);
  const mediaInputRef = useRef<HTMLInputElement | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // A lista nasce recolhida: com mensagem inteira aberta cabiam três respostas
  // na tela, e o atalho — que é o que se procura aqui — ficava perdido.
  const [expandedIds, setExpandedIds] = useState<string[]>([]);
  /** "" = todos; "general" = só as gerais; senão o id do departamento. */
  const [departmentFilter, setDepartmentFilter] = useState("");

  const load = useCallback(() => {
    quickRepliesApi.list().then(setReplies);
  }, []);
  useEffect(load, [load]);

  const isAdmin = me?.role === "admin";

  /**
   * Filtro local: a lista inteira já veio da API (dezenas de linhas, não
   * milhares) e refazer a consulta a cada troca só atrasaria a tela. Filtrar
   * por departamento usa a MESMA régua do composer (`appliesToConversation`):
   * mostra o que vale para uma conversa daquele departamento — as gerais
   * entram junto, porque é isso que o atendente enxerga na prática.
   */
  const visibleReplies = useMemo(() => {
    if (!replies) return null;
    if (!departmentFilter) return replies;
    if (departmentFilter === "general") return replies.filter((reply) => reply.isGeneral);
    return replies.filter((reply) => appliesToConversation(reply, departmentFilter));
  }, [replies, departmentFilter]);

  const allExpanded =
    !!visibleReplies &&
    visibleReplies.length > 0 &&
    visibleReplies.every((reply) => expandedIds.includes(reply.id));

  function openNew() {
    // Sem "vale para todos" para quem não é admin: já entra no primeiro
    // departamento dele marcado.
    setForm({
      ...EMPTY_FORM,
      departmentIds: isAdmin ? [] : departments[0] ? [departments[0].id] : [],
    });
    setMediaFile(null);
    setMediaRemoved(false);
    setError(null);
    setEditing("new");
  }

  function openEdit(reply: QuickReplyDto) {
    setForm({
      shortcut: reply.shortcut,
      title: reply.title ?? "",
      content: reply.content,
      isGeneral: reply.isGeneral,
      departmentIds: reply.departments.map((department) => department.id),
    });
    setMediaFile(null);
    setMediaRemoved(false);
    setError(null);
    setEditing(reply);
  }

  /** Barra o arquivo errado antes do upload — a API recusaria do mesmo jeito. */
  function pickMedia(file: File | null) {
    if (!file) return;
    if (!quickReplyMediaTypeFromMime(file.type)) {
      setError("Anexe uma imagem, um áudio ou um vídeo");
      return;
    }
    setError(null);
    setMediaFile(file);
    setMediaRemoved(false);
  }

  /**
   * Ligar "vale para todos" limpa a seleção, desligar volta ao vazio: são os
   * dois únicos estados que a API aceita.
   */
  function toggleGeneral(isGeneral: boolean) {
    setForm((current) => ({ ...current, isGeneral, departmentIds: [] }));
  }

  async function save() {
    setBusy(true);
    setError(null);
    const payload = {
      shortcut: form.shortcut.trim().toLowerCase(),
      title: form.title.trim() || undefined,
      content: form.content.trim(),
      isGeneral: form.isGeneral,
      departmentIds: form.isGeneral ? [] : form.departmentIds,
    };
    try {
      const saved =
        editing === "new"
          ? await quickRepliesApi.create(payload)
          : editing
            ? await quickRepliesApi.update(editing.id, payload)
            : null;
      if (saved) {
        try {
          if (mediaFile) {
            await quickRepliesApi.uploadMedia(saved.id, mediaFile);
          } else if (mediaRemoved && saved.media) {
            await quickRepliesApi.removeMedia(saved.id);
          }
        } catch (err) {
          // O texto já foi salvo: o modal vira edição da resposta criada,
          // para o "Salvar" de novo tentar só a mídia — sem duplicar atalho.
          setEditing(saved);
          setError(
            err instanceof Error
              ? `Resposta salva, mas a mídia falhou: ${err.message}`
              : "Resposta salva, mas a mídia falhou",
          );
          load();
          return;
        }
      }
      setEditing(null);
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Erro ao salvar");
    } finally {
      setBusy(false);
    }
  }

  function toggleExpanded(id: string) {
    setExpandedIds((current) =>
      current.includes(id) ? current.filter((item) => item !== id) : [...current, id],
    );
  }

  async function remove(reply: QuickReplyDto) {
    if (!window.confirm(`Excluir a resposta /${reply.shortcut}?`)) return;
    try {
      await quickRepliesApi.remove(reply.id);
      load();
    } catch (err) {
      window.alert(err instanceof Error ? err.message : "Erro ao excluir");
    }
  }

  return (
    <div className="thin-scroll h-full overflow-y-auto p-8">
      <div className="mb-2 flex items-center justify-between">
        <h1 className="text-2xl font-bold text-slate-900">Respostas rápidas</h1>
        <Button onClick={openNew}>
          <Plus className="h-4 w-4" /> Nova resposta
        </Button>
      </div>
      <div className="mb-6 flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-slate-500">
          Na Inbox, digite{" "}
          <span className="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-xs">/</span> na caixa de
          mensagem para inserir uma resposta com uma tecla.
        </p>
        {replies && replies.length > 0 && (
          <div className="flex items-center gap-3">
            <select
              value={departmentFilter}
              onChange={(event) => setDepartmentFilter(event.target.value)}
              className={cn(
                "rounded-lg border px-2 py-1.5 text-sm",
                departmentFilter
                  ? "border-brand-500 font-medium text-brand-700"
                  : "border-slate-200 text-slate-600",
              )}
            >
              <option value="">Todos os departamentos</option>
              <option value="general">Somente gerais</option>
              {departments.map((department) => (
                <option key={department.id} value={department.id}>
                  {department.name}
                </option>
              ))}
            </select>
            <button
              type="button"
              onClick={() =>
                setExpandedIds((current) => {
                  const visibleIds = (visibleReplies ?? []).map((reply) => reply.id);
                  // Age só sobre as linhas visíveis: expandir com filtro
                  // ligado não pode abrir o que está escondido.
                  return allExpanded
                    ? current.filter((id) => !visibleIds.includes(id))
                    : [...new Set([...current, ...visibleIds])];
                })
              }
              className="whitespace-nowrap text-sm font-medium text-brand-600 hover:underline"
            >
              {allExpanded ? "Recolher todas" : "Expandir todas"}
            </button>
          </div>
        )}
      </div>

      {!replies || !visibleReplies ? (
        <div className="flex justify-center py-16">
          <Spinner className="h-8 w-8" />
        </div>
      ) : replies.length === 0 ? (
        <EmptyState
          icon={<Zap className="h-12 w-12" />}
          title="Nenhuma resposta rápida cadastrada"
          description='Crie atalhos como /bomdia ou /boleto e use-os na Inbox digitando "/".'
        />
      ) : visibleReplies.length === 0 ? (
        // Há respostas, só não neste recorte: mensagem curta em vez do
        // EmptyState de cadastro, que sugeriria criar do zero.
        <p className="py-16 text-center text-sm text-slate-500">
          Nenhuma resposta rápida no departamento selecionado.
        </p>
      ) : (
        <Card className="divide-y divide-slate-100">
          {visibleReplies.map((reply) => {
            const expanded = expandedIds.includes(reply.id);
            return (
              <div key={reply.id} className="flex items-start gap-2 px-2 py-1">
                <button
                  type="button"
                  onClick={() => toggleExpanded(reply.id)}
                  aria-expanded={expanded}
                  className="flex min-w-0 flex-1 items-start gap-2 rounded-lg px-3 py-2.5 text-left hover:bg-slate-50"
                >
                  <ChevronRight
                    className={cn(
                      "mt-0.5 h-4 w-4 shrink-0 text-slate-400 transition-transform",
                      expanded && "rotate-90",
                    )}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                      <span className="text-sm font-semibold text-brand-700">/{reply.shortcut}</span>
                      {reply.title && <span className="text-sm text-slate-500">{reply.title}</span>}
                      <DepartmentBadges item={reply} />
                      {reply.media && <MediaBadge type={reply.media.type} />}
                      <span
                        className="ml-auto inline-flex items-center gap-1 whitespace-nowrap text-[11px] text-slate-400"
                        title="Última vez que o atalho foi enviado na Inbox"
                      >
                        <Clock className="h-3 w-3" />
                        {reply.lastUsedAt
                          ? `Último uso: ${formatDateTime(reply.lastUsedAt)}`
                          : "Nunca usada"}
                      </span>
                    </span>
                    {/* Recolhida mostra só a primeira linha: dá para varrer a
                        lista inteira sem perder a noção do que a resposta diz. */}
                    <span
                      className={cn(
                        "mt-0.5 block text-sm text-slate-600",
                        expanded ? "whitespace-pre-wrap" : "truncate",
                      )}
                    >
                      {expanded ? reply.content : reply.content.replace(/\s+/g, " ").trim()}
                    </span>
                  </span>
                </button>
                {canManageScopedItem(reply, !!isAdmin, departments) && (
                  <div className="flex shrink-0 gap-1 py-2.5 pr-2">
                    <button
                      onClick={() => openEdit(reply)}
                      className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-600"
                      title="Editar"
                    >
                      <Pencil className="h-4 w-4" />
                    </button>
                    <button
                      onClick={() => void remove(reply)}
                      className="rounded-lg p-1.5 text-slate-300 hover:bg-red-50 hover:text-red-600"
                      title="Excluir"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </div>
                )}
              </div>
            );
          })}
        </Card>
      )}

      <Modal
        open={editing != null}
        onClose={() => setEditing(null)}
        title={editing === "new" ? "Nova resposta rápida" : "Editar resposta rápida"}
        wide
      >
        <div className="space-y-4">
          <Field label="Atalho (sem espaços — será usado como /atalho)">
            <Input
              value={form.shortcut}
              onChange={(event) =>
                setForm({ ...form, shortcut: event.target.value.toLowerCase().replace(/[^a-z0-9_-]/g, "") })
              }
              placeholder="Ex.: bomdia"
            />
          </Field>
          <Field label="Título (opcional, ajuda a encontrar)">
            <Input
              value={form.title}
              onChange={(event) => setForm({ ...form, title: event.target.value })}
              placeholder="Ex.: Saudação da manhã"
            />
          </Field>
          {isAdmin && (
            <label className="flex cursor-pointer items-center gap-2 text-sm text-slate-700">
              <input
                type="checkbox"
                className="h-4 w-4 rounded border-slate-300 text-brand-600"
                checked={form.isGeneral}
                onChange={(event) => toggleGeneral(event.target.checked)}
              />
              Vale para todos os departamentos
            </label>
          )}
          <Field label="Departamentos">
            <DepartmentCheckboxes
              selected={form.departmentIds}
              departments={departments}
              disabled={form.isGeneral}
              onChange={(departmentIds) => setForm({ ...form, departmentIds })}
            />
          </Field>
          <p className="text-xs text-slate-400">
            {form.isGeneral
              ? "A resposta aparece no /atalho de toda a organização."
              : "A resposta aparece para quem atua em qualquer um dos departamentos marcados."}
          </p>
          <Field label="Mensagem">
            <Textarea
              rows={5}
              value={form.content}
              onChange={(event) => setForm({ ...form, content: event.target.value })}
              placeholder="Texto completo que será inserido na conversa"
            />
          </Field>
          <Field label="Mídia (opcional — imagem, áudio ou vídeo)">
            {(() => {
              // Ordem de exibição: arquivo recém-escolhido vence a mídia já
              // salva; removida, volta o botão de anexar.
              const existingMedia =
                editing !== "new" && !mediaRemoved ? editing?.media ?? null : null;
              if (mediaFile) {
                const pickedType = quickReplyMediaTypeFromMime(mediaFile.type);
                return (
                  <div className="flex items-center gap-2 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2">
                    {pickedType && <MediaBadge type={pickedType} />}
                    <span className="min-w-0 flex-1 truncate text-sm text-slate-700">
                      {mediaFile.name}
                    </span>
                    <button
                      type="button"
                      onClick={() => setMediaFile(null)}
                      className="rounded p-1 text-slate-400 hover:bg-slate-200 hover:text-slate-600"
                      title="Descartar arquivo"
                    >
                      <X className="h-4 w-4" />
                    </button>
                  </div>
                );
              }
              if (existingMedia) {
                return (
                  <div className="flex items-center gap-2 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2">
                    <MediaBadge type={existingMedia.type} />
                    <span className="min-w-0 flex-1 truncate text-sm text-slate-700">
                      {existingMedia.filename ?? "Arquivo anexado"}
                    </span>
                    <button
                      type="button"
                      onClick={() => setMediaRemoved(true)}
                      className="rounded p-1 text-slate-400 hover:bg-red-50 hover:text-red-600"
                      title="Remover mídia"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </div>
                );
              }
              return (
                <button
                  type="button"
                  onClick={() => mediaInputRef.current?.click()}
                  className="flex w-full items-center justify-center gap-2 rounded-lg border border-dashed border-slate-300 px-3 py-2.5 text-sm text-slate-500 hover:border-brand-400 hover:text-brand-600"
                >
                  <Paperclip className="h-4 w-4" /> Anexar mídia
                </button>
              );
            })()}
            <input
              ref={mediaInputRef}
              type="file"
              accept="image/*,audio/*,video/*"
              className="hidden"
              onChange={(event) => {
                pickMedia(event.target.files?.[0] ?? null);
                event.target.value = "";
              }}
            />
          </Field>
          <p className="text-xs text-slate-400">
            A mídia sai junto com o texto ao usar o atalho na Inbox. Em imagem e vídeo o texto
            vira a legenda; em áudio, ele é enviado como mensagem logo em seguida.
          </p>
          {error && <p className="text-sm text-red-600">{error}</p>}
          <Button
            className="w-full"
            disabled={
              busy ||
              form.shortcut.length === 0 ||
              form.content.trim().length === 0 ||
              (!form.isGeneral && form.departmentIds.length === 0)
            }
            onClick={() => void save()}
          >
            Salvar
          </Button>
        </div>
      </Modal>
    </div>
  );
}

"use client";

import { useCallback, useEffect, useState } from "react";
import { ChevronRight, Pencil, Plus, Trash2, Zap } from "lucide-react";
import { quickRepliesApi } from "@/lib/api";
import { useAuth } from "@/lib/auth-context";
import { cn } from "@/lib/utils";
import type { QuickReplyDto } from "@/lib/types";
import { Button, Card, EmptyState, Field, Input, Modal, Spinner, Textarea } from "@/components/ui";
import {
  DepartmentBadges,
  DepartmentCheckboxes,
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

export default function QuickRepliesPage() {
  const { user: me } = useAuth();
  const departments = useMyDepartments();
  const [replies, setReplies] = useState<QuickReplyDto[] | null>(null);
  const [editing, setEditing] = useState<QuickReplyDto | "new" | null>(null);
  const [form, setForm] = useState(EMPTY_FORM);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // A lista nasce recolhida: com mensagem inteira aberta cabiam três respostas
  // na tela, e o atalho — que é o que se procura aqui — ficava perdido.
  const [expandedIds, setExpandedIds] = useState<string[]>([]);

  const load = useCallback(() => {
    quickRepliesApi.list().then(setReplies);
  }, []);
  useEffect(load, [load]);

  const isAdmin = me?.role === "admin";
  const allExpanded = !!replies && replies.length > 0 && expandedIds.length === replies.length;

  function openNew() {
    // Sem "vale para todos" para quem não é admin: já entra no primeiro
    // departamento dele marcado.
    setForm({
      ...EMPTY_FORM,
      departmentIds: isAdmin ? [] : departments[0] ? [departments[0].id] : [],
    });
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
    setError(null);
    setEditing(reply);
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
      if (editing === "new") {
        await quickRepliesApi.create(payload);
      } else if (editing) {
        await quickRepliesApi.update(editing.id, payload);
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
          <button
            type="button"
            onClick={() =>
              setExpandedIds(allExpanded ? [] : replies.map((reply) => reply.id))
            }
            className="text-sm font-medium text-brand-600 hover:underline"
          >
            {allExpanded ? "Recolher todas" : "Expandir todas"}
          </button>
        )}
      </div>

      {!replies ? (
        <div className="flex justify-center py-16">
          <Spinner className="h-8 w-8" />
        </div>
      ) : replies.length === 0 ? (
        <EmptyState
          icon={<Zap className="h-12 w-12" />}
          title="Nenhuma resposta rápida cadastrada"
          description='Crie atalhos como /bomdia ou /boleto e use-os na Inbox digitando "/".'
        />
      ) : (
        <Card className="divide-y divide-slate-100">
          {replies.map((reply) => {
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

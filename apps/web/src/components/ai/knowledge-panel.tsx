"use client";

import { useCallback, useEffect, useState } from "react";
import { BookOpen, Pencil, Plus, Trash2 } from "lucide-react";
import {
  AI_KNOWLEDGE_KINDS,
  AI_KNOWLEDGE_KIND_LABELS,
  AI_KNOWLEDGE_MAX_CHARS,
  type AiKnowledgeSourceDto,
} from "@azvchat/shared";
import { ApiError, aiApi, type AiKnowledgeInput } from "@/lib/api";
import { formatDateTime } from "@/lib/utils";
import { Badge, Button, Card, EmptyState, Field, Input, Modal, Spinner, Textarea } from "@/components/ui";
import { Notice, Select, Toggle } from "./ai-ui";

/**
 * Base de conhecimento: fontes de texto livre ou perguntas e respostas. Cada
 * agente escolhe quais fontes usa; a busca é por trecho, então a fonte
 * inteira nunca vai ao modelo.
 */

const EMPTY: AiKnowledgeInput = { title: "", kind: "text", content: "", active: true };

const FAQ_HINT = "P: Vocês atendem MEI?\nR: Sim, atendemos MEI com plano específico.\n\nP: Qual o horário de atendimento?\nR: De segunda a sexta, das 8h às 18h.";

export function KnowledgePanel() {
  const [sources, setSources] = useState<AiKnowledgeSourceDto[] | null>(null);
  const [editing, setEditing] = useState<AiKnowledgeSourceDto | "new" | null>(null);
  const [form, setForm] = useState<AiKnowledgeInput>(EMPTY);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setSources(await aiApi.knowledge());
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Não foi possível carregar a base");
    }
  }, []);
  useEffect(() => void load(), [load]);

  function open(target: AiKnowledgeSourceDto | "new") {
    setEditing(target);
    setForm(target === "new" ? EMPTY : { title: target.title, kind: target.kind, content: target.content, active: target.active });
  }

  async function save() {
    if (!editing) return;
    setBusy(true);
    setError(null);
    try {
      if (editing === "new") await aiApi.createKnowledge(form);
      else await aiApi.updateKnowledge(editing.id, form);
      setEditing(null);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Não foi possível salvar");
    } finally {
      setBusy(false);
    }
  }

  async function remove(source: AiKnowledgeSourceDto) {
    if (!window.confirm(`Excluir a fonte "${source.title}"? Os agentes que a usam deixam de consultá-la.`)) return;
    try {
      await aiApi.deleteKnowledge(source.id);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Não foi possível excluir");
    }
  }

  if (!sources) {
    return (
      <div className="flex justify-center py-8">
        <Spinner />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-4">
        <p className="text-sm text-slate-500">
          O que a IA pode consultar: serviços, FAQ, informações institucionais, procedimentos. Cada agente escolhe
          suas fontes; só os trechos relevantes para a pergunta vão ao modelo.
        </p>
        <Button onClick={() => open("new")}>
          <Plus className="h-4 w-4" /> Nova fonte
        </Button>
      </div>
      {error && <Notice tone="error">{error}</Notice>}
      {sources.length === 0 ? (
        <Card>
          <EmptyState icon={<BookOpen className="h-8 w-8" />} title="Base vazia" description="Cadastre os serviços do escritório e um FAQ. Sem base, a IA só responde com o que está no objetivo e nas instruções." />
        </Card>
      ) : (
        <div className="space-y-2">
          {sources.map((source) => (
            <Card key={source.id} className="flex items-center gap-3 p-4">
              <div className="min-w-0 flex-1">
                <p className="flex items-center gap-2 text-sm font-medium text-slate-900">
                  {source.title}
                  <Badge>{AI_KNOWLEDGE_KIND_LABELS[source.kind]}</Badge>
                  {!source.active && <Badge color="#b45309">Inativa</Badge>}
                </p>
                <p className="truncate text-xs text-slate-400">{source.content.slice(0, 160)}</p>
                <p className="text-[11px] text-slate-400">
                  {source.content.length.toLocaleString("pt-BR")} caracteres · usada por {source.agentsCount} agente(s) · {formatDateTime(source.updatedAt)}
                </p>
              </div>
              <Button size="sm" variant="ghost" onClick={() => open(source)}>
                <Pencil className="h-3.5 w-3.5" />
              </Button>
              <Button size="sm" variant="ghost" onClick={() => void remove(source)}>
                <Trash2 className="h-3.5 w-3.5 text-red-500" />
              </Button>
            </Card>
          ))}
        </div>
      )}

      <Modal open={editing !== null} onClose={() => setEditing(null)} title={editing === "new" ? "Nova fonte de conhecimento" : "Editar fonte"} wide>
        <div className="space-y-4">
          <div className="grid gap-3 md:grid-cols-2">
            <Field label="Título">
              <Input value={form.title} maxLength={120} placeholder="Ex.: Serviços, FAQ Comercial" onChange={(event) => setForm({ ...form, title: event.target.value })} />
            </Field>
            <Field label="Tipo">
              <Select value={form.kind} onChange={(event) => setForm({ ...form, kind: event.target.value as AiKnowledgeInput["kind"] })}>
                {AI_KNOWLEDGE_KINDS.map((kind) => (
                  <option key={kind} value={kind}>
                    {AI_KNOWLEDGE_KIND_LABELS[kind]}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          <Field label={form.kind === "faq" ? "Perguntas e respostas (P:/R:, um par por bloco)" : "Conteúdo (parágrafos separados por linha em branco)"}>
            <Textarea
              rows={14}
              maxLength={AI_KNOWLEDGE_MAX_CHARS}
              className="font-mono text-xs"
              placeholder={form.kind === "faq" ? FAQ_HINT : "Abertura de empresa: cuidamos do registro na Junta, CNPJ, inscrição municipal e alvará. Prazo médio de 15 dias úteis.\n\nContabilidade mensal: ..."}
              value={form.content}
              onChange={(event) => setForm({ ...form, content: event.target.value })}
            />
          </Field>
          <p className="text-[11px] text-slate-400">
            {form.content.length.toLocaleString("pt-BR")} / {AI_KNOWLEDGE_MAX_CHARS.toLocaleString("pt-BR")} caracteres
          </p>
          <Toggle checked={form.active} onChange={(checked) => setForm({ ...form, active: checked })} label="Fonte ativa" hint="Inativa continua cadastrada, mas nenhum agente a consulta." />
          {error && <Notice tone="error">{error}</Notice>}
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setEditing(null)}>
              Cancelar
            </Button>
            <Button disabled={busy || form.title.trim().length < 2 || !form.content.trim()} onClick={() => void save()}>
              {busy ? "Salvando…" : "Salvar"}
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}

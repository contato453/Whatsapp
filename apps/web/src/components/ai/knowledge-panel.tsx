"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { BookOpen, Link2, Pencil, Plus, Trash2, Upload } from "lucide-react";
import {
  AI_KNOWLEDGE_EXTRACTED_KINDS,
  AI_KNOWLEDGE_KINDS,
  AI_KNOWLEDGE_KIND_LABELS,
  AI_KNOWLEDGE_MAX_CHARS,
  type AiKnowledgeKind,
  type AiKnowledgeSourceDto,
} from "@azvchat/shared";
import { ApiError, aiApi, type AiKnowledgeInput } from "@/lib/api";
import { formatDateTime } from "@/lib/utils";
import { Badge, Button, Card, EmptyState, Field, Input, Modal, Spinner, Textarea } from "@/components/ui";
import { Notice, Select, Toggle } from "./ai-ui";

/**
 * Base de conhecimento: fontes de texto livre, perguntas e respostas, LINK
 * ou DOCUMENTO (PDF/DOCX/TXT). Cada agente escolhe quais fontes usa; a
 * busca é por trecho, então a fonte inteira nunca vai ao modelo.
 *
 * Link e documento são só um jeito A MAIS de preencher o campo de conteúdo:
 * a extração roda num clique, cai no MESMO textarea das outras duas, e quem
 * cadastra revisa/edita antes de salvar — igual a colar o texto à mão.
 * Depois de salva, a fonte não tem diferença nenhuma das demais (mesma
 * busca, mesmo limite de caracteres); não existe reextração automática, e
 * por isso trocar de link ou reenviar o arquivo é sempre "extrair de novo",
 * nunca um botão de "atualizar".
 */

const EMPTY: AiKnowledgeInput = { title: "", kind: "text", content: "", sourceRef: null, active: true };

const FAQ_HINT = "P: Vocês atendem MEI?\nR: Sim, atendemos MEI com plano específico.\n\nP: Qual o horário de atendimento?\nR: De segunda a sexta, das 8h às 18h.";

function isExtractedKind(kind: AiKnowledgeKind): boolean {
  return (AI_KNOWLEDGE_EXTRACTED_KINDS as readonly string[]).includes(kind);
}

export function KnowledgePanel() {
  const [sources, setSources] = useState<AiKnowledgeSourceDto[] | null>(null);
  const [editing, setEditing] = useState<AiKnowledgeSourceDto | "new" | null>(null);
  const [form, setForm] = useState<AiKnowledgeInput>(EMPTY);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Estado só da extração (link/documento) — separado do erro de salvar,
  // porque as duas ações não acontecem juntas.
  const [urlToExtract, setUrlToExtract] = useState("");
  const [extracting, setExtracting] = useState(false);
  const [extractError, setExtractError] = useState<string | null>(null);
  const [truncatedNotice, setTruncatedNotice] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const load = useCallback(async () => {
    try {
      setSources(await aiApi.knowledge());
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Não foi possível carregar a base");
    }
  }, []);
  useEffect(() => void load(), [load]);

  function resetExtractionState() {
    setUrlToExtract("");
    setExtractError(null);
    setTruncatedNotice(false);
  }

  function open(target: AiKnowledgeSourceDto | "new") {
    setEditing(target);
    setForm(
      target === "new"
        ? EMPTY
        : { title: target.title, kind: target.kind, content: target.content, sourceRef: target.sourceRef, active: target.active },
    );
    resetExtractionState();
  }

  async function extractFromUrl() {
    if (!urlToExtract.trim()) return;
    setExtracting(true);
    setExtractError(null);
    setTruncatedNotice(false);
    try {
      const result = await aiApi.extractKnowledgeUrl(urlToExtract.trim());
      setForm((prev) => ({
        ...prev,
        title: prev.title.trim() ? prev.title : result.title,
        content: result.content,
        sourceRef: urlToExtract.trim(),
      }));
      setTruncatedNotice(result.truncated);
    } catch (err) {
      setExtractError(err instanceof ApiError ? err.message : "Não foi possível extrair esse link");
    } finally {
      setExtracting(false);
    }
  }

  async function extractFromFile(file: File) {
    setExtracting(true);
    setExtractError(null);
    setTruncatedNotice(false);
    try {
      const result = await aiApi.extractKnowledgeDocument(file);
      setForm((prev) => ({
        ...prev,
        title: prev.title.trim() ? prev.title : result.title,
        content: result.content,
        sourceRef: file.name,
      }));
      setTruncatedNotice(result.truncated);
    } catch (err) {
      setExtractError(err instanceof ApiError ? err.message : "Não foi possível ler esse arquivo");
    } finally {
      setExtracting(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
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
                  {source.sourceRef && <> · extraída de {source.sourceRef}</>}
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
              <Select
                value={form.kind}
                onChange={(event) => {
                  const kind = event.target.value as AiKnowledgeInput["kind"];
                  setForm({ ...form, kind, sourceRef: isExtractedKind(kind) ? form.sourceRef : null });
                  resetExtractionState();
                }}
              >
                {AI_KNOWLEDGE_KINDS.map((kind) => (
                  <option key={kind} value={kind}>
                    {AI_KNOWLEDGE_KIND_LABELS[kind]}
                  </option>
                ))}
              </Select>
            </Field>
          </div>

          {form.kind === "url" && (
            <div className="space-y-2 rounded-lg border border-slate-200 bg-slate-50 p-3">
              <div className="flex gap-2">
                <Input
                  value={urlToExtract}
                  placeholder="https://www.exemplo.com.br/servicos"
                  onChange={(event) => setUrlToExtract(event.target.value)}
                />
                <Button variant="outline" disabled={extracting || !urlToExtract.trim()} onClick={() => void extractFromUrl()}>
                  {extracting ? <Spinner className="h-4 w-4" /> : <Link2 className="h-4 w-4" />} Extrair texto
                </Button>
              </div>
              <p className="text-[11px] text-slate-400">
                Busca a página e traz o texto para o campo abaixo — revise e edite antes de salvar. Só páginas
                públicas (http/https).
              </p>
            </div>
          )}

          {form.kind === "document" && (
            <div className="space-y-2 rounded-lg border border-slate-200 bg-slate-50 p-3">
              <input
                ref={fileInputRef}
                type="file"
                accept=".pdf,.docx,.txt"
                hidden
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (file) void extractFromFile(file);
                }}
              />
              <Button variant="outline" disabled={extracting} onClick={() => fileInputRef.current?.click()}>
                {extracting ? <Spinner className="h-4 w-4" /> : <Upload className="h-4 w-4" />} Escolher arquivo (PDF, DOCX ou TXT)
              </Button>
              {form.sourceRef && <p className="text-[11px] text-slate-400">Último arquivo lido: {form.sourceRef}</p>}
            </div>
          )}

          {extractError && <Notice tone="error">{extractError}</Notice>}
          {truncatedNotice && (
            <Notice tone="warn">
              O texto extraído passou de {AI_KNOWLEDGE_MAX_CHARS.toLocaleString("pt-BR")} caracteres e foi cortado —
              revise o que ficou de fora antes de salvar.
            </Notice>
          )}

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

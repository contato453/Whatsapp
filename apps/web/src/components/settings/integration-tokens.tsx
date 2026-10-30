"use client";

import { useEffect, useState } from "react";
import { Check, Copy, KanbanSquare, KeyRound, Plus, Trash2 } from "lucide-react";
import type { CrmPipelineDirectoryResponse } from "@azvchat/shared";
import { API_URL, ApiError, api, crmApi, integrationTokensApi } from "@/lib/api";
import type { InstanceDto, IntegrationTokenDto } from "@/lib/types";
import { Badge, Button, Card, Field, Input, Modal, Spinner } from "@/components/ui";

/**
 * Administração dos tokens da API de integração — só o admin vê este card (a
 * tela de Configurações renderiza condicionalmente, e a API recusa de novo por
 * conta própria com `requireRole("admin")`).
 *
 * O token em claro aparece UMA vez, logo após criar, com aviso de que não será
 * mostrado de novo e botão de copiar. Depois disso, só o prefixo.
 */
const SEND_ENDPOINT = `${API_URL}/integrations/messages`;

function exemploChamada(): string {
  return [
    `curl -X POST "${SEND_ENDPOINT}" \\`,
    `  -H "Authorization: Bearer SEU_TOKEN" \\`,
    `  -H "Content-Type: application/json" \\`,
    `  -d '{"telefone":"5511999998888","mensagem":"Sua reunião foi confirmada.","nome":"Maria Souza"}'`,
  ].join("\n");
}

const SELECT_CLASS =
  "w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 focus:border-brand-600 focus:outline-none focus:ring-1 focus:ring-brand-600 disabled:bg-slate-50 disabled:text-slate-400";

interface CrmTarget {
  pipelineId: string;
  stageId: string;
}

/**
 * Funil e etapa do CRM para onde vai quem chega pelo token (ex.: o formulário
 * do site). Vazio = o token só manda a mensagem. Etapa vazia = a primeira do
 * funil. A lista vem do mesmo diretório do bloco "Enviar para funil" dos
 * fluxos, então os dois lugares oferecem exatamente os mesmos funis.
 */
function CrmTargetFields({
  directory,
  value,
  onChange,
}: {
  directory: CrmPipelineDirectoryResponse | null;
  value: CrmTarget;
  onChange: (value: CrmTarget) => void;
}) {
  if (directory && !directory.enabled) {
    return (
      <p className="text-xs text-slate-400">
        O CRM está desligado neste escritório. Ligue-o em Configurações para mandar os contatos
        deste token para um funil.
      </p>
    );
  }
  const pipelines = directory?.pipelines ?? [];
  const pipeline = pipelines.find((item) => item.id === value.pipelineId);
  return (
    <div className="grid gap-2 sm:grid-cols-2">
      <Field label="Enviar também para o funil (CRM)">
        <select
          value={value.pipelineId}
          disabled={!directory}
          onChange={(event) => onChange({ pipelineId: event.target.value, stageId: "" })}
          className={SELECT_CLASS}
        >
          <option value="">Não enviar ao CRM</option>
          {pipelines.map((item) => (
            <option key={item.id} value={item.id}>
              {item.name}
              {item.isActive ? "" : " (desativado)"}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Etapa">
        <select
          value={value.stageId}
          disabled={!pipeline}
          onChange={(event) => onChange({ ...value, stageId: event.target.value })}
          className={SELECT_CLASS}
        >
          <option value="">Primeira etapa do funil</option>
          {pipeline?.stages.map((stage) => (
            <option key={stage.id} value={stage.id}>
              {stage.name}
            </option>
          ))}
        </select>
      </Field>
    </div>
  );
}

/** Texto curto do destino no CRM, para a linha da lista. */
function crmTargetLabel(token: IntegrationTokenDto): string | null {
  if (!token.crmPipelineId) return null;
  return `CRM: ${token.crmPipelineName ?? "funil"} → ${token.crmStageName ?? "primeira etapa"}`;
}

export function IntegrationTokensCard() {
  const [tokens, setTokens] = useState<IntegrationTokenDto[]>([]);
  const [instances, setInstances] = useState<InstanceDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [name, setName] = useState("");
  const [instanceId, setInstanceId] = useState("");
  const [crmTarget, setCrmTarget] = useState<CrmTarget>({ pipelineId: "", stageId: "" });
  const [creating, setCreating] = useState(false);
  // Diretório de funis: nulo enquanto carrega (ou se falhou) — os seletores
  // ficam desabilitados, mas criar token sem CRM continua possível.
  const [directory, setDirectory] = useState<CrmPipelineDirectoryResponse | null>(null);
  // Token cujo destino no CRM está sendo editado.
  const [editing, setEditing] = useState<IntegrationTokenDto | null>(null);
  const [editTarget, setEditTarget] = useState<CrmTarget>({ pipelineId: "", stageId: "" });
  const [saving, setSaving] = useState(false);
  // Token recém-criado, mostrado uma única vez.
  const [freshToken, setFreshToken] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const [tokenList, instanceData] = await Promise.all([
          integrationTokensApi.list(),
          api.get<{ instances: InstanceDto[] }>("/whatsapp-instances"),
        ]);
        setTokens(tokenList);
        setInstances(instanceData.instances);
        // O diretório é acessório: falhar aqui não pode esconder os tokens.
        setDirectory(await crmApi.pipelinesDirectory().catch(() => null));
      } catch (err) {
        setError(err instanceof ApiError ? err.message : "Não foi possível carregar os tokens");
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  async function create() {
    if (!name.trim() || !instanceId) return;
    setCreating(true);
    setError(null);
    try {
      const result = await integrationTokensApi.create({
        name: name.trim(),
        whatsappInstanceId: instanceId,
        crmPipelineId: crmTarget.pipelineId || null,
        crmStageId: crmTarget.stageId || null,
      });
      setTokens((prev) => [result.integrationToken, ...prev]);
      setFreshToken(result.token);
      setName("");
      setInstanceId("");
      setCrmTarget({ pipelineId: "", stageId: "" });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Não foi possível criar o token");
    } finally {
      setCreating(false);
    }
  }

  function openEdit(token: IntegrationTokenDto) {
    setEditing(token);
    setEditTarget({ pipelineId: token.crmPipelineId ?? "", stageId: token.crmStageId ?? "" });
  }

  async function saveEdit() {
    if (!editing) return;
    setSaving(true);
    setError(null);
    try {
      const updated = await integrationTokensApi.update(editing.id, {
        crmPipelineId: editTarget.pipelineId || null,
        crmStageId: editTarget.stageId || null,
      });
      setTokens((prev) => prev.map((entry) => (entry.id === updated.id ? updated : entry)));
      setEditing(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Não foi possível salvar o destino no CRM");
    } finally {
      setSaving(false);
    }
  }

  async function revoke(token: IntegrationTokenDto) {
    if (!window.confirm(`Revogar o token "${token.name}"? Ele deixa de funcionar imediatamente.`)) return;
    try {
      const updated = await integrationTokensApi.revoke(token.id);
      setTokens((prev) => prev.map((entry) => (entry.id === token.id ? updated : entry)));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Não foi possível revogar o token");
    }
  }

  return (
    <Card className="space-y-4 p-6">
      <div>
        <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">
          Tokens de integração
        </h2>
        <p className="mt-1 text-xs text-slate-400">
          Para um sistema externo (ex.: seu agendador) enviar uma mensagem pelo WhatsApp do
          escritório. Cada token envia por um único número e pode, além da mensagem, colocar o
          contato numa etapa do funil do CRM.
        </p>
      </div>

      {/* Token recém-criado: mostrado UMA vez. */}
      {freshToken && (
        <div className="space-y-2 rounded-lg border border-amber-300 bg-amber-50 p-3">
          <p className="text-xs font-medium text-amber-800">
            Copie agora — este token não será mostrado de novo.
          </p>
          <div className="flex items-center gap-2">
            <code className="min-w-0 flex-1 truncate rounded bg-white px-2 py-1.5 font-mono text-xs text-slate-800">
              {freshToken}
            </code>
            <CopyButton value={freshToken} />
          </div>
        </div>
      )}

      {/* Criar */}
      <div className="space-y-2 rounded-lg border border-slate-200 p-3">
        <Field label="Nome do token">
          <Input
            value={name}
            maxLength={80}
            placeholder="Ex.: Agendamento de reuniões"
            onChange={(event) => setName(event.target.value)}
          />
        </Field>
        <Field label="Número que envia">
          <select
            value={instanceId}
            onChange={(event) => setInstanceId(event.target.value)}
            className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 focus:border-brand-600 focus:outline-none focus:ring-1 focus:ring-brand-600"
          >
            <option value="">Selecione um número…</option>
            {instances.map((instance) => (
              <option key={instance.id} value={instance.id}>
                {instance.name}
                {instance.phoneNumber ? ` (${instance.phoneNumber})` : ""}
              </option>
            ))}
          </select>
        </Field>
        <CrmTargetFields directory={directory} value={crmTarget} onChange={setCrmTarget} />
        <Button disabled={creating || !name.trim() || !instanceId} onClick={() => void create()}>
          <Plus className="h-4 w-4" /> Gerar token
        </Button>
      </div>

      {error && <p className="text-sm text-red-600">{error}</p>}

      {/* Lista */}
      {loading ? (
        <div className="flex justify-center py-4">
          <Spinner className="h-5 w-5" />
        </div>
      ) : tokens.length === 0 ? (
        <p className="py-2 text-sm text-slate-400">Nenhum token criado ainda.</p>
      ) : (
        <ul className="divide-y divide-slate-100">
          {tokens.map((token) => (
            <li key={token.id} className="flex items-center gap-3 py-3">
              <KeyRound className="h-4 w-4 shrink-0 text-slate-400" />
              <div className="min-w-0 flex-1">
                <p className="flex items-center gap-2 text-sm font-medium text-slate-900">
                  {token.name}
                  {token.active ? (
                    <Badge color="#16a34a">Ativo</Badge>
                  ) : (
                    <Badge>Revogado</Badge>
                  )}
                </p>
                <p className="mt-0.5 truncate text-xs text-slate-400">
                  <span className="font-mono">{token.tokenPrefix}…</span>
                  {" · "}
                  {token.instanceName ?? "número removido"}
                  {" · "}
                  {token.usageCount} envio{token.usageCount === 1 ? "" : "s"}
                  {" · "}
                  {token.lastUsedAt
                    ? `último uso ${new Date(token.lastUsedAt).toLocaleString("pt-BR")}`
                    : "nunca usado"}
                </p>
                {crmTargetLabel(token) && (
                  <p className="mt-0.5 truncate text-xs text-slate-500">{crmTargetLabel(token)}</p>
                )}
              </div>
              {token.active && (
                <>
                  <Button size="sm" variant="outline" onClick={() => openEdit(token)}>
                    <KanbanSquare className="h-3.5 w-3.5" /> CRM
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => void revoke(token)}>
                    <Trash2 className="h-3.5 w-3.5" /> Revogar
                  </Button>
                </>
              )}
            </li>
          ))}
        </ul>
      )}

      {/* Como usar */}
      <div className="space-y-2 border-t border-slate-100 pt-3">
        <p className="text-xs font-medium text-slate-600">Endpoint de envio</p>
        <div className="flex items-center gap-2">
          <code className="min-w-0 flex-1 truncate rounded bg-slate-50 px-2 py-1.5 font-mono text-xs text-slate-700">
            POST {SEND_ENDPOINT}
          </code>
          <CopyButton value={SEND_ENDPOINT} />
        </div>
        <p className="text-xs text-slate-400">
          Opcionais: <span className="font-mono">nome</span> (vira o título do card no CRM) e{" "}
          <span className="font-mono">funilId</span>/<span className="font-mono">etapaId</span>{" "}
          (escolhem o funil por chamada, por cima do configurado no token).
        </p>
        <p className="text-xs font-medium text-slate-600">Exemplo</p>
        <div className="relative">
          <pre className="overflow-x-auto rounded bg-slate-900 p-3 text-[11px] leading-relaxed text-slate-100">
            <code>{exemploChamada()}</code>
          </pre>
          <div className="absolute right-2 top-2">
            <CopyButton value={exemploChamada()} dark />
          </div>
        </div>
      </div>

      <Modal
        open={editing !== null}
        onClose={() => setEditing(null)}
        title={editing ? `CRM do token "${editing.name}"` : "CRM do token"}
      >
        <div className="space-y-3">
          <p className="text-xs text-slate-500">
            Todo envio feito com este token abre também um card nesta etapa. Contato que já tem
            card aberto no mesmo funil continua onde está. A mudança vale a partir do próximo
            envio, sem mexer no sistema que chama a API.
          </p>
          <CrmTargetFields directory={directory} value={editTarget} onChange={setEditTarget} />
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setEditing(null)}>
              Cancelar
            </Button>
            <Button disabled={saving} onClick={() => void saveEdit()}>
              Salvar
            </Button>
          </div>
        </div>
      </Modal>
    </Card>
  );
}

/** Botão de copiar com confirmação visual por 2s. */
function CopyButton({ value, dark }: { value: string; dark?: boolean }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Área de transferência bloqueada: sem confirmação, mas não quebra a tela.
    }
  }
  return (
    <button
      type="button"
      onClick={() => void copy()}
      aria-label="Copiar"
      className={
        dark
          ? "rounded p-1.5 text-slate-300 hover:bg-slate-700 hover:text-white"
          : "rounded p-1.5 text-slate-500 hover:bg-slate-100 hover:text-slate-800"
      }
    >
      {copied ? <Check className="h-4 w-4 text-emerald-500" /> : <Copy className="h-4 w-4" />}
    </button>
  );
}

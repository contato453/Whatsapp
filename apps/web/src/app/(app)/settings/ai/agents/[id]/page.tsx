"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { ArrowLeft, FlaskConical, History, Power, Save } from "lucide-react";
import {
  AI_AGENT_STATUS_COLORS,
  AI_AGENT_STATUS_LABELS,
  defaultAiAgentConfig,
  type AiAgentDto,
  type AiAgentVersionDto,
  type AiKnowledgeSourceDto,
  type AiModelDto,
} from "@azvchat/shared";
import { ApiError, aiApi, api, type AiAgentInput } from "@/lib/api";
import { useAuth } from "@/lib/auth-context";
import type { DepartmentDto, UserDirectoryDto } from "@/lib/types";
import { formatDateTime } from "@/lib/utils";
import { Badge, Button, Card, Spinner } from "@/components/ui";
import { useMyDepartments } from "@/components/department-picker";
import { AgentForm, type AgentFormOptions } from "@/components/ai/agent-form";
import { AgentTester } from "@/components/ai/agent-tester";
import { Notice } from "@/components/ai/ai-ui";

/**
 * Tela do agente: formulário estruturado à esquerda, testador à direita.
 * `new` cria; um id edita. Salvar com mudança de configuração gera versão
 * nova (a API decide); ativar exige provedor conectado e objetivo.
 */
function toInput(agent: AiAgentDto): AiAgentInput {
  return {
    name: agent.name,
    description: agent.description,
    isGeneral: agent.isGeneral,
    departmentIds: agent.departments.map((department) => department.id),
    model: agent.model === agent.config.advanced.model || agent.config.advanced.model ? agent.config.advanced.model : null,
    knowledgeSourceIds: agent.knowledgeSourceIds,
    config: agent.config,
  };
}

const NEW_INPUT: AiAgentInput = {
  name: "",
  description: "",
  isGeneral: false,
  departmentIds: [],
  model: null,
  knowledgeSourceIds: [],
  config: defaultAiAgentConfig(),
};

export default function AgentPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const { user, can } = useAuth();
  const isNew = params.id === "new";
  const myDepartments = useMyDepartments();

  const [agent, setAgent] = useState<AiAgentDto | null>(null);
  const [input, setInput] = useState<AiAgentInput>(NEW_INPUT);
  const [saved, setSaved] = useState<AiAgentInput>(NEW_INPUT);
  const [allDepartments, setAllDepartments] = useState<DepartmentDto[]>([]);
  const [users, setUsers] = useState<UserDirectoryDto[]>([]);
  const [knowledge, setKnowledge] = useState<AiKnowledgeSourceDto[]>([]);
  const [models, setModels] = useState<AiModelDto[]>([]);
  const [defaultModel, setDefaultModel] = useState<string | null>(null);
  const [versions, setVersions] = useState<AiAgentVersionDto[]>([]);
  const [showVersions, setShowVersions] = useState(false);
  const [loading, setLoading] = useState(!isNew);
  const [busy, setBusy] = useState<"save" | "status" | null>(null);
  const [feedback, setFeedback] = useState<{ ok: boolean; message: string } | null>(null);
  const [showTester, setShowTester] = useState(false);

  const load = useCallback(async () => {
    try {
      const [departmentData, optionData, knowledgeData] = await Promise.all([
        api.get<{ departments: DepartmentDto[] }>("/departments"),
        aiApi.options(),
        aiApi.knowledge(),
      ]);
      setAllDepartments(departmentData.departments);
      setUsers(optionData.users);
      setKnowledge(knowledgeData);
      if (user?.role === "admin") {
        const modelData = await aiApi.models("openai").catch(() => null);
        if (modelData) setModels(modelData.models);
        const providers = await aiApi.providers().catch(() => null);
        setDefaultModel(providers?.providers.find((provider) => provider.provider === "openai")?.defaultModel ?? null);
      }
      if (!isNew) {
        const loaded = await aiApi.agent(params.id);
        setAgent(loaded);
        const asInput = toInput(loaded);
        setInput(asInput);
        setSaved(asInput);
        setVersions(await aiApi.agentVersions(loaded.id));
      }
    } catch (err) {
      setFeedback({ ok: false, message: err instanceof ApiError ? err.message : "Não foi possível carregar o agente" });
    } finally {
      setLoading(false);
    }
  }, [isNew, params.id, user?.role]);
  useEffect(() => void load(), [load]);

  const dirty = useMemo(() => JSON.stringify(input) !== JSON.stringify(saved), [input, saved]);

  async function save() {
    setBusy("save");
    setFeedback(null);
    try {
      const result = isNew ? await aiApi.createAgent(input) : await aiApi.updateAgent(params.id, input);
      setAgent(result);
      const asInput = toInput(result);
      setInput(asInput);
      setSaved(asInput);
      setFeedback({ ok: true, message: isNew ? "Agente criado como rascunho. Teste e depois ative." : `Salvo (versão ${result.version}).` });
      if (isNew) router.replace(`/settings/ai/agents/${result.id}`);
      else setVersions(await aiApi.agentVersions(result.id));
    } catch (err) {
      setFeedback({ ok: false, message: err instanceof ApiError ? err.message : "Não foi possível salvar" });
    } finally {
      setBusy(null);
    }
  }

  async function toggleStatus() {
    if (!agent) return;
    const next = agent.status === "active" ? "inactive" : "active";
    if (next === "inactive" && !window.confirm("Desativar o agente? Atendimentos em andamento são encerrados com a mensagem de fallback e vão para a fila humana.")) return;
    setBusy("status");
    setFeedback(null);
    try {
      const result = await aiApi.setAgentStatus(agent.id, next);
      setAgent(result);
      setFeedback({ ok: true, message: next === "active" ? "Agente ativo. Crie uma automação para colocá-lo em uma conversa." : "Agente desativado." });
    } catch (err) {
      setFeedback({ ok: false, message: err instanceof ApiError ? err.message : "Não foi possível alterar o status" });
    } finally {
      setBusy(null);
    }
  }

  if (!can("ai.agent.manage")) {
    return <div className="p-8 text-sm text-slate-500">Sem permissão para configurar agentes de IA.</div>;
  }
  if (loading) {
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner className="h-8 w-8" />
      </div>
    );
  }

  const options: AgentFormOptions = {
    departments: myDepartments,
    allDepartments,
    users,
    knowledge,
    models,
    defaultModel,
    canCreateGeneral: user?.role === "admin",
  };

  return (
    <div className="flex h-full min-h-0">
      <div className="thin-scroll min-w-0 flex-1 overflow-y-auto p-8">
        <div className="mb-1 flex items-center gap-2 text-xs text-slate-400">
          <Link href="/settings/ai?tab=agents" className="inline-flex items-center gap-1 hover:text-slate-600">
            <ArrowLeft className="h-3 w-3" /> Agentes de IA
          </Link>
        </div>
        <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="flex items-center gap-2 text-2xl font-bold text-slate-900">
              {isNew ? "Novo agente de IA" : agent?.name}
              {agent && <Badge color={AI_AGENT_STATUS_COLORS[agent.status]}>{AI_AGENT_STATUS_LABELS[agent.status]}</Badge>}
              {agent && <span className="text-sm font-normal text-slate-400">v{agent.version}</span>}
            </h1>
            {agent && <p className="text-xs text-slate-400">Alterado em {formatDateTime(agent.updatedAt)} · {agent.sessionsCount} atendimento(s)</p>}
          </div>
          <div className="flex flex-wrap gap-2">
            {agent && (
              <>
                <Button variant="outline" onClick={() => setShowTester((value) => !value)}>
                  <FlaskConical className="h-4 w-4" /> {showTester ? "Fechar testador" : "Testar agente"}
                </Button>
                <Button variant="outline" onClick={() => setShowVersions((value) => !value)}>
                  <History className="h-4 w-4" /> Versões
                </Button>
                <Button variant={agent.status === "active" ? "outline" : "secondary"} disabled={busy !== null || dirty} onClick={() => void toggleStatus()} title={dirty ? "Salve antes de ativar" : undefined}>
                  <Power className="h-4 w-4" /> {agent.status === "active" ? "Desativar" : "Ativar"}
                </Button>
              </>
            )}
            <Button disabled={busy !== null || !dirty || input.name.trim().length < 2} onClick={() => void save()}>
              <Save className="h-4 w-4" /> {busy === "save" ? "Salvando…" : isNew ? "Criar agente" : "Salvar"}
            </Button>
          </div>
        </div>
        {feedback && (
          <div className="mb-4">
            <Notice tone={feedback.ok ? "ok" : "error"}>{feedback.message}</Notice>
          </div>
        )}
        {showVersions && agent && (
          <Card className="mb-4 p-4">
            <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">Versões</p>
            <p className="mb-2 text-[11px] text-slate-400">
              Cada gravação que muda a configuração ou o modelo vira uma versão. Atendimentos em andamento continuam na
              versão em que começaram.
            </p>
            <ul className="space-y-1 text-xs text-slate-600">
              {versions.map((version) => (
                <li key={version.id}>
                  v{version.version} · {formatDateTime(version.createdAt)}
                  {version.createdBy ? ` · ${version.createdBy.name}` : ""}
                  {version.model ? ` · ${version.model}` : ""}
                </li>
              ))}
            </ul>
          </Card>
        )}
        <div className="max-w-4xl">
          <AgentForm value={input} onChange={setInput} options={options} />
        </div>
      </div>
      {showTester && agent && (
        <aside className="hidden w-[26rem] shrink-0 border-l border-slate-200 bg-slate-50 lg:block">
          <AgentTester agentId={agent.id} agentName={agent.name} dirty={dirty} />
        </aside>
      )}
    </div>
  );
}

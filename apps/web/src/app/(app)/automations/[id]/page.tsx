"use client";

import "@xyflow/react/dist/style.css";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import {
  Background,
  Controls,
  ReactFlow,
  addEdge,
  useEdgesState,
  useNodesState,
  type Connection,
  type Edge,
  type Node,
  type NodeTypes,
} from "@xyflow/react";
import {
  ArrowLeft,
  CircleCheck,
  Pause,
  Play,
  Save,
  TriangleAlert,
} from "lucide-react";
import {
  AUTOMATION_ALL_INSTANCES_LABEL,
  AUTOMATION_GENERAL_DEPARTMENT_HINT,
  AUTOMATION_GENERAL_DEPARTMENT_LABEL,
  AUTOMATION_TRIGGER_LABELS,
  AUTOMATION_TRIGGER_TYPES,
  SCHEDULE_MODES,
  SCHEDULE_MODE_HINTS,
  SCHEDULE_MODE_LABELS,
  type AiAgentDirectoryDto,
  type AutomationGraph,
  type AutomationNodeType,
  type AutomationTriggerType,
  type ScheduleMode,
} from "@azvchat/shared";
import { aiApi, api, automationApi } from "@/lib/api";
import type {
  AutomationFlowDetailDto,
  AutomationFlowProblemDto,
  DepartmentDto,
  TagDto,
  UserDirectoryDto,
} from "@/lib/types";
import { Button, Spinner } from "@/components/ui";
import { FlowNode, FLOW_NODE_TYPE, type FlowNodeData } from "@/components/automations/flow-node";
import { stoppedExecutionsMessage } from "@/components/automations/automation-ui";
import { useMyDepartments } from "@/components/department-picker";
import { useAuth } from "@/lib/auth-context";
import { NodeInspector } from "@/components/automations/node-inspector";
import { NodePalette } from "@/components/automations/node-palette";

const nodeTypes: NodeTypes = { [FLOW_NODE_TYPE]: FlowNode };

function defaultConfigFor(type: AutomationNodeType): Record<string, unknown> {
  switch (type) {
    case "send_message":
      return { messageType: "text", text: "" };
    case "ask_question":
      return { question: "", answerType: "text", saveKey: "resposta" };
    case "menu":
      return { question: "", options: [] };
    case "condition":
      return { combinator: "and", clauses: [] };
    case "wait":
      return { mode: "duration", amount: 1, unit: "minutes" };
    case "tag_add":
    case "tag_remove":
      return { tagId: "" };
    case "change_status":
      return { status: "open" };
    case "forward_department":
      return { departmentId: "" };
    case "assign_user":
      return { userId: "" };
    case "ai_agent":
      return { agentId: "" };
    case "webhook":
      return { url: "", headers: {} };
    case "finish":
      return {};
    default:
      return {};
  }
}

function toReactFlow(graph: AutomationGraph): { nodes: Node<FlowNodeData>[]; edges: Edge[] } {
  return {
    nodes: graph.nodes.map((node) => ({
      id: node.id,
      type: FLOW_NODE_TYPE,
      position: node.position,
      data: { kind: node.type, config: node.data },
    })),
    edges: graph.edges.map((edge) => ({
      id: edge.id,
      source: edge.source,
      target: edge.target,
      sourceHandle: edge.sourceHandle ?? undefined,
    })),
  };
}

function fromReactFlow(nodes: Node<FlowNodeData>[], edges: Edge[]): AutomationGraph {
  return {
    nodes: nodes.map((node) => ({
      id: node.id,
      type: node.data.kind,
      position: node.position,
      data: node.data.config,
    })),
    edges: edges.map((edge) => ({
      id: edge.id,
      source: edge.source,
      target: edge.target,
      sourceHandle: edge.sourceHandle ?? null,
    })),
  };
}

const SELECT_CLASS =
  "rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 text-sm text-slate-900 focus:border-brand-600 focus:outline-none focus:ring-2 focus:ring-brand-500/20";

export default function AutomationFlowBuilderPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const flowId = params.id;

  const [flow, setFlow] = useState<AutomationFlowDetailDto | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [nodes, setNodes, onNodesChange] = useNodesState<Node<FlowNodeData>>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [instances, setInstances] = useState<{ id: string; name: string }[]>([]);
  const [departments, setDepartments] = useState<DepartmentDto[]>([]);
  const [tags, setTags] = useState<TagDto[]>([]);
  const [users, setUsers] = useState<UserDirectoryDto[]>([]);
  const [agents, setAgents] = useState<AiAgentDirectoryDto[]>([]);
  const [name, setName] = useState("");
  const [triggerType, setTriggerType] = useState<AutomationTriggerType>("new_message");
  const [triggerConfigText, setTriggerConfigText] = useState("");
  const [whatsappInstanceId, setWhatsappInstanceId] = useState<string>("");
  /** "" = geral. Governa quem vê e edita o fluxo, nunca onde ele roda. */
  const [departmentId, setDepartmentId] = useState<string>("");
  const [saveError, setSaveError] = useState<string | null>(null);
  const { can } = useAuth();
  const canManageGeneral = can("automation.manage_general");
  const myDepartments = useMyDepartments();
  const [priority, setPriority] = useState(100);
  const [cooldownMinutes, setCooldownMinutes] = useState(0);
  const [scheduleMode, setScheduleMode] = useState<ScheduleMode>("always");
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [problems, setProblems] = useState<AutomationFlowProblemDto[] | null>(null);
  const [busy, setBusy] = useState(false);
  /** Quantos atendimentos o desligamento deste fluxo encerrou (some ao ligar de novo). */
  const [stoppedNotice, setStoppedNotice] = useState<string | null>(null);

  const loadedRef = useRef(false);
  // Quem só enxerga (fluxo geral sem a chave de alcance geral) abre o
  // construtor para LER: o autosave fica desligado, senão cada clique viraria
  // uma gravação recusada pela API.
  const canEditRef = useRef(false);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    Promise.all([
      automationApi.getFlow(flowId),
      api.get<{ instances: { id: string; name: string }[] }>("/whatsapp-instances"),
      api.get<{ departments: DepartmentDto[] }>("/departments"),
      api.get<{ tags: TagDto[] }>("/tags"),
      api.get<{ users: UserDirectoryDto[] }>("/users"),
      aiApi.agentsDirectory(),
    ])
      .then(([loadedFlow, instancesData, departmentsData, tagsData, usersData, agentsData]) => {
        setFlow(loadedFlow);
        setName(loadedFlow.name);
        setTriggerType(loadedFlow.triggerType);
        setTriggerConfigText(triggerConfigToText(loadedFlow.triggerType, loadedFlow.triggerConfig));
        setWhatsappInstanceId(loadedFlow.whatsappInstanceId ?? "");
        setDepartmentId(loadedFlow.departmentId ?? "");
        canEditRef.current = loadedFlow.canEdit;
        setPriority(loadedFlow.priority);
        setCooldownMinutes(loadedFlow.cooldownMinutes);
        setScheduleMode(loadedFlow.scheduleMode);
        const { nodes: initialNodes, edges: initialEdges } = toReactFlow(loadedFlow.draftGraph);
        setNodes(initialNodes);
        setEdges(initialEdges);
        setInstances(instancesData.instances);
        setDepartments(departmentsData.departments);
        setTags(tagsData.tags);
        setUsers(usersData.users);
        setAgents(agentsData);
        // O autosave só liga DEPOIS da primeira carga — sem isso, montar o
        // estado inicial contaria como "mudou" e gravaria de volta o que
        // acabou de vir do servidor.
        setTimeout(() => (loadedRef.current = true), 0);
      })
      .catch((err) => setLoadError(err instanceof Error ? err.message : "Falha ao carregar o fluxo"));
  }, [flowId]);

  const save = useCallback(async () => {
    if (!loadedRef.current || !canEditRef.current) return;
    setSaveState("saving");
    setSaveError(null);
    try {
      const updated = await automationApi.updateFlow(flowId, {
        name,
        triggerType,
        triggerConfig: triggerConfigFromText(triggerType, triggerConfigText),
        whatsappInstanceId: whatsappInstanceId || null,
        departmentId: departmentId || null,
        priority,
        cooldownMinutes,
        scheduleMode,
        draftGraph: fromReactFlow(nodes, edges),
      });
      setFlow(updated);
      canEditRef.current = updated.canEdit;
      setSaveState("saved");
    } catch (err) {
      setSaveState("error");
      setSaveError(err instanceof Error ? err.message : null);
    }
  }, [flowId, name, triggerType, triggerConfigText, whatsappInstanceId, departmentId, priority, cooldownMinutes, scheduleMode, nodes, edges]);

  // Autosave: qualquer mudança agenda uma gravação daqui a 1s, cancelando a
  // anterior — mesmo espírito do rascunho do composer da Inbox, só que
  // gravado no servidor em vez do localStorage.
  useEffect(() => {
    if (!loadedRef.current) return;
    setSaveState("idle");
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => void save(), 1000);
    return () => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
    };
  }, [name, triggerType, triggerConfigText, whatsappInstanceId, departmentId, priority, cooldownMinutes, scheduleMode, nodes, edges]);

  const onConnect = useCallback(
    (connection: Connection) => setEdges((eds) => addEdge(connection, eds)),
    [setEdges],
  );

  function handleAddNode(type: AutomationNodeType) {
    const id = `${type}-${Date.now().toString(36)}${Math.floor(Math.random() * 100)}`;
    setNodes((current) => [
      ...current,
      {
        id,
        type: FLOW_NODE_TYPE,
        position: { x: 320 + (current.length % 4) * 40, y: 120 + current.length * 60 },
        data: { kind: type, config: defaultConfigFor(type) },
      },
    ]);
    setSelectedNodeId(id);
  }

  function handleNodeConfigChange(config: Record<string, unknown>) {
    if (!selectedNodeId) return;
    setNodes((current) =>
      current.map((node) => (node.id === selectedNodeId ? { ...node, data: { ...node.data, config } } : node)),
    );
  }

  function handleDeleteNode() {
    if (!selectedNodeId) return;
    setNodes((current) => current.filter((node) => node.id !== selectedNodeId));
    setEdges((current) => current.filter((edge) => edge.source !== selectedNodeId && edge.target !== selectedNodeId));
    setSelectedNodeId(null);
  }

  async function handleValidate() {
    setProblems(await automationApi.validateFlow(flowId));
  }

  async function handlePublish() {
    setBusy(true);
    try {
      await save();
      const result = await automationApi.publishFlow(flowId);
      setFlow(result);
      setProblems([]);
    } catch (err) {
      if (err instanceof Error && "details" in err) {
        const details = (err as unknown as { details?: { problems?: AutomationFlowProblemDto[] } }).details;
        setProblems(details?.problems ?? [{ message: err.message }]);
      } else {
        setProblems([{ message: err instanceof Error ? err.message : "Falha ao publicar" }]);
      }
    } finally {
      setBusy(false);
    }
  }

  async function handleToggleActive() {
    if (!flow) return;
    setBusy(true);
    try {
      if (flow.status === "active") {
        const result = await automationApi.deactivateFlow(flowId);
        setFlow(result.flow);
        setStoppedNotice(stoppedExecutionsMessage(result.stoppedExecutions));
      } else {
        setFlow(await automationApi.activateFlow(flowId));
        setStoppedNotice(null);
      }
    } finally {
      setBusy(false);
    }
  }

  const selectedNode = useMemo(() => nodes.find((node) => node.id === selectedNodeId) ?? null, [nodes, selectedNodeId]);

  // Departamentos do seletor: os da pessoa, mais o atual do fluxo (para ele
  // não sumir do campo). A lista completa de /departments só alimenta os
  // blocos de encaminhamento, que é outra pergunta.
  const departmentOptions = useMemo(() => {
    const options = myDepartments.map((department) => ({ id: department.id, name: department.name }));
    if (flow?.departmentId && !options.some((option) => option.id === flow.departmentId)) {
      options.push({ id: flow.departmentId, name: flow.departmentName ?? "Departamento atual" });
    }
    return options;
  }, [myDepartments, flow?.departmentId, flow?.departmentName]);

  if (loadError) return <p className="p-8 text-sm text-red-600">{loadError}</p>;
  if (!flow) {
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner className="h-8 w-8" />
      </div>
    );
  }

  const readOnly = !flow.canEdit;

  return (
    <div className="flex h-full flex-col">
      {readOnly && (
        <p className="border-b border-slate-200 bg-slate-50 px-4 py-2 text-xs text-slate-600">
          Somente leitura: este fluxo é geral (sem departamento ou para todos os números), e editá-lo exige a
          permissão de automações gerais.
        </p>
      )}
      {stoppedNotice && (
        <p className="border-b border-amber-300 bg-amber-50 px-4 py-2 text-xs text-amber-800">{stoppedNotice}</p>
      )}
      <div className="flex items-center gap-3 border-b border-slate-200 bg-white px-4 py-2.5">
        <Button variant="ghost" size="sm" onClick={() => router.push("/automations")}>
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <input
          value={name}
          onChange={(event) => setName(event.target.value)}
          className="w-56 border-none bg-transparent text-base font-semibold text-slate-900 outline-none focus:ring-0"
        />

        <select
          className={SELECT_CLASS}
          value={triggerType}
          onChange={(event) => {
            setTriggerType(event.target.value as AutomationTriggerType);
            setTriggerConfigText("");
          }}
        >
          {AUTOMATION_TRIGGER_TYPES.map((type) => (
            <option key={type} value={type}>
              {AUTOMATION_TRIGGER_LABELS[type]}
            </option>
          ))}
        </select>

        <TriggerConfigField
          triggerType={triggerType}
          value={triggerConfigText}
          onChange={setTriggerConfigText}
          tags={tags}
        />

        <select
          className={SELECT_CLASS}
          value={departmentId}
          onChange={(event) => setDepartmentId(event.target.value)}
          title={AUTOMATION_GENERAL_DEPARTMENT_HINT}
          aria-label="Departamento do fluxo"
        >
          {(canManageGeneral || !departmentId) && (
            <option value="">{AUTOMATION_GENERAL_DEPARTMENT_LABEL} (todos os departamentos)</option>
          )}
          {departmentOptions.map((department) => (
            <option key={department.id} value={department.id}>
              {department.name}
            </option>
          ))}
        </select>

        <select
          className={SELECT_CLASS}
          value={whatsappInstanceId}
          onChange={(event) => setWhatsappInstanceId(event.target.value)}
          aria-label="Número do fluxo"
        >
          {(canManageGeneral || !whatsappInstanceId) && <option value="">{AUTOMATION_ALL_INSTANCES_LABEL}</option>}
          {instances.map((instance) => (
            <option key={instance.id} value={instance.id}>
              {instance.name}
            </option>
          ))}
        </select>

        <label className="flex items-center gap-1 text-xs text-slate-500">
          Prioridade
          <input
            type="number"
            className={`${SELECT_CLASS} w-16`}
            value={priority}
            onChange={(event) => setPriority(Number(event.target.value) || 100)}
          />
        </label>
        <label className="flex items-center gap-1 text-xs text-slate-500">
          Intervalo mín. (min)
          <input
            type="number"
            className={`${SELECT_CLASS} w-16`}
            value={cooldownMinutes}
            onChange={(event) => setCooldownMinutes(Number(event.target.value) || 0)}
          />
        </label>
        <label className="flex items-center gap-1 text-xs text-slate-500" title={SCHEDULE_MODE_HINTS[scheduleMode]}>
          Horário
          <select
            className={SELECT_CLASS}
            value={scheduleMode}
            onChange={(event) => setScheduleMode(event.target.value as ScheduleMode)}
          >
            {SCHEDULE_MODES.map((mode) => (
              <option key={mode} value={mode}>
                {SCHEDULE_MODE_LABELS[mode]}
              </option>
            ))}
          </select>
        </label>

        <div className="ml-auto flex items-center gap-2">
          <SaveIndicator state={saveState} message={saveError} />
          <Button variant="outline" size="sm" onClick={() => void handleValidate()}>
            Validar
          </Button>
          {!readOnly && (
            <Button variant="outline" size="sm" onClick={() => void handlePublish()} disabled={busy}>
              <Save className="h-3.5 w-3.5" />
              Publicar
            </Button>
          )}
          {flow.hasPublishedVersion && !readOnly && (
            <Button variant={flow.status === "active" ? "secondary" : "primary"} size="sm" onClick={() => void handleToggleActive()} disabled={busy}>
              {flow.status === "active" ? <Pause className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}
              {flow.status === "active" ? "Desativar" : "Ativar"}
            </Button>
          )}
        </div>
      </div>

      {problems && (
        <div className="border-b border-amber-200 bg-amber-50 px-4 py-2 text-xs text-amber-800">
          {problems.length === 0 ? (
            <span className="flex items-center gap-1.5 text-emerald-700">
              <CircleCheck className="h-3.5 w-3.5" /> Fluxo publicado sem pendências.
            </span>
          ) : (
            <ul className="space-y-0.5">
              {problems.map((problem, index) => (
                <li key={index} className="flex items-center gap-1.5">
                  <TriangleAlert className="h-3.5 w-3.5 shrink-0" />
                  {problem.message}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      <div className="flex min-h-0 flex-1">
        <NodePalette onAdd={handleAddNode} />
        <div className="min-w-0 flex-1">
          <ReactFlow
            nodes={nodes}
            edges={edges}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            nodeTypes={nodeTypes}
            onNodeClick={(_, node) => setSelectedNodeId(node.id)}
            onPaneClick={() => setSelectedNodeId(null)}
            fitView
          >
            <Background />
            <Controls />
          </ReactFlow>
        </div>
        {selectedNode && (
          <NodeInspector
            kind={selectedNode.data.kind}
            config={selectedNode.data.config}
            onChange={handleNodeConfigChange}
            onDelete={handleDeleteNode}
            onClose={() => setSelectedNodeId(null)}
            tags={tags}
            departments={departments}
            users={users}
            agents={agents}
          />
        )}
      </div>
    </div>
  );
}

function SaveIndicator({ state, message }: { state: "idle" | "saving" | "saved" | "error"; message: string | null }) {
  if (state === "saving") return <span className="text-xs text-slate-400">Salvando...</span>;
  if (state === "saved") return <span className="text-xs text-emerald-600">Salvo</span>;
  if (state === "error") {
    // A recusa de alcance diz o motivo; "falhou" sozinho faria a pessoa
    // tentar de novo sem saber que precisa escolher outro departamento.
    return <span className="max-w-xs text-xs text-red-600">{message ?? "Falha ao salvar"}</span>;
  }
  return null;
}

function triggerConfigToText(type: AutomationTriggerType, config: Record<string, unknown> | null): string {
  if (!config) return "";
  if (type === "keyword") return Array.isArray(config.keywords) ? (config.keywords as string[]).join(", ") : "";
  if (type === "no_reply_timeout") return typeof config.minutes === "number" ? String(config.minutes) : "";
  if (type === "tag_added") return typeof config.tagId === "string" ? config.tagId : "";
  return "";
}

function triggerConfigFromText(type: AutomationTriggerType, text: string): Record<string, unknown> | null {
  if (type === "keyword") {
    const keywords = text.split(",").map((word) => word.trim()).filter(Boolean);
    return keywords.length ? { keywords } : null;
  }
  if (type === "no_reply_timeout") {
    const minutes = Number(text);
    return minutes > 0 ? { minutes } : null;
  }
  if (type === "tag_added") {
    return text ? { tagId: text } : null;
  }
  return null;
}

function TriggerConfigField({
  triggerType,
  value,
  onChange,
  tags,
}: {
  triggerType: AutomationTriggerType;
  value: string;
  onChange: (value: string) => void;
  tags: TagDto[];
}) {
  if (triggerType === "keyword") {
    return (
      <input
        className={`${SELECT_CLASS} w-56`}
        placeholder="palavras-chave, separadas por vírgula"
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
    );
  }
  if (triggerType === "no_reply_timeout") {
    return (
      <input
        type="number"
        min={1}
        className={`${SELECT_CLASS} w-32`}
        placeholder="minutos"
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
    );
  }
  if (triggerType === "tag_added") {
    return (
      <select className={SELECT_CLASS} value={value} onChange={(event) => onChange(event.target.value)}>
        <option value="">Selecione a etiqueta</option>
        {tags.map((tag) => (
          <option key={tag.id} value={tag.id}>
            {tag.name}
          </option>
        ))}
      </select>
    );
  }
  return null;
}

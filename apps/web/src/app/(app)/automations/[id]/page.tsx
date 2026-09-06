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
  AUTOMATION_TRIGGER_LABELS,
  AUTOMATION_TRIGGER_TYPES,
  type AutomationGraph,
  type AutomationNodeType,
  type AutomationTriggerType,
} from "@azvchat/shared";
import { api, automationApi } from "@/lib/api";
import type {
  AutomationFlowDetailDto,
  AutomationFlowProblemDto,
  DepartmentDto,
  TagDto,
  UserDirectoryDto,
} from "@/lib/types";
import { Button, Spinner } from "@/components/ui";
import { FlowNode, FLOW_NODE_TYPE, type FlowNodeData } from "@/components/automations/flow-node";
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
  const [name, setName] = useState("");
  const [triggerType, setTriggerType] = useState<AutomationTriggerType>("new_message");
  const [triggerConfigText, setTriggerConfigText] = useState("");
  const [whatsappInstanceId, setWhatsappInstanceId] = useState<string>("");
  const [priority, setPriority] = useState(100);
  const [cooldownMinutes, setCooldownMinutes] = useState(0);
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [problems, setProblems] = useState<AutomationFlowProblemDto[] | null>(null);
  const [busy, setBusy] = useState(false);

  const loadedRef = useRef(false);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    Promise.all([
      automationApi.getFlow(flowId),
      api.get<{ instances: { id: string; name: string }[] }>("/whatsapp-instances"),
      api.get<{ departments: DepartmentDto[] }>("/departments"),
      api.get<{ tags: TagDto[] }>("/tags"),
      api.get<{ users: UserDirectoryDto[] }>("/users"),
    ])
      .then(([loadedFlow, instancesData, departmentsData, tagsData, usersData]) => {
        setFlow(loadedFlow);
        setName(loadedFlow.name);
        setTriggerType(loadedFlow.triggerType);
        setTriggerConfigText(triggerConfigToText(loadedFlow.triggerType, loadedFlow.triggerConfig));
        setWhatsappInstanceId(loadedFlow.whatsappInstanceId ?? "");
        setPriority(loadedFlow.priority);
        setCooldownMinutes(loadedFlow.cooldownMinutes);
        const { nodes: initialNodes, edges: initialEdges } = toReactFlow(loadedFlow.draftGraph);
        setNodes(initialNodes);
        setEdges(initialEdges);
        setInstances(instancesData.instances);
        setDepartments(departmentsData.departments);
        setTags(tagsData.tags);
        setUsers(usersData.users);
        // O autosave só liga DEPOIS da primeira carga — sem isso, montar o
        // estado inicial contaria como "mudou" e gravaria de volta o que
        // acabou de vir do servidor.
        setTimeout(() => (loadedRef.current = true), 0);
      })
      .catch((err) => setLoadError(err instanceof Error ? err.message : "Falha ao carregar o fluxo"));
  }, [flowId]);

  const save = useCallback(async () => {
    if (!loadedRef.current) return;
    setSaveState("saving");
    try {
      const updated = await automationApi.updateFlow(flowId, {
        name,
        triggerType,
        triggerConfig: triggerConfigFromText(triggerType, triggerConfigText),
        whatsappInstanceId: whatsappInstanceId || null,
        priority,
        cooldownMinutes,
        draftGraph: fromReactFlow(nodes, edges),
      });
      setFlow(updated);
      setSaveState("saved");
    } catch {
      setSaveState("error");
    }
  }, [flowId, name, triggerType, triggerConfigText, whatsappInstanceId, priority, cooldownMinutes, nodes, edges]);

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
  }, [name, triggerType, triggerConfigText, whatsappInstanceId, priority, cooldownMinutes, nodes, edges]);

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
      const updated = flow.status === "active" ? await automationApi.deactivateFlow(flowId) : await automationApi.activateFlow(flowId);
      setFlow(updated);
    } finally {
      setBusy(false);
    }
  }

  const selectedNode = useMemo(() => nodes.find((node) => node.id === selectedNodeId) ?? null, [nodes, selectedNodeId]);

  if (loadError) return <p className="p-8 text-sm text-red-600">{loadError}</p>;
  if (!flow) {
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner className="h-8 w-8" />
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
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
          value={whatsappInstanceId}
          onChange={(event) => setWhatsappInstanceId(event.target.value)}
        >
          <option value="">Todos os números</option>
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

        <div className="ml-auto flex items-center gap-2">
          <SaveIndicator state={saveState} />
          <Button variant="outline" size="sm" onClick={() => void handleValidate()}>
            Validar
          </Button>
          <Button variant="outline" size="sm" onClick={() => void handlePublish()} disabled={busy}>
            <Save className="h-3.5 w-3.5" />
            Publicar
          </Button>
          {flow.hasPublishedVersion && (
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
          />
        )}
      </div>
    </div>
  );
}

function SaveIndicator({ state }: { state: "idle" | "saving" | "saved" | "error" }) {
  if (state === "saving") return <span className="text-xs text-slate-400">Salvando...</span>;
  if (state === "saved") return <span className="text-xs text-emerald-600">Salvo</span>;
  if (state === "error") return <span className="text-xs text-red-600">Falha ao salvar</span>;
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

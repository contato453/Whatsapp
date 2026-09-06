"use client";

import { memo } from "react";
import { Handle, Position, type NodeProps } from "@xyflow/react";
import {
  AUTOMATION_NODE_TYPE_DEFINITIONS,
  type AskQuestionNodeData,
  type AutomationNodeType,
  type ChangeStatusNodeData,
  type ConditionNodeData,
  type FinishNodeData,
  type MenuNodeData,
  type SendMessageNodeData,
  type WaitNodeData,
} from "@azvchat/shared";

export interface FlowNodeData extends Record<string, unknown> {
  kind: AutomationNodeType;
  config: Record<string, unknown>;
}

/** Resumo de uma linha para a pessoa reconhecer o bloco sem abrir o inspetor. */
function summaryFor(kind: AutomationNodeType, config: Record<string, unknown>): string | null {
  switch (kind) {
    case "send_message":
      return (config as unknown as SendMessageNodeData).text?.slice(0, 60) || null;
    case "ask_question":
      return (config as unknown as AskQuestionNodeData).question?.slice(0, 60) || null;
    case "menu":
      return `${(config as unknown as MenuNodeData).options?.length ?? 0} opções`;
    case "condition": {
      const clauses = (config as unknown as ConditionNodeData).clauses ?? [];
      return clauses.length ? `${clauses.length} condição(ões)` : "sem condição";
    }
    case "wait": {
      const data = config as unknown as WaitNodeData;
      return data.mode === "until_next_business_hours"
        ? "até o próximo expediente"
        : `${data.amount ?? 0} ${data.unit ?? "minutes"}`;
    }
    case "change_status":
      return (config as unknown as ChangeStatusNodeData).status ?? null;
    case "finish":
      return (config as unknown as FinishNodeData).message?.slice(0, 60) || null;
    default:
      return null;
  }
}

/** Saídas nomeadas deste nó — usadas para desenhar um "handle" por saída. */
function outputsFor(kind: AutomationNodeType, config: Record<string, unknown>): { id: string; label: string }[] {
  if (kind === "condition") return [{ id: "true", label: "Sim" }, { id: "false", label: "Não" }];
  if (kind === "wait") {
    const data = config as unknown as WaitNodeData;
    return data.resumeOnReply
      ? [{ id: "timeout", label: "Tempo esgotado" }, { id: "reply", label: "Cliente respondeu" }]
      : [{ id: "timeout", label: "Tempo esgotado" }];
  }
  if (kind === "menu") {
    const options = (config as unknown as MenuNodeData).options ?? [];
    return options.map((option) => ({ id: option.id, label: option.label || option.id }));
  }
  return [];
}

function FlowNodeComponent({ data, selected }: NodeProps) {
  const nodeData = data as FlowNodeData;
  const definition = AUTOMATION_NODE_TYPE_DEFINITIONS[nodeData.kind];
  const outputs = outputsFor(nodeData.kind, nodeData.config);
  const summary = summaryFor(nodeData.kind, nodeData.config);
  const hasSingleDefaultOutput = outputs.length === 0 && !definition.isTerminal;

  return (
    <div
      className={`min-w-[190px] max-w-[240px] rounded-lg border bg-white shadow-sm ${
        selected ? "ring-2 ring-brand-500" : ""
      }`}
      style={{ borderColor: definition.color }}
    >
      {!definition.isTrigger && (
        <Handle type="target" position={Position.Left} className="!h-2.5 !w-2.5 !border-slate-400" />
      )}
      <div
        className="rounded-t-lg px-3 py-1.5 text-xs font-semibold text-white"
        style={{ backgroundColor: definition.color }}
      >
        {definition.label}
      </div>
      <div className="px-3 py-2">
        <p className="truncate text-xs text-slate-600">{summary ?? definition.description}</p>
      </div>
      {hasSingleDefaultOutput && (
        <Handle type="source" position={Position.Right} className="!h-2.5 !w-2.5 !border-slate-400" />
      )}
      {outputs.map((output) => (
        <div
          key={output.id}
          className="relative border-t border-slate-100 px-3 py-1 text-right text-[10px] text-slate-500"
        >
          {output.label}
          <Handle
            type="source"
            position={Position.Right}
            id={output.id}
            className="!h-2.5 !w-2.5 !border-slate-400"
          />
        </div>
      ))}
    </div>
  );
}

export const FlowNode = memo(FlowNodeComponent);
export const FLOW_NODE_TYPE = "automationNode";

"use client";

import {
  AUTOMATION_NODE_CATEGORIES,
  AUTOMATION_NODE_CATEGORY_LABELS,
  AUTOMATION_NODE_TYPE_DEFINITIONS,
  AUTOMATION_NODE_TYPES,
  type AutomationNodeType,
} from "@azvchat/shared";

/** Paleta de blocos (seção 7) — clicar adiciona o bloco ao canvas. */
export function NodePalette({ onAdd }: { onAdd: (type: AutomationNodeType) => void }) {
  return (
    <div className="thin-scroll w-56 shrink-0 overflow-y-auto border-r border-slate-200 bg-white p-3">
      <p className="mb-2 px-1 text-xs font-semibold uppercase tracking-wide text-slate-400">Blocos</p>
      {AUTOMATION_NODE_CATEGORIES.filter((category) => category !== "inicio").map((category) => (
        <div key={category} className="mb-3">
          <p className="mb-1 px-1 text-[11px] font-medium uppercase tracking-wide text-slate-400">
            {AUTOMATION_NODE_CATEGORY_LABELS[category]}
          </p>
          <div className="space-y-1">
            {AUTOMATION_NODE_TYPES.filter((type) => AUTOMATION_NODE_TYPE_DEFINITIONS[type].category === category).map(
              (type) => {
                const definition = AUTOMATION_NODE_TYPE_DEFINITIONS[type];
                return (
                  <button
                    key={type}
                    type="button"
                    onClick={() => onAdd(type)}
                    className="flex w-full items-center gap-2 rounded-lg border border-slate-200 px-2.5 py-1.5 text-left text-xs text-slate-700 hover:border-slate-300 hover:bg-slate-50"
                  >
                    <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: definition.color }} />
                    {definition.label}
                  </button>
                );
              },
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Sparkles } from "lucide-react";
import { AUTOMATION_SCOPE_EXECUTION_NOTE, AUTOMATION_TRIGGER_LABELS } from "@azvchat/shared";
import { automationApi } from "@/lib/api";
import type { AutomationTemplateSummaryDto } from "@/lib/types";
import { Badge, Button, Card, Modal, Spinner } from "@/components/ui";
import { AutomationTabs, AutomationsHeader } from "@/components/automations/automation-tabs";
import {
  EMPTY_SCOPE,
  FlowScopeFields,
  scopeDraftComplete,
  scopeFromDraft,
  useFlowScopeOptions,
  type FlowScopeDraft,
} from "@/components/automations/flow-scope";

export default function AutomationTemplatesPage() {
  const router = useRouter();
  const [templates, setTemplates] = useState<AutomationTemplateSummaryDto[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  // O template é catálogo do sistema e não tem departamento; a CÓPIA tem, e
  // quem usa escolhe onde ela nasce, pela mesma régua de criar do zero.
  const [choosing, setChoosing] = useState<AutomationTemplateSummaryDto | null>(null);
  const [scope, setScope] = useState<FlowScopeDraft>(EMPTY_SCOPE);
  const [useError, setUseError] = useState<string | null>(null);
  const scopeOptions = useFlowScopeOptions();

  useEffect(() => {
    automationApi
      .listTemplates()
      .then(setTemplates)
      .catch((err) => setError(err instanceof Error ? err.message : "Falha ao carregar templates"));
  }, []);

  function openUse(template: AutomationTemplateSummaryDto) {
    setScope(EMPTY_SCOPE);
    setUseError(null);
    setChoosing(template);
  }

  async function handleUse() {
    if (!choosing || !scopeDraftComplete(scope)) return;
    setBusyKey(choosing.key);
    setUseError(null);
    try {
      const flow = await automationApi.useTemplate(choosing.key, scopeFromDraft(scope));
      router.push(`/automations/${flow.id}`);
    } catch (err) {
      setUseError(err instanceof Error ? err.message : "Falha ao usar o template");
    } finally {
      setBusyKey(null);
    }
  }

  return (
    <div className="thin-scroll h-full overflow-y-auto p-8">
      <AutomationsHeader
        title="Automações"
        description="Templates prontos, editáveis a partir de uma cópia — usar um nunca altera o template original."
      />
      <AutomationTabs />

      {error && <p className="mb-4 text-sm text-red-600">{error}</p>}

      {!templates ? (
        <div className="flex justify-center py-12">
          <Spinner className="h-6 w-6" />
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {templates.map((template) => (
            <Card key={template.key} className="flex flex-col gap-3 p-5">
              <div className="flex items-center gap-2">
                <Sparkles className="h-4 w-4 text-brand-600" />
                <h3 className="font-semibold text-slate-900">{template.name}</h3>
              </div>
              <p className="flex-1 text-sm text-slate-500">{template.description}</p>
              <div className="flex items-center justify-between">
                <Badge>{template.category}</Badge>
                <span className="text-xs text-slate-400">{AUTOMATION_TRIGGER_LABELS[template.triggerType]}</span>
              </div>
              <Button
                variant="outline"
                onClick={() => openUse(template)}
                disabled={busyKey === template.key}
              >
                {busyKey === template.key ? <Spinner className="h-4 w-4" /> : "Usar este template"}
              </Button>
            </Card>
          ))}
        </div>
      )}

      <Modal open={choosing !== null} onClose={() => setChoosing(null)} title={`Usar "${choosing?.name ?? ""}"`}>
        <div className="space-y-4">
          <FlowScopeFields
            value={scope}
            onChange={setScope}
            departments={scopeOptions.departments}
            instances={scopeOptions.instances}
            canManageGeneral={scopeOptions.canManageGeneral}
          />
          <p className="text-xs text-slate-400">{AUTOMATION_SCOPE_EXECUTION_NOTE}</p>
          {useError && <p className="text-sm text-red-600">{useError}</p>}
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setChoosing(null)}>
              Cancelar
            </Button>
            <Button onClick={() => void handleUse()} disabled={!scopeDraftComplete(scope) || busyKey !== null}>
              {busyKey ? <Spinner className="h-4 w-4" /> : "Criar a cópia e abrir o construtor"}
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}

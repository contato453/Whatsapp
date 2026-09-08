"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Sparkles } from "lucide-react";
import { AUTOMATION_TRIGGER_LABELS } from "@azvchat/shared";
import { automationApi } from "@/lib/api";
import type { AutomationTemplateSummaryDto } from "@/lib/types";
import { Badge, Button, Card, Spinner } from "@/components/ui";
import { AutomationTabs, AutomationsHeader } from "@/components/automations/automation-tabs";

export default function AutomationTemplatesPage() {
  const router = useRouter();
  const [templates, setTemplates] = useState<AutomationTemplateSummaryDto[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);

  useEffect(() => {
    automationApi
      .listTemplates()
      .then(setTemplates)
      .catch((err) => setError(err instanceof Error ? err.message : "Falha ao carregar templates"));
  }, []);

  async function handleUse(key: string) {
    setBusyKey(key);
    try {
      const flow = await automationApi.useTemplate(key);
      router.push(`/automations/${flow.id}`);
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
                onClick={() => void handleUse(template.key)}
                disabled={busyKey === template.key}
              >
                {busyKey === template.key ? <Spinner className="h-4 w-4" /> : "Usar este template"}
              </Button>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}

"use client";

import { Suspense } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { ArrowLeft, Lock } from "lucide-react";
import { useAuth } from "@/lib/auth-context";
import { cn } from "@/lib/utils";
import { Spinner } from "@/components/ui";
import { OverviewPanel } from "@/components/ai/overview-panel";
import { ProvidersPanel } from "@/components/ai/providers-panel";
import { AgentsPanel } from "@/components/ai/agents-panel";
import { AutomationsPanel } from "@/components/ai/automations-panel";
import { KnowledgePanel } from "@/components/ai/knowledge-panel";
import { UsagePanel } from "@/components/ai/usage-panel";
import { LogsPanel } from "@/components/ai/logs-panel";
import { GeneralPanel } from "@/components/ai/general-panel";

/**
 * Configurações → Inteligência artificial.
 *
 * Abas por chave: admin vê tudo; `ai.agent.manage` abre agentes, automações
 * e base; `ai.view_usage` abre visão geral, consumo e logs. Provedores e
 * configurações gerais são só do admin — e a API recusa de novo por conta
 * própria em cada rota.
 */
const TABS = [
  { key: "overview", label: "Visão geral", need: "usage" },
  { key: "providers", label: "Provedores", need: "admin" },
  { key: "agents", label: "Agentes de IA", need: "manage" },
  { key: "automations", label: "Automações", need: "manage" },
  { key: "knowledge", label: "Base de conhecimento", need: "manage" },
  { key: "usage", label: "Consumo e limites", need: "usage" },
  { key: "logs", label: "Logs", need: "usage" },
  { key: "general", label: "Configurações gerais", need: "admin" },
] as const;
type TabKey = (typeof TABS)[number]["key"];

export default function AiSettingsPage() {
  return (
    <Suspense
      fallback={
        <div className="flex h-full items-center justify-center">
          <Spinner className="h-8 w-8" />
        </div>
      }
    >
      <AiSettingsContent />
    </Suspense>
  );
}

function AiSettingsContent() {
  const { user, can } = useAuth();
  const router = useRouter();
  const params = useSearchParams();
  const isAdmin = user?.role === "admin";
  const allowed = (need: (typeof TABS)[number]["need"]) =>
    need === "admin" ? isAdmin : need === "manage" ? can("ai.agent.manage") : can("ai.view_usage") || can("ai.agent.manage");
  const tabs = TABS.filter((tab) => allowed(tab.need));
  const requested = params.get("tab") as TabKey | null;
  const active: TabKey = tabs.some((tab) => tab.key === requested) ? (requested as TabKey) : (tabs[0]?.key ?? "overview");

  if (tabs.length === 0) {
    return (
      <div className="flex h-full items-center justify-center p-8">
        <div className="max-w-sm text-center">
          <div className="mx-auto mb-3 flex h-11 w-11 items-center justify-center rounded-full bg-slate-100">
            <Lock className="h-5 w-5 text-slate-400" />
          </div>
          <h1 className="text-base font-semibold text-slate-900">Acesso restrito</h1>
          <p className="mt-1 text-sm text-slate-500">A configuração de inteligência artificial depende de permissão. Fale com um administrador.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="thin-scroll h-full overflow-y-auto p-8">
      <div className="mb-1 flex items-center gap-2 text-xs text-slate-400">
        <Link href="/settings" className="inline-flex items-center gap-1 hover:text-slate-600">
          <ArrowLeft className="h-3 w-3" /> Configurações
        </Link>
      </div>
      <h1 className="mb-1 text-2xl font-bold text-slate-900">Inteligência artificial</h1>
      <p className="mb-6 text-sm text-slate-500">
        Agentes de IA que atendem conversas do WhatsApp com regras, limites, conhecimento e custo sob controle.
      </p>
      <div className="mb-6 flex flex-wrap gap-1 border-b border-slate-200">
        {tabs.map((tab) => (
          <button
            key={tab.key}
            type="button"
            onClick={() => router.replace(`/settings/ai?tab=${tab.key}`)}
            className={cn(
              "-mb-px border-b-2 px-3 py-2 text-sm font-medium transition-colors",
              active === tab.key ? "border-brand-600 text-brand-600" : "border-transparent text-slate-500 hover:text-slate-800",
            )}
          >
            {tab.label}
          </button>
        ))}
      </div>
      <div className="max-w-6xl">
        {active === "overview" && <OverviewPanel />}
        {active === "providers" && <ProvidersPanel />}
        {active === "agents" && <AgentsPanel />}
        {active === "automations" && <AutomationsPanel />}
        {active === "knowledge" && <KnowledgePanel />}
        {active === "usage" && <UsagePanel />}
        {active === "logs" && <LogsPanel initialAgentId={params.get("agentId") ?? undefined} />}
        {active === "general" && <GeneralPanel />}
      </div>
    </div>
  );
}

"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { SlidersHorizontal, Workflow } from "lucide-react";
import { cn } from "@/lib/utils";
import { useAuth } from "@/lib/auth-context";

/**
 * Navegação interna da área AUTOMAÇÕES (seção 2 do pedido): Fluxos,
 * Templates, Histórico e um atalho para Configurações de Atendimento — que
 * é a tela `/attendance-settings` já existente, reaproveitada em vez de
 * duplicada (é lá que moram saudação e fora do expediente).
 */
const TABS = [
  { href: "/automations", label: "Fluxos" },
  { href: "/automations/templates", label: "Templates" },
  { href: "/automations/history", label: "Histórico", permission: "automation.view_history" as const },
];

export function AutomationTabs() {
  const pathname = usePathname();
  const { can } = useAuth();
  return (
    <div className="mb-6 flex items-center justify-between border-b border-slate-200">
      <nav className="flex gap-1">
        {TABS.filter((tab) => !tab.permission || can(tab.permission)).map((tab) => {
          const active = pathname === tab.href;
          return (
            <Link
              key={tab.href}
              href={tab.href}
              className={cn(
                "border-b-2 px-3 py-2.5 text-sm font-medium transition-colors",
                active
                  ? "border-brand-600 text-brand-600"
                  : "border-transparent text-slate-500 hover:text-slate-800",
              )}
            >
              {tab.label}
            </Link>
          );
        })}
      </nav>
      <Link
        href="/attendance-settings"
        className="mb-2 flex items-center gap-1.5 text-xs font-medium text-slate-500 hover:text-brand-600"
      >
        <SlidersHorizontal className="h-3.5 w-3.5" />
        Configurações de Atendimento
      </Link>
    </div>
  );
}

export function AutomationsHeader({ title, description }: { title: string; description: string }) {
  return (
    <div className="mb-4 flex items-center gap-2.5">
      <Workflow className="h-5 w-5 text-slate-400" />
      <div>
        <h1 className="text-2xl font-bold text-slate-900">{title}</h1>
        <p className="text-sm text-slate-500">{description}</p>
      </div>
    </div>
  );
}

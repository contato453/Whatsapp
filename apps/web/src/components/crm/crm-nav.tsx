"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { PermissionAction } from "@azvchat/shared";
import { useAuth } from "@/lib/auth-context";
import { cn } from "@/lib/utils";

/**
 * As telas do CRM.
 *
 * O menu lateral do sistema não tem submenu (e criar um só para o CRM mudaria
 * a navegação do sistema inteiro por causa de uma área), então o CRM entra
 * como UM item na barra e se divide aqui dentro, no topo das próprias telas.
 * Quem clica em "CRM" cai no Kanban, que é onde o trabalho acontece.
 *
 * Cada aba respeita a MESMA chave que a API exige: esconder e recusar andam
 * sempre juntos, senão a configuração de Permissões vira mentira visual.
 */
const ABAS: Array<{ href: string; label: string; permission?: PermissionAction }> = [
  { href: "/crm/kanban", label: "Kanban" },
  { href: "/crm/opportunities", label: "Oportunidades" },
  { href: "/crm/activities", label: "Atividades" },
  { href: "/crm/pipelines", label: "Funis", permission: "crm.pipeline.manage" },
  { href: "/crm/reports", label: "Relatórios", permission: "crm.reports.view" },
  { href: "/crm/settings", label: "Configurações", permission: "crm.pipeline.manage" },
];

export function CrmNav() {
  const pathname = usePathname();
  const { can } = useAuth();
  const visiveis = ABAS.filter((aba) => !aba.permission || can(aba.permission));

  return (
    <nav className="flex flex-wrap items-center gap-1 border-b border-slate-200 px-4 pb-2 pt-1">
      {visiveis.map((aba) => {
        const ativo = pathname === aba.href || pathname.startsWith(`${aba.href}/`);
        return (
          <Link
            key={aba.href}
            href={aba.href}
            aria-current={ativo ? "page" : undefined}
            className={cn(
              "rounded-lg px-3 py-1.5 text-sm font-medium transition-colors",
              ativo
                ? "bg-brand-50 text-brand-700"
                : "text-slate-500 hover:bg-slate-100 hover:text-slate-700",
            )}
          >
            {aba.label}
          </Link>
        );
      })}
    </nav>
  );
}

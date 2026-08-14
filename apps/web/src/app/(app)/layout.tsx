"use client";

import { useEffect, type ReactNode } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  Inbox,
  LayoutDashboard,
  LogOut,
  Settings,
  Smartphone,
  Tags,
  Users,
  Building2,
  Zap,
  Lock,
} from "lucide-react";
import { USER_ROLE_LABELS, hasRole, type UserRole } from "@azvchat/shared";
import { useAuth } from "@/lib/auth-context";
import { cn } from "@/lib/utils";
import { Avatar, Spinner } from "@/components/ui";
import { CallAlerts } from "@/components/call-alerts";
import { Logo } from "@/components/logo";

/**
 * Menu e permissão de tela na mesma tabela. `minRole` espelha exatamente o
 * papel mínimo que a API exige para administrar aquilo, então o item não
 * aparece para quem receberia 403 ao clicar.
 *
 * Vale como conveniência, não como segurança: quem chegar na URL direto
 * cai na tela de acesso restrito abaixo, e a API barra de novo por conta
 * própria — a autorização de verdade é sempre a do servidor.
 */
const NAV: Array<{
  href: string;
  label: string;
  icon: typeof Inbox;
  minRole: UserRole;
}> = [
  { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard, minRole: "agent" },
  { href: "/inbox", label: "Inbox", icon: Inbox, minRole: "agent" },
  { href: "/whatsapp", label: "WhatsApp", icon: Smartphone, minRole: "supervisor" },
  { href: "/users", label: "Usuários", icon: Users, minRole: "admin" },
  { href: "/departments", label: "Departamentos", icon: Building2, minRole: "supervisor" },
  { href: "/tags", label: "Etiquetas", icon: Tags, minRole: "supervisor" },
  { href: "/quick-replies", label: "Respostas rápidas", icon: Zap, minRole: "agent" },
  { href: "/settings", label: "Configurações", icon: Settings, minRole: "agent" },
];

function AccessDenied() {
  return (
    <div className="flex h-full items-center justify-center p-8">
      <div className="max-w-sm text-center">
        <div className="mx-auto mb-3 flex h-11 w-11 items-center justify-center rounded-full bg-slate-100">
          <Lock className="h-5 w-5 text-slate-400" />
        </div>
        <h1 className="text-base font-semibold text-slate-900">Acesso restrito</h1>
        <p className="mt-1 text-sm text-slate-500">
          Esta área é de administração. Fale com um administrador do sistema se você precisa
          acessá-la.
        </p>
      </div>
    </div>
  );
}

export default function AppLayout({ children }: { children: ReactNode }) {
  const { user, loading, logout } = useAuth();
  const router = useRouter();
  const pathname = usePathname();

  useEffect(() => {
    if (!loading && !user) {
      router.replace("/login");
    }
  }, [loading, user, router]);

  if (loading || !user) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <Spinner className="h-8 w-8" />
      </div>
    );
  }

  // A tela atual pode não estar no menu (ex.: /users/new): a permissão é a
  // do item cujo caminho a URL começa, e caminho desconhecido fica liberado.
  const current = NAV.find(
    (item) => pathname === item.href || pathname.startsWith(`${item.href}/`),
  );
  const allowed = !current || hasRole(user.role, current.minRole);

  return (
    <div className="flex h-screen overflow-hidden bg-slate-50">
      <aside className="flex w-56 shrink-0 flex-col border-r border-slate-800 bg-slate-900">
        <div className="px-4 py-5">
          {/* Sidebar é fundo escuro: marca na versão branca. */}
          <Logo tone="dark" />
        </div>
        <nav className="flex-1 space-y-0.5 px-2">
          {NAV.filter((item) => hasRole(user.role, item.minRole)).map((item) => {
            const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
            return (
              <Link
                key={item.href}
                href={item.href}
                className={cn(
                  "flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm font-medium transition-colors",
                  active
                    ? "bg-slate-800 text-white"
                    : "text-slate-400 hover:bg-slate-800/60 hover:text-slate-200",
                )}
              >
                <item.icon className="h-4 w-4" />
                {item.label}
              </Link>
            );
          })}
        </nav>
        <div className="border-t border-slate-800 p-3">
          <div className="flex items-center gap-2.5">
            <Avatar name={user.name} size="sm" />
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium text-white">{user.name}</p>
              <p className="truncate text-[11px] text-slate-400">{USER_ROLE_LABELS[user.role]}</p>
            </div>
            <button
              onClick={logout}
              title="Sair"
              className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-800 hover:text-white"
            >
              <LogOut className="h-4 w-4" />
            </button>
          </div>
        </div>
      </aside>
      <main className="min-w-0 flex-1 overflow-hidden">
        {allowed ? children : <AccessDenied />}
      </main>
      {/* Chamada tocando: aviso em qualquer tela do sistema. */}
      <CallAlerts />
    </div>
  );
}

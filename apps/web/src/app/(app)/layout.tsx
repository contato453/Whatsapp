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
} from "lucide-react";
import { useAuth } from "@/lib/auth-context";
import { cn } from "@/lib/utils";
import { Avatar, Spinner } from "@/components/ui";
import { Logo } from "@/components/logo";

const NAV = [
  { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
  { href: "/inbox", label: "Inbox", icon: Inbox },
  { href: "/whatsapp", label: "WhatsApp", icon: Smartphone },
  { href: "/users", label: "Atendentes", icon: Users },
  { href: "/departments", label: "Departamentos", icon: Building2 },
  { href: "/tags", label: "Etiquetas", icon: Tags },
  { href: "/quick-replies", label: "Respostas rápidas", icon: Zap },
  { href: "/settings", label: "Configurações", icon: Settings },
];

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

  return (
    <div className="flex h-screen overflow-hidden bg-slate-50">
      <aside className="flex w-56 shrink-0 flex-col border-r border-slate-800 bg-slate-900">
        <div className="px-4 py-5">
          {/* Sidebar é fundo escuro: marca na versão branca. */}
          <Logo tone="dark" />
        </div>
        <nav className="flex-1 space-y-0.5 px-2">
          {NAV.map((item) => {
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
              <p className="truncate text-[11px] capitalize text-slate-400">{user.role}</p>
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
      <main className="min-w-0 flex-1 overflow-hidden">{children}</main>
    </div>
  );
}

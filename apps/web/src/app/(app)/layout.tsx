"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  Inbox,
  PhoneCall,
  LayoutDashboard,
  LogOut,
  PanelLeftClose,
  PanelLeftOpen,
  Settings,
  ShieldCheck,
  SlidersHorizontal,
  Smartphone,
  Tags,
  Users,
  Building2,
  BarChart3,
  Zap,
  Lock,
} from "lucide-react";
import {
  USER_ROLE_LABELS,
  hasRole,
  type PermissionAction,
  type UserRole,
} from "@azvchat/shared";
import { useAuth } from "@/lib/auth-context";
import type { UserDto } from "@/lib/types";
import { cn } from "@/lib/utils";
import { Spinner, Tooltip } from "@/components/ui";
import { UserAvatar } from "@/components/user-avatar";
import { CallAlerts } from "@/components/call-alerts";
import { CallProvider } from "@/lib/call-context";
import { MessageSound } from "@/components/message-sound";
import { SessionSchedule } from "@/components/session-schedule";
import { UnreadTitle } from "@/components/unread-title";
import { Logo, LogoMark } from "@/components/logo";

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
  /** Papel mínimo — usado só onde a tela é fixa no código (admin). */
  minRole: UserRole;
  /**
   * Chave do catálogo que a tela exige. Quando existe, é ELA que decide, e
   * não o papel: o item precisa sumir exatamente quando a API recusa, senão
   * desligar a chave produziria um menu que só dá 403.
   */
  permission?: PermissionAction;
  /**
   * Telas ABAIXO deste caminho continuam exclusivas do administrador, mesmo
   * que a lista esteja liberada por chave. É o caso de /users: quem tem
   * `user.deactivate` abre a lista e desativa alguém, mas /users/new e
   * /users/:id são o cadastro inteiro, que segue fixo em admin.
   */
  adminOnlySubRoutes?: boolean;
}> = [
  { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard, minRole: "agent" },
  // Os rótulos falam a língua da equipe; as rotas continuam /inbox e
  // /whatsapp — mudá-las quebraria favoritos e os links dos cards do
  // dashboard sem ganho nenhum.
  { href: "/inbox", label: "Conversas", icon: Inbox, minRole: "agent" },
  // Registro de todas as chamadas (com gravação). Aparece por chave: quem não
  // pode ver o registro não vê o menu (esconder e recusar andam juntos).
  { href: "/calls", label: "Ligações", icon: PhoneCall, minRole: "agent", permission: "call.view" },
  {
    href: "/whatsapp",
    label: "Conexões",
    icon: Smartphone,
    minRole: "supervisor",
    permission: "whatsapp_instance.manage",
  },
  {
    href: "/users",
    label: "Usuários",
    icon: Users,
    minRole: "admin",
    permission: "user.deactivate",
    adminOnlySubRoutes: true,
  },
  {
    href: "/departments",
    label: "Departamentos",
    icon: Building2,
    minRole: "supervisor",
    permission: "department.manage",
  },
  {
    href: "/reports",
    label: "Relatórios",
    icon: BarChart3,
    minRole: "supervisor",
    permission: "reports.view",
  },
  {
    href: "/tags",
    label: "Etiquetas",
    icon: Tags,
    minRole: "supervisor",
    permission: "tag.manage",
  },
  { href: "/quick-replies", label: "Respostas rápidas", icon: Zap, minRole: "agent" },
  // Fica fora de Configurações de propósito: aquilo é escopo pessoal (perfil
  // e senha) e isto é regra do escritório inteiro.
  {
    href: "/attendance-settings",
    label: "Parâmetros",
    icon: SlidersHorizontal,
    minRole: "supervisor",
    permission: "attendance_settings.manage",
  },
  // Só admin abre e só admin grava, sem chave: uma chave "editar permissões"
  // deixaria um supervisor se promover sozinho, e o menu inteiro deixaria de
  // valer alguma coisa.
  { href: "/permissions", label: "Permissões", icon: ShieldCheck, minRole: "admin" },
  { href: "/settings", label: "Configurações", icon: Settings, minRole: "agent" },
];

/** Uma tela do menu está liberada para esta sessão? */
function navAllowed(
  item: (typeof NAV)[number],
  role: UserRole,
  can: (action: PermissionAction) => boolean,
): boolean {
  // Admin passa em qualquer chave, então `can` já o cobre nos dois ramos.
  return item.permission ? can(item.permission) : hasRole(role, item.minRole);
}

/**
 * O caminho atual está liberado? Igual ao menu, mais a exceção das telas
 * filhas de cadastro: entrar em /users/:id pela URL não pode contornar o
 * `requireRole("admin")` que a API aplica lá.
 */
function pathAllowed(
  item: (typeof NAV)[number],
  pathname: string,
  role: UserRole,
  can: (action: PermissionAction) => boolean,
): boolean {
  if (!navAllowed(item, role, can)) return false;
  if (item.adminOnlySubRoutes && pathname !== item.href) return hasRole(role, "admin");
  return true;
}

/**
 * Preferência de barra recolhida. Mesmo prefixo do token (`zapdesk.`) para
 * o storage do produto continuar reconhecível numa olhada. É preferência de
 * apresentação de um navegador, não dado de cadastro: não vira coluna em
 * `User` nem rota na API.
 */
const SIDEBAR_STORAGE_KEY = "zapdesk.sidebar-collapsed";

/**
 * Atravessar a tela com o mouse não pode abrir a barra: o atraso de entrada
 * exige intenção. O de saída é maior porque sair um pixel sem querer (indo
 * do menu para a lista de conversas) não deveria fechar na cara da pessoa.
 */
const HOVER_OPEN_DELAY_MS = 150;
const HOVER_CLOSE_DELAY_MS = 250;

/** Largura de hoje da barra expandida — a recolhida cabe só o ícone. */
const EXPANDED_WIDTH = "w-56";
const COLLAPSED_WIDTH = "w-16";

function readCollapsedPreference(): boolean {
  try {
    return window.localStorage.getItem(SIDEBAR_STORAGE_KEY) === "1";
  } catch {
    // Storage bloqueado (aba privada) ou valor estranho: vale o padrão de
    // hoje, barra expandida. Preferência de menu nunca derruba a tela.
    return false;
  }
}

function writeCollapsedPreference(collapsed: boolean): void {
  try {
    window.localStorage.setItem(SIDEBAR_STORAGE_KEY, collapsed ? "1" : "0");
  } catch {
    // Sem storage a escolha só vale para esta aba — segue o jogo.
  }
}

function Sidebar({
  user,
  logout,
  can,
}: {
  user: UserDto;
  logout: () => void;
  can: (action: PermissionAction) => boolean;
}) {
  const pathname = usePathname();
  // Começa expandida: é o estado de hoje e o que o servidor renderiza. A
  // preferência salva entra no efeito, depois da hidratação, para o HTML do
  // servidor e o do cliente não divergirem.
  const [collapsed, setCollapsed] = useState(false);
  const [hydrated, setHydrated] = useState(false);
  const [hoverOpen, setHoverOpen] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    setCollapsed(readCollapsedPreference());
    setHydrated(true);
  }, []);

  const clearTimer = useCallback(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  // Entrar e sair rápido não pode piscar nem deixar a barra presa aberta:
  // todo agendamento cancela o anterior.
  const schedule = useCallback(
    (open: boolean, delay: number) => {
      clearTimer();
      timerRef.current = setTimeout(() => {
        timerRef.current = null;
        setHoverOpen(open);
      }, delay);
    },
    [clearTimer],
  );

  useEffect(() => clearTimer, [clearTimer]);

  const expanded = !collapsed || hoverOpen;
  // Só a expansão temporária flutua. Assim a Inbox (três colunas, onde a
  // equipe passa o dia) não se mexe nem remonta a cada passada de mouse;
  // já o botão altera a largura de verdade e empurra o conteúdo, como hoje.
  const overlay = collapsed && hoverOpen;
  const transition = hydrated
    ? "transition-[width] duration-200 ease-out motion-reduce:transition-none"
    : "";

  const toggle = () => {
    const next = !collapsed;
    setCollapsed(next);
    writeCollapsedPreference(next);
    // Alternar pelo botão zera o hover pendente: sem isso a barra recolhida
    // reabriria sozinha por causa do mouse parado sobre ela.
    clearTimer();
    setHoverOpen(false);
  };

  const items = NAV.filter((item) => navAllowed(item, user.role, can));

  return (
    <div
      className={cn("relative shrink-0", transition, collapsed ? COLLAPSED_WIDTH : EXPANDED_WIDTH)}
      onMouseEnter={() => {
        if (collapsed) schedule(true, HOVER_OPEN_DELAY_MS);
      }}
      onMouseLeave={() => schedule(false, HOVER_CLOSE_DELAY_MS)}
      // Foco dentro da barra conta como hover, senão navegar por Tab levaria
      // a itens invisíveis. Aqui abre na hora: teclado não tem "passar por
      // cima sem querer", o atraso só atrapalharia.
      onFocus={() => {
        if (collapsed) {
          clearTimer();
          setHoverOpen(true);
        }
      }}
      onBlur={() => schedule(false, HOVER_CLOSE_DELAY_MS)}
    >
      <aside
        className={cn(
          "absolute inset-y-0 left-0 flex flex-col border-r border-slate-800 bg-slate-900",
          transition,
          expanded ? EXPANDED_WIDTH : COLLAPSED_WIDTH,
          overlay && "z-30 shadow-2xl shadow-slate-950/50",
        )}
      >
        <div className={cn("px-2 py-5", expanded && "px-4")}>
          <div className={cn("flex items-center gap-2", expanded ? "justify-between" : "flex-col gap-3")}>
            {/* Sidebar é fundo escuro: marca na versão branca. Recolhida
                sobra só o símbolo — o logotipo não caberia. */}
            {expanded ? <Logo tone="dark" /> : <LogoMark tone="dark" className="h-8 w-8" />}
            <Tooltip label={collapsed ? "Expandir barra lateral" : "Recolher barra lateral"}>
              <button
                type="button"
                onClick={toggle}
                aria-label={collapsed ? "Expandir barra lateral" : "Recolher barra lateral"}
                aria-expanded={!collapsed}
                className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-800 hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-slate-500"
              >
                {collapsed ? (
                  <PanelLeftOpen className="h-4 w-4" />
                ) : (
                  <PanelLeftClose className="h-4 w-4" />
                )}
              </button>
            </Tooltip>
          </div>
        </div>
        <nav className="flex-1 space-y-0.5 px-2">
          {items.map((item) => {
            const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
            const link = (
              <Link
                key={item.href}
                href={item.href}
                aria-current={active ? "page" : undefined}
                // Recolhida o rótulo some, então o nome acessível vem do
                // `aria-label` — mesmo texto do NAV, nunca outro escrito aqui.
                aria-label={expanded ? undefined : item.label}
                className={cn(
                  "flex w-full items-center gap-2.5 rounded-lg py-2 text-sm font-medium transition-colors",
                  expanded ? "px-3" : "justify-center px-0",
                  active
                    ? "bg-slate-800 text-white"
                    : "text-slate-400 hover:bg-slate-800/60 hover:text-slate-200",
                )}
              >
                <item.icon className="h-4 w-4 shrink-0" />
                {expanded && <span className="truncate">{item.label}</span>}
              </Link>
            );
            // Expandida o rótulo já está na tela: dica de texto ali seria
            // repetição.
            return expanded ? (
              link
            ) : (
              <Tooltip key={item.href} label={item.label}>
                {link}
              </Tooltip>
            );
          })}
        </nav>
        <div className={cn("border-t border-slate-800 p-3", !expanded && "px-2")}>
          <div className={cn("flex items-center gap-2.5", !expanded && "flex-col gap-2")}>
            {expanded ? (
              <UserAvatar userId={user.id} name={user.name} hasAvatar={user.hasAvatar} size="sm" />
            ) : (
              <Tooltip
                label={
                  <span className="block">
                    {user.name}
                    <span className="block text-slate-300">{USER_ROLE_LABELS[user.role]}</span>
                  </span>
                }
              >
                <UserAvatar userId={user.id} name={user.name} hasAvatar={user.hasAvatar} size="sm" />
              </Tooltip>
            )}
            {expanded && (
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-white">{user.name}</p>
                <p className="truncate text-[11px] text-slate-400">{USER_ROLE_LABELS[user.role]}</p>
              </div>
            )}
            <Tooltip label="Sair">
              <button
                type="button"
                onClick={logout}
                aria-label="Sair"
                className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-800 hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-slate-500"
              >
                <LogOut className="h-4 w-4" />
              </button>
            </Tooltip>
          </div>
        </div>
      </aside>
    </div>
  );
}

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
  const { user, loading, logout, can } = useAuth();
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
  const allowed = !current || pathAllowed(current, pathname, user.role, can);

  return (
    <CallProvider>
    <div className="flex h-screen overflow-hidden bg-slate-50">
      <Sidebar user={user} logout={logout} can={can} />
      <main className="min-w-0 flex-1 overflow-hidden">
        {allowed ? children : <AccessDenied />}
      </main>
      {/* Chamada tocando: aviso em qualquer tela do sistema. */}
      <CallAlerts />
      {/* Som de mensagem recebida: vale em qualquer tela, não só na Inbox. */}
      <MessageSound />
      {/* Título da aba piscando: alcança quem está com o som desligado. */}
      <UnreadTitle />
      {/* Aviso de fechamento do horário de uso, e saída quando ele chega. */}
      <SessionSchedule />
    </div>
    </CallProvider>
  );
}

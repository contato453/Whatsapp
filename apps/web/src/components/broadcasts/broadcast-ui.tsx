"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Megaphone, ShieldAlert } from "lucide-react";
import {
  BROADCAST_CAMPAIGN_STATUS_COLORS,
  BROADCAST_CAMPAIGN_STATUS_LABELS,
  BROADCAST_PAUSE_REASON_LABELS,
  type BroadcastCampaignCountsDto,
  type BroadcastCampaignStatus,
  type BroadcastPauseReason,
} from "@azvchat/shared";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui";

/**
 * Navegação interna dos DISPAROS EM MASSA. No Interno a área mora dentro do
 * grupo Automações da barra lateral (é mais uma forma de o sistema mandar
 * mensagem sozinho, ao lado de fluxos e follow-up), e as três telas de
 * dentro — Campanhas, Audiências e Descadastros — ficam divididas no topo da
 * própria área, como nas outras telas de Automações.
 */
const TABS = [
  { href: "/automations/broadcasts", label: "Campanhas" },
  { href: "/automations/broadcasts/audiences", label: "Audiências" },
  { href: "/automations/broadcasts/opt-outs", label: "Descadastros" },
];

export function BroadcastTabs() {
  const pathname = usePathname();
  return (
    <div className="mb-6 border-b border-slate-200">
      <nav className="flex gap-1">
        {TABS.map((tab) => {
          // `/automations/broadcasts/new` e `/automations/broadcasts/<id>` continuam sob a aba
          // Campanhas: sair da lista para o detalhe não pode apagar o
          // destaque da área em que a pessoa está.
          const active =
            tab.href === "/automations/broadcasts"
              ? pathname === "/automations/broadcasts" ||
                (pathname.startsWith("/automations/broadcasts/") &&
                  !pathname.startsWith("/automations/broadcasts/audiences") &&
                  !pathname.startsWith("/automations/broadcasts/opt-outs"))
              : pathname.startsWith(tab.href);
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
    </div>
  );
}

export function BroadcastHeader({
  title,
  description,
  action,
}: {
  title: string;
  description: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
      <div className="flex items-center gap-2.5">
        <Megaphone className="h-5 w-5 shrink-0 text-slate-400" />
        <div>
          <h1 className="text-2xl font-bold text-slate-900">{title}</h1>
          <p className="text-sm text-slate-500">{description}</p>
        </div>
      </div>
      {action}
    </div>
  );
}

export function CampaignStatusBadge({
  status,
  pausedReason,
}: {
  status: BroadcastCampaignStatus;
  pausedReason?: BroadcastPauseReason | null;
}) {
  return (
    <Badge
      color={BROADCAST_CAMPAIGN_STATUS_COLORS[status]}
      title={
        status === "paused" && pausedReason
          ? BROADCAST_PAUSE_REASON_LABELS[pausedReason]
          : undefined
      }
    >
      {BROADCAST_CAMPAIGN_STATUS_LABELS[status]}
    </Badge>
  );
}

/**
 * A barra de progresso do disparo.
 *
 * Mostra ENVIADAS, PULADAS e FALHAS separadas, e não uma porcentagem só: as
 * três significam coisas diferentes para quem acompanha. "Pulada" é o
 * sistema protegendo o número (descadastrado, telefone inválido) e não
 * precisa de ação; "falha" precisa. Juntar tudo num número esconderia
 * exatamente o que a pessoa foi olhar.
 */
export function CampaignProgress({ counts }: { counts: BroadcastCampaignCountsDto }) {
  const total = Math.max(counts.total, 1);
  const fatia = (valor: number) => `${(valor / total) * 100}%`;
  const concluidas = counts.sent + counts.failed + counts.skipped;
  const porcentagem = counts.total === 0 ? 0 : Math.round((concluidas / counts.total) * 100);

  return (
    <div className="space-y-1.5">
      <div className="flex h-2 w-full overflow-hidden rounded-full bg-slate-100">
        <div style={{ width: fatia(counts.sent) }} className="bg-green-600" />
        <div style={{ width: fatia(counts.skipped) }} className="bg-slate-400" />
        <div style={{ width: fatia(counts.failed) }} className="bg-red-500" />
      </div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-500">
        <span className="font-medium text-slate-700">{porcentagem}%</span>
        <span>
          <strong className="text-green-700">{counts.sent}</strong> enviadas
        </span>
        <span>
          <strong className="text-slate-700">{counts.pending}</strong> na fila
        </span>
        {counts.skipped > 0 && (
          <span>
            <strong className="text-slate-600">{counts.skipped}</strong> puladas
          </span>
        )}
        {counts.failed > 0 && (
          <span>
            <strong className="text-red-600">{counts.failed}</strong> falharam
          </span>
        )}
        {counts.replied > 0 && (
          <span className="text-brand-700">
            <strong>{counts.replied}</strong> responderam
          </span>
        )}
      </div>
    </div>
  );
}

/**
 * O aviso que abre a área.
 *
 * Não é enfeite: quem chega aqui vai mandar mensagem para gente que não
 * pediu, e o preço de errar é o número do escritório — com ele vai o
 * histórico de TODOS os clientes daquele chip. O texto fica curto e sempre
 * visível de propósito; esconder num "saiba mais" seria tratar como
 * detalhe o risco que define o módulo.
 */
export function BroadcastWarning() {
  return (
    <div className="mb-5 flex items-start gap-3 rounded-xl border border-amber-300 bg-amber-50 p-4">
      <ShieldAlert className="mt-0.5 h-5 w-5 shrink-0 text-amber-600" />
      <div className="text-sm text-amber-900">
        <p className="font-semibold">Disparo em massa é o que mais derruba número de WhatsApp.</p>
        <p className="mt-1 text-xs leading-relaxed">
          O sistema já protege você: intervalo sorteado entre uma mensagem e outra, envio só
          dentro do expediente, teto por dia, quem responde &quot;SAIR&quot; para de receber na
          hora e a campanha se pausa sozinha depois de falhas seguidas. O que o sistema não faz
          por você é escolher a lista — mandar para quem nunca falou com o escritório é o
          caminho mais curto para a denúncia, e é a denúncia que bane o número.
        </p>
      </div>
    </div>
  );
}

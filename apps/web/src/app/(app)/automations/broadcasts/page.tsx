"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Copy, Pause, Pencil, Play, Plus, Square, Trash2 } from "lucide-react";
import {
  BROADCAST_PAUSE_REASON_LABELS,
  formatEstimate,
  estimateCampaignMinutes,
  type BroadcastCampaignDto,
  type BroadcastPauseReason,
} from "@azvchat/shared";
import { ApiError, broadcastApi } from "@/lib/api";
import { useAuth } from "@/lib/auth-context";
import { Button, Card, EmptyState, Spinner } from "@/components/ui";
import {
  BroadcastHeader,
  BroadcastTabs,
  BroadcastWarning,
  CampaignProgress,
  CampaignStatusBadge,
} from "@/components/broadcasts/broadcast-ui";

/**
 * O PAINEL DOS DISPAROS — a lista de campanhas com o progresso ao vivo.
 *
 * Recarrega sozinha a cada 5 segundos enquanto alguma campanha está
 * enviando, e para de recarregar quando nenhuma está: é o mesmo desenho do
 * Dashboard (`setInterval` chamando a mesma rota, e NÃO evento de socket).
 * Empurrar cada mensagem enviada por socket custaria mais que uma consulta
 * por volta, e criaria uma sala nova só para contadores — o payload aqui é
 * agregado, não é conversa de cliente.
 */
const AUTO_REFRESH_MS = 5000;

export default function BroadcastsPage() {
  const { can } = useAuth();
  const router = useRouter();
  const [campaigns, setCampaigns] = useState<BroadcastCampaignDto[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const podeDisparar = can("broadcast.send");
  const podeMontar = can("broadcast.campaign.manage");

  const load = useCallback(async () => {
    try {
      setCampaigns(await broadcastApi.campaigns.list());
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Não foi possível carregar as campanhas");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Só fica recarregando quando há disparo em andamento — tela parada não
  // precisa bater na API a cada 5 segundos.
  const temAtividade = (campaigns ?? []).some(
    (item) => item.status === "running" || item.status === "scheduled",
  );
  useEffect(() => {
    if (!temAtividade) return;
    const timer = setInterval(() => void load(), AUTO_REFRESH_MS);
    return () => clearInterval(timer);
  }, [temAtividade, load]);

  async function acao(
    campaign: BroadcastCampaignDto,
    tipo: "start" | "pause" | "resume" | "cancel" | "remove" | "edit" | "duplicate",
  ) {
    // Só o RASCUNHO se edita no lugar. Depois de disparada, a campanha guarda o
    // texto exato que saiu para cada contato, e mudá-la reescreveria esse
    // histórico — então "Editar" vira uma cópia em rascunho, e a tela diz isso
    // antes, para ninguém achar que mexeu na original.
    if (tipo === "edit" && campaign.status === "draft") {
      router.push(`/automations/broadcasts/${campaign.id}/edit`);
      return;
    }
    if (
      tipo === "edit" &&
      !window.confirm(
        `"${campaign.name}" já saiu do rascunho e não pode mais ser alterada — o histórico dela continua como está.\n\n` +
          "Vou criar uma cópia em rascunho, com a mesma mensagem, audiência e ritmo, para você editar e disparar de novo.",
      )
    ) {
      return;
    }

    if (tipo === "start") {
      const confirmado = window.confirm(
        `Disparar "${campaign.name}" para a audiência ${campaign.audienceName}?\n\n` +
          "A partir daqui as mensagens começam a sair e não há como desfazer o que já saiu.",
      );
      if (!confirmado) return;
    }
    if (tipo === "cancel" && !window.confirm(`Cancelar "${campaign.name}"? O que ainda não saiu não sai mais.`)) {
      return;
    }
    if (tipo === "remove" && !window.confirm(`Excluir "${campaign.name}" e o histórico dela?`)) {
      return;
    }

    setBusy(campaign.id);
    setError(null);
    try {
      if (tipo === "start") {
        const resultado = await broadcastApi.campaigns.start(campaign.id);
        const avisos: string[] = [];
        if (resultado.skippedOptOut > 0) {
          avisos.push(`${resultado.skippedOptOut} descadastrado(s) foram pulados`);
        }
        if (resultado.skippedInvalid > 0) {
          avisos.push(`${resultado.skippedInvalid} com telefone inválido foram pulados`);
        }
        if (avisos.length > 0) {
          window.alert(`${resultado.queued} mensagens na fila.\n\n${avisos.join("\n")}.`);
        }
      } else if (tipo === "pause") {
        await broadcastApi.campaigns.pause(campaign.id);
      } else if (tipo === "resume") {
        await broadcastApi.campaigns.resume(campaign.id);
      } else if (tipo === "cancel") {
        await broadcastApi.campaigns.cancel(campaign.id);
      } else if (tipo === "edit") {
        const copia = await broadcastApi.campaigns.duplicate(campaign.id);
        router.push(`/automations/broadcasts/${copia.id}/edit`);
        return;
      } else if (tipo === "duplicate") {
        await broadcastApi.campaigns.duplicate(campaign.id);
      } else {
        await broadcastApi.campaigns.remove(campaign.id);
      }
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Não foi possível concluir a ação");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="thin-scroll h-full overflow-y-auto p-8">
      <BroadcastHeader
        title="Disparos"
        description="Campanhas de mensagem em massa pelo WhatsApp do escritório."
        action={
          podeMontar ? (
            <Link href="/automations/broadcasts/new">
              <Button>
                <Plus className="h-4 w-4" /> Nova campanha
              </Button>
            </Link>
          ) : undefined
        }
      />
      <BroadcastTabs />
      <BroadcastWarning />

      {error && <p className="mb-4 text-sm text-red-600">{error}</p>}

      {!campaigns ? (
        <div className="flex justify-center py-16">
          <Spinner className="h-8 w-8" />
        </div>
      ) : campaigns.length === 0 ? (
        <Card className="p-4">
          <EmptyState
            title="Nenhuma campanha ainda"
            description="Monte uma audiência e crie a primeira campanha para começar."
          />
        </Card>
      ) : (
        <div className="space-y-3">
          {campaigns.map((campaign) => {
            const estimativa = estimateCampaignMinutes(
              campaign.counts.pending,
              campaign.minIntervalSeconds,
              campaign.maxIntervalSeconds,
            );
            return (
              <Card key={campaign.id} className="p-5">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <Link
                        href={`/automations/broadcasts/${campaign.id}`}
                        className="text-sm font-semibold text-slate-900 hover:text-brand-600"
                      >
                        {campaign.name}
                      </Link>
                      <CampaignStatusBadge
                        status={campaign.status}
                        pausedReason={campaign.pausedReason}
                      />
                    </div>
                    <p className="mt-0.5 text-xs text-slate-500">
                      {campaign.audienceName} · pelo número {campaign.instanceName ?? "—"} · uma
                      mensagem a cada {campaign.minIntervalSeconds}–{campaign.maxIntervalSeconds}s
                      {campaign.counts.pending > 0 && campaign.status === "running"
                        ? ` · faltam ${formatEstimate(estimativa)}`
                        : ""}
                    </p>
                    {campaign.status === "paused" && campaign.pausedReason && (
                      <p className="mt-1 text-xs font-medium text-amber-700">
                        {BROADCAST_PAUSE_REASON_LABELS[campaign.pausedReason as BroadcastPauseReason]}
                      </p>
                    )}
                  </div>

                  <div className="flex shrink-0 items-center gap-1.5">
                    {podeDisparar && (campaign.status === "draft" || campaign.status === "scheduled") && (
                      <Button size="sm" disabled={busy === campaign.id} onClick={() => void acao(campaign, "start")}>
                        <Play className="h-3.5 w-3.5" /> Disparar
                      </Button>
                    )}
                    {podeDisparar && campaign.status === "running" && (
                      <Button
                        size="sm"
                        variant="secondary"
                        disabled={busy === campaign.id}
                        onClick={() => void acao(campaign, "pause")}
                      >
                        <Pause className="h-3.5 w-3.5" /> Pausar
                      </Button>
                    )}
                    {podeDisparar && campaign.status === "paused" && (
                      <Button size="sm" disabled={busy === campaign.id} onClick={() => void acao(campaign, "resume")}>
                        <Play className="h-3.5 w-3.5" /> Retomar
                      </Button>
                    )}
                    {podeDisparar &&
                      (campaign.status === "running" || campaign.status === "paused") && (
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={busy === campaign.id}
                          onClick={() => void acao(campaign, "cancel")}
                        >
                          <Square className="h-3.5 w-3.5" /> Cancelar
                        </Button>
                      )}
                    {podeMontar && (
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={busy === campaign.id}
                        title={
                          campaign.status === "draft"
                            ? "Editar a campanha"
                            : "Já saiu do rascunho: edita uma cópia nova"
                        }
                        onClick={() => void acao(campaign, "edit")}
                      >
                        <Pencil className="h-3.5 w-3.5" /> Editar
                      </Button>
                    )}
                    {podeMontar && (
                      <button
                        type="button"
                        title="Duplicar"
                        aria-label="Duplicar"
                        className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100 hover:text-brand-600"
                        disabled={busy === campaign.id}
                        onClick={() => void acao(campaign, "duplicate")}
                      >
                        <Copy className="h-4 w-4" />
                      </button>
                    )}
                    {podeMontar && campaign.status !== "running" && (
                      <button
                        type="button"
                        title="Excluir"
                        className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100 hover:text-red-600"
                        disabled={busy === campaign.id}
                        onClick={() => void acao(campaign, "remove")}
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    )}
                  </div>
                </div>

                {campaign.counts.total > 0 && (
                  <div className="mt-4">
                    <CampaignProgress counts={campaign.counts} />
                  </div>
                )}
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}

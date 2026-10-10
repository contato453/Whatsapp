"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { ArrowLeft, Copy, Pause, Pencil, Play, Send, Square } from "lucide-react";
import {
  BROADCAST_CRM_MODE_LABELS,
  BROADCAST_DELIVERY_STATUSES,
  BROADCAST_DELIVERY_STATUS_LABELS,
  BROADCAST_PAUSE_REASON_LABELS,
  BROADCAST_SKIP_REASON_LABELS,
  estimateCampaignMinutes,
  formatEstimate,
  type BroadcastCampaignDto,
  type BroadcastDeliveryDto,
  type BroadcastDeliveryStatus,
} from "@azvchat/shared";
import { ApiError, broadcastApi } from "@/lib/api";
import { useAuth } from "@/lib/auth-context";
import { Button, Card, EmptyState, Input, Modal, Spinner } from "@/components/ui";
import {
  BroadcastHeader,
  CampaignProgress,
  CampaignStatusBadge,
} from "@/components/broadcasts/broadcast-ui";

/**
 * A TELA DE UM DISPARO — status ao vivo e histórico contato a contato.
 *
 * Ela responde as duas perguntas de quem abre um disparo em andamento:
 * "quantos já saíram e quantos faltam" (a barra e os contadores, que se
 * atualizam sozinhos) e "o que aconteceu com o fulano" (a lista de
 * entregas, com o texto EXATO que ele recebeu).
 *
 * A recarga é por `setInterval`, como no painel e no Dashboard, e só
 * enquanto há movimento. Uma campanha concluída não bate mais na API.
 */
const AUTO_REFRESH_MS = 5000;

export default function BroadcastDetailPage() {
  const params = useParams<{ id: string }>();
  const id = params.id;
  const { can } = useAuth();
  const router = useRouter();

  const [campaign, setCampaign] = useState<BroadcastCampaignDto | null>(null);
  const [deliveries, setDeliveries] = useState<BroadcastDeliveryDto[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [filtro, setFiltro] = useState<BroadcastDeliveryStatus | "all">("all");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [testOpen, setTestOpen] = useState(false);
  const [testPhone, setTestPhone] = useState("");
  const [testResult, setTestResult] = useState<string | null>(null);

  const podeDisparar = can("broadcast.send");
  const podeMontar = can("broadcast.campaign.manage");

  const carregarCampanha = useCallback(async () => {
    try {
      setCampaign(await broadcastApi.campaigns.get(id));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Não foi possível carregar a campanha");
    }
  }, [id]);

  const carregarEntregas = useCallback(async () => {
    try {
      const resposta = await broadcastApi.campaigns.deliveries(id, {
        status: filtro === "all" ? undefined : filtro,
      });
      setDeliveries(resposta.deliveries);
      setNextCursor(resposta.nextCursor);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Não foi possível carregar as entregas");
    }
  }, [id, filtro]);

  useEffect(() => {
    void carregarCampanha();
  }, [carregarCampanha]);

  useEffect(() => {
    void carregarEntregas();
  }, [carregarEntregas]);

  const emMovimento = campaign?.status === "running" || campaign?.status === "scheduled";

  useEffect(() => {
    if (!emMovimento) return;
    const timer = setInterval(() => {
      void carregarCampanha();
      void carregarEntregas();
    }, AUTO_REFRESH_MS);
    return () => clearInterval(timer);
  }, [emMovimento, carregarCampanha, carregarEntregas]);

  async function acao(fn: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await fn();
      await carregarCampanha();
      await carregarEntregas();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Não foi possível concluir a ação");
    } finally {
      setBusy(false);
    }
  }

  // Fora do rascunho a campanha não se edita no lugar (o histórico guarda o
  // texto exato que saiu): "Editar" cria uma cópia em rascunho e abre ela.
  async function duplicar(paraEditar: boolean) {
    if (!campaign) return;
    if (
      paraEditar &&
      !window.confirm(
        `"${campaign.name}" já saiu do rascunho e não pode mais ser alterada — o histórico dela continua como está.\n\n` +
          "Vou criar uma cópia em rascunho, com a mesma mensagem, audiência e ritmo, para você editar e disparar de novo.",
      )
    ) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const copia = await broadcastApi.campaigns.duplicate(campaign.id);
      router.push(paraEditar ? `/automations/broadcasts/${copia.id}/edit` : `/automations/broadcasts/${copia.id}`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Não foi possível duplicar a campanha");
      setBusy(false);
    }
  }

  async function enviarTeste() {
    setBusy(true);
    setError(null);
    setTestResult(null);
    try {
      const resposta = await broadcastApi.campaigns.testSend(id, testPhone);
      setTestResult(resposta.content);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Não foi possível mandar o teste");
    } finally {
      setBusy(false);
    }
  }

  async function carregarMais() {
    if (!nextCursor) return;
    const resposta = await broadcastApi.campaigns.deliveries(id, {
      status: filtro === "all" ? undefined : filtro,
      cursor: nextCursor,
    });
    setDeliveries((atual) => [...atual, ...resposta.deliveries]);
    setNextCursor(resposta.nextCursor);
  }

  if (!campaign) {
    return (
      <div className="flex h-full items-center justify-center py-16">
        {error ? <p className="text-sm text-red-600">{error}</p> : <Spinner />}
      </div>
    );
  }

  const restante = estimateCampaignMinutes(
    campaign.counts.pending,
    campaign.minIntervalSeconds,
    campaign.maxIntervalSeconds,
  );

  return (
    <div className="thin-scroll h-full overflow-y-auto p-6 lg:p-8">
      <Link
        href="/automations/broadcasts"
        className="mb-3 inline-flex items-center gap-1.5 text-sm text-slate-500 hover:text-slate-800"
      >
        <ArrowLeft className="h-4 w-4" />
        Campanhas
      </Link>

      <BroadcastHeader
        title={campaign.name}
        description={`${campaign.audienceName} · ${campaign.instanceName ?? "número removido"}`}
        action={
          <div className="flex flex-wrap items-center gap-2">
            <CampaignStatusBadge status={campaign.status} pausedReason={campaign.pausedReason} />
            {campaign.status === "draft" && podeMontar && (
              <Link href={`/automations/broadcasts/${campaign.id}/edit`}>
                <Button variant="outline" size="sm">
                  <Pencil className="h-3.5 w-3.5" />
                  Editar
                </Button>
              </Link>
            )}
            {campaign.status !== "draft" && podeMontar && (
              <Button
                variant="outline"
                size="sm"
                disabled={busy}
                title="Já saiu do rascunho: edita uma cópia nova"
                onClick={() => void duplicar(true)}
              >
                <Pencil className="h-3.5 w-3.5" />
                Editar
              </Button>
            )}
            {podeMontar && (
              <Button variant="outline" size="sm" disabled={busy} onClick={() => void duplicar(false)}>
                <Copy className="h-3.5 w-3.5" />
                Duplicar
              </Button>
            )}
            {podeDisparar && (
              <Button variant="outline" size="sm" onClick={() => setTestOpen(true)}>
                <Send className="h-3.5 w-3.5" />
                Mandar teste
              </Button>
            )}
            {podeDisparar && (campaign.status === "draft" || campaign.status === "scheduled") && (
              <Button
                size="sm"
                disabled={busy}
                onClick={() => void acao(() => broadcastApi.campaigns.start(campaign.id))}
              >
                <Play className="h-3.5 w-3.5" />
                Iniciar
              </Button>
            )}
            {podeDisparar && campaign.status === "running" && (
              <Button
                variant="outline"
                size="sm"
                disabled={busy}
                onClick={() => void acao(() => broadcastApi.campaigns.pause(campaign.id))}
              >
                <Pause className="h-3.5 w-3.5" />
                Pausar
              </Button>
            )}
            {podeDisparar && campaign.status === "paused" && (
              <Button
                size="sm"
                disabled={busy}
                onClick={() => void acao(() => broadcastApi.campaigns.resume(campaign.id))}
              >
                <Play className="h-3.5 w-3.5" />
                Retomar
              </Button>
            )}
            {podeDisparar &&
              (campaign.status === "running" ||
                campaign.status === "paused" ||
                campaign.status === "scheduled") && (
                <Button
                  variant="danger"
                  size="sm"
                  disabled={busy}
                  onClick={() => {
                    if (
                      !confirm(
                        "Cancelar o disparo? O que ainda não saiu não sai mais, e isso não se desfaz.",
                      )
                    )
                      return;
                    void acao(() => broadcastApi.campaigns.cancel(campaign.id));
                  }}
                >
                  <Square className="h-3.5 w-3.5" />
                  Cancelar
                </Button>
              )}
          </div>
        }
      />

      {error && (
        <p className="mb-4 rounded-lg bg-red-50 p-3 text-sm text-red-700">{error}</p>
      )}

      {campaign.status === "paused" && campaign.pausedReason && (
        <p className="mb-4 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
          {BROADCAST_PAUSE_REASON_LABELS[campaign.pausedReason]}
        </p>
      )}

      <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_300px]">
        <div className="space-y-5">
          <Card className="space-y-4 p-5">
            <CampaignProgress counts={campaign.counts} />
            {campaign.counts.pending > 0 && campaign.status === "running" && (
              <p className="text-xs text-slate-500">
                Faltam {campaign.counts.pending} — {formatEstimate(restante)} no ritmo atual.
                {campaign.nextSendAt && (
                  <> Próxima às {new Date(campaign.nextSendAt).toLocaleTimeString("pt-BR")}.</>
                )}
              </p>
            )}
          </Card>

          <Card className="p-5">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
              <h2 className="text-sm font-semibold text-slate-900">Histórico contato a contato</h2>
              <div className="flex flex-wrap gap-1.5">
                {(["all", ...BROADCAST_DELIVERY_STATUSES] as const).map((valor) => (
                  <button
                    key={valor}
                    type="button"
                    onClick={() => setFiltro(valor)}
                    className={
                      filtro === valor
                        ? "rounded-full bg-slate-800 px-2.5 py-1 text-xs font-medium text-white"
                        : "rounded-full border border-slate-200 px-2.5 py-1 text-xs text-slate-600 hover:border-slate-400"
                    }
                  >
                    {valor === "all" ? "Todas" : BROADCAST_DELIVERY_STATUS_LABELS[valor]}
                  </button>
                ))}
              </div>
            </div>

            {deliveries.length === 0 ? (
              <EmptyState
                title="Nada aqui ainda"
                description={
                  campaign.status === "draft"
                    ? "A fila só é gerada quando o disparo começa."
                    : "Nenhuma entrega com este filtro."
                }
              />
            ) : (
              <div className="divide-y divide-slate-100">
                {deliveries.map((entrega) => (
                  <DeliveryRow key={entrega.id} delivery={entrega} />
                ))}
              </div>
            )}

            {nextCursor && (
              <div className="pt-3 text-center">
                <Button variant="outline" size="sm" onClick={() => void carregarMais()}>
                  Carregar mais
                </Button>
              </div>
            )}
          </Card>
        </div>

        <Card className="space-y-3 p-5 xl:sticky xl:top-4 xl:self-start">
          <h2 className="text-sm font-semibold text-slate-900">Como está configurada</h2>
          <Linha
            rotulo="Intervalo"
            valor={`${campaign.minIntervalSeconds}–${campaign.maxIntervalSeconds}s (sorteado)`}
          />
          <Linha
            rotulo="Teto por dia"
            valor={campaign.dailyLimit ? String(campaign.dailyLimit) : "Sem teto"}
          />
          <Linha
            rotulo="Expediente"
            valor={campaign.respectBusinessHours ? "Só no expediente" : "A qualquer hora"}
          />
          <Linha
            rotulo="Agendada para"
            valor={
              campaign.scheduledFor
                ? new Date(campaign.scheduledFor).toLocaleString("pt-BR")
                : "Início manual"
            }
          />
          <Linha rotulo="CRM" valor={BROADCAST_CRM_MODE_LABELS[campaign.crmMode]} />
          {campaign.crmPipelineName && (
            <Linha
              rotulo="Funil"
              valor={`${campaign.crmPipelineName}${campaign.crmStageName ? ` · ${campaign.crmStageName}` : ""}`}
            />
          )}
          {campaign.tagName && <Linha rotulo="Etiqueta" valor={campaign.tagName} />}
          {campaign.messageVariants.length > 0 && (
            <Linha rotulo="Variações do texto" valor={String(campaign.messageVariants.length + 1)} />
          )}
          <div className="border-t border-slate-100 pt-3">
            <p className="mb-1 text-[11px] font-medium uppercase tracking-wide text-slate-500">
              Mensagem
            </p>
            <p className="whitespace-pre-wrap text-xs text-slate-700">{campaign.message}</p>
          </div>
        </Card>
      </div>

      {testOpen && (
        <Modal
          open
          title="Mandar um teste"
          onClose={() => {
            setTestOpen(false);
            setTestResult(null);
          }}
        >
          <div className="space-y-3">
            <p className="text-sm text-slate-600">
              Manda a mensagem para UM número, resolvendo as variáveis com dados de exemplo.
              Use o próprio celular: é a única forma de ver o que o cliente vai ver antes de
              mandar para a lista inteira.
            </p>
            <Input
              value={testPhone}
              onChange={(event) => setTestPhone(event.target.value)}
              placeholder="(11) 99999-8888"
            />
            {testResult && (
              <div className="rounded-lg bg-slate-50 p-3">
                <p className="mb-1 text-[11px] font-medium uppercase tracking-wide text-slate-500">
                  Texto enviado
                </p>
                <p className="whitespace-pre-wrap text-sm text-slate-800">{testResult}</p>
              </div>
            )}
            <div className="flex justify-end gap-2">
              <Button
                variant="ghost"
                onClick={() => {
                  setTestOpen(false);
                  setTestResult(null);
                }}
              >
                Fechar
              </Button>
              <Button disabled={busy || testPhone.trim().length < 8} onClick={() => void enviarTeste()}>
                Enviar teste
              </Button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}

function DeliveryRow({ delivery }: { delivery: BroadcastDeliveryDto }) {
  const cor =
    delivery.status === "sent"
      ? "text-green-700"
      : delivery.status === "failed"
        ? "text-red-600"
        : delivery.status === "skipped"
          ? "text-slate-500"
          : "text-slate-400";

  return (
    <div className="flex flex-wrap items-start justify-between gap-2 py-2.5">
      <div className="min-w-0">
        <p className="truncate text-sm font-medium text-slate-800">
          {delivery.contactName ?? delivery.phoneLabel}
          {delivery.contactCompany && (
            <span className="ml-1.5 text-xs font-normal text-slate-500">
              {delivery.contactCompany}
            </span>
          )}
        </p>
        <p className="text-xs text-slate-500">{delivery.phoneLabel}</p>
        {delivery.skipReason && (
          <p className="text-xs text-slate-500">
            {BROADCAST_SKIP_REASON_LABELS[delivery.skipReason]}
          </p>
        )}
        {delivery.failureReason && (
          <p className="text-xs text-red-600">{delivery.failureReason}</p>
        )}
        {delivery.content && (
          <p className="mt-1 line-clamp-2 whitespace-pre-wrap text-xs text-slate-600">
            {delivery.content}
          </p>
        )}
      </div>
      <div className="shrink-0 text-right">
        <p className={`text-xs font-medium ${cor}`}>
          {BROADCAST_DELIVERY_STATUS_LABELS[delivery.status]}
        </p>
        {delivery.sentAt && (
          <p className="text-[11px] text-slate-400">
            {new Date(delivery.sentAt).toLocaleString("pt-BR")}
          </p>
        )}
        {delivery.repliedAt && (
          <p className="text-[11px] font-medium text-brand-700">respondeu</p>
        )}
        {delivery.conversationId && (
          <Link
            href={`/inbox/${delivery.conversationId}`}
            className="text-[11px] text-brand-600 hover:underline"
          >
            abrir conversa
          </Link>
        )}
      </div>
    </div>
  );
}

function Linha({ rotulo, valor }: { rotulo: string; valor: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3 text-sm">
      <span className="text-slate-500">{rotulo}</span>
      <span className="text-right font-medium text-slate-900">{valor}</span>
    </div>
  );
}

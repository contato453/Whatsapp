"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import {
  CalendarClock,
  Check,
  ExternalLink,
  Loader2,
  MessageSquare,
  Pencil,
  Plus,
  RotateCcw,
  ThumbsDown,
  Trophy,
  X,
} from "lucide-react";
import {
  CRM_ACTIVITY_PRIORITY_LABELS,
  CRM_ACTIVITY_TYPES,
  CRM_ACTIVITY_TYPE_LABELS,
  CRM_EVENT_TYPE_LABELS,
  crmOriginLabel,
  crmTimeInStageLabel,
  formatCurrencyBRL,
} from "@azvchat/shared";
import { crmApi } from "@/lib/api";
import { useAuth } from "@/lib/auth-context";
import type {
  CrmActivityDto,
  CrmEventDto,
  CrmLossReasonDto,
  CrmOpportunityDto,
  CrmPipelineDto,
} from "@/lib/types";
import { cn, formatDateTime } from "@/lib/utils";
import { Badge, Button, Field, Input, Modal, Spinner, Textarea } from "@/components/ui";

type Aba = "dados" | "atividades" | "historico";

/**
 * O detalhe da oportunidade, em painel lateral.
 *
 * Painel e não página: a pessoa está trabalhando o quadro, e trocar de tela a
 * cada card faria ela perder o contexto do funil — o mesmo motivo do painel do
 * relatório por atendente. Em tela estreita ele vira sobreposição.
 *
 * As três abas separam três perguntas diferentes: como está (dados), o que
 * fazer (atividades) e o que aconteceu (histórico). O histórico e as
 * atividades só são buscados quando a aba é aberta — abrir um card não pode
 * custar três consultas.
 */
export function OpportunityPanel({
  opportunityId,
  pipelines,
  lossReasons,
  onClose,
  onChanged,
  onEdit,
}: {
  opportunityId: string;
  pipelines: CrmPipelineDto[];
  lossReasons: CrmLossReasonDto[];
  onClose: () => void;
  onChanged: (opportunity: CrmOpportunityDto) => void;
  onEdit: (opportunity: CrmOpportunityDto) => void;
}) {
  const { user, can } = useAuth();
  const [aba, setAba] = useState<Aba>("dados");
  const [carregando, setCarregando] = useState(true);
  const [oportunidade, setOportunidade] = useState<CrmOpportunityDto | null>(null);
  const [atividades, setAtividades] = useState<CrmActivityDto[]>([]);
  const [followUps, setFollowUps] = useState<Array<{ id: string; scheduledFor: string; content: string }>>([]);
  const [eventos, setEventos] = useState<CrmEventDto[] | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [perdaAberta, setPerdaAberta] = useState(false);
  const [ganhoAberto, setGanhoAberto] = useState(false);
  const [novaAtividade, setNovaAtividade] = useState(false);

  const podeMexer = can("crm.opportunity.manage");

  const carregar = useCallback(async () => {
    setCarregando(true);
    setErro(null);
    try {
      const detalhe = await crmApi.get(opportunityId);
      setOportunidade(detalhe.opportunity);
      setAtividades(detalhe.activities);
      setFollowUps(detalhe.followUps);
    } catch (err) {
      setErro(err instanceof Error ? err.message : "Não foi possível carregar");
    } finally {
      setCarregando(false);
    }
  }, [opportunityId]);

  useEffect(() => {
    void carregar();
  }, [carregar]);

  useEffect(() => {
    if (aba !== "historico" || eventos) return;
    void crmApi.history(opportunityId).then(setEventos).catch(() => setEventos([]));
  }, [aba, eventos, opportunityId]);

  function aplicar(atualizada: CrmOpportunityDto) {
    setOportunidade(atualizada);
    onChanged(atualizada);
  }

  const funil = pipelines.find((item) => item.id === oportunidade?.pipelineId) ?? null;

  return (
    <aside className="flex h-full w-full flex-col border-l border-slate-200 bg-white lg:w-[26rem]">
      <header className="flex items-start justify-between gap-2 border-b border-slate-100 px-4 py-3">
        <div className="min-w-0">
          <h2 className="truncate text-sm font-semibold text-slate-900">
            {oportunidade?.title ?? "Oportunidade"}
          </h2>
          {oportunidade && (
            <p className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[11px] text-slate-500">
              <Badge color={oportunidade.stageColor}>{oportunidade.stageName}</Badge>
              <span>{crmTimeInStageLabel(oportunidade.stageEnteredAt)}</span>
            </p>
          )}
        </div>
        <button
          onClick={onClose}
          aria-label="Fechar painel"
          className="rounded-lg p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600"
        >
          <X className="h-4 w-4" />
        </button>
      </header>

      <nav className="flex gap-1 border-b border-slate-100 px-3 py-1.5">
        {(["dados", "atividades", "historico"] as const).map((item) => (
          <button
            key={item}
            onClick={() => setAba(item)}
            className={cn(
              "rounded-lg px-2.5 py-1 text-xs font-medium",
              aba === item ? "bg-brand-50 text-brand-700" : "text-slate-500 hover:bg-slate-100",
            )}
          >
            {item === "dados" ? "Dados" : item === "atividades" ? "Atividades" : "Histórico"}
          </button>
        ))}
      </nav>

      <div className="thin-scroll min-h-0 flex-1 overflow-y-auto px-4 py-3">
        {carregando && (
          <div className="flex justify-center py-10">
            <Spinner />
          </div>
        )}
        {erro && <p className="text-xs text-red-600">{erro}</p>}

        {!carregando && oportunidade && aba === "dados" && (
          <div className="space-y-3 text-sm">
            <dl className="space-y-2">
              <Linha rotulo="Status">
                <Badge
                  className={cn(
                    oportunidade.status === "won" && "bg-green-50 text-green-700",
                    oportunidade.status === "lost" && "bg-red-50 text-red-700",
                    oportunidade.status === "open" && "bg-blue-50 text-blue-700",
                  )}
                >
                  {oportunidade.status === "won"
                    ? "Ganha"
                    : oportunidade.status === "lost"
                      ? "Perdida"
                      : "Em aberto"}
                </Badge>
              </Linha>
              <Linha rotulo="Cliente">
                {oportunidade.conversationId ? (
                  <Link
                    href={`/inbox/${oportunidade.conversationId}`}
                    className="inline-flex items-center gap-1 text-brand-700 hover:underline"
                  >
                    <MessageSquare className="h-3.5 w-3.5" />
                    {oportunidade.contactName ?? "Abrir conversa"}
                    <ExternalLink className="h-3 w-3" />
                  </Link>
                ) : (
                  <span>{oportunidade.contactName ?? "Lead sem conversa"}</span>
                )}
              </Linha>
              <Linha rotulo="Valor">
                {formatCurrencyBRL(oportunidade.finalValue)}
                <span className="text-xs text-slate-400">
                  {" · "}
                  {formatCurrencyBRL(oportunidade.weightedValue)} ponderado (
                  {oportunidade.probability}%)
                </span>
              </Linha>
              {oportunidade.closedValue != null && (
                <Linha rotulo="Valor fechado">{formatCurrencyBRL(oportunidade.closedValue)}</Linha>
              )}
              <Linha rotulo="Responsável">
                {oportunidade.assignedUser?.name ?? "Sem responsável"}
              </Linha>
              <Linha rotulo="Departamento">
                {oportunidade.department?.name ?? "Sem departamento"}
              </Linha>
              <Linha rotulo="Serviço">{oportunidade.product?.name ?? "—"}</Linha>
              <Linha rotulo="Origem">{crmOriginLabel(oportunidade.origin)}</Linha>
              <Linha rotulo="Previsão">
                {oportunidade.expectedCloseDate
                  ? new Date(oportunidade.expectedCloseDate).toLocaleDateString("pt-BR")
                  : "—"}
              </Linha>
              <Linha rotulo="Última interação">
                {oportunidade.lastInteractionAt
                  ? formatDateTime(oportunidade.lastInteractionAt)
                  : "—"}
              </Linha>
              {oportunidade.lossReason && (
                <Linha rotulo="Motivo da perda">
                  {oportunidade.lossReason.name}
                  {oportunidade.lossNote && (
                    <span className="block text-xs text-slate-500">{oportunidade.lossNote}</span>
                  )}
                </Linha>
              )}
            </dl>

            {oportunidade.tags.length > 0 && (
              <div className="flex flex-wrap gap-1">
                {oportunidade.tags.map((tag) => (
                  <Badge key={tag.id} color={tag.color}>
                    {tag.name}
                  </Badge>
                ))}
              </div>
            )}

            {oportunidade.notes && (
              <p className="whitespace-pre-wrap rounded-lg bg-slate-50 p-2 text-xs text-slate-600">
                {oportunidade.notes}
              </p>
            )}

            {followUps.length > 0 && (
              // A equipe precisa ver o que o sistema vai mandar antes de
              // mandar a mesma coisa na mão.
              <div className="rounded-lg border border-amber-200 bg-amber-50 p-2">
                <p className="text-[11px] font-medium text-amber-800">Follow-up a caminho</p>
                {followUps.map((item) => (
                  <p key={item.id} className="mt-0.5 text-[11px] text-amber-700">
                    {formatDateTime(item.scheduledFor)} — {item.content.slice(0, 80)}
                  </p>
                ))}
              </div>
            )}

            {podeMexer && oportunidade.status === "open" && funil && (
              <Field label="Mover para etapa">
                <select
                  value={oportunidade.stageId}
                  onChange={async (event) => {
                    const destino = funil.stages.find((s) => s.id === event.target.value);
                    if (!destino) return;
                    // Etapa de perda pelo seletor cai no mesmo fluxo do botão:
                    // sem motivo a API recusa, então a tela pergunta antes.
                    if (destino.type === "lost") {
                      setPerdaAberta(true);
                      return;
                    }
                    try {
                      const atualizada = await crmApi.move(oportunidade.id, {
                        stageId: destino.id,
                        fromStageId: oportunidade.stageId,
                      });
                      aplicar(atualizada);
                    } catch (err) {
                      setErro(err instanceof Error ? err.message : "Não foi possível mover");
                      void carregar();
                    }
                  }}
                  className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm"
                >
                  {funil.stages.map((stage) => (
                    <option key={stage.id} value={stage.id}>
                      {stage.name}
                    </option>
                  ))}
                </select>
              </Field>
            )}

            <div className="flex flex-wrap gap-2 pt-1">
              {podeMexer && (
                <Button size="sm" variant="outline" onClick={() => onEdit(oportunidade)}>
                  <Pencil className="h-3.5 w-3.5" /> Editar
                </Button>
              )}
              {podeMexer && oportunidade.status === "open" && (
                <>
                  <Button size="sm" onClick={() => setGanhoAberto(true)}>
                    <Trophy className="h-3.5 w-3.5" /> Ganhei
                  </Button>
                  <Button size="sm" variant="danger" onClick={() => setPerdaAberta(true)}>
                    <ThumbsDown className="h-3.5 w-3.5" /> Perdi
                  </Button>
                </>
              )}
              {oportunidade.status !== "open" && can("crm.opportunity.reopen") && (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={async () => {
                    try {
                      aplicar(await crmApi.reopen(oportunidade.id));
                    } catch (err) {
                      setErro(err instanceof Error ? err.message : "Não foi possível reabrir");
                    }
                  }}
                >
                  <RotateCcw className="h-3.5 w-3.5" /> Reabrir
                </Button>
              )}
            </div>
          </div>
        )}

        {!carregando && oportunidade && aba === "atividades" && (
          <div className="space-y-2">
            {podeMexer && (
              <Button size="sm" variant="outline" onClick={() => setNovaAtividade(true)}>
                <Plus className="h-3.5 w-3.5" /> Nova atividade
              </Button>
            )}
            {atividades.length === 0 && (
              <p className="py-6 text-center text-xs text-slate-400">
                Nenhuma atividade. A próxima ação aparece no card do quadro.
              </p>
            )}
            {atividades.map((atividade) => (
              <div
                key={atividade.id}
                className={cn(
                  "rounded-lg border p-2",
                  atividade.overdue ? "border-amber-300 bg-amber-50" : "border-slate-200",
                  atividade.status !== "pending" && "opacity-60",
                )}
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-slate-800">
                      {atividade.title}
                    </p>
                    <p className="text-[11px] text-slate-500">
                      {CRM_ACTIVITY_TYPE_LABELS[atividade.type]} ·{" "}
                      {formatDateTime(atividade.dueAt)}
                      {atividade.assignedUser && ` · ${atividade.assignedUser.name}`}
                    </p>
                    {atividade.description && (
                      <p className="mt-1 text-[11px] text-slate-500">{atividade.description}</p>
                    )}
                  </div>
                  {podeMexer && atividade.status === "pending" && (
                    <button
                      title="Concluir"
                      aria-label={`Concluir ${atividade.title}`}
                      onClick={async () => {
                        const atualizada = await crmApi.updateActivity(atividade.id, {
                          status: "done",
                        });
                        setAtividades((atual) =>
                          atual.map((item) => (item.id === atualizada.id ? atualizada : item)),
                        );
                        void carregar();
                      }}
                      className="rounded-lg p-1 text-green-600 hover:bg-green-50"
                    >
                      <Check className="h-4 w-4" />
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}

        {!carregando && aba === "historico" && (
          <div className="space-y-2">
            {!eventos && (
              <div className="flex justify-center py-6">
                <Loader2 className="h-4 w-4 animate-spin text-slate-400" />
              </div>
            )}
            {eventos?.length === 0 && (
              <p className="py-6 text-center text-xs text-slate-400">Sem histórico ainda.</p>
            )}
            {eventos?.map((evento) => (
              <div key={evento.id} className="border-l-2 border-slate-200 pl-3">
                <p className="text-[11px] font-medium text-slate-700">
                  {CRM_EVENT_TYPE_LABELS[evento.type]}
                </p>
                {evento.description && (
                  <p className="text-[11px] text-slate-500">{evento.description}</p>
                )}
                <p className="text-[10px] text-slate-400">
                  {formatDateTime(evento.createdAt)} ·{" "}
                  {/* Autor nulo é o sistema: automação de etapa ou resposta do
                      cliente. Deixar em branco faria parecer erro. */}
                  {evento.performedBy?.name ?? "Sistema"}
                </p>
              </div>
            ))}
          </div>
        )}
      </div>

      {oportunidade && (
        <>
          <GanhoModal
            open={ganhoAberto}
            opportunity={oportunidade}
            onClose={() => setGanhoAberto(false)}
            onDone={aplicar}
          />
          <PerdaModal
            open={perdaAberta}
            opportunity={oportunidade}
            lossReasons={lossReasons}
            onClose={() => setPerdaAberta(false)}
            onDone={aplicar}
          />
          <AtividadeModal
            open={novaAtividade}
            opportunityId={oportunidade.id}
            defaultUserId={user?.id ?? null}
            onClose={() => setNovaAtividade(false)}
            onCreated={(atividade) => {
              setAtividades((atual) => [atividade, ...atual]);
              void carregar();
            }}
          />
        </>
      )}
    </aside>
  );
}

function Linha({ rotulo, children }: { rotulo: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-3">
      <dt className="shrink-0 text-[11px] uppercase tracking-wide text-slate-400">{rotulo}</dt>
      <dd className="min-w-0 text-right text-sm text-slate-700">{children}</dd>
    </div>
  );
}

/**
 * Ganho: pergunta o valor FECHADO, que é diferente do estimado.
 *
 * Guardar os dois é o que permite ao relatório comparar o que se previu com o
 * que aconteceu — sobrescrever um com o outro apagaria a diferença.
 */
function GanhoModal({
  open,
  opportunity,
  onClose,
  onDone,
}: {
  open: boolean;
  opportunity: CrmOpportunityDto;
  onClose: () => void;
  onDone: (opportunity: CrmOpportunityDto) => void;
}) {
  const [valor, setValor] = useState("");
  const [salvando, setSalvando] = useState(false);
  const [erro, setErro] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setValor(String(opportunity.finalValue || ""));
      setErro(null);
    }
  }, [open, opportunity.finalValue]);

  return (
    <Modal open={open} onClose={onClose} title="Registrar ganho">
      <div className="space-y-3">
        <Field label="Valor fechado (R$)">
          <Input value={valor} onChange={(event) => setValor(event.target.value)} inputMode="decimal" />
        </Field>
        <p className="text-xs text-slate-500">
          Ao marcar como ganha, os follow-ups pendentes são cancelados e as atividades em aberto
          são encerradas.
        </p>
        {erro && <p className="text-xs text-red-600">{erro}</p>}
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            Cancelar
          </Button>
          <Button
            disabled={salvando}
            onClick={async () => {
              setSalvando(true);
              try {
                const limpo = Number(valor.replace(/\./g, "").replace(",", "."));
                onDone(
                  await crmApi.win(opportunity.id, Number.isFinite(limpo) ? limpo : null),
                );
                onClose();
              } catch (err) {
                setErro(err instanceof Error ? err.message : "Não foi possível registrar");
              } finally {
                setSalvando(false);
              }
            }}
          >
            Confirmar ganho
          </Button>
        </div>
      </div>
    </Modal>
  );
}

/**
 * Perda: o motivo é OBRIGATÓRIO, e a lista vem do cadastro.
 *
 * Campo livre aqui destruiria o relatório de motivos ("preço" digitado de seis
 * jeitos não se agrupa) — e é esse relatório que diz ao escritório o que
 * corrigir. A API também recusa sem motivo: esconder e recusar andam juntos.
 */
function PerdaModal({
  open,
  opportunity,
  lossReasons,
  onClose,
  onDone,
}: {
  open: boolean;
  opportunity: CrmOpportunityDto;
  lossReasons: CrmLossReasonDto[];
  onClose: () => void;
  onDone: (opportunity: CrmOpportunityDto) => void;
}) {
  const ativos = lossReasons.filter((item) => item.active);
  const primeiroMotivo = ativos[0]?.id ?? "";
  const [motivo, setMotivo] = useState("");
  const [nota, setNota] = useState("");
  const [erro, setErro] = useState<string | null>(null);
  const [salvando, setSalvando] = useState(false);

  // A dependência é o ID do primeiro motivo, e não a lista filtrada: aquela é
  // derivada da prop e muda de identidade a cada render, o que reabriria o
  // efeito sem parar e apagaria o que a pessoa já tivesse escolhido.
  useEffect(() => {
    if (!open) return;
    setMotivo(primeiroMotivo);
    setNota("");
    setErro(null);
  }, [open, primeiroMotivo]);

  return (
    <Modal open={open} onClose={onClose} title="Registrar perda">
      <div className="space-y-3">
        <Field label="Motivo da perda (obrigatório)">
          <select
            value={motivo}
            onChange={(event) => setMotivo(event.target.value)}
            className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm"
          >
            {ativos.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Observação (opcional)">
          <Textarea rows={3} value={nota} onChange={(event) => setNota(event.target.value)} />
        </Field>
        {erro && <p className="text-xs text-red-600">{erro}</p>}
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            Cancelar
          </Button>
          <Button
            variant="danger"
            disabled={salvando || !motivo}
            onClick={async () => {
              setSalvando(true);
              try {
                onDone(await crmApi.lose(opportunity.id, motivo, nota || null));
                onClose();
              } catch (err) {
                setErro(err instanceof Error ? err.message : "Não foi possível registrar");
              } finally {
                setSalvando(false);
              }
            }}
          >
            Confirmar perda
          </Button>
        </div>
      </div>
    </Modal>
  );
}

function AtividadeModal({
  open,
  opportunityId,
  defaultUserId,
  onClose,
  onCreated,
}: {
  open: boolean;
  opportunityId: string;
  defaultUserId: string | null;
  onClose: () => void;
  onCreated: (activity: CrmActivityDto) => void;
}) {
  const [tipo, setTipo] = useState<string>("call");
  const [titulo, setTitulo] = useState("");
  const [descricao, setDescricao] = useState("");
  const [quando, setQuando] = useState("");
  const [prioridade, setPrioridade] = useState("normal");
  const [erro, setErro] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setTipo("call");
    setTitulo("");
    setDescricao("");
    setPrioridade("normal");
    // Amanhã às 9h como padrão: prazo em branco vira tarefa que ninguém marca,
    // e a agenda do CRM depende de todas terem data.
    const amanha = new Date();
    amanha.setDate(amanha.getDate() + 1);
    amanha.setHours(9, 0, 0, 0);
    setQuando(amanha.toISOString().slice(0, 16));
    setErro(null);
  }, [open]);

  return (
    <Modal open={open} onClose={onClose} title="Nova atividade">
      <div className="space-y-3">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Tipo">
            <select
              value={tipo}
              onChange={(event) => setTipo(event.target.value)}
              className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm"
            >
              {CRM_ACTIVITY_TYPES.map((item) => (
                <option key={item} value={item}>
                  {CRM_ACTIVITY_TYPE_LABELS[item]}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Prioridade">
            <select
              value={prioridade}
              onChange={(event) => setPrioridade(event.target.value)}
              className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm"
            >
              {(["low", "normal", "high"] as const).map((item) => (
                <option key={item} value={item}>
                  {CRM_ACTIVITY_PRIORITY_LABELS[item]}
                </option>
              ))}
            </select>
          </Field>
        </div>
        <Field label="Título">
          <Input
            value={titulo}
            onChange={(event) => setTitulo(event.target.value)}
            placeholder="Ex.: Ligar para o cliente"
          />
        </Field>
        <Field label="Quando">
          <Input
            type="datetime-local"
            value={quando}
            onChange={(event) => setQuando(event.target.value)}
          />
        </Field>
        <Field label="Descrição (opcional)">
          <Textarea rows={2} value={descricao} onChange={(event) => setDescricao(event.target.value)} />
        </Field>
        {erro && <p className="text-xs text-red-600">{erro}</p>}
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            Cancelar
          </Button>
          <Button
            disabled={!titulo.trim() || !quando}
            onClick={async () => {
              try {
                const atividade = await crmApi.createActivity(opportunityId, {
                  type: tipo,
                  title: titulo.trim(),
                  description: descricao.trim() || null,
                  dueAt: new Date(quando).toISOString(),
                  priority: prioridade,
                  assignedUserId: defaultUserId,
                });
                onCreated(atividade);
                onClose();
              } catch (err) {
                setErro(err instanceof Error ? err.message : "Não foi possível criar");
              }
            }}
          >
            <CalendarClock className="h-3.5 w-3.5" /> Criar
          </Button>
        </div>
      </div>
    </Modal>
  );
}

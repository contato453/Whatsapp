"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { ExternalLink, Plus, Target } from "lucide-react";
import { formatCurrencyBRL, RealtimeEvents } from "@azvchat/shared";
import { api, crmApi } from "@/lib/api";
import { useAuth } from "@/lib/auth-context";
import { useSocket } from "@/lib/socket-context";
import type {
  CrmOpportunityDto,
  CrmPipelineDto,
  CrmProductDto,
  TagDto,
  UserDirectoryDto,
} from "@/lib/types";
import { Badge, Button } from "@/components/ui";
import { OpportunityForm } from "@/components/crm/opportunity-form";

/**
 * O CRM dentro da conversa.
 *
 * É a ponte que faz o CRM ser usado: sem ela, criar oportunidade exigiria
 * sair do atendimento, achar o cliente no quadro e digitar o que já está na
 * tela — e ninguém faz isso no meio de uma conversa. Com ela, "+ Criar
 * oportunidade" aproveita a conversa aberta: contato, telefone, departamento
 * e responsável são herdados, e nada é perguntado duas vezes.
 *
 * Quando já existe oportunidade, o card mostra o estado dela de forma
 * DISCRETA (etapa, valor, responsável) e um link para o quadro. Nada de
 * repetir o funil inteiro aqui: o painel de contexto é do atendimento.
 */
export function CrmConversationCard({
  conversationId,
  conversationTitle,
}: {
  conversationId: string;
  conversationTitle: string;
}) {
  const { can } = useAuth();
  const socket = useSocket();
  const [oportunidades, setOportunidades] = useState<CrmOpportunityDto[]>([]);
  const [carregando, setCarregando] = useState(true);
  const [formAberto, setFormAberto] = useState(false);
  const [pipelines, setPipelines] = useState<CrmPipelineDto[]>([]);
  const [products, setProducts] = useState<CrmProductDto[]>([]);
  const [users, setUsers] = useState<UserDirectoryDto[]>([]);
  const [tags, setTags] = useState<TagDto[]>([]);
  const [aviso, setAviso] = useState<string | null>(null);

  const podeVer = can("crm.view");
  const podeCriar = can("crm.opportunity.manage");

  const carregar = useCallback(async () => {
    if (!podeVer) return;
    setCarregando(true);
    try {
      setOportunidades(await crmApi.byConversation(conversationId));
    } catch {
      // O CRM é acessório dentro da conversa: uma falha aqui não pode
      // atrapalhar quem está atendendo. O card simplesmente não aparece.
      setOportunidades([]);
    } finally {
      setCarregando(false);
    }
  }, [conversationId, podeVer]);

  useEffect(() => {
    void carregar();
  }, [carregar]);

  /** As listas do formulário só são buscadas quando ele é aberto. */
  useEffect(() => {
    if (!formAberto || pipelines.length > 0) return;
    void crmApi.pipelines().then(setPipelines).catch(() => undefined);
    void crmApi.settings().then((data) => setProducts(data.products)).catch(() => undefined);
    void api.get<{ users: UserDirectoryDto[] }>("/users").then((d) => setUsers(d.users)).catch(() => undefined);
    void api.get<{ tags: TagDto[] }>("/tags").then((d) => setTags(d.tags)).catch(() => undefined);
  }, [formAberto, pipelines.length]);

  /** O card acompanha o quadro: mover lá atualiza aqui, sem recarregar. */
  useEffect(() => {
    if (!socket || !podeVer) return;
    const aoMudar = (opportunity: CrmOpportunityDto) => {
      if (opportunity.conversationId !== conversationId) return;
      setOportunidades((atual) => {
        const semEla = atual.filter((item) => item.id !== opportunity.id);
        return [opportunity, ...semEla];
      });
    };
    socket.on(RealtimeEvents.CrmOpportunity, aoMudar);
    return () => {
      socket.off(RealtimeEvents.CrmOpportunity, aoMudar);
    };
  }, [socket, conversationId, podeVer]);

  if (!podeVer) return null;

  const abertas = oportunidades.filter((item) => item.status === "open");
  const fechadas = oportunidades.length - abertas.length;

  return (
    <div className="border-t border-slate-100 px-4 py-3">
      <div className="flex items-center justify-between gap-2">
        <h3 className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-slate-500">
          <Target className="h-3.5 w-3.5" /> CRM
        </h3>
        {podeCriar && (
          <Button size="sm" variant="ghost" onClick={() => setFormAberto(true)}>
            <Plus className="h-3.5 w-3.5" /> Criar oportunidade
          </Button>
        )}
      </div>

      {carregando && <p className="mt-1 text-[11px] text-slate-400">Carregando...</p>}

      {!carregando && abertas.length === 0 && (
        <p className="mt-1 text-[11px] text-slate-400">
          Nenhuma oportunidade aberta para este cliente.
          {fechadas > 0 && ` ${fechadas} já encerrada(s).`}
        </p>
      )}

      <div className="mt-2 space-y-1.5">
        {abertas.map((oportunidade) => (
          <div
            key={oportunidade.id}
            className="rounded-lg border border-slate-200 px-2.5 py-2 text-xs"
          >
            <div className="flex items-center justify-between gap-2">
              <span className="min-w-0 truncate font-medium text-slate-800">
                {oportunidade.title}
              </span>
              <Badge color={oportunidade.stageColor}>{oportunidade.stageName}</Badge>
            </div>
            <p className="mt-0.5 text-[11px] text-slate-500">
              {formatCurrencyBRL(oportunidade.finalValue)} ·{" "}
              {oportunidade.assignedUser?.name ?? "Sem responsável"}
            </p>
            {oportunidade.nextActivity && (
              <p
                className={
                  oportunidade.nextActivity.overdue
                    ? "mt-0.5 text-[11px] font-medium text-amber-700"
                    : "mt-0.5 text-[11px] text-slate-400"
                }
              >
                Próxima ação: {oportunidade.nextActivity.title}
              </p>
            )}
            <Link
              href="/crm/kanban"
              className="mt-1 inline-flex items-center gap-1 text-[11px] text-brand-700 hover:underline"
            >
              Ver no quadro <ExternalLink className="h-3 w-3" />
            </Link>
          </div>
        ))}
      </div>

      {aviso && <p className="mt-1 text-[11px] text-amber-700">{aviso}</p>}

      <OpportunityForm
        open={formAberto}
        onClose={() => setFormAberto(false)}
        pipelines={pipelines}
        products={products}
        users={users}
        tags={tags}
        conversation={{ id: conversationId, title: conversationTitle }}
        onSaved={(oportunidade, duplicated) => {
          setOportunidades((atual) => [
            oportunidade,
            ...atual.filter((item) => item.id !== oportunidade.id),
          ]);
          // Duplicada não é erro: alguém (ou uma automação) já tinha aberto o
          // card. Avisar em vez de estourar erro evita a segunda tentativa.
          setAviso(
            duplicated
              ? "Este cliente já tinha uma oportunidade aberta neste funil — ela foi aberta em vez de criar outra."
              : null,
          );
        }}
      />
    </div>
  );
}

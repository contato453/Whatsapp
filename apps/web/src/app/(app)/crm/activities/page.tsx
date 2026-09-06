"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { CalendarCheck2, Check, MessageSquare } from "lucide-react";
import {
  CRM_ACTIVITY_PRIORITY_COLORS,
  CRM_ACTIVITY_PRIORITY_LABELS,
  CRM_ACTIVITY_RANGES,
  CRM_ACTIVITY_RANGE_LABELS,
  CRM_ACTIVITY_TYPE_LABELS,
} from "@azvchat/shared";
import { crmApi } from "@/lib/api";
import { useAuth } from "@/lib/auth-context";
import type { CrmActivityDto } from "@/lib/types";
import { cn, formatDateTime } from "@/lib/utils";
import { Badge, EmptyState, Spinner } from "@/components/ui";
import { CrmNav } from "@/components/crm/crm-nav";

/**
 * A agenda do CRM.
 *
 * O recorte padrão é "atrasadas": é a pergunta que a pessoa tem ao abrir a
 * tela ("o que eu deixei passar?"), e começar por "todas" faria a lista mais
 * longa esconder justamente o que precisa de ação hoje.
 *
 * "Atrasada" NÃO é status gravado — é pendente com prazo vencido, derivado do
 * relógio. Concluir tira o vermelho na hora, sem processo nenhum varrendo
 * tabela na virada da hora.
 */
export default function CrmActivitiesPage() {
  const { user, can } = useAuth();
  const [range, setRange] = useState<string>("overdue");
  const [somenteMinhas, setSomenteMinhas] = useState(true);
  const [items, setItems] = useState<CrmActivityDto[]>([]);
  const [carregando, setCarregando] = useState(true);

  const carregar = useCallback(async () => {
    setCarregando(true);
    try {
      const data = await crmApi.activities({ range, mine: somenteMinhas });
      setItems(data.activities);
    } finally {
      setCarregando(false);
    }
  }, [range, somenteMinhas]);

  useEffect(() => {
    void carregar();
  }, [carregar]);

  const podeMexer = can("crm.opportunity.manage");

  return (
    <div className="flex h-full flex-col">
      <div className="px-4 pt-4">
        <h1 className="text-lg font-semibold text-slate-900">CRM</h1>
        <p className="text-xs text-slate-500">Ligações, reuniões e retornos combinados</p>
      </div>
      <CrmNav />

      <div className="flex flex-wrap items-center gap-2 px-4 py-2">
        {["all", ...CRM_ACTIVITY_RANGES].map((valor) => (
          <button
            key={valor}
            onClick={() => setRange(valor)}
            className={cn(
              "rounded-lg border px-2 py-1 text-[11px]",
              range === valor
                ? "border-brand-500 bg-brand-50 font-medium text-brand-700"
                : "border-slate-200 text-slate-600 hover:bg-slate-50",
            )}
          >
            {valor === "all"
              ? "Todas"
              : CRM_ACTIVITY_RANGE_LABELS[valor as keyof typeof CRM_ACTIVITY_RANGE_LABELS]}
          </button>
        ))}
        <label className="ml-2 flex items-center gap-1.5 text-[11px] text-slate-600">
          <input
            type="checkbox"
            checked={somenteMinhas}
            onChange={(event) => setSomenteMinhas(event.target.checked)}
            className="h-3.5 w-3.5 accent-brand-600"
          />
          Somente as minhas ({user?.name.split(" ")[0]})
        </label>
      </div>

      <div className="thin-scroll min-h-0 flex-1 overflow-y-auto px-4 pb-4">
        {carregando && (
          <div className="flex justify-center py-10">
            <Spinner />
          </div>
        )}
        {!carregando && items.length === 0 && (
          <EmptyState
            icon={<CalendarCheck2 className="h-10 w-10" />}
            title="Nada por aqui"
            description={
              range === "overdue"
                ? "Nenhuma atividade atrasada — a agenda está em dia."
                : "Nenhuma atividade neste recorte."
            }
          />
        )}
        <div className="space-y-2">
          {items.map((atividade) => (
            <div
              key={atividade.id}
              className={cn(
                "flex items-start justify-between gap-3 rounded-lg border p-3",
                atividade.overdue ? "border-amber-300 bg-amber-50" : "border-slate-200 bg-white",
                atividade.status !== "pending" && "opacity-60",
              )}
            >
              <div className="min-w-0">
                <p className="flex flex-wrap items-center gap-1.5 text-sm font-medium text-slate-800">
                  {atividade.title}
                  <Badge color={CRM_ACTIVITY_PRIORITY_COLORS[atividade.priority]}>
                    {CRM_ACTIVITY_PRIORITY_LABELS[atividade.priority]}
                  </Badge>
                </p>
                <p className="mt-0.5 text-[11px] text-slate-500">
                  {CRM_ACTIVITY_TYPE_LABELS[atividade.type]} · {formatDateTime(atividade.dueAt)}
                  {atividade.assignedUser && ` · ${atividade.assignedUser.name}`}
                </p>
                <p className="mt-0.5 flex flex-wrap items-center gap-2 text-[11px] text-slate-400">
                  {atividade.opportunityTitle && <span>{atividade.opportunityTitle}</span>}
                  {atividade.conversationId && (
                    <Link
                      href={`/inbox/${atividade.conversationId}`}
                      className="inline-flex items-center gap-1 text-brand-700 hover:underline"
                    >
                      <MessageSquare className="h-3 w-3" /> Abrir conversa
                    </Link>
                  )}
                </p>
              </div>
              {podeMexer && atividade.status === "pending" && (
                <button
                  onClick={async () => {
                    await crmApi.updateActivity(atividade.id, { status: "done" });
                    void carregar();
                  }}
                  aria-label={`Concluir ${atividade.title}`}
                  className="shrink-0 rounded-lg border border-green-200 p-1.5 text-green-600 hover:bg-green-50"
                >
                  <Check className="h-4 w-4" />
                </button>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

"use client";

import { AlarmClock, Building2, CalendarClock, MessageSquare, Phone } from "lucide-react";
import {
  crmOriginLabel,
  crmStageSlaBroken,
  crmTimeInStageLabel,
  formatCurrencyBRL,
} from "@azvchat/shared";
import type { CrmOpportunityDto } from "@/lib/types";
import { cn, formatPhone } from "@/lib/utils";
import { Badge } from "@/components/ui";

/**
 * O card do Kanban.
 *
 * O QUE ELE MOSTRA foi escolhido para caber numa varredura de olho, e o resto
 * fica no painel de detalhe: cliente, valor, responsável, próxima ação e há
 * quanto tempo está parado. Card cheio de campo vira parede de texto, e um
 * quadro de parede de texto ninguém lê — a pessoa volta para a lista.
 *
 * Dois sinais têm cor porque são os que fazem alguém agir hoje: a atividade
 * ATRASADA (âmbar) e o card PARADO além do prazo da etapa (borda âmbar). O
 * resto é cinza de propósito.
 */
export function OpportunityCard({
  opportunity,
  onOpen,
  dragging,
  onDragStart,
  onDragEnd,
}: {
  opportunity: CrmOpportunityDto;
  onOpen: () => void;
  dragging?: boolean;
  onDragStart?: () => void;
  onDragEnd?: () => void;
}) {
  const parado = crmStageSlaBroken(opportunity.stageEnteredAt, opportunity.stageSlaDays);
  const atrasada = opportunity.nextActivity?.overdue ?? false;

  return (
    <article
      // Arrastar é HTML5 puro: nenhuma biblioteca de drag entrou no projeto
      // por causa desta tela. O clique continua abrindo o detalhe, e quem
      // navega por teclado usa Enter — arrastar nunca é o ÚNICO caminho para
      // mover (o painel tem o seletor de etapa).
      draggable
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onClick={onOpen}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onOpen();
        }
      }}
      role="button"
      tabIndex={0}
      aria-label={`Abrir oportunidade ${opportunity.title}`}
      className={cn(
        "cursor-grab rounded-lg border bg-white p-2.5 shadow-sm transition-shadow hover:shadow-md focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/40 active:cursor-grabbing",
        parado ? "border-amber-300" : "border-slate-200",
        dragging && "opacity-40",
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <p className="min-w-0 flex-1 truncate text-sm font-medium text-slate-900">
          {opportunity.title}
        </p>
        {opportunity.value > 0 && (
          <span className="shrink-0 text-xs font-semibold text-slate-700">
            {formatCurrencyBRL(opportunity.finalValue)}
          </span>
        )}
      </div>

      {opportunity.contactName && opportunity.contactName !== opportunity.title && (
        <p className="mt-0.5 truncate text-[11px] text-slate-500">{opportunity.contactName}</p>
      )}

      <div className="mt-1.5 flex flex-wrap items-center gap-1">
        {opportunity.product && (
          <Badge className="bg-slate-100 text-slate-600">{opportunity.product.name}</Badge>
        )}
        {opportunity.origin && (
          <Badge className="bg-slate-100 text-slate-500">
            {crmOriginLabel(opportunity.origin)}
          </Badge>
        )}
        {opportunity.tags.slice(0, 2).map((tag) => (
          <Badge key={tag.id} color={tag.color}>
            {tag.name}
          </Badge>
        ))}
      </div>

      {opportunity.nextActivity && (
        <p
          className={cn(
            "mt-1.5 flex items-center gap-1 truncate text-[11px]",
            atrasada ? "font-medium text-amber-700" : "text-slate-500",
          )}
        >
          {atrasada ? (
            <AlarmClock className="h-3 w-3 shrink-0" />
          ) : (
            <CalendarClock className="h-3 w-3 shrink-0" />
          )}
          <span className="truncate">
            {opportunity.nextActivity.title} ·{" "}
            {new Date(opportunity.nextActivity.dueAt).toLocaleString("pt-BR", {
              day: "2-digit",
              month: "2-digit",
              hour: "2-digit",
              minute: "2-digit",
            })}
          </span>
        </p>
      )}

      <div className="mt-2 flex items-center justify-between gap-2 text-[10px] text-slate-400">
        <span className="flex min-w-0 items-center gap-1 truncate">
          {opportunity.conversationId ? (
            <MessageSquare className="h-3 w-3 shrink-0" />
          ) : opportunity.contactPhone ? (
            <Phone className="h-3 w-3 shrink-0" />
          ) : (
            <Building2 className="h-3 w-3 shrink-0" />
          )}
          <span className="truncate">
            {opportunity.assignedUser?.name ?? "Sem responsável"}
          </span>
        </span>
        <span className={cn("shrink-0", parado && "font-medium text-amber-600")}>
          {crmTimeInStageLabel(opportunity.stageEnteredAt)}
        </span>
      </div>

      {opportunity.contactPhone && !opportunity.conversationId && (
        <p className="mt-1 text-[10px] text-slate-400">{formatPhone(opportunity.contactPhone)}</p>
      )}
    </article>
  );
}

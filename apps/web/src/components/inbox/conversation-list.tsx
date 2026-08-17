"use client";

import { Archive, Users2, User, UserRound } from "lucide-react";
import {
  ALL_USERS_ASSIGNEE_LABEL,
  AZEVEDO_OS_SOURCE,
  CONNECTION_STATUS_COLORS,
  CONNECTION_STATUS_LABELS,
  CONVERSATION_STATUS_COLORS,
  CONVERSATION_STATUS_LABELS,
} from "@azvchat/shared";
import { cn, formatDateTime, formatTime } from "@/lib/utils";
import type { ConversationDto } from "@/lib/types";
import { Badge } from "@/components/ui";
import { ConversationAvatar } from "./conversation-avatar";

export function ConversationListItem({
  conversation,
  active,
  onClick,
}: {
  conversation: ConversationDto;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "w-full border-b border-slate-100 px-3 py-3 text-left transition-colors",
        active ? "bg-brand-50" : "hover:bg-slate-50",
      )}
    >
      <div className="flex items-start gap-2.5">
        <div className="relative shrink-0">
          <ConversationAvatar
            conversationId={conversation.id}
            name={conversation.title}
            hasAvatar={conversation.hasAvatar}
          />
          <span
            className="absolute -bottom-0.5 -right-0.5 flex h-4 w-4 items-center justify-center rounded-full bg-white text-slate-500 shadow"
            title={conversation.type === "group" ? "Grupo" : "Contato"}
          >
            {conversation.type === "group" ? (
              <Users2 className="h-2.5 w-2.5" />
            ) : (
              <User className="h-2.5 w-2.5" />
            )}
          </span>
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-2">
            <p className="truncate text-sm font-semibold text-slate-900">{conversation.title}</p>
            <span className="shrink-0 text-[10px] text-slate-400">
              {formatTime(conversation.lastMessageAt)}
            </span>
          </div>
          <div className="mt-0.5 flex items-center justify-between gap-2">
            <p className="truncate text-xs text-slate-500">
              {conversation.lastMessagePreview ?? "Sem mensagens"}
            </p>
            {conversation.unreadCount > 0 && (
              <span className="flex h-4.5 min-w-[18px] shrink-0 items-center justify-center rounded-full bg-brand-600 px-1 text-[10px] font-bold text-white">
                {conversation.unreadCount > 99 ? "99+" : conversation.unreadCount}
              </span>
            )}
          </div>
          <div className="mt-1.5 flex flex-wrap items-center gap-1">
            <Badge color={CONVERSATION_STATUS_COLORS[conversation.status]}>
              {CONVERSATION_STATUS_LABELS[conversation.status]}
            </Badge>
            {conversation.instanceName && (
              <Badge
                className="bg-slate-100 text-slate-500"
                // Bolinha indica se o número está conectado no momento
                title={`Conexão: ${CONNECTION_STATUS_LABELS[conversation.instanceStatus ?? "disconnected"]}`}
              >
                <span
                  className="h-1.5 w-1.5 shrink-0 rounded-full"
                  style={{
                    backgroundColor:
                      CONNECTION_STATUS_COLORS[conversation.instanceStatus ?? "disconnected"],
                  }}
                />
                {conversation.instanceName}
              </Badge>
            )}
            {conversation.department && (
              <Badge color={conversation.department.color ?? "#64748b"}>
                {conversation.department.name}
              </Badge>
            )}
            {conversation.tags.slice(0, 2).map((tag) => (
              <Badge key={tag.id} color={tag.color}>
                {tag.name}
              </Badge>
            ))}
          </div>

          {/* Responsável sempre visível — inclusive quando ninguém assumiu.
              O cadastro da empresa divide a linha, alinhado à direita. */}
          {/* Só existe na visão de arquivadas — a lista padrão nunca as traz.
              Sem autor foi o arquivamento automático do número de backup. */}
          {conversation.archivedAt && (
            <p className="mt-1 flex items-center gap-1 text-[11px] text-slate-500">
              <Archive className="h-3 w-3 shrink-0 text-slate-400" />
              <span className="truncate">
                Arquivada {conversation.archivedBy ? `por ${conversation.archivedBy.name} ` : "automaticamente "}
                em {formatDateTime(conversation.archivedAt)}
              </span>
            </p>
          )}

          <p className="mt-1 flex items-center gap-1 text-[11px]">
            <UserRound className="h-3 w-3 shrink-0 text-slate-400" />
            {conversation.assignedUser ? (
              <span className="truncate text-slate-600">{conversation.assignedUser.name}</span>
            ) : conversation.assignedToAll ? (
              /* Coletivo por decisão: ocupa o lugar do responsável, mas com
                 estilo próprio para ninguém ler "@todos" como nome de gente —
                 e para não se confundir com o âmbar de quem está sem dono. */
              <span className="shrink-0 rounded bg-indigo-50 px-1.5 py-0.5 text-[10px] font-bold text-indigo-700">
                {ALL_USERS_ASSIGNEE_LABEL}
              </span>
            ) : (
              <span className="truncate font-medium text-amber-600">Sem responsável</span>
            )}
            {/* Vínculo com o Azevedo-OS guarda o identificador da empresa no
                mesmo campo. Ele é interno: como chip viraria um punhado de
                caracteres sem significado no lugar do código do cadastro.
                Quem mostra a empresa é o card do painel de contexto. */}
            {conversation.externalReference && conversation.externalSource !== AZEVEDO_OS_SOURCE && (
              <span className="ml-auto shrink-0 rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-amber-800">
                {conversation.externalReference}
              </span>
            )}
          </p>
        </div>
      </div>
    </button>
  );
}

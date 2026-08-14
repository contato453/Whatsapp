"use client";

import { Users2, User } from "lucide-react";
import { cn, formatTime } from "@/lib/utils";
import type { ConversationDto } from "@/lib/types";
import { Badge } from "@/components/ui";
import { ConversationAvatar } from "./conversation-avatar";

const STATUS_COLORS: Record<ConversationDto["status"], string> = {
  new: "#0891b2",
  open: "#16a34a",
  waiting: "#d97706",
  resolved: "#64748b",
  archived: "#94a3b8",
};

const STATUS_LABELS: Record<ConversationDto["status"], string> = {
  new: "Nova",
  open: "Aberta",
  waiting: "Aguardando",
  resolved: "Finalizada",
  archived: "Arquivada",
};

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
            <Badge color={STATUS_COLORS[conversation.status]}>{STATUS_LABELS[conversation.status]}</Badge>
            {conversation.instanceName && (
              <Badge className="bg-slate-100 text-slate-500">{conversation.instanceName}</Badge>
            )}
            {conversation.department && (
              <Badge color={conversation.department.color ?? "#64748b"}>
                {conversation.department.name}
              </Badge>
            )}
            {conversation.assignedUser && (
              <Badge className="bg-slate-100 text-slate-600">
                {conversation.assignedUser.name.split(" ")[0]}
              </Badge>
            )}
            {conversation.tags.slice(0, 2).map((tag) => (
              <Badge key={tag.id} color={tag.color}>
                {tag.name}
              </Badge>
            ))}
          </div>
        </div>
      </div>
    </button>
  );
}

export { STATUS_LABELS as CONVERSATION_STATUS_LABELS, STATUS_COLORS as CONVERSATION_STATUS_COLORS };

"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  Inbox as InboxIcon,
  Info,
  Paperclip,
  Search,
  Send,
  Users2,
  Zap,
} from "lucide-react";
import { RealtimeEvents } from "@zapdesk/shared";
import { api } from "@/lib/api";
import { useSocket } from "@/lib/socket-context";
import { useAuth } from "@/lib/auth-context";
import { cn } from "@/lib/utils";
import type {
  ConversationDetailDto,
  ConversationDto,
  DepartmentDto,
  InstanceDto,
  MessageDto,
  QuickReplyDto,
  TagDto,
  UserDto,
} from "@/lib/types";
import { Button, EmptyState, Input, Spinner, Textarea } from "@/components/ui";
import { ConversationListItem } from "./conversation-list";
import { ConversationAvatar } from "./conversation-avatar";
import { MessageBubble } from "./message-bubble";
import { ContextPanel } from "./context-panel";

type QuickFilter =
  | "all"
  | "mine"
  | "unassigned"
  | "groups"
  | "individual"
  | "unread"
  | "open"
  | "waiting"
  | "resolved";

const QUICK_FILTERS: Array<{ key: QuickFilter; label: string }> = [
  { key: "all", label: "Todas" },
  { key: "mine", label: "Minhas" },
  { key: "unassigned", label: "Sem responsável" },
  { key: "groups", label: "Grupos" },
  { key: "individual", label: "Individuais" },
  { key: "unread", label: "Não lidas" },
  { key: "open", label: "Abertas" },
  { key: "waiting", label: "Aguardando" },
  { key: "resolved", label: "Finalizadas" },
];

export function InboxShell({ conversationId }: { conversationId?: string }) {
  const router = useRouter();
  const socket = useSocket();
  const { user: me } = useAuth();

  const [conversations, setConversations] = useState<ConversationDto[] | null>(null);
  const [filter, setFilter] = useState<QuickFilter>("all");
  const [departmentFilter, setDepartmentFilter] = useState("");
  const [instanceFilter, setInstanceFilter] = useState("");
  const [tagFilter, setTagFilter] = useState("");
  const [searchTerm, setSearchTerm] = useState("");

  const [detail, setDetail] = useState<ConversationDetailDto | null>(null);
  const [messages, setMessages] = useState<MessageDto[] | null>(null);
  const [showPanel, setShowPanel] = useState(true);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);

  const [users, setUsers] = useState<UserDto[]>([]);
  const [departments, setDepartments] = useState<DepartmentDto[]>([]);
  const [tags, setTags] = useState<TagDto[]>([]);
  const [instances, setInstances] = useState<InstanceDto[]>([]);
  const [quickReplies, setQuickReplies] = useState<QuickReplyDto[]>([]);
  const [quickReplyIndex, setQuickReplyIndex] = useState(0);
  const [quickReplyDismissed, setQuickReplyDismissed] = useState(false);

  const bottomRef = useRef<HTMLDivElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // ---------- Carregamento de dados auxiliares ----------
  useEffect(() => {
    api.get<{ users: UserDto[] }>("/users").then((data) => setUsers(data.users)).catch(() => undefined);
    api.get<{ departments: DepartmentDto[] }>("/departments").then((data) => setDepartments(data.departments)).catch(() => undefined);
    api.get<{ tags: TagDto[] }>("/tags").then((data) => setTags(data.tags)).catch(() => undefined);
    api.get<{ instances: InstanceDto[] }>("/whatsapp-instances").then((data) => setInstances(data.instances)).catch(() => undefined);
    api.get<{ quickReplies: QuickReplyDto[] }>("/quick-replies").then((data) => setQuickReplies(data.quickReplies)).catch(() => undefined);
  }, []);

  // ---------- Lista de conversas ----------
  const loadConversations = useCallback(() => {
    const params = new URLSearchParams();
    if (filter === "mine") params.set("assigned", "me");
    if (filter === "unassigned") params.set("assigned", "none");
    if (filter === "groups") params.set("type", "group");
    if (filter === "individual") params.set("type", "individual");
    if (filter === "unread") params.set("unread", "true");
    if (filter === "open") params.set("status", "open");
    if (filter === "waiting") params.set("status", "waiting");
    if (filter === "resolved") params.set("status", "resolved");
    if (departmentFilter) params.set("departmentId", departmentFilter);
    if (instanceFilter) params.set("instanceId", instanceFilter);
    if (tagFilter) params.set("tagId", tagFilter);
    if (searchTerm.trim().length >= 2) params.set("q", searchTerm.trim());
    params.set("limit", "80");
    api
      .get<{ conversations: ConversationDto[] }>(`/conversations?${params.toString()}`)
      .then((data) => setConversations(data.conversations))
      .catch(() => undefined);
  }, [filter, departmentFilter, instanceFilter, tagFilter, searchTerm]);

  useEffect(() => {
    const timer = setTimeout(loadConversations, searchTerm ? 300 : 0);
    return () => clearTimeout(timer);
  }, [loadConversations, searchTerm]);

  // ---------- Conversa selecionada ----------
  const loadDetail = useCallback(() => {
    if (!conversationId) return;
    api
      .get<ConversationDetailDto>(`/conversations/${conversationId}`)
      .then(setDetail)
      .catch(() => setDetail(null));
  }, [conversationId]);

  useEffect(() => {
    setDetail(null);
    setMessages(null);
    if (!conversationId) return;
    loadDetail();
    api
      .get<{ messages: MessageDto[] }>(`/conversations/${conversationId}/messages?limit=60`)
      .then((data) => setMessages(data.messages))
      .catch(() => setMessages([]));
    void api.post(`/conversations/${conversationId}/read`).catch(() => undefined);
  }, [conversationId, loadDetail]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "auto" });
  }, [messages?.length]);

  // ---------- Tempo real ----------
  useEffect(() => {
    if (!socket) return;
    const onMessageNew = (payload: { conversation: ConversationDto; message: MessageDto }) => {
      setConversations((current) => {
        if (!current) return current;
        const rest = current.filter((conversation) => conversation.id !== payload.conversation.id);
        return [payload.conversation, ...rest];
      });
      if (payload.message.conversationId === conversationId) {
        setMessages((current) => {
          if (!current) return current;
          if (current.some((message) => message.id === payload.message.id)) return current;
          return [...current, payload.message];
        });
        void api.post(`/conversations/${conversationId}/read`).catch(() => undefined);
      }
    };
    const onConversationUpdated = (payload: ConversationDto) => {
      setConversations((current) =>
        current?.map((conversation) => (conversation.id === payload.id ? payload : conversation)) ?? null,
      );
      if (payload.id === conversationId) {
        setDetail((current) => (current ? { ...current, conversation: payload } : current));
      }
    };
    const onMessageStatus = (payload: { conversationId: string; messageId: string; status: MessageDto["status"] }) => {
      if (payload.conversationId !== conversationId) return;
      setMessages((current) =>
        current?.map((message) =>
          message.id === payload.messageId ? { ...message, status: payload.status } : message,
        ) ?? null,
      );
    };
    // Fotos dos participantes chegaram: recarrega o painel de contexto.
    const onGroupParticipants = (payload: { conversationId: string }) => {
      if (payload.conversationId === conversationId) {
        loadDetail();
      }
    };
    socket.on(RealtimeEvents.MessageNew, onMessageNew);
    socket.on(RealtimeEvents.ConversationUpdated, onConversationUpdated);
    socket.on(RealtimeEvents.MessageStatus, onMessageStatus);
    socket.on(RealtimeEvents.GroupParticipants, onGroupParticipants);
    return () => {
      socket.off(RealtimeEvents.MessageNew, onMessageNew);
      socket.off(RealtimeEvents.ConversationUpdated, onConversationUpdated);
      socket.off(RealtimeEvents.MessageStatus, onMessageStatus);
      socket.off(RealtimeEvents.GroupParticipants, onGroupParticipants);
    };
  }, [socket, conversationId, loadDetail]);

  // ---------- Envio ----------
  async function sendText() {
    if (!conversationId || draft.trim().length === 0 || sending) return;
    setSending(true);
    const content = draft.trim();
    setDraft("");
    try {
      const result = await api.post<{ message: MessageDto }>(
        `/conversations/${conversationId}/messages`,
        { content },
      );
      setMessages((current) => {
        if (!current) return [result.message];
        if (current.some((message) => message.id === result.message.id)) return current;
        return [...current, result.message];
      });
    } catch (err) {
      setDraft(content);
      window.alert(err instanceof Error ? err.message : "Falha ao enviar mensagem");
    } finally {
      setSending(false);
    }
  }

  async function sendFile(file: File) {
    if (!conversationId || sending) return;
    setSending(true);
    try {
      const form = new FormData();
      form.append("file", file);
      const result = await api.postForm<{ message: MessageDto }>(
        `/conversations/${conversationId}/messages/media`,
        form,
      );
      setMessages((current) => {
        if (!current) return [result.message];
        if (current.some((message) => message.id === result.message.id)) return current;
        return [...current, result.message];
      });
    } catch (err) {
      window.alert(err instanceof Error ? err.message : "Falha ao enviar arquivo");
    } finally {
      setSending(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }

  const conversation = detail?.conversation;
  const isGroup = conversation?.type === "group";

  // ---------- Respostas rápidas (atalho "/") ----------
  const slashQuery =
    draft.startsWith("/") && !draft.includes("\n") ? draft.slice(1).toLowerCase() : null;
  const quickReplyMatches = useMemo(() => {
    if (slashQuery === null || quickReplyDismissed) return [];
    return quickReplies
      .filter(
        (reply) =>
          reply.shortcut.startsWith(slashQuery) ||
          (reply.title ?? "").toLowerCase().includes(slashQuery) ||
          reply.content.toLowerCase().includes(slashQuery),
      )
      .slice(0, 8);
  }, [slashQuery, quickReplies, quickReplyDismissed]);
  const quickReplyOpen = quickReplyMatches.length > 0;

  useEffect(() => {
    setQuickReplyIndex(0);
  }, [slashQuery]);

  useEffect(() => {
    if (slashQuery === null) setQuickReplyDismissed(false);
  }, [slashQuery]);

  function applyQuickReply(reply: QuickReplyDto) {
    setDraft(reply.content);
    setQuickReplyDismissed(true);
  }

  const groupedMessages = useMemo(() => {
    if (!messages) return [];
    return messages.map((message, index) => {
      const previous = messages[index - 1];
      const showSender =
        !previous ||
        previous.senderExternalId !== message.senderExternalId ||
        previous.direction !== message.direction;
      return { message, showSender };
    });
  }, [messages]);

  return (
    <div className="flex h-full">
      {/* Coluna esquerda: lista */}
      <div className="flex w-80 shrink-0 flex-col border-r border-slate-200 bg-white xl:w-96">
        <div className="space-y-2 border-b border-slate-200 p-3">
          <div className="relative">
            <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-slate-400" />
            <Input
              className="pl-8"
              placeholder="Buscar conversa, grupo, cliente..."
              value={searchTerm}
              onChange={(event) => setSearchTerm(event.target.value)}
            />
          </div>
          <div className="thin-scroll flex gap-1 overflow-x-auto pb-1">
            {QUICK_FILTERS.map((entry) => (
              <button
                key={entry.key}
                onClick={() => setFilter(entry.key)}
                className={cn(
                  "shrink-0 rounded-full px-2.5 py-1 text-[11px] font-medium transition-colors",
                  filter === entry.key
                    ? "bg-brand-600 text-white"
                    : "bg-slate-100 text-slate-600 hover:bg-slate-200",
                )}
              >
                {entry.label}
              </button>
            ))}
          </div>
          <div className="grid grid-cols-3 gap-1.5">
            <select
              className="rounded-lg border border-slate-200 px-1.5 py-1 text-[11px] text-slate-600"
              value={instanceFilter}
              onChange={(event) => setInstanceFilter(event.target.value)}
            >
              <option value="">WhatsApp</option>
              {instances.map((instance) => (
                <option key={instance.id} value={instance.id}>
                  {instance.name}
                </option>
              ))}
            </select>
            <select
              className="rounded-lg border border-slate-200 px-1.5 py-1 text-[11px] text-slate-600"
              value={departmentFilter}
              onChange={(event) => setDepartmentFilter(event.target.value)}
            >
              <option value="">Depto</option>
              {departments.map((department) => (
                <option key={department.id} value={department.id}>
                  {department.name}
                </option>
              ))}
            </select>
            <select
              className="rounded-lg border border-slate-200 px-1.5 py-1 text-[11px] text-slate-600"
              value={tagFilter}
              onChange={(event) => setTagFilter(event.target.value)}
            >
              <option value="">Etiqueta</option>
              {tags.map((tag) => (
                <option key={tag.id} value={tag.id}>
                  {tag.name}
                </option>
              ))}
            </select>
          </div>
        </div>
        <div className="thin-scroll flex-1 overflow-y-auto">
          {!conversations ? (
            <div className="flex justify-center py-10">
              <Spinner />
            </div>
          ) : conversations.length === 0 ? (
            <EmptyState
              icon={<InboxIcon className="h-10 w-10" />}
              title="Nenhuma conversa encontrada"
              description="Conecte um WhatsApp e as conversas aparecerão aqui automaticamente."
            />
          ) : (
            conversations.map((entry) => (
              <ConversationListItem
                key={entry.id}
                conversation={entry}
                active={entry.id === conversationId}
                onClick={() => router.push(`/inbox/${entry.id}`)}
              />
            ))
          )}
        </div>
      </div>

      {/* Centro: chat */}
      <div className="flex min-w-0 flex-1 flex-col bg-slate-100">
        {!conversationId ? (
          <EmptyState
            icon={<InboxIcon className="h-14 w-14" />}
            title="Selecione uma conversa"
            description="Escolha um grupo ou contato na lista ao lado para visualizar o histórico."
          />
        ) : !conversation ? (
          <div className="flex flex-1 items-center justify-center">
            <Spinner className="h-8 w-8" />
          </div>
        ) : (
          <>
            <header className="flex items-center justify-between border-b border-slate-200 bg-white px-4 py-3">
              <div className="flex min-w-0 items-center gap-2.5">
                <ConversationAvatar
                  conversationId={conversation.id}
                  name={conversation.title}
                  hasAvatar={conversation.hasAvatar}
                  size="sm"
                />
                {isGroup && <Users2 className="h-4 w-4 shrink-0 text-slate-400" />}
                <div className="min-w-0">
                  <h2 className="truncate text-sm font-semibold text-slate-900">{conversation.title}</h2>
                  <p className="truncate text-[11px] text-slate-400">
                    {isGroup
                      ? `${detail?.group?.participantCount ?? "..."} participantes · via ${conversation.instanceName ?? "—"}`
                      : `via ${conversation.instanceName ?? "—"}`}
                  </p>
                </div>
              </div>
              <Button size="sm" variant="ghost" onClick={() => setShowPanel((value) => !value)}>
                <Info className="h-4 w-4" />
              </Button>
            </header>

            <div className="thin-scroll flex-1 space-y-2 overflow-y-auto px-4 py-4">
              {!messages ? (
                <div className="flex justify-center py-10">
                  <Spinner />
                </div>
              ) : messages.length === 0 ? (
                <EmptyState title="Sem mensagens ainda" description="As novas mensagens deste chat aparecerão aqui em tempo real." />
              ) : (
                groupedMessages.map(({ message, showSender }) => (
                  <MessageBubble
                    key={message.id}
                    message={message}
                    isGroup={isGroup ?? false}
                    showSender={showSender}
                  />
                ))
              )}
              <div ref={bottomRef} />
            </div>

            <footer className="relative border-t border-slate-200 bg-white p-3">
              {quickReplyOpen && (
                <div className="absolute bottom-full left-3 right-3 z-20 mb-1 max-h-72 overflow-y-auto rounded-xl border border-slate-200 bg-white shadow-lg">
                  <p className="flex items-center gap-1.5 border-b border-slate-100 px-3 py-2 text-[11px] font-semibold uppercase tracking-wide text-slate-400">
                    <Zap className="h-3 w-3" /> Respostas rápidas — Enter insere, Esc fecha
                  </p>
                  {quickReplyMatches.map((reply, index) => (
                    <button
                      key={reply.id}
                      onMouseDown={(event) => {
                        event.preventDefault();
                        applyQuickReply(reply);
                      }}
                      onMouseEnter={() => setQuickReplyIndex(index)}
                      className={cn(
                        "block w-full px-3 py-2 text-left",
                        index === quickReplyIndex ? "bg-brand-50" : "hover:bg-slate-50",
                      )}
                    >
                      <p className="text-xs font-semibold text-brand-700">
                        /{reply.shortcut}
                        {reply.title && (
                          <span className="ml-2 font-normal text-slate-500">{reply.title}</span>
                        )}
                      </p>
                      <p className="truncate text-xs text-slate-500">{reply.content}</p>
                    </button>
                  ))}
                </div>
              )}
              <div className="flex items-end gap-2">
                <input
                  ref={fileInputRef}
                  type="file"
                  hidden
                  onChange={(event) => {
                    const file = event.target.files?.[0];
                    if (file) void sendFile(file);
                  }}
                />
                <Button
                  variant="ghost"
                  size="sm"
                  className="mb-1"
                  title="Enviar arquivo"
                  disabled={sending}
                  onClick={() => fileInputRef.current?.click()}
                >
                  <Paperclip className="h-4 w-4" />
                </Button>
                <Textarea
                  rows={1}
                  value={draft}
                  disabled={sending}
                  onChange={(event) => setDraft(event.target.value)}
                  onKeyDown={(event) => {
                    if (quickReplyOpen) {
                      if (event.key === "ArrowDown") {
                        event.preventDefault();
                        setQuickReplyIndex((index) => (index + 1) % quickReplyMatches.length);
                        return;
                      }
                      if (event.key === "ArrowUp") {
                        event.preventDefault();
                        setQuickReplyIndex(
                          (index) => (index - 1 + quickReplyMatches.length) % quickReplyMatches.length,
                        );
                        return;
                      }
                      if (event.key === "Enter" || event.key === "Tab") {
                        event.preventDefault();
                        const selected = quickReplyMatches[quickReplyIndex];
                        if (selected) applyQuickReply(selected);
                        return;
                      }
                      if (event.key === "Escape") {
                        event.preventDefault();
                        setQuickReplyDismissed(true);
                        return;
                      }
                    }
                    if (event.key === "Enter" && !event.shiftKey) {
                      event.preventDefault();
                      void sendText();
                    }
                  }}
                  placeholder={`Mensagem para ${conversation.title}... ("/" para respostas rápidas, Enter envia)`}
                  className="max-h-32 min-h-[40px] resize-none"
                />
                <Button
                  className="mb-0.5"
                  disabled={sending || draft.trim().length === 0}
                  onClick={() => void sendText()}
                  title="Enviar"
                >
                  <Send className="h-4 w-4" />
                </Button>
              </div>
              {me && conversation.assignedUser && conversation.assignedUser.id !== me.id && (
                <p className="mt-1.5 text-[11px] text-amber-600">
                  Atendimento atribuído a {conversation.assignedUser.name}.
                </p>
              )}
            </footer>
          </>
        )}
      </div>

      {/* Coluna direita: contexto */}
      {conversationId && detail && showPanel && (
        <div className="hidden w-80 shrink-0 border-l border-slate-200 bg-white lg:block">
          <ContextPanel
            detail={detail}
            users={users}
            departments={departments}
            tags={tags}
            onChanged={loadDetail}
          />
        </div>
      )}
    </div>
  );
}

"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  CornerUpLeft,
  Forward,
  History,
  Inbox as InboxIcon,
  Info,
  Paperclip,
  Search,
  Send,
  StickyNote,
  Users2,
  X,
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
  NoteDto,
  QuickReplyDto,
  TagDto,
  UserDto,
} from "@/lib/types";
import { Button, EmptyState, Input, Modal, Spinner, Textarea } from "@/components/ui";
import { ConversationListItem } from "./conversation-list";
import { ConversationAvatar } from "./conversation-avatar";
import { AudioRecorder } from "./audio-recorder";

/** Nota interna exibida dentro da conversa — nunca vai para o WhatsApp. */
function InternalNoteItem({ note }: { note: NoteDto }) {
  return (
    <div className="flex justify-center py-1">
      <div className="max-w-[80%] rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 shadow-sm">
        <p className="mb-0.5 flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide text-amber-700">
          <StickyNote className="h-3 w-3" /> Nota interna
        </p>
        <p className="whitespace-pre-wrap break-words text-sm text-slate-700">{note.content}</p>
        <p className="mt-1 text-[10px] text-amber-600/80">
          {note.user?.name ?? "—"} ·{" "}
          {new Date(note.createdAt).toLocaleString("pt-BR", {
            day: "2-digit",
            month: "2-digit",
            hour: "2-digit",
            minute: "2-digit",
          })}
        </p>
      </div>
    </div>
  );
}
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
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [showPanel, setShowPanel] = useState(true);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  /** "message" envia ao WhatsApp; "note" grava nota interna da equipe. */
  const [composerMode, setComposerMode] = useState<"message" | "note">("message");
  const [replyTo, setReplyTo] = useState<MessageDto | null>(null);
  const [forwarding, setForwarding] = useState<MessageDto | null>(null);
  const [forwardSearch, setForwardSearch] = useState("");

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
    setReplyTo(null);
    setComposerMode("message");
    if (!conversationId) return;
    loadDetail();
    api
      .get<{ messages: MessageDto[]; hasMore: boolean }>(
        `/conversations/${conversationId}/messages?limit=60`,
      )
      .then((data) => {
        setMessages(data.messages);
        setHasMore(data.hasMore);
      })
      .catch(() => setMessages([]));
    void api.post(`/conversations/${conversationId}/read`).catch(() => undefined);
  }, [conversationId, loadDetail]);

  /** Carrega o trecho anterior do histórico (paginação para trás). */
  async function loadOlderMessages() {
    if (!conversationId || !messages?.length || loadingMore) return;
    setLoadingMore(true);
    try {
      const oldest = messages[0];
      if (!oldest) return;
      const data = await api.get<{ messages: MessageDto[]; hasMore: boolean }>(
        `/conversations/${conversationId}/messages?limit=60&before=${encodeURIComponent(oldest.timestamp)}`,
      );
      setMessages((current) => [...data.messages, ...(current ?? [])]);
      setHasMore(data.hasMore);
    } finally {
      setLoadingMore(false);
    }
  }

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
    const onReaction = (payload: {
      conversationId: string;
      messageId: string;
      reactions: MessageDto["reactions"];
    }) => {
      if (payload.conversationId !== conversationId) return;
      setMessages((current) =>
        current?.map((message) =>
          message.id === payload.messageId ? { ...message, reactions: payload.reactions } : message,
        ) ?? null,
      );
    };
    // Mensagem editada ou apagada (por nós, por outro atendente ou pelo cliente)
    const onMessageUpdated = (payload: MessageDto) => {
      if (payload.conversationId !== conversationId) return;
      setMessages((current) =>
        current?.map((message) => (message.id === payload.id ? payload : message)) ?? null,
      );
    };
    const onNote = (payload: NoteDto & { conversationId?: string }) => {
      if (payload.conversationId !== conversationId) return;
      setDetail((current) =>
        current
          ? {
              ...current,
              notes: current.notes.some((note) => note.id === payload.id)
                ? current.notes
                : [payload, ...current.notes],
            }
          : current,
      );
    };
    socket.on(RealtimeEvents.MessageNew, onMessageNew);
    socket.on(RealtimeEvents.ConversationUpdated, onConversationUpdated);
    socket.on(RealtimeEvents.MessageStatus, onMessageStatus);
    socket.on(RealtimeEvents.GroupParticipants, onGroupParticipants);
    socket.on(RealtimeEvents.MessageReaction, onReaction);
    socket.on(RealtimeEvents.MessageUpdated, onMessageUpdated);
    socket.on(RealtimeEvents.InternalNote, onNote);
    return () => {
      socket.off(RealtimeEvents.MessageNew, onMessageNew);
      socket.off(RealtimeEvents.ConversationUpdated, onConversationUpdated);
      socket.off(RealtimeEvents.MessageStatus, onMessageStatus);
      socket.off(RealtimeEvents.GroupParticipants, onGroupParticipants);
      socket.off(RealtimeEvents.MessageReaction, onReaction);
      socket.off(RealtimeEvents.MessageUpdated, onMessageUpdated);
      socket.off(RealtimeEvents.InternalNote, onNote);
    };
  }, [socket, conversationId, loadDetail]);

  // ---------- Envio ----------
  async function sendText() {
    if (!conversationId || draft.trim().length === 0 || sending) return;
    setSending(true);
    const content = draft.trim();
    setDraft("");

    // Modo nota interna: grava sem enviar nada ao WhatsApp.
    if (composerMode === "note") {
      try {
        await api.post(`/conversations/${conversationId}/notes`, { content });
        loadDetail();
      } catch (err) {
        setDraft(content);
        window.alert(err instanceof Error ? err.message : "Falha ao salvar nota");
      } finally {
        setSending(false);
      }
      return;
    }

    const replyId = replyTo?.id;
    setReplyTo(null);
    try {
      const result = await api.post<{ message: MessageDto }>(
        `/conversations/${conversationId}/messages`,
        { content, ...(replyId ? { replyToMessageId: replyId } : {}) },
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

  async function handleReact(message: MessageDto, emoji: string) {
    // Atualização otimista: a confirmação chega pelo WebSocket.
    setMessages((current) =>
      current?.map((entry) =>
        entry.id === message.id
          ? {
              ...entry,
              reactions: emoji
                ? [
                    ...entry.reactions.filter((reaction) => !reaction.fromMe),
                    { emoji, senderName: me?.name ?? null, fromMe: true },
                  ]
                : entry.reactions.filter((reaction) => !reaction.fromMe),
            }
          : entry,
      ) ?? null,
    );
    try {
      await api.post(`/messages/${message.id}/reactions`, { emoji });
    } catch (err) {
      window.alert(err instanceof Error ? err.message : "Falha ao reagir");
      loadDetail();
    }
  }

  async function handleEdit(message: MessageDto) {
    const next = window.prompt("Editar mensagem:", message.content ?? "");
    if (next === null) return;
    const content = next.trim();
    if (!content || content === message.content) return;
    try {
      const result = await api.patch<{ message: MessageDto }>(`/messages/${message.id}`, {
        content,
      });
      setMessages((current) =>
        current?.map((entry) => (entry.id === message.id ? result.message : entry)) ?? null,
      );
    } catch (err) {
      window.alert(err instanceof Error ? err.message : "Falha ao editar mensagem");
    }
  }

  async function handleDelete(message: MessageDto) {
    if (!window.confirm("Apagar esta mensagem para todos? Não é possível desfazer.")) return;
    try {
      await api.delete(`/messages/${message.id}`);
      setMessages((current) =>
        current?.map((entry) =>
          entry.id === message.id
            ? { ...entry, deletedAt: new Date().toISOString(), content: null }
            : entry,
        ) ?? null,
      );
    } catch (err) {
      window.alert(err instanceof Error ? err.message : "Falha ao apagar mensagem");
    }
  }

  /** Envia um áudio gravado no navegador como mensagem de voz. */
  async function sendVoiceNote(file: File) {
    if (!conversationId) return;
    setSending(true);
    try {
      const form = new FormData();
      form.append("asVoiceNote", "true");
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
      window.alert(err instanceof Error ? err.message : "Falha ao enviar áudio");
    } finally {
      setSending(false);
    }
  }

  async function handleForward(targetConversationId: string) {
    if (!forwarding) return;
    const message = forwarding;
    setForwarding(null);
    setForwardSearch("");
    try {
      await api.post(`/messages/${message.id}/forward`, {
        conversationId: targetConversationId,
      });
    } catch (err) {
      window.alert(err instanceof Error ? err.message : "Falha ao encaminhar");
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

  /**
   * Linha do tempo: mensagens do WhatsApp e notas internas da equipe
   * intercaladas por horário. As notas nunca são enviadas ao cliente.
   */
  const timeline = useMemo(() => {
    if (!messages) return [];
    const items: Array<
      | { kind: "message"; at: number; message: MessageDto; showSender: boolean }
      | { kind: "note"; at: number; note: NoteDto }
    > = messages.map((message, index) => {
      const previous = messages[index - 1];
      const showSender =
        !previous ||
        previous.senderExternalId !== message.senderExternalId ||
        previous.direction !== message.direction;
      return {
        kind: "message" as const,
        at: new Date(message.timestamp).getTime(),
        message,
        showSender,
      };
    });

    const oldest = items[0]?.at ?? 0;
    for (const note of detail?.notes ?? []) {
      const at = new Date(note.createdAt).getTime();
      // Só intercala notas dentro do trecho de histórico carregado.
      if (at >= oldest) {
        items.push({ kind: "note" as const, at, note });
      }
    }
    return items.sort((a, b) => a.at - b.at);
  }, [messages, detail?.notes]);

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
              {hasMore && messages && messages.length > 0 && (
                <div className="flex justify-center pb-2">
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={loadingMore}
                    onClick={() => void loadOlderMessages()}
                  >
                    <History className="h-3.5 w-3.5" />
                    {loadingMore ? "Carregando..." : "Carregar mensagens anteriores"}
                  </Button>
                </div>
              )}
              {!messages ? (
                <div className="flex justify-center py-10">
                  <Spinner />
                </div>
              ) : timeline.length === 0 ? (
                <EmptyState title="Sem mensagens ainda" description="As novas mensagens deste chat aparecerão aqui em tempo real." />
              ) : (
                timeline.map((item) =>
                  item.kind === "message" ? (
                    <MessageBubble
                      key={item.message.id}
                      message={item.message}
                      isGroup={isGroup ?? false}
                      showSender={item.showSender}
                      onReact={(message, emoji) => void handleReact(message, emoji)}
                      onReply={(message) => {
                        setReplyTo(message);
                        setComposerMode("message");
                      }}
                      onForward={(message) => setForwarding(message)}
                      onEdit={(message) => void handleEdit(message)}
                      onDelete={(message) => void handleDelete(message)}
                    />
                  ) : (
                    <InternalNoteItem key={`note-${item.note.id}`} note={item.note} />
                  ),
                )
              )}
              <div ref={bottomRef} />
            </div>

            <footer
              className={cn(
                "relative border-t p-3 transition-colors",
                composerMode === "note"
                  ? "border-amber-300 bg-amber-50"
                  : "border-slate-200 bg-white",
              )}
            >
              {/* Alternância entre resposta ao cliente e nota interna */}
              <div className="mb-2 flex items-center gap-1">
                <button
                  onClick={() => setComposerMode("message")}
                  className={cn(
                    "rounded-full px-2.5 py-1 text-[11px] font-medium transition-colors",
                    composerMode === "message"
                      ? "bg-brand-600 text-white"
                      : "bg-slate-100 text-slate-600 hover:bg-slate-200",
                  )}
                >
                  Responder ao cliente
                </button>
                <button
                  onClick={() => {
                    setComposerMode("note");
                    setReplyTo(null);
                  }}
                  className={cn(
                    "flex items-center gap-1 rounded-full px-2.5 py-1 text-[11px] font-medium transition-colors",
                    composerMode === "note"
                      ? "bg-amber-500 text-white"
                      : "bg-slate-100 text-slate-600 hover:bg-slate-200",
                  )}
                >
                  <StickyNote className="h-3 w-3" /> Nota interna
                </button>
                {composerMode === "note" && (
                  <span className="ml-1 text-[11px] text-amber-700">
                    Visível só para a equipe — não vai para o WhatsApp
                  </span>
                )}
              </div>

              {/* Mensagem sendo respondida */}
              {replyTo && composerMode === "message" && (
                <div className="mb-2 flex items-start gap-2 rounded-lg border-l-2 border-brand-500 bg-slate-50 px-2.5 py-1.5">
                  <CornerUpLeft className="mt-0.5 h-3.5 w-3.5 shrink-0 text-brand-600" />
                  <div className="min-w-0 flex-1">
                    <p className="text-[11px] font-semibold text-slate-700">
                      Respondendo {replyTo.senderName ?? "mensagem"}
                    </p>
                    <p className="truncate text-xs text-slate-500">
                      {replyTo.content ?? `[${replyTo.type}]`}
                    </p>
                  </div>
                  <button
                    onClick={() => setReplyTo(null)}
                    className="rounded p-0.5 text-slate-400 hover:text-slate-600"
                    aria-label="Cancelar resposta"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>
              )}
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
                {composerMode === "message" && (
                  <>
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
                    <AudioRecorder disabled={sending} onSend={sendVoiceNote} />
                  </>
                )}
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
                  placeholder={
                    composerMode === "note"
                      ? "Anotação interna sobre este atendimento..."
                      : `Mensagem para ${conversation.title}... ("/" para respostas rápidas, Enter envia)`
                  }
                  className="max-h-32 min-h-[40px] resize-none"
                />
                <Button
                  className="mb-0.5"
                  variant={composerMode === "note" ? "secondary" : "primary"}
                  disabled={sending || draft.trim().length === 0}
                  onClick={() => void sendText()}
                  title={composerMode === "note" ? "Salvar nota" : "Enviar"}
                >
                  {composerMode === "note" ? (
                    <StickyNote className="h-4 w-4" />
                  ) : (
                    <Send className="h-4 w-4" />
                  )}
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

      {/* Encaminhar mensagem */}
      <Modal
        open={forwarding != null}
        onClose={() => {
          setForwarding(null);
          setForwardSearch("");
        }}
        title="Encaminhar mensagem"
      >
        <div className="space-y-3">
          <div className="rounded-lg bg-slate-50 p-2.5 text-xs text-slate-600">
            {forwarding?.content ?? `[${forwarding?.type}]`}
          </div>
          <Input
            placeholder="Buscar conversa ou grupo..."
            value={forwardSearch}
            onChange={(event) => setForwardSearch(event.target.value)}
            autoFocus
          />
          <div className="thin-scroll max-h-64 space-y-1 overflow-y-auto">
            {(conversations ?? [])
              .filter(
                (entry) =>
                  entry.id !== conversationId &&
                  entry.title.toLowerCase().includes(forwardSearch.toLowerCase()),
              )
              .slice(0, 30)
              .map((entry) => (
                <button
                  key={entry.id}
                  onClick={() => void handleForward(entry.id)}
                  className="flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left hover:bg-slate-50"
                >
                  <ConversationAvatar
                    conversationId={entry.id}
                    name={entry.title}
                    hasAvatar={entry.hasAvatar}
                    size="sm"
                  />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm text-slate-800">{entry.title}</p>
                    <p className="truncate text-[11px] text-slate-400">
                      {entry.type === "group" ? "Grupo" : "Contato"} · {entry.instanceName}
                    </p>
                  </div>
                  <Forward className="h-4 w-4 shrink-0 text-slate-300" />
                </button>
              ))}
          </div>
        </div>
      </Modal>

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

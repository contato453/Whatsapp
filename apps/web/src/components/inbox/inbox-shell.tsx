"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import {
  CalendarClock,
  CornerUpLeft,
  Forward,
  History,
  Inbox as InboxIcon,
  Info,
  Paperclip,
  Pencil,
  Search,
  Send,
  StickyNote,
  Trash2,
  Users2,
  X,
  Zap,
} from "lucide-react";
import {
  QUICK_REPLY_MEDIA_TYPE_LABELS,
  RealtimeEvents,
  type ScheduledPendingPayload,
} from "@azvchat/shared";
import { api, fetchQuickReplyMediaFile, quickRepliesApi } from "@/lib/api";
import { useSocket } from "@/lib/socket-context";
import { useAuth } from "@/lib/auth-context";
import { pruneDrafts, readDraft, saveDraft, type DraftMode } from "@/lib/drafts";
import { cn, formatDateTime, formatDayLabel } from "@/lib/utils";
import type {
  ConversationDetailDto,
  ConversationDto,
  DepartmentDto,
  InstanceDto,
  MessageDto,
  NoteDto,
  QuickReplyDto,
  TagDto,
  UserDirectoryDto,
} from "@/lib/types";
import { Avatar, Button, EmptyState, Input, Modal, Spinner, Textarea } from "@/components/ui";
import { appliesToConversation } from "@/components/department-picker";
import { ConversationListItem } from "./conversation-list";
import { ConversationAvatar, ParticipantAvatar } from "./conversation-avatar";
import { AudioRecorder } from "./audio-recorder";
import { ScheduleModal } from "./composer-modals";
import { MessageBubble } from "./message-bubble";
import { ContextPanel } from "./context-panel";
import { StatusSelect } from "./status-select";

/** Nota interna exibida dentro da conversa — nunca vai para o WhatsApp. */
function InternalNoteItem({
  note,
  canManage,
  onEdit,
  onDelete,
}: {
  note: NoteDto;
  canManage: boolean;
  onEdit: (note: NoteDto) => void;
  onDelete: (note: NoteDto) => void;
}) {
  return (
    <div className="group flex justify-center py-1">
      <div className="relative max-w-[80%] rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 shadow-sm">
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
        {canManage && (
          <div className="absolute right-1 top-1 flex gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
            <button
              onClick={() => onEdit(note)}
              title="Editar nota"
              className="rounded p-1 text-amber-600/70 hover:bg-amber-100 hover:text-amber-800"
            >
              <Pencil className="h-3 w-3" />
            </button>
            <button
              onClick={() => onDelete(note)}
              title="Apagar nota"
              className="rounded p-1 text-amber-600/70 hover:bg-red-50 hover:text-red-600"
            >
              <Trash2 className="h-3 w-3" />
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
type QuickFilter =
  | "all"
  | "mine"
  | "unassigned"
  | "groups"
  | "individual"
  | "unread"
  | "open"
  | "waiting_client"
  | "waiting_internal"
  | "resolved";

/**
 * Os filtros rápidos em grupos, para caber num seletor só — mesmo formato
 * dos filtros de número, departamento e etiqueta. Como só um vale por vez,
 * a fileira de chips não representava melhor o comportamento e ainda
 * empurrava metade das opções para fora da tela.
 */
const QUICK_FILTER_GROUPS: Array<{ label: string; options: Array<{ key: QuickFilter; label: string }> }> = [
  {
    label: "Atendimento",
    options: [
      { key: "mine", label: "Minhas" },
      { key: "unassigned", label: "Sem responsável" },
      { key: "unread", label: "Não lidas" },
    ],
  },
  {
    label: "Tipo",
    options: [
      { key: "groups", label: "Grupos" },
      { key: "individual", label: "Individuais" },
    ],
  },
  {
    label: "Status",
    options: [
      { key: "open", label: "Aberto" },
      { key: "waiting_client", label: "AG. Cliente" },
      { key: "waiting_internal", label: "AG. Operacional" },
      { key: "resolved", label: "Concluído" },
    ],
  },
];

/**
 * Estilo dos seletores de filtro. Com valor escolhido o campo fica marcado,
 * para a pessoa perceber de relance que a lista está filtrada — sem isso, um
 * filtro esquecido parece inbox vazia.
 */
function filterSelectClass(ativo: boolean): string {
  return cn(
    "rounded-lg border px-1.5 py-1 text-[11px]",
    ativo ? "border-brand-500 font-medium text-brand-700" : "border-slate-200 text-slate-600",
  );
}

/** Status que a Inbox aceita receber pela URL — os mesmos do atendimento. */
const STATUS_QUICK_FILTERS: QuickFilter[] = [
  "open",
  "waiting_client",
  "waiting_internal",
  "resolved",
];

function isStatusQuickFilter(value: string | null): value is QuickFilter {
  return value !== null && (STATUS_QUICK_FILTERS as string[]).includes(value);
}

export function InboxShell({ conversationId }: { conversationId?: string }) {
  const router = useRouter();
  const searchParams = useSearchParams();
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
  const [scheduleOpen, setScheduleOpen] = useState(false);
  /**
   * Agendamentos ainda por sair da conversa aberta (badge no ícone de
   * agendar). Fica fora de `detail` porque o evento de conversa não carrega
   * esse número e sobrescreveria o valor; aqui ele é sempre da conversa atual.
   */
  const [scheduledPending, setScheduledPending] = useState(0);
  // Busca dentro da conversa aberta
  const [chatSearchOpen, setChatSearchOpen] = useState(false);
  const [chatSearch, setChatSearch] = useState("");
  const [chatResults, setChatResults] = useState<MessageDto[] | null>(null);
  const [highlightId, setHighlightId] = useState<string | null>(null);

  const [users, setUsers] = useState<UserDirectoryDto[]>([]);
  const [departments, setDepartments] = useState<DepartmentDto[]>([]);
  const [tags, setTags] = useState<TagDto[]>([]);
  const [instances, setInstances] = useState<InstanceDto[]>([]);
  const [quickReplies, setQuickReplies] = useState<QuickReplyDto[]>([]);
  const [quickReplyIndex, setQuickReplyIndex] = useState(0);
  const [quickReplyDismissed, setQuickReplyDismissed] = useState(false);
  /**
   * Resposta rápida com mídia escolhida no "/": fica como anexo pendente no
   * composer — a pessoa confere (e pode remover) antes de enviar. O binário
   * só é baixado na hora do envio.
   */
  const [quickReplyMedia, setQuickReplyMedia] = useState<QuickReplyDto | null>(null);

  /** Supervisor e admin enxergam vários números/departamentos; usuário, não. */
  const canFilterScope = me?.role === "admin" || me?.role === "supervisor";

  /**
   * Filtro vindo da URL — é assim que os cards do dashboard abrem a Inbox já
   * recortada. Só entra em estado que a tela mostra: o seletor de status é
   * visível para todo mundo, mas os de número e departamento só aparecem
   * para supervisor e admin, e aplicar filtro que a pessoa não enxerga
   * deixaria a lista curta sem explicação nenhuma.
   *
   * O efeito depende dos valores crus da URL, e não do estado: enquanto a
   * pessoa navega dentro da Inbox os parâmetros não mudam, então trocar o
   * filtro na mão continua valendo. Vindo outro card, o valor muda e o
   * recorte novo entra sem precisar recarregar a página.
   */
  const statusParam = searchParams.get("status");
  const departmentParam = searchParams.get("departmentId");
  const instanceParam = searchParams.get("instanceId");

  useEffect(() => {
    if (isStatusQuickFilter(statusParam)) setFilter(statusParam);
  }, [statusParam]);

  useEffect(() => {
    if (!canFilterScope) return;
    if (departmentParam) setDepartmentFilter(departmentParam);
    if (instanceParam) setInstanceFilter(instanceParam);
  }, [canFilterScope, departmentParam, instanceParam]);

  const bottomRef = useRef<HTMLDivElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // ---------- Carregamento de dados auxiliares ----------
  useEffect(() => {
    api.get<{ users: UserDirectoryDto[] }>("/users").then((data) => setUsers(data.users)).catch(() => undefined);
    api.get<{ departments: DepartmentDto[] }>("/departments").then((data) => setDepartments(data.departments)).catch(() => undefined);
    api.get<{ tags: TagDto[] }>("/tags").then((data) => setTags(data.tags)).catch(() => undefined);
    api.get<{ instances: InstanceDto[] }>("/whatsapp-instances").then((data) => setInstances(data.instances)).catch(() => undefined);
    quickRepliesApi.list().then(setQuickReplies).catch(() => undefined);
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
    if (filter === "waiting_client") params.set("status", "waiting_client");
    if (filter === "waiting_internal") params.set("status", "waiting_internal");
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
      .then((data) => {
        setDetail(data);
        setScheduledPending(data.conversation.scheduledPendingCount);
      })
      .catch(() => setDetail(null));
  }, [conversationId]);

  useEffect(() => {
    setDetail(null);
    setMessages(null);
    setReplyTo(null);
    // A mídia pendente não é rascunho: ela vive na resposta rápida que a
    // pessoa acabou de escolher, e seguir para outra conversa com o anexo
    // colado mandaria arquivo para o cliente errado.
    setQuickReplyMedia(null);
    // Rascunho é por conversa, e volta com o modo em que foi escrito: nota
    // interna restaurada em modo mensagem mandaria para o cliente um texto
    // escrito para a equipe ler. Sem isso, o texto de um cliente também
    // apareceria no composer do próximo — fácil de mandar para o errado.
    const restored = conversationId && me ? readDraft(me.id, conversationId) : null;
    setDraft(restored?.text ?? "");
    setComposerMode(restored?.mode ?? "message");
    // Zera antes de carregar: o contador da conversa anterior não pode
    // aparecer por um instante na conversa recém-aberta.
    setScheduledPending(0);
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
  }, [conversationId, loadDetail, me]);

  // Busca dentro da conversa (com atraso para não consultar a cada tecla)
  useEffect(() => {
    if (!conversationId || chatSearch.trim().length < 2) {
      setChatResults(null);
      return;
    }
    const timer = setTimeout(() => {
      api
        .get<{ messages: MessageDto[] }>(
          `/conversations/${conversationId}/messages/search?q=${encodeURIComponent(chatSearch.trim())}`,
        )
        .then((data) => setChatResults(data.messages))
        .catch(() => setChatResults([]));
    }, 300);
    return () => clearTimeout(timer);
  }, [chatSearch, conversationId]);

  /** Abre o trecho da conversa em torno de uma mensagem encontrada. */
  async function jumpToMessage(message: MessageDto) {
    if (!conversationId) return;
    const data = await api.get<{ messages: MessageDto[]; hasMore: boolean }>(
      `/conversations/${conversationId}/messages/around?at=${encodeURIComponent(message.timestamp)}`,
    );
    setMessages(data.messages);
    setHasMore(data.hasMore);
    setHighlightId(message.id);
    setChatSearchOpen(false);
    setChatSearch("");
    setTimeout(() => {
      document.getElementById(`message-${message.id}`)?.scrollIntoView({
        behavior: "smooth",
        block: "center",
      });
    }, 100);
    setTimeout(() => setHighlightId(null), 3000);
  }

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
        setDetail((current) =>
          current
            ? {
                ...current,
                // O evento de conversa não carrega o contador de
                // agendamentos; preserva o que o detalhe já trouxe.
                conversation: {
                  ...payload,
                  scheduledPendingCount: current.conversation.scheduledPendingCount,
                },
              }
            : current,
        );
      }
    };
    // Agendamento criado, cancelado, enviado ou marcado como falho.
    const onScheduledPending = (payload: ScheduledPendingPayload) => {
      if (payload.conversationId !== conversationId) return;
      setScheduledPending(payload.pending);
    };
    const onMessageStatus = (payload: { conversationId: string; messageId: string; status: MessageDto["status"] }) => {
      if (payload.conversationId !== conversationId) return;
      setMessages((current) =>
        current?.map((message) =>
          message.id === payload.messageId ? { ...message, status: payload.status } : message,
        ) ?? null,
      );
    };
    // Conexão do número mudou: reflete o indicador nos cards da lista.
    const onInstanceStatus = (payload: {
      instanceId: string;
      status: ConversationDto["instanceStatus"];
    }) => {
      setConversations((current) =>
        current?.map((conversation) =>
          conversation.whatsappInstanceId === payload.instanceId
            ? { ...conversation, instanceStatus: payload.status }
            : conversation,
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
    socket.on(RealtimeEvents.InstanceStatus, onInstanceStatus);
    socket.on(RealtimeEvents.MessageReaction, onReaction);
    socket.on(RealtimeEvents.MessageUpdated, onMessageUpdated);
    socket.on(RealtimeEvents.InternalNote, onNote);
    socket.on(RealtimeEvents.ScheduledPending, onScheduledPending);
    return () => {
      socket.off(RealtimeEvents.MessageNew, onMessageNew);
      socket.off(RealtimeEvents.ConversationUpdated, onConversationUpdated);
      socket.off(RealtimeEvents.MessageStatus, onMessageStatus);
      socket.off(RealtimeEvents.GroupParticipants, onGroupParticipants);
      socket.off(RealtimeEvents.InstanceStatus, onInstanceStatus);
      socket.off(RealtimeEvents.MessageReaction, onReaction);
      socket.off(RealtimeEvents.MessageUpdated, onMessageUpdated);
      socket.off(RealtimeEvents.InternalNote, onNote);
      socket.off(RealtimeEvents.ScheduledPending, onScheduledPending);
    };
  }, [socket, conversationId, loadDetail]);

  /**
   * Toda escrita no composer passa por aqui, e grava na hora.
   *
   * Sem atraso de propósito: a sessão é encerrada no minuto do fechamento do
   * horário de uso, e um `setTimeout` de meio segundo perderia justamente as
   * últimas palavras — que são as que a pessoa ainda não mandou. A gravação é
   * uma chave por conversa no `localStorage`, custo desprezível por tecla.
   */
  function updateDraft(text: string, mode: DraftMode = composerMode): void {
    setDraft(text);
    setComposerMode(mode);
    if (conversationId && me) saveDraft(me.id, conversationId, { text, mode });
  }

  /** Troca de modo sem mexer no texto — o modo faz parte do rascunho. */
  function updateComposerMode(mode: DraftMode): void {
    updateDraft(draft, mode);
  }

  // Rascunho velho de qualquer usuário desta máquina sai do caminho na
  // abertura: cota cheia faria o rascunho de hoje deixar de ser gravado.
  useEffect(() => {
    pruneDrafts();
  }, []);

  // ---------- Envio ----------
  /** Acrescenta sem duplicar: a mesma mensagem também chega pelo socket. */
  function appendMessage(message: MessageDto) {
    setMessages((current) => {
      if (!current) return [message];
      if (current.some((entry) => entry.id === message.id)) return current;
      return [...current, message];
    });
  }

  async function sendText() {
    // Com mídia de resposta rápida anexada, texto vazio ainda envia: a
    // mídia sozinha é uma mensagem completa (um áudio de orientação, p.ex.).
    const pendingMedia = composerMode === "message" ? quickReplyMedia : null;
    if (!conversationId || sending) return;
    if (draft.trim().length === 0 && !pendingMedia?.media) return;
    setSending(true);
    const content = draft.trim();
    // Some do composer e do armazenamento juntos: rascunho já enviado que
    // voltasse no próximo login seria mandado duas vezes ao cliente.
    updateDraft("");

    // Modo nota interna: grava sem enviar nada ao WhatsApp.
    if (composerMode === "note") {
      try {
        await api.post(`/conversations/${conversationId}/notes`, { content });
        loadDetail();
      } catch (err) {
        updateDraft(content, "note");
        window.alert(err instanceof Error ? err.message : "Falha ao salvar nota");
      } finally {
        setSending(false);
      }
      return;
    }

    // Resposta rápida com mídia: sai pelo mesmo fluxo de mídia do clipe.
    // Imagem e vídeo levam o texto como legenda; áudio não tem legenda no
    // WhatsApp, então o texto sai como mensagem separada logo em seguida —
    // gravar a legenda no áudio mostraria na Inbox um texto que o cliente
    // nunca recebeu.
    if (pendingMedia?.media) {
      setQuickReplyMedia(null);
      setReplyTo(null);
      try {
        const file = await fetchQuickReplyMediaFile(pendingMedia);
        const form = new FormData();
        form.append("file", file);
        const isAudio = pendingMedia.media.type === "audio";
        if (!isAudio && content) form.append("caption", content);
        const result = await api.postForm<{ message: MessageDto }>(
          `/conversations/${conversationId}/messages/media`,
          form,
        );
        appendMessage(result.message);
        if (isAudio && content) {
          const textResult = await api.post<{ message: MessageDto }>(
            `/conversations/${conversationId}/messages`,
            { content },
          );
          appendMessage(textResult.message);
        }
      } catch (err) {
        // Nada saiu (ou saiu pela metade): devolve texto e anexo para a
        // pessoa tentar de novo sem redigitar. Pelo `updateDraft`, para o
        // texto devolvido também voltar a ser gravado como rascunho.
        updateDraft(content, "message");
        setQuickReplyMedia(pendingMedia);
        window.alert(err instanceof Error ? err.message : "Falha ao enviar a mídia");
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
      appendMessage(result.message);
    } catch (err) {
      updateDraft(content, "message");
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

  async function handleEditNote(note: NoteDto) {
    const next = window.prompt("Editar nota interna:", note.content);
    if (next === null) return;
    const content = next.trim();
    if (!content || content === note.content) return;
    try {
      await api.patch(`/conversations/${conversationId}/notes/${note.id}`, { content });
      loadDetail();
    } catch (err) {
      window.alert(err instanceof Error ? err.message : "Falha ao editar nota");
    }
  }

  async function handleDeleteNote(note: NoteDto) {
    if (!window.confirm("Apagar esta nota interna?")) return;
    try {
      await api.delete(`/conversations/${conversationId}/notes/${note.id}`);
      loadDetail();
    } catch (err) {
      window.alert(err instanceof Error ? err.message : "Falha ao apagar nota");
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

  /** Liga o remetente de cada mensagem ao participante, para exibir a foto. */
  const participantBySender = useMemo(() => {
    const map = new Map<string, { id: string; hasAvatar: boolean; name: string }>();
    for (const participant of detail?.group?.participants ?? []) {
      map.set(participant.externalContactId, {
        id: participant.id,
        hasAvatar: participant.hasAvatar,
        name: participant.name ?? participant.phoneNumber,
      });
    }
    return map;
  }, [detail?.group?.participants]);

  /** Foto de quem enviou a mensagem (participante do grupo ou o contato). */
  function senderAvatarFor(message: MessageDto) {
    if (!conversation) return null;
    if (conversation.type === "group") {
      const participant = message.senderExternalId
        ? participantBySender.get(message.senderExternalId)
        : undefined;
      if (participant) {
        return (
          <ParticipantAvatar
            participantId={participant.id}
            name={participant.name}
            hasAvatar={participant.hasAvatar}
            className="h-8 w-8 text-[10px]"
          />
        );
      }
      // Participante ainda não sincronizado: iniciais a partir do nome recebido.
      // Sem nome nem telefone (ex.: registro de chamada), não exibe avatar.
      if (!message.senderName && !message.senderPhone) return null;
      return (
        <Avatar
          name={message.senderName ?? message.senderPhone ?? "?"}
          size="sm"
          className="h-8 w-8 text-[10px]"
        />
      );
    }
    // Conversa individual: a foto do contato é a da própria conversa
    return (
      <ConversationAvatar
        conversationId={conversation.id}
        name={conversation.title}
        hasAvatar={conversation.hasAvatar}
        size="sm"
        className="h-8 w-8 text-[10px]"
      />
    );
  }

  // ---------- Respostas rápidas (atalho "/") ----------
  const slashQuery =
    draft.startsWith("/") && !draft.includes("\n") ? draft.slice(1).toLowerCase() : null;
  const conversationDepartmentId = conversation?.department?.id ?? null;
  const quickReplyMatches = useMemo(() => {
    if (slashQuery === null || quickReplyDismissed) return [];
    return quickReplies
      .filter(
        (reply) =>
          // Mesma regra da etiqueta: a resposta precisa valer para o
          // departamento desta conversa.
          appliesToConversation(reply, conversationDepartmentId) &&
          (reply.shortcut.startsWith(slashQuery) ||
            (reply.title ?? "").toLowerCase().includes(slashQuery) ||
            reply.content.toLowerCase().includes(slashQuery)),
      )
      .slice(0, 8);
  }, [slashQuery, quickReplies, quickReplyDismissed, conversationDepartmentId]);
  const quickReplyOpen = quickReplyMatches.length > 0;

  useEffect(() => {
    setQuickReplyIndex(0);
  }, [slashQuery]);

  useEffect(() => {
    if (slashQuery === null) setQuickReplyDismissed(false);
  }, [slashQuery]);

  function applyQuickReply(reply: QuickReplyDto) {
    updateDraft(reply.content);
    // A mídia não sai na hora: vira anexo pendente ao lado do texto, para a
    // pessoa revisar antes do Enter final.
    setQuickReplyMedia(reply.media ? reply : null);
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
    const sorted = items.sort((a, b) => a.at - b.at);

    // Insere o separador de data sempre que o dia muda.
    const withDividers: Array<
      | (typeof sorted)[number]
      | { kind: "day"; at: number; label: string }
    > = [];
    let lastDay: string | null = null;
    for (const item of sorted) {
      const day = new Date(item.at).toDateString();
      if (day !== lastDay) {
        withDividers.push({
          kind: "day" as const,
          at: item.at,
          label: formatDayLabel(new Date(item.at).toISOString()),
        });
        lastDay = day;
      }
      withDividers.push(item);
    }
    return withDividers;
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
          {/* Os quatro filtros no mesmo formato. Número e departamento só
              aparecem para quem enxerga mais de um recorte: para o usuário
              comum a lista já vem restrita, e os dois seletores ocupariam
              espaço sem mudar nada. */}
          <div className="grid grid-cols-2 gap-1.5">
            <select
              className={filterSelectClass(filter !== "all")}
              value={filter}
              onChange={(event) => setFilter(event.target.value as QuickFilter)}
            >
              <option value="all">Todas</option>
              {QUICK_FILTER_GROUPS.map((group) => (
                <optgroup key={group.label} label={group.label}>
                  {group.options.map((option) => (
                    <option key={option.key} value={option.key}>
                      {option.label}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
            {canFilterScope && (
              <>
                <select
                  className={filterSelectClass(instanceFilter !== "")}
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
                  className={filterSelectClass(departmentFilter !== "")}
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
              </>
            )}
            <select
              className={filterSelectClass(tagFilter !== "")}
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
                  <div className="flex items-center gap-1.5">
                    <h2 className="truncate text-sm font-semibold text-slate-900">
                      {conversation.title}
                    </h2>
                    {/* Cadastro da empresa no escritório */}
                    {conversation.externalReference && (
                      <span className="shrink-0 rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-amber-800">
                        {conversation.externalReference}
                      </span>
                    )}
                  </div>
                  <p className="truncate text-[11px] text-slate-400">
                    {isGroup
                      ? `${detail?.group?.participantCount ?? "..."} participantes · via ${conversation.instanceName ?? "—"}`
                      : `via ${conversation.instanceName ?? "—"}`}
                  </p>
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                {/* Status do atendimento, editável na própria barra */}
                <StatusSelect
                  status={conversation.status}
                  onChange={async (status) => {
                    await api.post(`/conversations/${conversation.id}/status`, { status });
                    loadDetail();
                    loadConversations();
                  }}
                />
                <Button
                  size="sm"
                  variant="ghost"
                  title="Buscar nesta conversa"
                  onClick={() => {
                    setChatSearchOpen((value) => !value);
                    setChatSearch("");
                  }}
                >
                  <Search className="h-4 w-4" />
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setShowPanel((value) => !value)}>
                  <Info className="h-4 w-4" />
                </Button>
              </div>
            </header>

            {/* Busca dentro da conversa */}
            {chatSearchOpen && (
              <div className="border-b border-slate-200 bg-white px-4 py-2">
                <div className="relative">
                  <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-slate-400" />
                  <Input
                    className="pl-8"
                    autoFocus
                    placeholder="Buscar mensagens nesta conversa..."
                    value={chatSearch}
                    onChange={(event) => setChatSearch(event.target.value)}
                  />
                </div>
                {chatResults && (
                  <div className="thin-scroll mt-2 max-h-56 space-y-1 overflow-y-auto">
                    {chatResults.length === 0 ? (
                      <p className="py-2 text-center text-xs text-slate-400">
                        Nenhuma mensagem encontrada.
                      </p>
                    ) : (
                      chatResults.map((result) => (
                        <button
                          key={result.id}
                          onClick={() => void jumpToMessage(result)}
                          className="block w-full rounded-lg px-2.5 py-1.5 text-left hover:bg-slate-50"
                        >
                          <p className="text-[11px] font-medium text-slate-500">
                            {result.senderName ?? (result.direction === "outbound" ? "Você" : "Cliente")}{" "}
                            · {formatDateTime(result.timestamp)}
                          </p>
                          <p className="truncate text-xs text-slate-700">
                            {result.content ?? `[${result.type}]`}
                          </p>
                        </button>
                      ))
                    )}
                  </div>
                )}
              </div>
            )}

            {/* overflow-x-hidden: nome de arquivo ou link longo não pode
                criar barra de rolagem lateral na conversa. */}
            <div className="thin-scroll flex-1 space-y-2 overflow-y-auto overflow-x-hidden px-4 py-4">
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
                  item.kind === "day" ? (
                    <div key={`day-${item.at}`} className="flex justify-center py-2">
                      <span className="rounded-full bg-slate-200/70 px-3 py-1 text-[11px] font-medium capitalize text-slate-600">
                        {item.label}
                      </span>
                    </div>
                  ) : item.kind === "message" ? (
                    <div
                      key={item.message.id}
                      id={`message-${item.message.id}`}
                      className={cn(
                        "rounded-xl transition-colors",
                        highlightId === item.message.id && "bg-amber-100/70 ring-2 ring-amber-300",
                      )}
                    >
                    <MessageBubble
                      message={item.message}
                      isGroup={isGroup ?? false}
                      showSender={item.showSender}
                      onReact={(message, emoji) => void handleReact(message, emoji)}
                      onReply={(message) => {
                        setReplyTo(message);
                        updateComposerMode("message");
                      }}
                      onForward={(message) => setForwarding(message)}
                      onEdit={(message) => void handleEdit(message)}
                      onDelete={(message) => void handleDelete(message)}
                      senderAvatar={senderAvatarFor(item.message)}
                    />
                    </div>
                  ) : (
                    <InternalNoteItem
                      key={`note-${item.note.id}`}
                      note={item.note}
                      canManage={
                        item.note.user?.id === me?.id || me?.role === "admin" || me?.role === "supervisor"
                      }
                      onEdit={(note) => void handleEditNote(note)}
                      onDelete={(note) => void handleDeleteNote(note)}
                    />
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
                  onClick={() => updateComposerMode("message")}
                  className={cn(
                    "shrink-0 whitespace-nowrap rounded-full px-2.5 py-1 text-[11px] font-medium transition-colors",
                    composerMode === "message"
                      ? "bg-brand-600 text-white"
                      : "bg-slate-100 text-slate-600 hover:bg-slate-200",
                  )}
                >
                  Responder ao cliente
                </button>
                <button
                  onClick={() => {
                    updateComposerMode("note");
                    setReplyTo(null);
                  }}
                  className={cn(
                    "flex shrink-0 items-center gap-1 whitespace-nowrap rounded-full px-2.5 py-1 text-[11px] font-medium transition-colors",
                    composerMode === "note"
                      ? "bg-amber-500 text-white"
                      : "bg-slate-100 text-slate-600 hover:bg-slate-200",
                  )}
                >
                  <StickyNote className="h-3 w-3" /> Nota interna
                </button>
                {composerMode === "note" && (
                  <span className="ml-1 min-w-0 truncate text-[11px] text-amber-700">
                    Só a equipe vê — não vai ao WhatsApp
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
              {/* Mídia da resposta rápida aguardando envio */}
              {quickReplyMedia?.media && composerMode === "message" && (
                <div className="mb-2 flex items-start gap-2 rounded-lg border-l-2 border-brand-500 bg-slate-50 px-2.5 py-1.5">
                  <Paperclip className="mt-0.5 h-3.5 w-3.5 shrink-0 text-brand-600" />
                  <div className="min-w-0 flex-1">
                    <p className="text-[11px] font-semibold text-slate-700">
                      {QUICK_REPLY_MEDIA_TYPE_LABELS[quickReplyMedia.media.type]} da resposta /
                      {quickReplyMedia.shortcut}
                    </p>
                    <p className="truncate text-xs text-slate-500">
                      {quickReplyMedia.media.filename ?? "Sai junto com a mensagem"}
                    </p>
                  </div>
                  <button
                    onClick={() => setQuickReplyMedia(null)}
                    className="rounded p-0.5 text-slate-400 hover:text-slate-600"
                    aria-label="Remover mídia anexada"
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
                        {reply.media && (
                          <span
                            className="ml-1.5 inline-flex items-center gap-0.5 font-normal text-slate-400"
                            title={`Envia ${QUICK_REPLY_MEDIA_TYPE_LABELS[reply.media.type].toLowerCase()} junto`}
                          >
                            <Paperclip className="h-3 w-3" />
                            {QUICK_REPLY_MEDIA_TYPE_LABELS[reply.media.type]}
                          </span>
                        )}
                        {reply.title && (
                          <span className="ml-2 font-normal text-slate-500">{reply.title}</span>
                        )}
                      </p>
                      <p className="truncate text-xs text-slate-500">{reply.content}</p>
                    </button>
                  ))}
                </div>
              )}
              <div className="space-y-2">
                <input
                  ref={fileInputRef}
                  type="file"
                  hidden
                  onChange={(event) => {
                    const file = event.target.files?.[0];
                    if (file) void sendFile(file);
                  }}
                />
                {/* O campo ocupa a linha inteira: duas linhas de texto ficam
                    visíveis sem precisar rolar. As ações vão para baixo. */}
                <Textarea
                  rows={2}
                  value={draft}
                  disabled={sending}
                  onChange={(event) => updateDraft(event.target.value)}
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
                      : `Mensagem para ${conversation.title}...`
                  }
                  className="max-h-40 min-h-[60px] w-full resize-none"
                />

                <div className="flex items-center gap-1">
                  {composerMode === "message" && (
                    <>
                      <Button
                        variant="ghost"
                        size="sm"
                        title="Enviar arquivo"
                        disabled={sending}
                        onClick={() => fileInputRef.current?.click()}
                      >
                        <Paperclip className="h-4 w-4" />
                      </Button>
                      <AudioRecorder disabled={sending} onSend={sendVoiceNote} />
                      {/*
                        O badge é sobreposto ao ícone, então o botão precisa
                        ser a referência de posicionamento. Zero não renderiza
                        nada: o ícone fica exatamente como sempre foi.
                      */}
                      <span className="relative inline-flex">
                        <Button
                          variant="ghost"
                          size="sm"
                          title="Agendar mensagem"
                          disabled={sending}
                          onClick={() => setScheduleOpen(true)}
                        >
                          <CalendarClock className="h-4 w-4" />
                        </Button>
                        {scheduledPending > 0 && (
                          <span
                            role="status"
                            aria-label={
                              scheduledPending === 1
                                ? "1 mensagem agendada nesta conversa"
                                : `${scheduledPending} mensagens agendadas nesta conversa`
                            }
                            // `pointer-events-none` para o clique no canto do
                            // ícone continuar abrindo o modal de agendamento.
                            className="pointer-events-none absolute -right-0.5 -top-0.5 flex h-4 min-w-[1rem] items-center justify-center rounded-full bg-red-600 px-1 text-[10px] font-semibold leading-none text-white ring-2 ring-white"
                          >
                            {/* Acima de 9 o número não cabe no círculo. */}
                            {scheduledPending > 9 ? "9+" : scheduledPending}
                          </span>
                        )}
                      </span>
                    </>
                  )}
                  <span className="ml-auto hidden truncate whitespace-nowrap pr-1 text-[11px] text-slate-400 xl:block">
                    {composerMode === "message" && '"/" respostas rápidas · Enter envia'}
                  </span>
                  <Button
                    variant={composerMode === "note" ? "secondary" : "primary"}
                    disabled={
                      sending ||
                      (draft.trim().length === 0 &&
                        !(composerMode === "message" && quickReplyMedia?.media))
                    }
                    onClick={() => void sendText()}
                  >
                    {composerMode === "note" ? (
                      <>
                        <StickyNote className="h-4 w-4" /> Salvar nota
                      </>
                    ) : (
                      <>
                        <Send className="h-4 w-4" /> Enviar
                      </>
                    )}
                  </Button>
                </div>
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

      {conversationId && (
        <>
          <ScheduleModal
            open={scheduleOpen}
            onClose={() => setScheduleOpen(false)}
            conversationId={conversationId}
            initialContent={draft}
          />
        </>
      )}

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

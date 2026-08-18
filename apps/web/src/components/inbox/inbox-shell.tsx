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
  Mail,
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
  AZEVEDO_OS_SOURCE,
  FILTER_ALL_USERS,
  FILTER_NONE,
  QUICK_REPLY_MEDIA_TYPE_LABELS,
  RealtimeEvents,
  MENTION_ALL_TOKEN,
  activeMentions,
  buildOutboundMention,
  insertMention,
  mentionDigits,
  mentionTrigger,
  type DraftMention,
  type ScheduledPendingPayload,
} from "@azvchat/shared";
import {
  api,
  conversationMediaApi,
  conversationReadApi,
  messagesApi,
  quickRepliesApi,
} from "@/lib/api";
import { useSocket } from "@/lib/socket-context";
import { useAuth } from "@/lib/auth-context";
import { pruneDrafts, readDraft, saveDraft, type Draft, type DraftMode } from "@/lib/drafts";
import {
  EMPTY_INBOX_FILTERS,
  conversationMatchesFilters,
  hasActiveInboxFilters,
  readInboxFilters,
  saveInboxFilters,
  type InboxFilters,
  type QuickFilter,
} from "@/lib/inbox-filters";
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
import { ArchivedBanner } from "./archived-banner";
import { ConversationListItem } from "./conversation-list";
import { useUnreadCounts } from "./use-unread-counts";
import { FilterBar } from "./filter-bar";
import { ConversationAvatar, ParticipantAvatar } from "./conversation-avatar";
import { MentionPicker, mentionOptions, type MentionOption } from "./mention-picker";
import { AudioRecorder } from "./audio-recorder";
import {
  ATTACHMENT_PASTE_FIELD,
  AttachmentDropZone,
  useBlockStrayFileDrop,
} from "./attachment-drop";
import { ScheduleModal } from "./composer-modals";
import { MediaLightbox } from "./media-lightbox";
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

/** Grupo ainda não carregado ou conversa individual — sempre a mesma lista vazia. */
const NO_PARTICIPANTS: NonNullable<ConversationDetailDto["group"]>["participants"] = [];

export function InboxShell({ conversationId }: { conversationId?: string }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const socket = useSocket();
  const { user: me } = useAuth();

  const [conversations, setConversations] = useState<ConversationDto[] | null>(null);
  /**
   * Não lidas DESTA pessoa, por conversa. Vem em separado do DTO da conversa
   * de propósito: aquele payload é publicado para todo mundo que enxerga a
   * conversa, e um contador ali seria o mesmo número para o supervisor e para
   * quem atende — o defeito que a leitura por usuário conserta.
   */
  const {
    counts: unreadCounts,
    countsRef: unreadCountsRef,
    replaceAll: replaceUnreadCounts,
    bump: bumpUnreadCount,
    set: setUnreadCount,
  } = useUnreadCounts();
  /**
   * Filtros da lista, num objeto só, reidratados do navegador já na
   * montagem. Este componente vive no layout da rota (`inbox/layout.tsx`)
   * porque, quando era renderizado pelas páginas, cada clique numa conversa
   * trocava de página e o remontava — e a remontagem zerava estes estados,
   * que era o bug do "filtro que some no primeiro atendimento".
   *
   * A leitura do storage pode ser síncrona aqui: o layout do app só
   * renderiza a Inbox depois da sessão carregar, então este componente
   * nunca entra no HTML do servidor e não há hidratação para divergir.
   */
  const [filters, setFilters] = useState<InboxFilters>(() => {
    if (!me) return EMPTY_INBOX_FILTERS;
    const stored = readInboxFilters(me.id);
    if (me.role === "admin" || me.role === "supervisor") return stored;
    // O usuário comum não tem os seletores de número e departamento:
    // reidratar esses dois seria filtro invisível, lista curta sem
    // explicação — mesma regra dos parâmetros vindos da URL.
    return { ...stored, instanceId: "", departmentId: "" };
  });

  /** Toda mudança de filtro passa por aqui — a persistência vem no efeito. */
  const applyFilters = useCallback((patch: Partial<InboxFilters>) => {
    setFilters((current) => ({ ...current, ...patch }));
  }, []);

  const meId = me?.id ?? null;

  // Grava toda mudança (mão, URL do dashboard, poda de id extinto): o F5
  // com uma conversa aberta volta exatamente ao que estava na tela. Sem
  // nenhum filtro ativo a entrada é apagada do storage.
  useEffect(() => {
    if (meId) saveInboxFilters(meId, filters);
  }, [meId, filters]);

  const [detail, setDetail] = useState<ConversationDetailDto | null>(null);
  const [messages, setMessages] = useState<MessageDto[] | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [showPanel, setShowPanel] = useState(true);
  const [draft, setDraft] = useState("");
  /**
   * Marcações vivas no rascunho. Andam SEMPRE junto com o texto: é esta
   * lista, e não o "@Fulano" escrito na frase, que faz o WhatsApp notificar
   * alguém. Separá-las produziria a pior falha possível — mensagem correta na
   * tela e ninguém avisado.
   */
  const [mentions, setMentions] = useState<DraftMention[]>([]);
  /** Posição do cursor no composer, para saber onde o "@" foi digitado. */
  const [caret, setCaret] = useState(0);
  const [mentionIndex, setMentionIndex] = useState(0);
  const [mentionDismissed, setMentionDismissed] = useState(false);
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  const [sending, setSending] = useState(false);
  /** "message" envia ao WhatsApp; "note" grava nota interna da equipe. */
  const [composerMode, setComposerMode] = useState<"message" | "note">("message");
  const [replyTo, setReplyTo] = useState<MessageDto | null>(null);
  /**
   * Mensagem sendo editada no composer, no lugar do `prompt` do navegador —
   * é assim que o WhatsApp faz, e o texto longo precisa do mesmo campo em
   * que foi escrito. O rascunho que estava no campo é guardado à parte e
   * volta ao cancelar ou ao salvar: entrar em edição não pode custar o que a
   * pessoa já tinha digitado.
   */
  const [editing, setEditing] = useState<MessageDto | null>(null);
  const [draftBeforeEdit, setDraftBeforeEdit] = useState<Draft | null>(null);
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
  /** Mídia aberta em tela cheia — guarda o id para sobreviver a atualizações da lista. */
  const [lightboxMessageId, setLightboxMessageId] = useState<string | null>(null);

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
  /**
   * Atalho aplicado no rascunho atual — vira o `lastUsedAt` da resposta
   * quando a mensagem SAI de fato. Ajustar o texto antes de enviar continua
   * contando como uso; apagar o rascunho inteiro e escrever outra coisa, não.
   */
  const [appliedQuickReplyId, setAppliedQuickReplyId] = useState<string | null>(null);

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
  // É assim que o card de arquivadas do dashboard abre a visão certa.
  const archivedParam = searchParams.get("archived");

  useEffect(() => {
    if (isStatusQuickFilter(statusParam)) {
      setFilters((current) => ({ ...current, quick: statusParam }));
    }
  }, [statusParam]);

  useEffect(() => {
    if (archivedParam === "true" || archivedParam === "1") {
      setFilters((current) => ({ ...current, quick: "archived" }));
    }
  }, [archivedParam]);

  useEffect(() => {
    if (!canFilterScope) return;
    if (!departmentParam && !instanceParam) return;
    setFilters((current) => ({
      ...current,
      ...(departmentParam ? { departmentId: departmentParam } : {}),
      ...(instanceParam ? { instanceId: instanceParam } : {}),
    }));
  }, [canFilterScope, departmentParam, instanceParam]);

  const bottomRef = useRef<HTMLDivElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  /**
   * Gravação de áudio em andamento: enquanto ela existe, arrastar e colar
   * arquivo ficam desligados — a prévia de anexo por cima do gravador
   * disputaria o mesmo Enter e o mesmo Esc.
   */
  const [recordingAudio, setRecordingAudio] = useState(false);

  // Arquivo solto fora da conversa (lista, painel, menu) não pode abrir no
  // navegador: isso trocaria a página pelo arquivo e o atendente perderia a
  // tela. Vale também com nenhuma conversa aberta, por isso fica aqui.
  useBlockStrayFileDrop();

  // ---------- Carregamento de dados auxiliares ----------
  // Quando cada lista chega, o filtro reidratado que aponta para um id que
  // não existe mais (departamento excluído, etiqueta apagada, número
  // removido — ou fora do acesso de quem entrou nesta máquina) é descartado
  // em silêncio: aquele campo volta para "todos", em vez de deixar a lista
  // vazia sem explicação.
  useEffect(() => {
    api.get<{ users: UserDirectoryDto[] }>("/users").then((data) => setUsers(data.users)).catch(() => undefined);
    api
      .get<{ departments: DepartmentDto[] }>("/departments")
      .then((data) => {
        setDepartments(data.departments);
        setFilters((current) =>
          current.departmentId && !data.departments.some((department) => department.id === current.departmentId)
            ? { ...current, departmentId: "" }
            : current,
        );
      })
      .catch(() => undefined);
    api
      .get<{ tags: TagDto[] }>("/tags")
      .then((data) => {
        setTags(data.tags);
        setFilters((current) =>
          current.tagId && !data.tags.some((tag) => tag.id === current.tagId)
            ? { ...current, tagId: "" }
            : current,
        );
      })
      .catch(() => undefined);
    api
      .get<{ instances: InstanceDto[] }>("/whatsapp-instances")
      .then((data) => {
        setInstances(data.instances);
        setFilters((current) =>
          current.instanceId && !data.instances.some((instance) => instance.id === current.instanceId)
            ? { ...current, instanceId: "" }
            : current,
        );
      })
      .catch(() => undefined);
    quickRepliesApi.list().then(setQuickReplies).catch(() => undefined);
  }, []);

  // ---------- Lista de conversas ----------
  const loadConversations = useCallback(() => {
    const params = new URLSearchParams();
    const quick = filters.quick;
    if (quick === "mine") params.set("assigned", "me");
    if (quick === "unassigned") params.set("assigned", FILTER_NONE);
    if (quick === "all_users") params.set("assigned", FILTER_ALL_USERS);
    if (quick === "groups") params.set("type", "group");
    if (quick === "individual") params.set("type", "individual");
    if (quick === "unread") params.set("unread", "true");
    // Sem o parâmetro a API já exclui arquivadas; com ele, lista só elas.
    if (quick === "archived") params.set("archived", "true");
    if (quick === "open") params.set("status", "open");
    if (quick === "waiting_client") params.set("status", "waiting_client");
    if (quick === "waiting_internal") params.set("status", "waiting_internal");
    if (quick === "resolved") params.set("status", "resolved");
    if (filters.departmentId) params.set("departmentId", filters.departmentId);
    if (filters.instanceId) params.set("instanceId", filters.instanceId);
    if (filters.tagId) params.set("tagId", filters.tagId);
    if (filters.search.trim().length >= 2) params.set("q", filters.search.trim());
    params.set("limit", "80");
    api
      .get<{ conversations: ConversationDto[]; unread: Record<string, number> }>(
        `/conversations?${params.toString()}`,
      )
      .then((data) => {
        setConversations(data.conversations);
        // O mapa vem calculado para a página inteira, numa consulta só.
        replaceUnreadCounts(data.unread ?? {});
      })
      .catch(() => undefined);
  }, [filters, replaceUnreadCounts]);

  useEffect(() => {
    const timer = setTimeout(loadConversations, filters.search ? 300 : 0);
    return () => clearTimeout(timer);
  }, [loadConversations, filters.search]);

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
    // A lightbox pertence à conversa aberta: trocar de conversa fecha.
    setLightboxMessageId(null);
    // A mídia pendente não é rascunho: ela vive na resposta rápida que a
    // pessoa acabou de escolher, e seguir para outra conversa com o anexo
    // colado mandaria arquivo para o cliente errado.
    setQuickReplyMedia(null);
    // Rascunho restaurado não é o atalho recém-aplicado: o uso só conta na
    // conversa em que a pessoa escolheu a resposta.
    setAppliedQuickReplyId(null);
    // Rascunho é por conversa, e volta com o modo em que foi escrito: nota
    // interna restaurada em modo mensagem mandaria para o cliente um texto
    // escrito para a equipe ler. Sem isso, o texto de um cliente também
    // apareceria no composer do próximo — fácil de mandar para o errado.
    const restored = conversationId && me ? readDraft(me.id, conversationId) : null;
    setDraft(restored?.text ?? "");
    setComposerMode(restored?.mode ?? "message");
    setMentions(restored?.mentions ?? []);
    setMentionDismissed(false);
    setCaret(restored?.text.length ?? 0);
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
    // Abrir marca como lida SÓ para quem abriu — o gatilho é o mesmo de
    // sempre, o que mudou é o alcance. A resposta traz o contador já
    // recalculado; as outras abas desta pessoa recebem pelo socket.
    void conversationReadApi
      .read(conversationId)
      .then((data) => setUnreadCount(conversationId, data.unreadCount))
      .catch(() => undefined);
  }, [conversationId, loadDetail, me, setUnreadCount]);

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
        // O tempo real respeita o filtro ativo: conversa fora do recorte não
        // é forçada para dentro da lista, e a que deixou de casar sai — mas
        // a aberta continua aberta no chat, filtro nunca fecha conversa.
        const count =
          (unreadCountsRef.current[payload.conversation.id] ?? 0) +
          (payload.message.direction === "inbound" &&
          payload.message.conversationId !== conversationId
            ? 1
            : 0);
        if (!conversationMatchesFilters(payload.conversation, filters, meId, count)) {
          return rest.length === current.length ? current : rest;
        }
        return [payload.conversation, ...rest];
      });
      // Contador de cada um sobe sozinho na aba de cada um. A conversa
      // ABERTA não sobe: ela é marcada como lida logo abaixo, exatamente
      // como já acontecia antes desta mudança.
      if (
        payload.message.direction === "inbound" &&
        payload.message.conversationId !== conversationId
      ) {
        bumpUnreadCount(payload.message.conversationId);
      }
      if (payload.message.conversationId === conversationId) {
        setMessages((current) => {
          if (!current) return current;
          if (current.some((message) => message.id === payload.message.id)) return current;
          return [...current, payload.message];
        });
        void conversationReadApi
          .read(conversationId)
          .then((data) => setUnreadCount(conversationId, data.unreadCount))
          .catch(() => undefined);
      }
    };
    const onConversationUpdated = (payload: ConversationDto) => {
      setConversations((current) => {
        if (!current) return current;
        if (!current.some((conversation) => conversation.id === payload.id)) return current;
        // Atribuição, status, departamento ou etiqueta mudou e a linha
        // deixou de casar com o filtro ativo: sai da lista sem recarregar
        // tudo. A conversa aberta no chat não é fechada por isso.
        if (
          !conversationMatchesFilters(
            payload,
            filters,
            meId,
            unreadCountsRef.current[payload.id] ?? 0,
          )
        ) {
          return current.filter((conversation) => conversation.id !== payload.id);
        }
        return current.map((conversation) => (conversation.id === payload.id ? payload : conversation));
      });
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
    // `filters`/`meId` entram nas dependências porque os handlers casam a
    // conversa com o filtro ativo — reassinar os listeners é barato e a
    // lista de dependências continua honesta.
  }, [
    socket,
    conversationId,
    loadDetail,
    filters,
    meId,
    unreadCountsRef,
    bumpUnreadCount,
    setUnreadCount,
  ]);

  /**
   * Toda escrita no composer passa por aqui, e grava na hora.
   *
   * Sem atraso de propósito: a sessão é encerrada no minuto do fechamento do
   * horário de uso, e um `setTimeout` de meio segundo perderia justamente as
   * últimas palavras — que são as que a pessoa ainda não mandou. A gravação é
   * uma chave por conversa no `localStorage`, custo desprezível por tecla.
   */
  function updateDraft(
    text: string,
    mode: DraftMode = composerMode,
    nextMentions: DraftMention[] = mentions,
  ): void {
    // Toda escrita recalcula as marcações: apagar "@João" com backspace tira
    // o João da lista na mesma tecla. Menção órfã notificaria alguém que já
    // não aparece no texto da mensagem.
    const alive = activeMentions(text, nextMentions);
    setDraft(text);
    setComposerMode(mode);
    setMentions(alive);
    // Editando, o campo é da mensagem já enviada — não é rascunho de nada.
    // Gravar aqui faria o texto antigo reaparecer no composer no próximo
    // login, pronto para ser mandado de novo ao cliente.
    if (editing) return;
    if (conversationId && me) saveDraft(me.id, conversationId, { text, mode, mentions: alive });
  }

  /** Troca de modo sem mexer no texto — o modo faz parte do rascunho. */
  function updateComposerMode(mode: DraftMode): void {
    updateDraft(draft, mode);
  }

  // ---------- Marcação de participantes (atalho "@") ----------
  /**
   * O seletor só existe em GRUPO e só na aba "Responder ao cliente".
   *
   * Em conversa individual não há a quem marcar. Na nota interna, marcar não
   * faria sentido nenhum: os participantes são clientes, e a nota é justamente
   * o texto que o cliente nunca vai ver — a notificação chegaria para ele
   * falando de algo que ele não pode ler. Marcar colega de equipe é outra
   * funcionalidade, com outra lista de gente.
   */
  const mentionsEnabled =
    detail?.conversation.type === "group" && composerMode === "message" && !editing;
  // Referência estável: `?? []` criaria um array novo a cada render e
  // invalidaria os memos abaixo sem nenhum motivo.
  const groupParticipants = detail?.group?.participants ?? NO_PARTICIPANTS;
  const mentionTriggerAt = mentionsEnabled && !mentionDismissed
    ? mentionTrigger(draft, caret)
    : null;
  const mentionQuery = mentionTriggerAt?.query ?? null;
  const mentionList = useMemo(
    () => (mentionQuery === null ? [] : mentionOptions(groupParticipants, mentionQuery)),
    [mentionQuery, groupParticipants],
  );
  const mentionOpen = mentionTriggerAt !== null;
  /**
   * Nome de cada participante indexado pelos dígitos do identificador — pelo
   * telefone e também pelo "@lid", porque a mensagem recebida pode marcar por
   * qualquer um dos dois. É o que troca o número cru pelo nome na bolha.
   */
  const mentionNames = useMemo(() => {
    const names = new Map<string, string>();
    for (const participant of groupParticipants) {
      if (participant.phoneNumber) {
        names.set(mentionDigits(participant.phoneNumber), participant.name);
      }
      const internal = mentionDigits(participant.externalContactId);
      if (internal) names.set(internal, participant.name);
    }
    return names;
  }, [groupParticipants]);

  /**
   * Com "@todos" no rascunho, quantos participantes o coletivo NÃO consegue
   * notificar — por não terem telefone conhecido ou por passarem do teto de
   * menções. A conta só aparece quando o coletivo está mesmo no texto: num
   * "@Fulano" comum ela seria ruído.
   */
  const mentionAllSkipped = useMemo(() => {
    if (!mentionsEnabled) return 0;
    const coletivo = mentions.find((mention) => mention.token === MENTION_ALL_TOKEN);
    if (!coletivo) return 0;
    return groupParticipants.length - coletivo.externalIds.length;
  }, [mentionsEnabled, mentions, groupParticipants]);

  useEffect(() => {
    setMentionIndex(0);
  }, [mentionTriggerAt?.query, mentionTriggerAt?.start]);

  useEffect(() => {
    if (!mentionTriggerAt) setMentionDismissed(false);
    // Só o `start` importa: enquanto o mesmo "@" estiver sendo editado, o
    // Esc continua valendo.
  }, [mentionTriggerAt?.start]);

  function applyMention(option: MentionOption): void {
    const chosen = option.mention;
    if (!chosen || !mentionTriggerAt) return;
    const { text, caret: nextCaret } = insertMention(draft, mentionTriggerAt, chosen.label);
    updateDraft(text, composerMode, [...mentions, chosen]);
    setMentionDismissed(false);
    setCaret(nextCaret);
    // O cursor precisa ir para depois do rótulo: sem isso a próxima tecla
    // cairia no meio do nome recém-inserido.
    window.requestAnimationFrame(() => {
      const field = composerRef.current;
      if (!field) return;
      field.focus();
      field.setSelectionRange(nextCaret, nextCaret);
    });
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
    // Nota interna não conta como uso: o cliente não recebeu nada.
    const usedQuickReplyId = composerMode === "message" ? appliedQuickReplyId : null;
    if (!conversationId || sending) return;
    if (draft.trim().length === 0 && !pendingMedia?.media) return;
    setSending(true);
    const content = draft.trim();
    // Guardadas antes de limpar o campo: limpar o rascunho zera as marcações,
    // e elas precisam viajar com este texto.
    const sentMentions = composerMode === "message" ? activeMentions(content, mentions) : [];
    // Some do composer e do armazenamento juntos: rascunho já enviado que
    // voltasse no próximo login seria mandado duas vezes ao cliente.
    updateDraft("", composerMode, []);

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

    // Resposta rápida com mídia: a API envia direto do storage dela — daqui
    // sai só um JSON, nada de baixar o binário para subir de volta (era isso
    // que fazia vídeo grande parecer travado). O chip fica visível com
    // "Enviando..." até a confirmação. Imagem e vídeo levam o texto como
    // legenda; áudio não tem legenda no WhatsApp, então o texto sai como
    // mensagem separada logo em seguida.
    if (pendingMedia?.media) {
      setReplyTo(null);
      const isAudio = pendingMedia.media.type === "audio";
      try {
        const result = await api.post<{ message: MessageDto }>(
          `/conversations/${conversationId}/quick-reply-media`,
          {
            quickReplyId: pendingMedia.id,
            ...(!isAudio && content ? { caption: content } : {}),
          },
        );
        appendMessage(result.message);
        // A rota já marcou o lastUsedAt — não precisa da segunda chamada.
        setQuickReplyMedia(null);
        setAppliedQuickReplyId(null);
      } catch (err) {
        // Nada saiu: devolve o texto (regravado como rascunho, pelo
        // updateDraft) e mantém o anexo para tentar de novo.
        updateDraft(content, "message");
        window.alert(err instanceof Error ? err.message : "Falha ao enviar a mídia");
        setSending(false);
        return;
      }
      if (isAudio && content) {
        try {
          const textResult = await api.post<{ message: MessageDto }>(
            `/conversations/${conversationId}/messages`,
            { content },
          );
          appendMessage(textResult.message);
        } catch (err) {
          // O áudio saiu; só o texto falhou. Devolver o rascunho sem o
          // anexo evita reenviar o áudio em duplicidade no retry.
          updateDraft(content, "message");
          window.alert(
            err instanceof Error
              ? `O áudio foi enviado, mas o texto falhou: ${err.message}`
              : "O áudio foi enviado, mas o texto falhou — envie o texto de novo",
          );
        }
      }
      setSending(false);
      return;
    }

    const replyId = replyTo?.id;
    setReplyTo(null);
    // O texto que sai leva os tokens no lugar dos rótulos ("@João Silva" vira
    // "@5511999998888"), e a lista de participantes vai SEPARADA no corpo da
    // requisição. É a lista que notifica — o token no texto só faz o aplicativo
    // de quem recebe desenhar o destaque.
    const outgoing = buildOutboundMention(content, sentMentions);
    try {
      const result = await messagesApi.send(conversationId, {
        content: outgoing.text,
        ...(replyId ? { replyToMessageId: replyId } : {}),
        ...(outgoing.externalIds.length > 0 ? { mentions: outgoing.externalIds } : {}),
      });
      appendMessage(result);
      if (usedQuickReplyId) {
        setAppliedQuickReplyId(null);
        void quickRepliesApi.markUsed(usedQuickReplyId);
      }
    } catch (err) {
      updateDraft(content, "message", sentMentions);
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

  /** Abre a edição no composer. O rascunho atual fica guardado. */
  function startEdit(message: MessageDto) {
    setDraftBeforeEdit({ text: draft, mode: composerMode, mentions });
    setReplyTo(null);
    setEditing(message);
    // A edição é sempre do texto que foi para o cliente — nunca de nota.
    updateDraft(message.content ?? "", "message", []);
    window.requestAnimationFrame(() => composerRef.current?.focus());
  }

  /** Sai da edição devolvendo ao campo o que estava sendo escrito antes. */
  function cancelEdit() {
    const anterior = draftBeforeEdit;
    setEditing(null);
    setDraftBeforeEdit(null);
    updateDraft(anterior?.text ?? "", anterior?.mode ?? "message", anterior?.mentions ?? []);
  }

  async function handleEdit(message: MessageDto, novoTexto: string) {
    const content = novoTexto.trim();
    if (!content || content === message.content) {
      cancelEdit();
      return;
    }
    setSending(true);
    try {
      const result = await messagesApi.edit(message.id, content);
      setMessages((current) =>
        current?.map((entry) => (entry.id === message.id ? result : entry)) ?? null,
      );
      // Só sai da edição depois da confirmação: se o WhatsApp recusar (a
      // janela de edição fechou, o número caiu), o texto continua no campo
      // para a pessoa copiar ou tentar de novo.
      cancelEdit();
    } catch (err) {
      window.alert(err instanceof Error ? err.message : "Falha ao editar mensagem");
    } finally {
      setSending(false);
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
      appendMessage(
        await conversationMediaApi.send(conversationId, file, { asVoiceNote: true }),
      );
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
      appendMessage(await conversationMediaApi.send(conversationId, file));
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
  // Durante a edição o "/" é texto: a pessoa está corrigindo uma frase já
  // enviada, não escolhendo uma resposta pronta.
  const slashQuery =
    !editing && draft.startsWith("/") && !draft.includes("\n")
      ? draft.slice(1).toLowerCase()
      : null;
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
    setAppliedQuickReplyId(reply.id);
    setQuickReplyDismissed(true);
  }

  /**
   * Mídias visuais já carregadas na janela de mensagens — é só entre elas que
   * a lightbox navega; ampliar nunca busca mais mensagens do servidor.
   * Mensagem apagada fica de fora: se for apagada com a lightbox aberta, o
   * índice some e a lightbox fecha sozinha.
   */
  const lightboxMessages = useMemo(
    () =>
      (messages ?? []).filter(
        (message) =>
          !message.deletedAt &&
          message.hasMedia &&
          (message.type === "image" || message.type === "video" || message.type === "sticker"),
      ),
    [messages],
  );
  const lightboxIndex = lightboxMessageId
    ? lightboxMessages.findIndex((message) => message.id === lightboxMessageId)
    : -1;

  /**
   * Arrastar e colar arquivo ficam desligados quando outra coisa já manda no
   * teclado: envio em curso, gravação de áudio, encaminhar, agendar ou mídia
   * ampliada. Sem isso o Ctrl+V dado dentro de um desses abriria a prévia de
   * anexo por cima deles.
   */
  const attachmentsDisabled =
    sending || recordingAudio || forwarding !== null || scheduleOpen || lightboxIndex >= 0;

  /**
   * A prévia de anexo levou o texto do composer como legenda e o envio saiu:
   * só agora o rascunho pode ir embora. A conversa vem no parâmetro porque a
   * prévia fica amarrada à conversa de origem — se a pessoa já trocou de
   * conversa, o que se limpa é o rascunho gravado daquela, não o texto que
   * está na tela agora.
   */
  function consumeComposerCaption(id: string) {
    if (id === conversationId) {
      updateDraft("");
      return;
    }
    if (me) saveDraft(me.id, id, { text: "", mode: "message" });
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
        <div className="border-b border-slate-200 p-3">
          <FilterBar
            filters={filters}
            onChange={applyFilters}
            onClear={() => setFilters(EMPTY_INBOX_FILTERS)}
            canFilterScope={canFilterScope}
            instances={instances}
            departments={departments}
            tags={tags}
          />
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
              description={
                hasActiveInboxFilters(filters)
                  ? "Nenhuma conversa casa com os filtros ativos. Limpe os filtros para ver tudo."
                  : "Conecte um WhatsApp e as conversas aparecerão aqui automaticamente."
              }
            />
          ) : (
            conversations.map((entry) => (
              <ConversationListItem
                key={entry.id}
                conversation={entry}
                unreadCount={unreadCounts[entry.id] ?? 0}
                active={entry.id === conversationId}
                onClick={() => router.push(`/inbox/${entry.id}`)}
              />
            ))
          )}
        </div>
      </div>

      {/* Centro: chat.
          A zona de arrastar/colar arquivo envolve a coluna inteira, e não só
          a janela de mensagens: trocar de conversa zera o `detail` por um
          instante, e uma zona dentro do ramo da conversa carregada seria
          desmontada nesse piscar — descartando em silêncio a prévia que a
          pessoa tinha aberto. Fora da coluna (lista, painel, menu) o gesto
          continua não fazendo nada. */}
      <AttachmentDropZone
        conversationId={conversationId ?? null}
        conversationTitle={conversation?.title ?? null}
        instanceStatus={conversation?.instanceStatus ?? null}
        // Nota interna não vira legenda de mídia do cliente.
        captionSeed={composerMode === "message" ? draft : ""}
        onCaptionConsumed={consumeComposerCaption}
        onMessageSent={appendMessage}
        disabled={attachmentsDisabled}
      >
      {/* `min-h-0` é obrigatório aqui: como filho de um flex COLUNA (a zona de
          anexo), a altura mínima automática desta coluna passa a ser a do
          conteúdo, e a janela de mensagens deixaria de rolar por dentro —
          empurrando o cabeçalho para fora da tela e o composer para baixo.
          Como filho direto da linha, o `stretch` fazia esse papel sozinho. */}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-slate-100">
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
                    {/* Cadastro da empresa no escritório. O identificador do
                        Azevedo-OS mora no mesmo campo e não vira chip: é
                        interno, e a empresa aparece no card do painel. */}
                    {conversation.externalReference &&
                      conversation.externalSource !== AZEVEDO_OS_SOURCE && (
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
                {/* Reservar a conversa para depois: recua a marca de leitura
                    DESTA pessoa e fecha o chat. Ninguém mais vê o aviso
                    voltar, e sair da conversa evita que a leitura volte a
                    avançar na próxima mensagem que chegar aqui. */}
                <Button
                  size="sm"
                  variant="ghost"
                  title="Marcar como não lida"
                  onClick={async () => {
                    const data = await conversationReadApi.unread(conversation.id);
                    setUnreadCount(conversation.id, data.unreadCount);
                    router.push("/inbox");
                  }}
                >
                  <Mail className="h-4 w-4" />
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setShowPanel((value) => !value)}>
                  <Info className="h-4 w-4" />
                </Button>
              </div>
            </header>

            {/* Conversa arquivada avisa no topo e oferece o desarquivar. */}
            <ArchivedBanner
              conversation={conversation}
              onUnarchived={() => {
                loadDetail();
                loadConversations();
              }}
            />

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
                      onEdit={(message) => startEdit(message)}
                      onDelete={(message) => void handleDelete(message)}
                      onOpenMedia={(message) => setLightboxMessageId(message.id)}
                      senderAvatar={senderAvatarFor(item.message)}
                      mentionNames={mentionNames}
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
              {/* Editando: o campo passa a ser da mensagem já enviada, e as
                  abas somem — nota interna não se edita por aqui. */}
              {editing && (
                <div className="mb-2 flex items-start gap-2 rounded-lg border-l-2 border-brand-600 bg-slate-50 px-2.5 py-1.5">
                  <Pencil className="mt-0.5 h-3.5 w-3.5 shrink-0 text-brand-600" />
                  <div className="min-w-0 flex-1">
                    <p className="text-[11px] font-semibold text-slate-700">
                      {editing.type === "text" ? "Editando mensagem" : "Editando legenda"}
                    </p>
                    <p className="truncate text-xs text-slate-500">
                      Enter salva · Esc cancela · o cliente vê a mensagem marcada como editada
                    </p>
                  </div>
                  <button
                    onClick={cancelEdit}
                    disabled={sending}
                    className="rounded p-0.5 text-slate-400 hover:text-slate-600 disabled:opacity-50"
                    aria-label="Cancelar edição"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>
              )}
              {/* Alternância entre resposta ao cliente e nota interna */}
              {!editing && (
              <div className="mb-2 flex items-center gap-1">
                <button
                  onClick={() => updateComposerMode("message")}
                  className={cn(
                    "shrink-0 whitespace-nowrap rounded-full px-2.5 py-1 text-[11px] font-medium transition-colors",
                    composerMode === "message"
                      ? "bg-brand-550 text-white"
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
              )}

              {/* Mensagem sendo respondida */}
              {replyTo && composerMode === "message" && (
                <div className="mb-2 flex items-start gap-2 rounded-lg border-l-2 border-brand-600 bg-slate-50 px-2.5 py-1.5">
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
              {/* Mídia da resposta rápida aguardando envio. Durante o envio o
                  chip vira o indicador de progresso: vídeo grande demora e,
                  sem isso, a espera parecia defeito. */}
              {quickReplyMedia?.media && composerMode === "message" && (
                <div className="mb-2 flex items-start gap-2 rounded-lg border-l-2 border-brand-600 bg-slate-50 px-2.5 py-1.5">
                  {sending ? (
                    <Spinner className="mt-0.5 h-3.5 w-3.5 shrink-0 text-brand-600" />
                  ) : (
                    <Paperclip className="mt-0.5 h-3.5 w-3.5 shrink-0 text-brand-600" />
                  )}
                  <div className="min-w-0 flex-1">
                    <p className="text-[11px] font-semibold text-slate-700">
                      {sending
                        ? `Enviando ${QUICK_REPLY_MEDIA_TYPE_LABELS[quickReplyMedia.media.type].toLowerCase()}... aguarde`
                        : `${QUICK_REPLY_MEDIA_TYPE_LABELS[quickReplyMedia.media.type]} da resposta /${quickReplyMedia.shortcut}`}
                    </p>
                    <p className="truncate text-xs text-slate-500">
                      {quickReplyMedia.media.filename ?? "Sai junto com a mensagem"}
                    </p>
                  </div>
                  {!sending && (
                    <button
                      onClick={() => setQuickReplyMedia(null)}
                      className="rounded p-0.5 text-slate-400 hover:text-slate-600"
                      aria-label="Remover mídia anexada"
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  )}
                </div>
              )}
              {mentionOpen && (
                <MentionPicker
                  options={mentionList}
                  activeIndex={mentionIndex}
                  onHover={setMentionIndex}
                  onSelect={applyMention}
                  hasParticipants={groupParticipants.length > 0}
                />
              )}
              {/* Aviso ANTES do envio: com "@todos" num grupo em que alguém
                  não tem telefone conhecido, a mensagem sai para os demais —
                  ninguém descobre a falha depois de mandar. */}
              {mentionAllSkipped > 0 && (
                <p className="mb-2 rounded-lg bg-amber-50 px-2.5 py-1.5 text-[11px] text-amber-700">
                  {mentionAllSkipped === 1
                    ? "1 participante ficará de fora do @todos — a mensagem sai para os demais."
                    : `${mentionAllSkipped} participantes ficarão de fora do @todos — a mensagem sai para os demais.`}
                </p>
              )}
              {quickReplyOpen && !mentionOpen && (
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
                  ref={composerRef}
                  rows={2}
                  value={draft}
                  disabled={sending}
                  // O seletor de "@" precisa saber ONDE está o cursor: só
                  // abre quando o "@" começa a mensagem ou vem depois de
                  // espaço, e isso se decide pelo caractere anterior a ele.
                  onSelect={(event) => setCaret(event.currentTarget.selectionStart ?? 0)}
                  // Marca o composer como o campo em que colar ARQUIVO abre a
                  // prévia de anexo. Sem a marca, colar arquivo na busca da
                  // conversa também seria interceptado — e lá o Ctrl+V é dela.
                  data-attachment-paste={ATTACHMENT_PASTE_FIELD}
                  onChange={(event) => {
                    const value = event.target.value;
                    setCaret(event.target.selectionStart ?? value.length);
                    // updateDraft grava o rascunho a cada tecla — e recalcula
                    // as marcações, para o backspace desmarcar de verdade.
                    updateDraft(value);
                    // Rascunho apagado por inteiro: o que vier depois é outra
                    // mensagem, não o atalho — não pode contar como uso.
                    if (value === "") setAppliedQuickReplyId(null);
                  }}
                  onKeyDown={(event) => {
                    if (mentionOpen) {
                      // Mesma mecânica do "/": seta navega, Enter ou Tab
                      // escolhe, Esc fecha e deixa o "@" como texto.
                      if (event.key === "ArrowDown" && mentionList.length > 0) {
                        event.preventDefault();
                        setMentionIndex((index) => (index + 1) % mentionList.length);
                        return;
                      }
                      if (event.key === "ArrowUp" && mentionList.length > 0) {
                        event.preventDefault();
                        setMentionIndex(
                          (index) => (index - 1 + mentionList.length) % mentionList.length,
                        );
                        return;
                      }
                      if (event.key === "Enter" || event.key === "Tab") {
                        const selected = mentionList[mentionIndex];
                        // Linha desabilitada (sem telefone) não escolhe nada,
                        // e o Enter não pode virar envio no meio da busca.
                        if (selected) {
                          event.preventDefault();
                          if (selected.mention) applyMention(selected);
                          return;
                        }
                      }
                      if (event.key === "Escape") {
                        event.preventDefault();
                        setMentionDismissed(true);
                        return;
                      }
                    }
                    if (quickReplyOpen && !mentionOpen) {
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
                    if (editing && event.key === "Escape") {
                      event.preventDefault();
                      cancelEdit();
                      return;
                    }
                    if (event.key === "Enter" && !event.shiftKey) {
                      event.preventDefault();
                      // Editando, o Enter salva a mensagem já enviada em vez
                      // de mandar uma nova — igual ao aplicativo.
                      if (editing) void handleEdit(editing, draft);
                      else void sendText();
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
                  {composerMode === "message" && !editing && (
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
                      <AudioRecorder
                        disabled={sending}
                        onSend={sendVoiceNote}
                        onActiveChange={setRecordingAudio}
                      />
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
                    {editing
                      ? "Enter salva · Esc cancela"
                      : composerMode === "message" &&
                        (mentionsEnabled
                          ? '"/" respostas rápidas · "@" marca participante · Enter envia'
                          : '"/" respostas rápidas · Enter envia')}
                  </span>
                  {editing && (
                    <Button variant="ghost" disabled={sending} onClick={cancelEdit}>
                      Cancelar
                    </Button>
                  )}
                  <Button
                    variant={composerMode === "note" && !editing ? "secondary" : "primary"}
                    disabled={
                      sending ||
                      (draft.trim().length === 0 &&
                        !(composerMode === "message" && !editing && quickReplyMedia?.media))
                    }
                    onClick={() => (editing ? void handleEdit(editing, draft) : void sendText())}
                  >
                    {editing ? (
                      <>
                        <Pencil className="h-4 w-4" /> Salvar
                      </>
                    ) : composerMode === "note" ? (
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
      </AttachmentDropZone>

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

      {/* Mídia ampliada em tela cheia */}
      {lightboxIndex >= 0 && (
        <MediaLightbox
          messages={lightboxMessages}
          index={lightboxIndex}
          onClose={() => setLightboxMessageId(null)}
          onNavigate={(nextIndex) => {
            const target = lightboxMessages[nextIndex];
            if (target) setLightboxMessageId(target.id);
          }}
        />
      )}
    </div>
  );
}

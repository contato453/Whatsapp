"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  Archive,
  ArchiveRestore,
  Check,
  FileText,
  MessageSquare,
  Pencil,
  RefreshCw,
  StickyNote,
  UserCog,
  X,
} from "lucide-react";
import {
  AZEVEDO_OS_SOURCE,
  canManageAzevedoOsLink,
  CONVERSATION_STATUSES,
  CONVERSATION_STATUS_LABELS,
  PARTICIPANT_CLIENT_ROLES,
  PARTICIPANT_CLIENT_ROLE_COLORS,
  PARTICIPANT_CLIENT_ROLE_LABELS,
  type ParticipantClientRole,
} from "@azvchat/shared";
import {
  api,
  conversationArchiveApi,
  fetchMediaBlobUrl,
  groupParticipantsApi,
  invalidateConversationAvatar,
} from "@/lib/api";
import { cn, formatDateTime, formatPhone } from "@/lib/utils";
import type {
  ConversationDetailDto,
  ConversationFileDto,
  DepartmentDto,
  TagDto,
  UserDirectoryDto,
} from "@/lib/types";
import { useAuth } from "@/lib/auth-context";
import { Badge, Button, Textarea } from "@/components/ui";
import { appliesToConversation } from "@/components/department-picker";
import { AzevedoOsCard } from "./azevedo-os-card";
import { ConversationAvatar, ParticipantAvatar } from "./conversation-avatar";

/**
 * Telefone de uma conversa individual. O endereço do WhatsApp vem como
 * "5521999999999@s.whatsapp.net"; contas novas usam "@lid", que não carrega
 * o telefone — nesse caso não há o que exibir.
 */
function phoneFromChatId(externalChatId: string): string | null {
  const [numero, dominio] = externalChatId.split("@");
  if (!numero || dominio === "lid" || !/^\d{8,15}$/.test(numero)) return null;
  return numero;
}

/** Campo de texto que salva ao sair ou no Enter, com rótulo curto. */
function InlineField({
  label,
  value,
  placeholder,
  disabled,
  onSave,
}: {
  label: string;
  value: string | null;
  placeholder: string;
  disabled?: boolean;
  onSave: (valor: string | null) => void | Promise<void>;
}) {
  const [texto, setTexto] = useState(value ?? "");
  useEffect(() => setTexto(value ?? ""), [value]);

  function salvar() {
    const limpo = texto.trim();
    if (limpo === (value ?? "")) return;
    void onSave(limpo.length > 0 ? limpo : null);
  }

  return (
    <div className="flex items-center justify-between gap-2">
      <span className="shrink-0 text-slate-500">{label}</span>
      <input
        className="min-w-0 flex-1 rounded-lg border border-slate-200 px-2 py-1 text-right text-xs text-slate-700 focus:border-brand-500 focus:outline-none"
        value={texto}
        placeholder={placeholder}
        disabled={disabled}
        onChange={(event) => setTexto(event.target.value)}
        onBlur={salvar}
        onKeyDown={(event) => {
          if (event.key === "Enter") event.currentTarget.blur();
          if (event.key === "Escape") setTexto(value ?? "");
        }}
      />
    </div>
  );
}

/** Nome exibido quando o arquivo chegou sem nome original. */
const FILE_TYPE_LABELS: Record<string, string> = {
  image: "Imagem",
  audio: "Áudio",
  video: "Vídeo",
  document: "Documento",
  sticker: "Figurinha",
};

const ACTION_LABELS: Record<string, string> = {
  assigned: "assumiu o atendimento",
  transferred_user: "transferiu o atendimento",
  transferred_department: "transferiu para departamento",
  unassigned: "removeu o responsável",
  resolved: "concluiu o atendimento",
  reopened: "reabriu o atendimento",
};

/**
 * Descrição do grupo recolhida em 3 linhas. Descrições longas empurram o
 * atendimento e a lista de participantes para fora da tela, então o texto
 * completo fica atrás de um "ver mais".
 */
function GroupDescription({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(false);
  const [overflows, setOverflows] = useState(false);
  const ref = useRef<HTMLParagraphElement | null>(null);

  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    // Só oferece o botão quando o texto realmente passa das 3 linhas —
    // medido no elemento, para não depender de contagem de caracteres.
    const check = () => setOverflows(node.scrollHeight > node.clientHeight + 1);
    check();
    const observer = new ResizeObserver(check);
    observer.observe(node);
    return () => observer.disconnect();
  }, [text]);

  return (
    <div className="mt-2 rounded-lg bg-slate-50 p-2">
      <p
        ref={ref}
        className={cn("whitespace-pre-wrap text-xs text-slate-500", !expanded && "line-clamp-3")}
      >
        {text}
      </p>
      {(overflows || expanded) && (
        <button
          type="button"
          onClick={() => setExpanded((value) => !value)}
          className="mt-1 text-xs font-medium text-brand-600 hover:underline"
        >
          {expanded ? "ver menos" : "ver mais"}
        </button>
      )}
    </div>
  );
}

export function ContextPanel({
  detail,
  users,
  departments,
  tags,
  onChanged,
}: {
  detail: ConversationDetailDto;
  users: UserDirectoryDto[];
  departments: DepartmentDto[];
  tags: TagDto[];
  onChanged: () => void;
}) {
  const router = useRouter();
  const { user: me } = useAuth();
  const conversation = detail.conversation;
  /** Conversa vinculada a uma empresa do Azevedo-OS (ver o card abaixo). */
  const vinculadaAoAzevedoOs = conversation.externalSource === AZEVEDO_OS_SOURCE;
  const [noteText, setNoteText] = useState("");
  const [busy, setBusy] = useState(false);

  async function run(action: () => Promise<unknown>) {
    setBusy(true);
    try {
      await action();
      onChanged();
    } finally {
      setBusy(false);
    }
  }

  // Nome próprio da conversa.
  const [renaming, setRenaming] = useState(false);
  const [nome, setNome] = useState(conversation.customTitle ?? "");
  useEffect(() => {
    setNome(conversation.customTitle ?? "");
    setRenaming(false);
  }, [conversation.id, conversation.customTitle]);

  async function salvarNome() {
    const valor = nome.trim();
    setRenaming(false);
    if (valor === (conversation.customTitle ?? "")) return;
    await run(() =>
      api.patch(`/conversations/${conversation.id}`, {
        customTitle: valor.length > 0 ? valor : null,
      }),
    );
  }

  const telefone =
    conversation.type === "individual"
      ? (() => {
          const numero = phoneFromChatId(conversation.externalChatId);
          return numero ? formatPhone(numero) : null;
        })()
      : null;

  // Nome próprio de participante de grupo.
  const [renamingParticipant, setRenamingParticipant] = useState<string | null>(null);
  async function salvarParticipante(participantId: string, valor: string) {
    setRenamingParticipant(null);
    const limpo = valor.trim();
    await run(() =>
      groupParticipantsApi.update(participantId, {
        customName: limpo.length > 0 ? limpo : null,
      }),
    );
  }

  // Seletor de papel no cliente, aberto uma linha por vez. Fica em fluxo,
  // abaixo do participante, porque a lista rola: um popover flutuante seria
  // cortado pelo recorte da rolagem.
  const [rolePickerFor, setRolePickerFor] = useState<string | null>(null);
  async function salvarPapelParticipante(
    participantId: string,
    clientRole: ParticipantClientRole | null,
  ) {
    setRolePickerFor(null);
    await run(() => groupParticipantsApi.update(participantId, { clientRole }));
  }

  // Arquivos da conversa, carregados sob demanda ao abrir a seção.
  const [files, setFiles] = useState<ConversationFileDto[] | null>(null);
  const [showFiles, setShowFiles] = useState(false);
  useEffect(() => {
    setFiles(null);
    setShowFiles(false);
  }, [conversation.id]);
  useEffect(() => {
    if (!showFiles || files) return;
    api
      .get<{ files: ConversationFileDto[] }>(`/conversations/${conversation.id}/files`)
      .then((data) => setFiles(data.files))
      .catch(() => setFiles([]));
  }, [showFiles, files, conversation.id]);

  /** A mídia é servida autenticada, então baixa o blob antes de salvar. */
  async function baixarArquivo(file: ConversationFileDto) {
    const url = await fetchMediaBlobUrl(file.id);
    const link = document.createElement("a");
    link.href = url;
    link.download = file.filename ?? `${file.type}-${file.id.slice(0, 8)}`;
    link.click();
    // Sem o revoke o blob fica na memória da aba até o reload.
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  }

  // Código do cadastro: editado localmente e salvo ao sair do campo.
  const [reference, setReference] = useState(conversation.externalReference ?? "");
  useEffect(() => {
    setReference(conversation.externalReference ?? "");
  }, [conversation.id, conversation.externalReference]);

  /**
   * Abre a conversa individual com o participante — o "chamar no privado".
   * A conversa é criada na hora se ainda não existir.
   */
  async function openDirect(participantId: string) {
    setBusy(true);
    try {
      const data = await api.post<{ conversationId: string }>(
        `/group-participants/${participantId}/conversation`,
      );
      router.push(`/inbox/${data.conversationId}`);
    } catch (err) {
      window.alert(err instanceof Error ? err.message : "Não foi possível abrir a conversa");
    } finally {
      setBusy(false);
    }
  }

  async function saveReference() {
    const value = reference.trim();
    if (value === (conversation.externalReference ?? "")) return;
    await run(() =>
      api.patch(`/conversations/${conversation.id}/reference`, {
        externalReference: value.length > 0 ? value : null,
      }),
    );
  }

  // Só oferece o que a API vai aceitar: a etiqueta precisa valer para o
  // departamento desta conversa. As já aplicadas saem da lista.
  const availableTags = tags.filter(
    (tag) =>
      !conversation.tags.some((assigned) => assigned.id === tag.id) &&
      appliesToConversation(tag, conversation.department?.id ?? null),
  );

  /**
   * A lista de usuários só traz gente ativa. Se o responsável atual foi
   * desativado, ele entra como opção mesmo assim — sem isso o seletor
   * mostraria "Sem responsável" numa conversa que tem dono.
   */
  const assignable = conversation.assignedUser
    ? users.some((item) => item.id === conversation.assignedUser?.id)
      ? users
      : [...users, conversation.assignedUser]
    : users;

  return (
    <div className="thin-scroll flex h-full flex-col gap-5 overflow-y-auto p-4">
      {/* Dados da conversa */}
      <section>
        <div className="flex items-center gap-3">
          <ConversationAvatar
            conversationId={conversation.id}
            name={conversation.title}
            hasAvatar={conversation.hasAvatar}
            size="lg"
          />
          <div className="min-w-0 flex-1">
            {renaming ? (
              <div className="flex items-center gap-1">
                <input
                  autoFocus
                  className="min-w-0 flex-1 rounded-lg border border-slate-300 px-2 py-1 text-sm font-semibold text-slate-900 focus:border-brand-500 focus:outline-none"
                  value={nome}
                  placeholder={conversation.whatsappTitle}
                  onChange={(event) => setNome(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") void salvarNome();
                    if (event.key === "Escape") {
                      setNome(conversation.customTitle ?? "");
                      setRenaming(false);
                    }
                  }}
                />
                <button
                  title="Salvar nome"
                  className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700"
                  onClick={() => void salvarNome()}
                >
                  <Check className="h-3.5 w-3.5" />
                </button>
              </div>
            ) : (
              <div className="flex items-center gap-1">
                <p className="truncate font-semibold text-slate-900">{conversation.title}</p>
                <button
                  title="Editar nome"
                  className="shrink-0 rounded-lg p-1 text-slate-300 hover:bg-slate-100 hover:text-slate-600"
                  onClick={() => setRenaming(true)}
                >
                  <Pencil className="h-3 w-3" />
                </button>
              </div>
            )}
            {/* Com nome próprio, o do WhatsApp fica embaixo como referência. */}
            {conversation.customTitle && (
              <p className="truncate text-xs text-slate-400">
                No WhatsApp: {conversation.whatsappTitle}
              </p>
            )}
            <p className="text-xs text-slate-500">
              {conversation.type === "group"
                ? `Grupo · ${detail.group?.participantCount ?? "?"} participantes`
                : (telefone ?? "Conversa individual")}
            </p>
            <p className="text-xs text-slate-400">via {conversation.instanceName ?? "—"}</p>
          </div>
          <button
            title="Atualizar fotos (conversa e participantes)"
            disabled={busy}
            onClick={() =>
              run(async () => {
                await api.post(`/conversations/${conversation.id}/avatar/refresh`);
                invalidateConversationAvatar(conversation.id);
              })
            }
            className="rounded-lg p-1.5 text-slate-300 hover:bg-slate-100 hover:text-slate-600"
          >
            <RefreshCw className="h-3.5 w-3.5" />
          </button>
        </div>
        {detail.group?.description && <GroupDescription text={detail.group.description} />}
      </section>

      {/* Atribuição */}
      <section className="space-y-2">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-400">Atendimento</h3>
        <div className="space-y-2 text-sm">
          <div className="flex items-center justify-between">
            <span className="text-slate-500">Status</span>
            <select
              className="max-w-[55%] rounded-lg border border-slate-200 px-2 py-1 text-xs"
              value={conversation.status}
              disabled={busy}
              onChange={(event) =>
                void run(() =>
                  api.post(`/conversations/${conversation.id}/status`, {
                    status: event.target.value,
                  }),
                )
              }
            >
              {CONVERSATION_STATUSES.map((status) => (
                <option key={status} value={status}>
                  {CONVERSATION_STATUS_LABELS[status]}
                </option>
              ))}
            </select>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-slate-500">Responsável</span>
            <select
              className="max-w-[55%] rounded-lg border border-slate-200 px-2 py-1 text-xs"
              value={conversation.assignedUser?.id ?? ""}
              disabled={busy}
              onChange={(event) => {
                const value = event.target.value;
                if (!value) {
                  void run(() => api.post(`/conversations/${conversation.id}/unassign`));
                } else {
                  void run(() => api.post(`/conversations/${conversation.id}/assign`, { userId: value }));
                }
              }}
            >
              <option value="">Sem responsável</option>
              {assignable.map((user) => (
                <option key={user.id} value={user.id}>
                  {user.name}
                </option>
              ))}
            </select>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-slate-500">Departamento</span>
            <select
              className="max-w-[55%] rounded-lg border border-slate-200 px-2 py-1 text-xs"
              value={conversation.department?.id ?? ""}
              disabled={busy}
              onChange={(event) => {
                const value = event.target.value;
                if (value) {
                  void run(() =>
                    api.post(`/conversations/${conversation.id}/transfer-department`, {
                      departmentId: value,
                    }),
                  );
                }
              }}
            >
              <option value="">Sem departamento</option>
              {departments.map((department) => (
                <option key={department.id} value={department.id}>
                  {department.name}
                </option>
              ))}
            </select>
          </div>
          {/*
            Código do cadastro da empresa/grupo no escritório. Some quando a
            conversa está vinculada ao Azevedo-OS: o campo no banco é o mesmo
            (`externalReference`), e ali ele guarda o identificador da
            empresa — deixar o campo editável convidaria a apagar o vínculo
            sem querer, e a API recusaria a gravação de qualquer forma.
          */}
          {!vinculadaAoAzevedoOs && (
            <div className="flex items-center justify-between">
              <span className="text-slate-500">Cadastro</span>
              <input
                className="max-w-[55%] rounded-lg border border-slate-200 px-2 py-1 text-xs font-semibold uppercase tracking-wide text-amber-800 placeholder:font-normal placeholder:normal-case placeholder:tracking-normal placeholder:text-slate-400"
                value={reference}
                maxLength={40}
                placeholder="EMPRESA 001"
                disabled={busy}
                onChange={(event) => setReference(event.target.value)}
                onBlur={() => void saveReference()}
                onKeyDown={(event) => {
                  if (event.key === "Enter") event.currentTarget.blur();
                  if (event.key === "Escape") setReference(conversation.externalReference ?? "");
                }}
              />
            </div>
          )}
          {/* Sócio representante perante a Receita Federal */}
          <InlineField
            label="Sócio"
            value={conversation.partnerName}
            placeholder="Nome do sócio"
            disabled={busy}
            onSave={(valor) =>
              run(() => api.patch(`/conversations/${conversation.id}`, { partnerName: valor }))
            }
          />
        </div>
        {/* Sem botões de "Assumir" e "Concluir": o responsável é trocado no
            seletor logo acima e o status, na barra da conversa. Dois caminhos
            para a mesma ação só criam dúvida sobre qual usar. */}
        {/* Arquivar mora junto de status e responsável: é o mesmo tipo de
            decisão sobre o atendimento. Papel mínimo é o mesmo dos dois. */}
        {conversation.archivedAt ? (
          <Button
            size="sm"
            variant="outline"
            className="w-full"
            disabled={busy}
            onClick={() => void run(() => conversationArchiveApi.unarchive(conversation.id))}
          >
            <ArchiveRestore className="h-3.5 w-3.5" /> Desarquivar conversa
          </Button>
        ) : (
          <Button
            size="sm"
            variant="outline"
            className="w-full"
            disabled={busy}
            onClick={() => {
              if (
                !window.confirm(
                  "Arquivar esta conversa? Ela some da lista de conversas e deixa de contar nos números do sistema. Nada é apagado, e dá para desarquivar quando quiser.",
                )
              ) {
                return;
              }
              void run(() => conversationArchiveApi.archive(conversation.id));
            }}
          >
            <Archive className="h-3.5 w-3.5" /> Arquivar conversa
          </Button>
        )}
      </section>

      {/*
        Cliente no Azevedo-OS. Fica logo abaixo do atendimento porque
        responde "com quem estou falando", que é a primeira pergunta de quem
        abre a conversa. Carrega e falha sozinho: Azevedo-OS fora do ar não
        atrapalha nada no restante do painel.
      */}
      <AzevedoOsCard
        conversation={conversation}
        canManage={me ? canManageAzevedoOsLink(me.role) : false}
        onChanged={onChanged}
      />

      {/* Etiquetas */}
      <section className="space-y-2">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-400">Etiquetas</h3>
        <div className="flex flex-wrap gap-1.5">
          {conversation.tags.map((tag) => (
            <Badge key={tag.id} color={tag.color}>
              {tag.name}
              <button
                disabled={busy}
                onClick={() =>
                  run(() => api.delete(`/conversations/${conversation.id}/tags/${tag.id}`))
                }
                className="opacity-60 hover:opacity-100"
                aria-label={`Remover ${tag.name}`}
              >
                <X className="h-3 w-3" />
              </button>
            </Badge>
          ))}
          {conversation.tags.length === 0 && (
            <p className="text-xs text-slate-400">Nenhuma etiqueta.</p>
          )}
        </div>
        {availableTags.length > 0 && (
          <select
            className="w-full rounded-lg border border-slate-200 px-2 py-1.5 text-xs"
            value=""
            disabled={busy}
            onChange={(event) => {
              const value = event.target.value;
              if (value) {
                void run(() => api.post(`/conversations/${conversation.id}/tags/${value}`));
              }
            }}
          >
            <option value="">+ Adicionar etiqueta</option>
            {availableTags.map((tag) => (
              <option key={tag.id} value={tag.id}>
                {tag.name}
              </option>
            ))}
          </select>
        )}
      </section>

      {/* Arquivos trocados na conversa */}
      <section className="space-y-2">
        <button
          className="flex w-full items-center gap-1 text-xs font-semibold uppercase tracking-wide text-slate-400 hover:text-slate-600"
          onClick={() => setShowFiles((atual) => !atual)}
        >
          <FileText className="h-3.5 w-3.5" /> Arquivos
          <span className="ml-auto font-normal normal-case tracking-normal text-slate-400">
            {showFiles ? "ocultar" : "ver"}
          </span>
        </button>
        {showFiles &&
          (files === null ? (
            <p className="text-xs text-slate-400">Carregando...</p>
          ) : files.length === 0 ? (
            <p className="text-xs text-slate-400">Nenhum arquivo nesta conversa ainda.</p>
          ) : (
            <div className="thin-scroll max-h-48 space-y-1 overflow-y-auto">
              {files.map((file) => (
                <button
                  key={file.id}
                  onClick={() => void baixarArquivo(file)}
                  className="flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-left text-xs hover:bg-slate-50"
                >
                  <FileText className="h-3.5 w-3.5 shrink-0 text-slate-400" />
                  <span className="min-w-0 flex-1 truncate text-slate-700">
                    {file.filename ?? FILE_TYPE_LABELS[file.type] ?? "Arquivo"}
                  </span>
                  <span className="shrink-0 text-[11px] text-slate-400">
                    {formatDateTime(file.timestamp)}
                  </span>
                </button>
              ))}
            </div>
          ))}
      </section>

      {/* Participantes do grupo */}
      {detail.group && (
        <section className="space-y-2">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-400">
            Participantes ({detail.group.participantCount})
          </h3>
          <div className="thin-scroll max-h-48 space-y-1.5 overflow-y-auto">
            {detail.group.participants.map((participant) => {
              // O nome já vem decidido da API — a tela não refaz a cadeia.
              // A segunda linha some quando o nome exibido já é o telefone,
              // para não repetir a mesma informação.
              const nomeExibido = participant.name;
              const mostrarTelefone = !!participant.phoneNumber && !participant.nameIsPhone;
              return (
                <div key={participant.id} className="text-xs">
                  <div className="flex items-center gap-1.5">
                    <ParticipantAvatar
                      participantId={participant.id}
                      name={nomeExibido}
                      hasAvatar={participant.hasAvatar}
                      className="h-7 w-7 shrink-0 text-[9px]"
                    />
                    <div className="min-w-0 flex-1">
                      {/* Nome quando conhecido; o telefone aparece logo abaixo */}
                      {renamingParticipant === participant.id ? (
                        <input
                          autoFocus
                          className="w-full rounded-lg border border-slate-300 px-2 py-0.5 text-xs text-slate-700 focus:border-brand-500 focus:outline-none"
                          defaultValue={participant.customName ?? ""}
                          placeholder={participant.whatsappName ?? "Nome do participante"}
                          onBlur={(event) =>
                            void salvarParticipante(participant.id, event.target.value)
                          }
                          onKeyDown={(event) => {
                            if (event.key === "Enter") event.currentTarget.blur();
                            if (event.key === "Escape") setRenamingParticipant(null);
                          }}
                        />
                      ) : (
                        <p className="truncate text-slate-700">{nomeExibido}</p>
                      )}
                      {mostrarTelefone && (
                        <p className="truncate text-[11px] text-slate-400">
                          {formatPhone(participant.phoneNumber)}
                        </p>
                      )}
                    </div>
                    {/*
                      Papel no cliente: chip retangular e de cor própria, para
                      não se confundir com o selo "admin" (pílula âmbar), que é
                      administrador do grupo no WhatsApp e vem do sync.
                    */}
                    {participant.clientRole && (
                      <span
                        className="shrink-0 rounded-[3px] px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-white"
                        style={{
                          backgroundColor: PARTICIPANT_CLIENT_ROLE_COLORS[participant.clientRole],
                        }}
                      >
                        {PARTICIPANT_CLIENT_ROLE_LABELS[participant.clientRole]}
                      </span>
                    )}
                    {participant.isAdmin && (
                      <Badge className="shrink-0 bg-amber-50 text-amber-700">admin</Badge>
                    )}
                    <button
                      title={
                        participant.hasKnownName
                          ? "Editar nome"
                          : "Dar um nome a este participante"
                      }
                      aria-label={
                        participant.hasKnownName
                          ? "Editar nome"
                          : "Dar um nome a este participante"
                      }
                      className="shrink-0 rounded-lg p-1 text-slate-300 hover:bg-slate-100 hover:text-slate-600"
                      onClick={() => setRenamingParticipant(participant.id)}
                    >
                      <Pencil className="h-3 w-3" />
                    </button>
                    <button
                      title="Marcar como sócio ou administrativo do cliente"
                      aria-label="Marcar como sócio ou administrativo do cliente"
                      aria-expanded={rolePickerFor === participant.id}
                      className="shrink-0 rounded-lg p-1 text-slate-300 hover:bg-slate-100 hover:text-slate-600"
                      onClick={() =>
                        setRolePickerFor((atual) =>
                          atual === participant.id ? null : participant.id,
                        )
                      }
                    >
                      <UserCog className="h-3 w-3" />
                    </button>
                    {/* Sem telefone conhecido não há para onde abrir a conversa */}
                    {participant.phoneNumber && (
                      <button
                        title={`Abrir conversa individual com ${nomeExibido}`}
                        aria-label={`Abrir conversa individual com ${nomeExibido}`}
                        disabled={busy}
                        onClick={() => void openDirect(participant.id)}
                        className="shrink-0 rounded-lg border border-slate-200 p-1 text-slate-600 hover:bg-slate-50 hover:text-brand-700 disabled:opacity-50"
                      >
                        <MessageSquare className="h-3 w-3" />
                      </button>
                    )}
                  </div>
                  {rolePickerFor === participant.id && (
                    <div className="ml-8 mt-1 flex flex-wrap items-center gap-1">
                      {PARTICIPANT_CLIENT_ROLES.map((papel) => (
                        <button
                          key={papel}
                          disabled={busy}
                          onClick={() => void salvarPapelParticipante(participant.id, papel)}
                          className={cn(
                            "rounded-[3px] border px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide disabled:opacity-50",
                            participant.clientRole === papel
                              ? "border-transparent text-white"
                              : "border-slate-200 text-slate-600 hover:bg-slate-50",
                          )}
                          style={
                            participant.clientRole === papel
                              ? { backgroundColor: PARTICIPANT_CLIENT_ROLE_COLORS[papel] }
                              : undefined
                          }
                        >
                          {PARTICIPANT_CLIENT_ROLE_LABELS[papel]}
                        </button>
                      ))}
                      <button
                        disabled={busy}
                        onClick={() => void salvarPapelParticipante(participant.id, null)}
                        className="rounded-[3px] border border-slate-200 px-1.5 py-0.5 text-[10px] text-slate-500 hover:bg-slate-50 disabled:opacity-50"
                      >
                        Sem marcação
                      </button>
                    </div>
                  )}
                </div>
              );
            })}
            {detail.group.participants.length === 0 && (
              <p className="text-xs text-slate-400">Participantes ainda não sincronizados.</p>
            )}
          </div>
        </section>
      )}

      {/* Notas internas */}
      <section className="space-y-2">
        <h3 className="flex items-center gap-1 text-xs font-semibold uppercase tracking-wide text-slate-400">
          <StickyNote className="h-3.5 w-3.5" /> Notas internas
        </h3>
        <div className="space-y-2">
          {detail.notes.map((note) => (
            <div key={note.id} className="rounded-lg border-l-2 border-amber-400 bg-amber-50 p-2.5">
              <p className="whitespace-pre-wrap text-xs text-slate-700">{note.content}</p>
              <p className="mt-1 text-[10px] text-slate-400">
                {note.user?.name ?? "—"} · {formatDateTime(note.createdAt)}
              </p>
            </div>
          ))}
        </div>
        <Textarea
          rows={2}
          value={noteText}
          onChange={(event) => setNoteText(event.target.value)}
          placeholder="Nota visível só para a equipe (não vai para o WhatsApp)"
          className="text-xs"
        />
        <Button
          size="sm"
          variant="secondary"
          disabled={busy || noteText.trim().length === 0}
          onClick={() =>
            run(async () => {
              await api.post(`/conversations/${conversation.id}/notes`, { content: noteText.trim() });
              setNoteText("");
            })
          }
        >
          Adicionar nota
        </Button>
      </section>

      {/* Histórico de responsáveis */}
      <section className="space-y-2">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-400">Histórico</h3>
        <div className="space-y-1.5">
          {detail.assignmentHistory.map((entry) => (
            <p key={entry.id} className="text-[11px] leading-snug text-slate-500">
              <span className="font-medium text-slate-700">{entry.performedBy?.name ?? "Sistema"}</span>{" "}
              {ACTION_LABELS[entry.action] ?? entry.action}
              <span className="text-slate-400"> · {formatDateTime(entry.createdAt)}</span>
            </p>
          ))}
          {detail.assignmentHistory.length === 0 && (
            <p className="text-xs text-slate-400">Nenhuma movimentação registrada.</p>
          )}
        </div>
      </section>
    </div>
  );
}

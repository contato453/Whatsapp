"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { CheckCheck, Eraser, Search } from "lucide-react";
import {
  ASSIGNMENT_ALL_USERS,
  ASSIGNMENT_NO_DEPARTMENT,
  ASSIGNMENT_UNASSIGNED,
  ALL_USERS_ASSIGNEE_LABEL,
  departmentAssignmentToken,
  userAssignmentToken,
} from "@azvchat/shared";
import { api } from "@/lib/api";
import type {
  ConversationDto,
  DepartmentDto,
  UserDirectoryDto,
  InstanceDto,
} from "@/lib/types";
import { Button, Input, MultiSelect, Spinner, type MultiSelectGroup } from "@/components/ui";
import { formatDateTime } from "./quality-ui";

/**
 * O SELETOR DE CONVERSAS DA ANÁLISE.
 *
 * Ele mostra a lista de conversas como a tela de Conversas mostra — com o chip
 * do número, o departamento e o responsável em cada linha — e não uma lista de
 * títulos soltos. O motivo é concreto: o escritório tem quatro grupos chamados
 * "Demandas CS - <cliente>", um por departamento, e sem esses chips eles
 * aparecem como quatro linhas idênticas. Escolher qual analisar viraria
 * adivinhação.
 *
 * Os filtros são os MESMOS da Inbox, pelo mesmo contrato: `instanceId` (o chip
 * de WhatsApp) CRUZA com o resto, e departamento e responsável vão juntos no
 * `assignment`, onde SOMAM. Não inventamos uma segunda régua de filtro aqui —
 * duas réguas divergiriam, e a equipe sentiria sem saber nomear.
 *
 * A busca por texto filtra o que já está carregado, e o rótulo diz isso. Ela
 * não é a busca global: aqui a pergunta é "dentro deste recorte, qual delas?",
 * e uma busca que trouxesse conversa de fora do filtro contradiria o filtro
 * que a pessoa acabou de marcar.
 */

const PAGINA = 50;

export function ConversationPicker({
  selecionadas,
  onChange,
  teto,
}: {
  selecionadas: ConversationDto[];
  onChange: (conversas: ConversationDto[]) => void;
  teto: number;
}) {
  const [instanceIds, setInstanceIds] = useState<string[]>([]);
  const [assignment, setAssignment] = useState<string[]>([]);
  const [termo, setTermo] = useState("");

  const [conversas, setConversas] = useState<ConversationDto[] | null>(null);
  const [total, setTotal] = useState(0);
  const [carregandoMais, setCarregandoMais] = useState(false);

  const [instancias, setInstancias] = useState<InstanceDto[]>([]);
  const [departamentos, setDepartamentos] = useState<DepartmentDto[]>([]);
  const [usuarios, setUsuarios] = useState<UserDirectoryDto[]>([]);

  useEffect(() => {
    void api
      .get<{ instances: InstanceDto[] }>("/whatsapp-instances")
      .then((data) => setInstancias(data.instances))
      .catch(() => undefined);
    void api
      .get<{ departments: DepartmentDto[] }>("/departments")
      .then((data) => setDepartamentos(data.departments))
      .catch(() => undefined);
    void api
      .get<{ users: UserDirectoryDto[] }>("/users")
      .then((data) => setUsuarios(data.users))
      .catch(() => undefined);
  }, []);

  const buscarPagina = useCallback(
    async (offset: number): Promise<{ conversations: ConversationDto[]; total: number }> => {
      const params = new URLSearchParams();
      params.set("limit", String(PAGINA));
      params.set("offset", String(offset));
      // Parâmetro REPETIDO, como a Inbox e o Dashboard já fazem.
      for (const id of instanceIds) params.append("instanceId", id);
      for (const token of assignment) params.append("assignment", token);
      return api.get<{ conversations: ConversationDto[]; total: number }>(
        `/conversations?${params.toString()}`,
      );
    },
    [instanceIds, assignment],
  );

  useEffect(() => {
    let ativo = true;
    setConversas(null);
    void buscarPagina(0)
      .then((data) => {
        if (!ativo) return;
        setConversas(data.conversations);
        setTotal(data.total);
      })
      .catch(() => {
        if (ativo) {
          setConversas([]);
          setTotal(0);
        }
      });
    return () => {
      ativo = false;
    };
  }, [buscarPagina]);

  async function carregarMais(): Promise<void> {
    if (!conversas) return;
    setCarregandoMais(true);
    try {
      const data = await buscarPagina(conversas.length);
      setConversas([...conversas, ...data.conversations]);
      setTotal(data.total);
    } catch {
      // Falhar em carregar mais não pode apagar o que já está na tela.
    } finally {
      setCarregandoMais(false);
    }
  }

  const gruposInstancia = useMemo<MultiSelectGroup[]>(
    () => [
      {
        label: null,
        options: instancias.map((instance) => ({ value: instance.id, label: instance.name })),
      },
    ],
    [instancias],
  );

  const gruposAtendimento = useMemo<MultiSelectGroup[]>(
    () => [
      {
        label: "Departamento",
        options: [
          { value: ASSIGNMENT_NO_DEPARTMENT, label: "Sem departamento" },
          ...departamentos.map((department) => ({
            value: departmentAssignmentToken(department.id),
            label: department.name,
          })),
        ],
      },
      {
        label: "Responsável",
        options: [
          { value: ASSIGNMENT_UNASSIGNED, label: "Sem responsável" },
          { value: ASSIGNMENT_ALL_USERS, label: ALL_USERS_ASSIGNEE_LABEL },
          ...usuarios
            .filter((user) => user.status === "active")
            .map((user) => ({ value: userAssignmentToken(user.id), label: user.name })),
        ],
      },
    ],
    [departamentos, usuarios],
  );

  const busca = termo.trim().toLowerCase();
  const visiveis = useMemo(() => {
    if (!conversas) return [];
    if (!busca) return conversas;
    return conversas.filter((conversation) => conversationLabel(conversation).toLowerCase().includes(busca));
  }, [conversas, busca]);

  const selecionadasIds = useMemo(
    () => new Set(selecionadas.map((conversation) => conversation.id)),
    [selecionadas],
  );

  function alternar(conversation: ConversationDto): void {
    onChange(
      selecionadasIds.has(conversation.id)
        ? selecionadas.filter((item) => item.id !== conversation.id)
        : [...selecionadas, conversation],
    );
  }

  /**
   * Marca as conversas visíveis até o teto. Vai até o limite e para: recusar
   * tudo porque a lista tem mais do que cabe seria pior do que marcar o que
   * cabe e dizer quantas entraram.
   */
  function marcarVisiveis(): void {
    const novas = [...selecionadas];
    for (const conversation of visiveis) {
      if (novas.length >= teto) break;
      if (!novas.some((item) => item.id === conversation.id)) novas.push(conversation);
    }
    onChange(novas);
  }

  const cheio = selecionadas.length >= teto;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <MultiSelect
          className="w-44"
          label="Conexão"
          groups={gruposInstancia}
          selected={instanceIds}
          onChange={setInstanceIds}
          searchPlaceholder="Buscar conexão"
          emptyLabel="Nenhuma conexão"
        />
        <MultiSelect
          className="w-56"
          label="Departamento ou atendente"
          groups={gruposAtendimento}
          selected={assignment}
          onChange={setAssignment}
          searchPlaceholder="Buscar departamento ou pessoa"
          emptyLabel="Nada encontrado"
        />
        <div className="relative min-w-[12rem] flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
          <Input
            className="pl-9"
            placeholder="Filtrar a lista pelo nome"
            value={termo}
            onChange={(event) => setTermo(event.target.value)}
          />
        </div>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-slate-500">
          {conversas === null
            ? "Carregando conversas..."
            : `${visiveis.length} de ${total} ${total === 1 ? "conversa" : "conversas"} no recorte`}
        </p>
        <div className="flex shrink-0 gap-1">
          <Button variant="ghost" size="sm" onClick={marcarVisiveis} disabled={cheio || visiveis.length === 0}>
            <CheckCheck className="h-3.5 w-3.5" /> Selecionar as visíveis
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => onChange([])}
            disabled={selecionadas.length === 0}
          >
            <Eraser className="h-3.5 w-3.5" /> Limpar
          </Button>
        </div>
      </div>

      {cheio ? (
        <p className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800 ring-1 ring-amber-200">
          Você chegou ao limite de {teto} conversas por análise. Para aumentar, use a aba Configurações.
        </p>
      ) : null}

      <div className="max-h-96 divide-y divide-slate-100 overflow-y-auto rounded-lg border border-slate-200">
        {conversas === null ? <Spinner className="mx-auto my-8 h-5 w-5" /> : null}
        {conversas !== null && visiveis.length === 0 ? (
          <p className="py-8 text-center text-sm text-slate-500">
            {busca ? "Nenhuma conversa com esse nome no recorte." : "Nenhuma conversa neste recorte."}
          </p>
        ) : null}
        {visiveis.map((conversation) => {
          const marcada = selecionadasIds.has(conversation.id);
          return (
            <label
              key={conversation.id}
              className={`flex cursor-pointer items-start gap-3 px-3 py-2 transition ${
                marcada ? "bg-brand-50" : "bg-white hover:bg-slate-50"
              }`}
            >
              <input
                type="checkbox"
                checked={marcada}
                onChange={() => alternar(conversation)}
                disabled={!marcada && cheio}
                className="mt-1 h-4 w-4 shrink-0 rounded border-slate-300 disabled:opacity-40"
              />
              <span className="min-w-0 flex-1">
                <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <span className="min-w-0 truncate text-sm font-medium text-slate-800">
                    {conversationLabel(conversation)}
                  </span>
                  <span className="shrink-0 rounded-full bg-slate-100 px-1.5 py-0.5 text-[10px] text-slate-600">
                    {conversation.type === "group" ? "Grupo" : "Individual"}
                  </span>
                </span>
                <span className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-slate-500">
                  {conversation.instanceName ? <span>{conversation.instanceName}</span> : null}
                  {conversation.department ? (
                    <span style={{ color: conversation.department.color ?? undefined }}>
                      {conversation.department.name}
                    </span>
                  ) : (
                    <span>Sem departamento</span>
                  )}
                  <span>
                    {conversation.assignedToAll
                      ? ALL_USERS_ASSIGNEE_LABEL
                      : (conversation.assignedUser?.name ?? "Sem responsável")}
                  </span>
                  {conversation.lastMessageAt ? (
                    <span>última mensagem em {formatDateTime(conversation.lastMessageAt)}</span>
                  ) : null}
                </span>
              </span>
            </label>
          );
        })}
      </div>

      {conversas !== null && conversas.length < total ? (
        <Button variant="outline" size="sm" onClick={carregarMais} disabled={carregandoMais}>
          {carregandoMais ? <Spinner className="h-3.5 w-3.5" /> : null}
          Carregar mais {Math.min(PAGINA, total - conversas.length)}
        </Button>
      ) : null}
    </div>
  );
}

export function conversationLabel(conversation: ConversationDto): string {
  return conversation.customTitle || conversation.title || "Conversa sem título";
}

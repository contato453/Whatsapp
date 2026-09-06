"use client";

import { useEffect, useState } from "react";
import { ArrowDown, ArrowUp, Plus, Save, Trash2, Zap } from "lucide-react";
import {
  CRM_STAGE_ACTION_TRIGGERS,
  CRM_STAGE_ACTION_TRIGGER_LABELS,
  CRM_STAGE_ACTION_TYPES,
  CRM_STAGE_ACTION_TYPE_HINTS,
  CRM_STAGE_ACTION_TYPE_LABELS,
  CRM_STAGE_TYPES,
  CRM_STAGE_TYPE_DESCRIPTIONS,
  CRM_STAGE_TYPE_LABELS,
  crmStageActionNeedsConversation,
  type CrmStageActionType,
} from "@azvchat/shared";
import { api, crmApi } from "@/lib/api";
import type {
  CrmPipelineDto,
  CrmStageActionDto,
  CrmStageDto,
  DepartmentDto,
  TagDto,
  UserDirectoryDto,
} from "@/lib/types";
import { Badge, Button, Card, Field, Input, Modal, Spinner, Textarea } from "@/components/ui";
import { CrmNav } from "@/components/crm/crm-nav";

/**
 * Configuração dos funis: colunas, probabilidades, prazos e AUTOMAÇÕES.
 *
 * As automações de etapa são o que o pedido chama de "ações ao mover de
 * etapa": cada uma chama um recurso que o AZVCHAT já tinha (etiqueta,
 * responsável, departamento, nota interna, mensagem agendada). A tela mostra
 * isso de forma explícita, com a explicação de cada tipo, porque automação
 * que ninguém entende é automação que ninguém liga — ou, pior, que alguém liga
 * sem saber que vai mandar mensagem para o cliente.
 */
export default function CrmPipelinesPage() {
  const [pipelines, setPipelines] = useState<CrmPipelineDto[]>([]);
  const [departments, setDepartments] = useState<DepartmentDto[]>([]);
  const [tags, setTags] = useState<TagDto[]>([]);
  const [users, setUsers] = useState<UserDirectoryDto[]>([]);
  const [selecionado, setSelecionado] = useState<string>("");
  const [carregando, setCarregando] = useState(true);
  const [erro, setErro] = useState<string | null>(null);
  const [novoFunil, setNovoFunil] = useState(false);
  const [etapaEmEdicao, setEtapaEmEdicao] = useState<CrmStageDto | null>(null);
  const [novaEtapa, setNovaEtapa] = useState(false);

  async function recarregar() {
    const lista = await crmApi.pipelines();
    setPipelines(lista);
    setSelecionado((atual) => atual || lista[0]?.id || "");
    setCarregando(false);
  }

  useEffect(() => {
    void recarregar().catch(() => setCarregando(false));
    void api
      .get<{ departments: DepartmentDto[] }>("/departments/mine")
      .then((d) => setDepartments(d.departments))
      .catch(() => undefined);
    void api.get<{ tags: TagDto[] }>("/tags").then((d) => setTags(d.tags)).catch(() => undefined);
    void api.get<{ users: UserDirectoryDto[] }>("/users").then((d) => setUsers(d.users)).catch(() => undefined);
  }, []);

  const funil = pipelines.find((item) => item.id === selecionado) ?? null;

  async function moverEtapa(indice: number, direcao: -1 | 1) {
    if (!funil) return;
    const ordem = [...funil.stages];
    const destino = indice + direcao;
    if (destino < 0 || destino >= ordem.length) return;
    const [movida] = ordem.splice(indice, 1);
    if (!movida) return;
    ordem.splice(destino, 0, movida);
    await crmApi.reorderStages(funil.id, ordem.map((stage) => stage.id));
    await recarregar();
  }

  return (
    <div className="flex h-full flex-col">
      <div className="px-4 pt-4">
        <h1 className="text-lg font-semibold text-slate-900">CRM</h1>
        <p className="text-xs text-slate-500">Funis, etapas e automações</p>
      </div>
      <CrmNav />

      <div className="thin-scroll min-h-0 flex-1 overflow-y-auto p-4">
        {carregando && <Spinner />}

        <div className="mb-3 flex flex-wrap items-center gap-2">
          {pipelines.map((item) => (
            <button
              key={item.id}
              onClick={() => setSelecionado(item.id)}
              className={
                item.id === selecionado
                  ? "rounded-lg border border-brand-500 bg-brand-50 px-3 py-1.5 text-xs font-medium text-brand-700"
                  : "rounded-lg border border-slate-200 px-3 py-1.5 text-xs text-slate-600 hover:bg-slate-50"
              }
            >
              {item.name}
              {!item.isActive && <span className="ml-1 text-slate-400">(inativo)</span>}
            </button>
          ))}
          <Button size="sm" variant="outline" onClick={() => setNovoFunil(true)}>
            <Plus className="h-3.5 w-3.5" /> Novo funil
          </Button>
        </div>

        {erro && <p className="mb-2 text-xs text-red-600">{erro}</p>}

        {funil && (
          <div className="space-y-4">
            <PipelineSettings
              pipeline={funil}
              departments={departments}
              tags={tags}
              onSaved={recarregar}
              onError={setErro}
            />

            <Card className="p-4">
              <div className="mb-3 flex items-center justify-between">
                <h2 className="text-sm font-semibold text-slate-800">Etapas do funil</h2>
                <Button size="sm" variant="outline" onClick={() => setNovaEtapa(true)}>
                  <Plus className="h-3.5 w-3.5" /> Nova etapa
                </Button>
              </div>
              <div className="space-y-2">
                {funil.stages.map((stage, indice) => (
                  <div
                    key={stage.id}
                    className="flex items-center gap-2 rounded-lg border border-slate-200 p-2"
                  >
                    <span
                      className="h-8 w-1.5 shrink-0 rounded-full"
                      style={{ backgroundColor: stage.color }}
                      aria-hidden
                    />
                    <div className="min-w-0 flex-1">
                      <p className="flex flex-wrap items-center gap-1.5 text-sm font-medium text-slate-800">
                        {stage.name}
                        <Badge className="bg-slate-100 text-slate-600">
                          {CRM_STAGE_TYPE_LABELS[stage.type]}
                        </Badge>
                        {stage.actions.length > 0 && (
                          <Badge className="bg-amber-50 text-amber-700">
                            <Zap className="h-3 w-3" /> {stage.actions.length} automação(ões)
                          </Badge>
                        )}
                      </p>
                      <p className="text-[11px] text-slate-500">
                        {stage.probability}% de chance
                        {stage.slaDays ? ` · alerta após ${stage.slaDays} dia(s) parada` : ""}
                      </p>
                    </div>
                    <div className="flex shrink-0 items-center gap-1">
                      <button
                        aria-label="Mover para cima"
                        disabled={indice === 0}
                        onClick={() => void moverEtapa(indice, -1)}
                        className="rounded p-1 text-slate-400 hover:bg-slate-100 disabled:opacity-30"
                      >
                        <ArrowUp className="h-3.5 w-3.5" />
                      </button>
                      <button
                        aria-label="Mover para baixo"
                        disabled={indice === funil.stages.length - 1}
                        onClick={() => void moverEtapa(indice, 1)}
                        className="rounded p-1 text-slate-400 hover:bg-slate-100 disabled:opacity-30"
                      >
                        <ArrowDown className="h-3.5 w-3.5" />
                      </button>
                      <Button size="sm" variant="ghost" onClick={() => setEtapaEmEdicao(stage)}>
                        Editar
                      </Button>
                      <button
                        aria-label={`Excluir ${stage.name}`}
                        onClick={async () => {
                          const destino = funil.stages.find((outra) => outra.id !== stage.id);
                          if (
                            !window.confirm(
                              `Excluir a etapa "${stage.name}"? As oportunidades dela vão para "${destino?.name ?? "—"}".`,
                            )
                          )
                            return;
                          try {
                            await crmApi.removeStage(stage.id, destino?.id);
                            await recarregar();
                          } catch (err) {
                            setErro(err instanceof Error ? err.message : "Não foi possível excluir");
                          }
                        }}
                        className="rounded p-1 text-red-500 hover:bg-red-50"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </Card>
          </div>
        )}
      </div>

      <NovoFunilModal
        open={novoFunil}
        departments={departments}
        onClose={() => setNovoFunil(false)}
        onCreated={recarregar}
      />

      {funil && (
        <StageModal
          open={novaEtapa || etapaEmEdicao !== null}
          pipelineId={funil.id}
          stage={etapaEmEdicao}
          tags={tags}
          users={users}
          departments={departments}
          onClose={() => {
            setNovaEtapa(false);
            setEtapaEmEdicao(null);
          }}
          onSaved={recarregar}
        />
      )}
    </div>
  );
}

/** Cabeçalho do funil: nome, cor, alcance por departamento e gatilho. */
function PipelineSettings({
  pipeline,
  departments,
  tags,
  onSaved,
  onError,
}: {
  pipeline: CrmPipelineDto;
  departments: DepartmentDto[];
  tags: TagDto[];
  onSaved: () => Promise<void>;
  onError: (message: string) => void;
}) {
  const [name, setName] = useState(pipeline.name);
  const [description, setDescription] = useState(pipeline.description ?? "");
  const [isGeneral, setIsGeneral] = useState(pipeline.isGeneral);
  const [departmentIds, setDepartmentIds] = useState<string[]>(
    pipeline.departments.map((item) => item.id),
  );
  const [autoCreateTagId, setAutoCreateTagId] = useState(pipeline.autoCreateTagId ?? "");
  const [isActive, setIsActive] = useState(pipeline.isActive);
  const [salvando, setSalvando] = useState(false);

  useEffect(() => {
    setName(pipeline.name);
    setDescription(pipeline.description ?? "");
    setIsGeneral(pipeline.isGeneral);
    setDepartmentIds(pipeline.departments.map((item) => item.id));
    setAutoCreateTagId(pipeline.autoCreateTagId ?? "");
    setIsActive(pipeline.isActive);
  }, [pipeline]);

  return (
    <Card className="p-4">
      <h2 className="mb-3 text-sm font-semibold text-slate-800">Configuração do funil</h2>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Nome">
          <Input value={name} onChange={(event) => setName(event.target.value)} />
        </Field>
        <Field label="Descrição">
          <Input value={description} onChange={(event) => setDescription(event.target.value)} />
        </Field>
      </div>

      <div className="mt-3">
        <p className="text-xs font-medium uppercase tracking-wide text-slate-500">
          Quem usa este funil
        </p>
        {/* Mesma regra de etiqueta e resposta rápida: geral OU pelo menos um
            departamento. Lista vazia não significa geral. */}
        <label className="mt-1 flex items-center gap-2 text-sm text-slate-700">
          <input
            type="checkbox"
            checked={isGeneral}
            onChange={(event) => {
              setIsGeneral(event.target.checked);
              if (event.target.checked) setDepartmentIds([]);
            }}
            className="h-4 w-4 accent-brand-600"
          />
          Todos os departamentos
        </label>
        {!isGeneral && (
          <div className="mt-1 flex flex-wrap gap-2">
            {departments.map((department) => (
              <label
                key={department.id}
                className="flex items-center gap-1.5 rounded-lg border border-slate-200 px-2 py-1 text-xs text-slate-700"
              >
                <input
                  type="checkbox"
                  checked={departmentIds.includes(department.id)}
                  onChange={(event) =>
                    setDepartmentIds((atual) =>
                      event.target.checked
                        ? [...atual, department.id]
                        : atual.filter((id) => id !== department.id),
                    )
                  }
                  className="h-3.5 w-3.5 accent-brand-600"
                />
                {department.name}
              </label>
            ))}
          </div>
        )}
      </div>

      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <Field label="Criar oportunidade automaticamente com a etiqueta">
          <select
            value={autoCreateTagId}
            onChange={(event) => setAutoCreateTagId(event.target.value)}
            className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm"
          >
            <option value="">Desligado</option>
            {tags.map((tag) => (
              <option key={tag.id} value={tag.id}>
                {tag.name}
              </option>
            ))}
          </select>
        </Field>
        <label className="flex items-end gap-2 pb-2 text-sm text-slate-700">
          <input
            type="checkbox"
            checked={isActive}
            onChange={(event) => setIsActive(event.target.checked)}
            className="h-4 w-4 accent-brand-600"
          />
          Funil ativo
        </label>
      </div>
      <p className="mt-1 text-[11px] text-slate-500">
        Com uma etiqueta escolhida, pendurá-la numa conversa abre um card na primeira etapa deste
        funil. A mesma conversa nunca gera duas oportunidades abertas aqui.
      </p>

      <div className="mt-3 flex justify-end">
        <Button
          size="sm"
          disabled={salvando}
          onClick={async () => {
            setSalvando(true);
            try {
              await crmApi.updatePipeline(pipeline.id, {
                name,
                description: description || null,
                isGeneral,
                departmentIds,
                autoCreateTagId: autoCreateTagId || null,
                isActive,
              });
              await onSaved();
            } catch (err) {
              onError(err instanceof Error ? err.message : "Não foi possível salvar");
            } finally {
              setSalvando(false);
            }
          }}
        >
          <Save className="h-3.5 w-3.5" /> Salvar funil
        </Button>
      </div>
    </Card>
  );
}

function NovoFunilModal({
  open,
  departments,
  onClose,
  onCreated,
}: {
  open: boolean;
  departments: DepartmentDto[];
  onClose: () => void;
  onCreated: () => Promise<void>;
}) {
  const [name, setName] = useState("");
  const [isGeneral, setIsGeneral] = useState(true);
  const [departmentIds, setDepartmentIds] = useState<string[]>([]);
  const [erro, setErro] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setName("");
      setIsGeneral(true);
      setDepartmentIds([]);
      setErro(null);
    }
  }, [open]);

  return (
    <Modal open={open} onClose={onClose} title="Novo funil">
      <div className="space-y-3">
        <Field label="Nome">
          <Input
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="Ex.: Cobrança"
          />
        </Field>
        <label className="flex items-center gap-2 text-sm text-slate-700">
          <input
            type="checkbox"
            checked={isGeneral}
            onChange={(event) => {
              setIsGeneral(event.target.checked);
              if (event.target.checked) setDepartmentIds([]);
            }}
            className="h-4 w-4 accent-brand-600"
          />
          Disponível para todos os departamentos
        </label>
        {!isGeneral && (
          <div className="flex flex-wrap gap-2">
            {departments.map((department) => (
              <label
                key={department.id}
                className="flex items-center gap-1.5 rounded-lg border border-slate-200 px-2 py-1 text-xs"
              >
                <input
                  type="checkbox"
                  checked={departmentIds.includes(department.id)}
                  onChange={(event) =>
                    setDepartmentIds((atual) =>
                      event.target.checked
                        ? [...atual, department.id]
                        : atual.filter((id) => id !== department.id),
                    )
                  }
                  className="h-3.5 w-3.5 accent-brand-600"
                />
                {department.name}
              </label>
            ))}
          </div>
        )}
        <p className="text-[11px] text-slate-500">
          O funil nasce sem etapas. Crie as colunas em seguida — sem elas não há onde arrastar.
        </p>
        {erro && <p className="text-xs text-red-600">{erro}</p>}
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            Cancelar
          </Button>
          <Button
            disabled={!name.trim() || (!isGeneral && departmentIds.length === 0)}
            onClick={async () => {
              try {
                await crmApi.createPipeline({ name: name.trim(), isGeneral, departmentIds });
                await onCreated();
                onClose();
              } catch (err) {
                setErro(err instanceof Error ? err.message : "Não foi possível criar");
              }
            }}
          >
            Criar funil
          </Button>
        </div>
      </div>
    </Modal>
  );
}

type AcaoRascunho = Omit<CrmStageActionDto, "id" | "stageId" | "position">;

/** Etapa: nome, tipo, probabilidade, SLA e a lista de automações. */
function StageModal({
  open,
  pipelineId,
  stage,
  tags,
  users,
  departments,
  onClose,
  onSaved,
}: {
  open: boolean;
  pipelineId: string;
  stage: CrmStageDto | null;
  tags: TagDto[];
  users: UserDirectoryDto[];
  departments: DepartmentDto[];
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const [name, setName] = useState("");
  const [color, setColor] = useState("#64748b");
  const [probability, setProbability] = useState("0");
  const [type, setType] = useState<string>("in_progress");
  const [slaDays, setSlaDays] = useState("");
  const [acoes, setAcoes] = useState<AcaoRascunho[]>([]);
  const [erro, setErro] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setErro(null);
    if (stage) {
      setName(stage.name);
      setColor(stage.color);
      setProbability(String(stage.probability));
      setType(stage.type);
      setSlaDays(stage.slaDays != null ? String(stage.slaDays) : "");
      setAcoes(
        stage.actions.map((acao) => ({
          trigger: acao.trigger,
          type: acao.type,
          tagId: acao.tagId,
          userId: acao.userId,
          departmentId: acao.departmentId,
          delayMinutes: acao.delayMinutes,
          content: acao.content,
        })),
      );
      return;
    }
    setName("");
    setColor("#64748b");
    setProbability("0");
    setType("in_progress");
    setSlaDays("");
    setAcoes([]);
  }, [open, stage]);

  return (
    <Modal open={open} onClose={onClose} wide title={stage ? "Editar etapa" : "Nova etapa"}>
      <div className="space-y-3">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Nome">
            <Input value={name} onChange={(event) => setName(event.target.value)} />
          </Field>
          <Field label="Cor">
            <input
              type="color"
              value={color}
              onChange={(event) => setColor(event.target.value)}
              className="h-9 w-full rounded-lg border border-slate-300"
            />
          </Field>
        </div>

        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Probabilidade (%)">
            <Input
              value={probability}
              onChange={(event) => setProbability(event.target.value)}
              inputMode="numeric"
            />
          </Field>
          <Field label="Tipo da etapa">
            <select
              value={type}
              onChange={(event) => setType(event.target.value)}
              className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm"
            >
              {CRM_STAGE_TYPES.map((item) => (
                <option key={item} value={item}>
                  {CRM_STAGE_TYPE_LABELS[item]}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Alerta de parada (dias)">
            <Input
              value={slaDays}
              onChange={(event) => setSlaDays(event.target.value)}
              inputMode="numeric"
              placeholder="sem prazo"
            />
          </Field>
        </div>
        <p className="rounded-lg bg-slate-50 px-3 py-2 text-[11px] text-slate-600">
          {CRM_STAGE_TYPE_DESCRIPTIONS[type as keyof typeof CRM_STAGE_TYPE_DESCRIPTIONS]}
        </p>

        <div>
          <div className="flex items-center justify-between">
            <p className="text-xs font-medium uppercase tracking-wide text-slate-500">
              Automações desta etapa
            </p>
            <Button
              size="sm"
              variant="outline"
              onClick={() =>
                setAcoes((atual) => [
                  ...atual,
                  {
                    trigger: "enter",
                    type: "add_tag",
                    tagId: null,
                    userId: null,
                    departmentId: null,
                    delayMinutes: 0,
                    content: null,
                  },
                ])
              }
            >
              <Plus className="h-3.5 w-3.5" /> Adicionar
            </Button>
          </div>

          <div className="mt-2 space-y-2">
            {acoes.length === 0 && (
              <p className="rounded-lg border border-dashed border-slate-200 px-3 py-4 text-center text-[11px] text-slate-400">
                Nenhuma automação. Ao mover um card para cá, nada acontece além da própria
                movimentação.
              </p>
            )}
            {acoes.map((acao, indice) => (
              <div key={indice} className="rounded-lg border border-slate-200 p-2">
                <div className="grid gap-2 sm:grid-cols-2">
                  <select
                    value={acao.trigger}
                    onChange={(event) =>
                      setAcoes((atual) =>
                        atual.map((item, i) =>
                          i === indice
                            ? { ...item, trigger: event.target.value as AcaoRascunho["trigger"] }
                            : item,
                        ),
                      )
                    }
                    className="rounded-lg border border-slate-300 bg-white px-2 py-1.5 text-xs"
                  >
                    {CRM_STAGE_ACTION_TRIGGERS.map((item) => (
                      <option key={item} value={item}>
                        {CRM_STAGE_ACTION_TRIGGER_LABELS[item]}
                      </option>
                    ))}
                  </select>
                  <select
                    value={acao.type}
                    onChange={(event) =>
                      setAcoes((atual) =>
                        atual.map((item, i) =>
                          i === indice
                            ? { ...item, type: event.target.value as CrmStageActionType }
                            : item,
                        ),
                      )
                    }
                    className="rounded-lg border border-slate-300 bg-white px-2 py-1.5 text-xs"
                  >
                    {CRM_STAGE_ACTION_TYPES.map((item) => (
                      <option key={item} value={item}>
                        {CRM_STAGE_ACTION_TYPE_LABELS[item]}
                      </option>
                    ))}
                  </select>
                </div>

                <p className="mt-1 text-[11px] text-slate-500">
                  {CRM_STAGE_ACTION_TYPE_HINTS[acao.type]}
                  {crmStageActionNeedsConversation(acao.type) && (
                    <span className="text-slate-400">
                      {" "}
                      Em oportunidade sem conversa vinculada, esta ação é ignorada.
                    </span>
                  )}
                </p>

                <div className="mt-2 grid gap-2 sm:grid-cols-2">
                  {(acao.type === "add_tag" || acao.type === "remove_tag") && (
                    <select
                      value={acao.tagId ?? ""}
                      onChange={(event) =>
                        setAcoes((atual) =>
                          atual.map((item, i) =>
                            i === indice ? { ...item, tagId: event.target.value || null } : item,
                          ),
                        )
                      }
                      className="rounded-lg border border-slate-300 bg-white px-2 py-1.5 text-xs"
                    >
                      <option value="">Escolha a etiqueta</option>
                      {tags.map((tag) => (
                        <option key={tag.id} value={tag.id}>
                          {tag.name}
                        </option>
                      ))}
                    </select>
                  )}
                  {(acao.type === "assign_user" || acao.type === "create_activity") && (
                    <select
                      value={acao.userId ?? ""}
                      onChange={(event) =>
                        setAcoes((atual) =>
                          atual.map((item, i) =>
                            i === indice ? { ...item, userId: event.target.value || null } : item,
                          ),
                        )
                      }
                      className="rounded-lg border border-slate-300 bg-white px-2 py-1.5 text-xs"
                    >
                      <option value="">
                        {acao.type === "assign_user" ? "Escolha a pessoa" : "Sem responsável fixo"}
                      </option>
                      {users
                        .filter((item) => item.status === "active")
                        .map((item) => (
                          <option key={item.id} value={item.id}>
                            {item.name}
                          </option>
                        ))}
                    </select>
                  )}
                  {acao.type === "change_department" && (
                    <select
                      value={acao.departmentId ?? ""}
                      onChange={(event) =>
                        setAcoes((atual) =>
                          atual.map((item, i) =>
                            i === indice
                              ? { ...item, departmentId: event.target.value || null }
                              : item,
                          ),
                        )
                      }
                      className="rounded-lg border border-slate-300 bg-white px-2 py-1.5 text-xs"
                    >
                      <option value="">Escolha o departamento</option>
                      {departments.map((item) => (
                        <option key={item.id} value={item.id}>
                          {item.name}
                        </option>
                      ))}
                    </select>
                  )}
                  {(acao.type === "schedule_message" || acao.type === "create_activity") && (
                    <label className="flex items-center gap-1 text-[11px] text-slate-600">
                      Depois de
                      <Input
                        value={String(acao.delayMinutes)}
                        onChange={(event) =>
                          setAcoes((atual) =>
                            atual.map((item, i) =>
                              i === indice
                                ? { ...item, delayMinutes: Number(event.target.value) || 0 }
                                : item,
                            ),
                          )
                        }
                        inputMode="numeric"
                        className="h-7 w-20 py-0.5 text-xs"
                      />
                      minutos
                    </label>
                  )}
                </div>

                {(acao.type === "schedule_message" ||
                  acao.type === "internal_note" ||
                  acao.type === "create_activity") && (
                  <Textarea
                    rows={2}
                    value={acao.content ?? ""}
                    onChange={(event) =>
                      setAcoes((atual) =>
                        atual.map((item, i) =>
                          i === indice ? { ...item, content: event.target.value } : item,
                        ),
                      )
                    }
                    placeholder={
                      acao.type === "schedule_message"
                        ? "Mensagem que sairá para o cliente"
                        : acao.type === "internal_note"
                          ? "Nota interna (o cliente nunca vê)"
                          : "Título da atividade"
                    }
                    className="mt-2 text-xs"
                  />
                )}

                <div className="mt-1 flex justify-end">
                  <button
                    onClick={() => setAcoes((atual) => atual.filter((_, i) => i !== indice))}
                    className="text-[11px] text-red-600 hover:underline"
                  >
                    Remover automação
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>

        {erro && <p className="text-xs text-red-600">{erro}</p>}

        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            Cancelar
          </Button>
          <Button
            disabled={!name.trim()}
            onClick={async () => {
              const payload = {
                name: name.trim(),
                color,
                probability: Math.max(0, Math.min(100, Number(probability) || 0)),
                type,
                slaDays: slaDays ? Number(slaDays) : null,
                actions: acoes.map((acao) => ({
                  ...acao,
                  content: acao.content || null,
                })),
              };
              try {
                if (stage) {
                  await crmApi.updateStage(stage.id, payload);
                } else {
                  await crmApi.createStage(pipelineId, payload);
                }
                await onSaved();
                onClose();
              } catch (err) {
                setErro(err instanceof Error ? err.message : "Não foi possível salvar");
              }
            }}
          >
            <Save className="h-3.5 w-3.5" /> Salvar etapa
          </Button>
        </div>
      </div>
    </Modal>
  );
}

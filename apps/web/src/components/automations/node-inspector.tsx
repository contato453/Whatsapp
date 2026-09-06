"use client";

import { useState } from "react";
import { Plus, Trash2, X } from "lucide-react";
import {
  AUTOMATION_ANSWER_TYPE_LABELS,
  AUTOMATION_ANSWER_TYPES,
  AUTOMATION_CONDITION_FIELDS,
  AUTOMATION_CONDITION_FIELD_LABELS,
  AUTOMATION_NODE_TYPE_DEFINITIONS,
  AUTOMATION_WAIT_UNITS,
  type AskQuestionNodeData,
  type AssignUserNodeData,
  type AutomationConditionField,
  type AutomationNodeType,
  type ChangeStatusNodeData,
  type ConditionNodeData,
  type FinishNodeData,
  type ForwardDepartmentNodeData,
  type MenuNodeData,
  type SendMessageNodeData,
  type TagNodeData,
  type WaitNodeData,
  type WebhookNodeData,
} from "@azvchat/shared";
import { Button, Field, Input, Textarea } from "@/components/ui";
import type { DepartmentDto, TagDto, UserDirectoryDto } from "@/lib/types";

const SELECT_CLASS =
  "w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 focus:border-brand-600 focus:outline-none focus:ring-2 focus:ring-brand-500/20";

interface InspectorProps {
  kind: AutomationNodeType;
  config: Record<string, unknown>;
  onChange: (config: Record<string, unknown>) => void;
  onDelete: () => void;
  onClose: () => void;
  tags: TagDto[];
  departments: DepartmentDto[];
  users: UserDirectoryDto[];
}

function slug(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "") || `opcao_${Math.random().toString(36).slice(2, 6)}`;
}

export function NodeInspector({ kind, config, onChange, onDelete, onClose, tags, departments, users }: InspectorProps) {
  const definition = AUTOMATION_NODE_TYPE_DEFINITIONS[kind];

  function set<T extends Record<string, unknown>>(patch: Partial<T>): void {
    onChange({ ...config, ...patch });
  }

  return (
    <div className="flex h-full w-80 shrink-0 flex-col border-l border-slate-200 bg-white">
      <div className="flex items-center justify-between border-b border-slate-100 px-4 py-3">
        <div>
          <p className="text-xs uppercase tracking-wide text-slate-400">Bloco</p>
          <h3 className="text-sm font-semibold text-slate-900">{definition.label}</h3>
        </div>
        <button onClick={onClose} className="rounded-lg p-1 text-slate-400 hover:bg-slate-100" aria-label="Fechar">
          <X className="h-4 w-4" />
        </button>
      </div>
      <div className="thin-scroll flex-1 space-y-4 overflow-y-auto p-4">
        {kind === "trigger" && (
          <p className="text-sm text-slate-500">
            O gatilho é configurado na barra de cima (tipo de disparo, palavras-chave, número).
          </p>
        )}

        {kind === "send_message" && <SendMessageFields config={config as unknown as SendMessageNodeData} set={set} />}
        {kind === "ask_question" && <AskQuestionFields config={config as unknown as AskQuestionNodeData} set={set} />}
        {kind === "menu" && <MenuFields config={config as unknown as MenuNodeData} set={set} />}
        {kind === "condition" && <ConditionFields config={config as unknown as ConditionNodeData} set={set} tags={tags} departments={departments} />}
        {kind === "wait" && <WaitFields config={config as unknown as WaitNodeData} set={set} />}
        {(kind === "tag_add" || kind === "tag_remove") && (
          <TagField tagId={(config as unknown as TagNodeData).tagId} tags={tags} onChange={(tagId) => set({ tagId })} />
        )}
        {kind === "change_status" && <ChangeStatusFields config={config as unknown as ChangeStatusNodeData} set={set} />}
        {kind === "forward_department" && (
          <DepartmentField
            departmentId={(config as unknown as ForwardDepartmentNodeData).departmentId}
            departments={departments}
            onChange={(departmentId) => set({ departmentId })}
          />
        )}
        {kind === "assign_user" && (
          <UserField userId={(config as unknown as AssignUserNodeData).userId} users={users} onChange={(userId) => set({ userId })} />
        )}
        {kind === "unassign" && (
          <p className="text-sm text-slate-500">Tira o responsável da conversa — sem configuração adicional.</p>
        )}
        {kind === "webhook" && <WebhookFields config={config as unknown as WebhookNodeData} set={set} />}
        {kind === "finish" && (
          <FinishFields config={config as unknown as FinishNodeData} set={set} tags={tags} />
        )}

        <div className="border-t border-slate-100 pt-4">
          <Button variant="danger" size="sm" onClick={onDelete}>
            <Trash2 className="h-3.5 w-3.5" />
            Excluir bloco
          </Button>
        </div>
      </div>
    </div>
  );
}

function SendMessageFields({
  config,
  set,
}: {
  config: SendMessageNodeData;
  set: (patch: Partial<SendMessageNodeData>) => void;
}) {
  return (
    <>
      <Field label="Tipo">
        <select
          className={SELECT_CLASS}
          value={config.messageType ?? "text"}
          onChange={(event) => set({ messageType: event.target.value as SendMessageNodeData["messageType"] })}
        >
          <option value="text">Texto</option>
          <option value="image">Imagem</option>
          <option value="audio">Áudio</option>
          <option value="video">Vídeo</option>
          <option value="document">Documento</option>
          <option value="link">Link</option>
        </select>
      </Field>
      {config.messageType && config.messageType !== "text" && (
        <p className="rounded-lg bg-amber-50 p-2 text-xs text-amber-700">
          Envio de mídia por este bloco ainda não é enviado pelo motor nesta entrega — use texto
          por enquanto (ver o relatório de entrega).
        </p>
      )}
      <Field label="Texto (aceita variáveis, ex.: {{primeiro_nome}})">
        <Textarea rows={4} value={config.text ?? ""} onChange={(event) => set({ text: event.target.value })} />
      </Field>
    </>
  );
}

function AskQuestionFields({
  config,
  set,
}: {
  config: AskQuestionNodeData;
  set: (patch: Partial<AskQuestionNodeData>) => void;
}) {
  return (
    <>
      <Field label="Pergunta">
        <Textarea rows={3} value={config.question ?? ""} onChange={(event) => set({ question: event.target.value })} />
      </Field>
      <Field label="Tipo de resposta">
        <select
          className={SELECT_CLASS}
          value={config.answerType ?? "text"}
          onChange={(event) => set({ answerType: event.target.value as AskQuestionNodeData["answerType"] })}
        >
          {AUTOMATION_ANSWER_TYPES.map((type) => (
            <option key={type} value={type}>
              {AUTOMATION_ANSWER_TYPE_LABELS[type]}
            </option>
          ))}
        </select>
      </Field>
      {config.answerType === "option" && (
        <Field label="Opções aceitas (uma por linha)">
          <Textarea
            rows={3}
            value={(config.options ?? []).join("\n")}
            onChange={(event) => set({ options: event.target.value.split("\n").map((v) => v.trim()).filter(Boolean) })}
          />
        </Field>
      )}
      <Field label="Guardar resposta em (nome da variável)">
        <Input
          value={config.saveKey ?? ""}
          onChange={(event) => set({ saveKey: slug(event.target.value) })}
          placeholder="ex.: documento_cliente"
        />
      </Field>
      <p className="text-xs text-slate-400">
        Disponível depois como <code>{`{{campo.${config.saveKey || "..."}}}`}</code>
      </p>
      <Field label="Desistir depois de quantos minutos (opcional)">
        <Input
          type="number"
          min={0}
          value={config.timeoutMinutes ?? ""}
          onChange={(event) =>
            set({ timeoutMinutes: event.target.value ? Number(event.target.value) : undefined })
          }
        />
      </Field>
    </>
  );
}

function MenuFields({ config, set }: { config: MenuNodeData; set: (patch: Partial<MenuNodeData>) => void }) {
  const options = config.options ?? [];
  return (
    <>
      <Field label="Pergunta do menu">
        <Textarea rows={3} value={config.question ?? ""} onChange={(event) => set({ question: event.target.value })} />
      </Field>
      <div>
        <p className="mb-1.5 text-xs font-medium uppercase tracking-wide text-slate-500">Opções</p>
        <div className="space-y-2">
          {options.map((option, index) => (
            <div key={option.id} className="flex items-center gap-1.5">
              <Input
                value={option.label}
                onChange={(event) => {
                  const next = [...options];
                  next[index] = { ...option, label: event.target.value };
                  set({ options: next });
                }}
                placeholder={`Opção ${index + 1}`}
              />
              <button
                type="button"
                onClick={() => set({ options: options.filter((_, i) => i !== index) })}
                className="shrink-0 rounded-lg p-1.5 text-slate-400 hover:bg-slate-100 hover:text-red-500"
                aria-label="Remover opção"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </div>
          ))}
        </div>
        <Button
          variant="outline"
          size="sm"
          className="mt-2"
          onClick={() => {
            const label = `Opção ${options.length + 1}`;
            set({ options: [...options, { id: slug(label) + "_" + (options.length + 1), label }] });
          }}
        >
          <Plus className="h-3.5 w-3.5" />
          Adicionar opção
        </Button>
      </div>
    </>
  );
}

function ConditionFields({
  config,
  set,
  tags,
  departments,
}: {
  config: ConditionNodeData;
  set: (patch: Partial<ConditionNodeData>) => void;
  tags: TagDto[];
  departments: DepartmentDto[];
}) {
  const clauses = config.clauses ?? [];
  function updateClause(index: number, patch: Partial<ConditionNodeData["clauses"][number]>) {
    const next = [...clauses];
    next[index] = { ...next[index], ...patch } as ConditionNodeData["clauses"][number];
    set({ clauses: next });
  }
  return (
    <>
      {clauses.length > 1 && (
        <Field label="Combinar condições com">
          <select
            className={SELECT_CLASS}
            value={config.combinator ?? "and"}
            onChange={(event) => set({ combinator: event.target.value as "and" | "or" })}
          >
            <option value="and">E (todas precisam ser verdadeiras)</option>
            <option value="or">OU (basta uma ser verdadeira)</option>
          </select>
        </Field>
      )}
      <div className="space-y-3">
        {clauses.map((clause, index) => (
          <div key={index} className="space-y-1.5 rounded-lg border border-slate-200 p-2.5">
            <select
              className={SELECT_CLASS}
              value={clause.field}
              onChange={(event) => updateClause(index, { field: event.target.value as AutomationConditionField })}
            >
              {AUTOMATION_CONDITION_FIELDS.map((field) => (
                <option key={field} value={field}>
                  {AUTOMATION_CONDITION_FIELD_LABELS[field]}
                </option>
              ))}
            </select>
            <ConditionValueInput clause={clause} tags={tags} departments={departments} onChange={(value) => updateClause(index, { value })} />
            {clause.field === "field_equals" && (
              <Input
                placeholder="nome da variável (saveKey)"
                value={clause.key ?? ""}
                onChange={(event) => updateClause(index, { key: event.target.value })}
              />
            )}
            <button
              type="button"
              onClick={() => set({ clauses: clauses.filter((_, i) => i !== index) })}
              className="text-xs text-red-500 hover:underline"
            >
              Remover condição
            </button>
          </div>
        ))}
      </div>
      <Button
        variant="outline"
        size="sm"
        onClick={() => set({ clauses: [...clauses, { field: "business_hours", value: "true" }] })}
      >
        <Plus className="h-3.5 w-3.5" />
        Adicionar condição
      </Button>
    </>
  );
}

function ConditionValueInput({
  clause,
  tags,
  departments,
  onChange,
}: {
  clause: { field: AutomationConditionField; value: string };
  tags: TagDto[];
  departments: DepartmentDto[];
  onChange: (value: string) => void;
}) {
  if (clause.field === "business_hours" || clause.field === "has_assignee") {
    return (
      <select className={SELECT_CLASS} value={clause.value} onChange={(event) => onChange(event.target.value)}>
        <option value="true">Sim</option>
        <option value="false">Não</option>
      </select>
    );
  }
  if (clause.field === "has_tag" || clause.field === "not_has_tag") {
    return (
      <select className={SELECT_CLASS} value={clause.value} onChange={(event) => onChange(event.target.value)}>
        <option value="">Selecione a etiqueta</option>
        {tags.map((tag) => (
          <option key={tag.id} value={tag.id}>
            {tag.name}
          </option>
        ))}
      </select>
    );
  }
  if (clause.field === "department") {
    return (
      <select className={SELECT_CLASS} value={clause.value} onChange={(event) => onChange(event.target.value)}>
        <option value="">Selecione o departamento</option>
        {departments.map((department) => (
          <option key={department.id} value={department.id}>
            {department.name}
          </option>
        ))}
      </select>
    );
  }
  if (clause.field === "conversation_status") {
    return (
      <select className={SELECT_CLASS} value={clause.value} onChange={(event) => onChange(event.target.value)}>
        <option value="open">Aberto</option>
        <option value="waiting_client">AG. Cliente</option>
        <option value="waiting_internal">AG. Operacional</option>
        <option value="resolved">Concluído</option>
      </select>
    );
  }
  if (clause.field === "weekday") {
    return (
      <select className={SELECT_CLASS} value={clause.value} onChange={(event) => onChange(event.target.value)}>
        {["Domingo", "Segunda", "Terça", "Quarta", "Quinta", "Sexta", "Sábado"].map((label, index) => (
          <option key={index} value={String(index)}>
            {label}
          </option>
        ))}
      </select>
    );
  }
  return <Input value={clause.value} onChange={(event) => onChange(event.target.value)} placeholder="Valor" />;
}

function WaitFields({ config, set }: { config: WaitNodeData; set: (patch: Partial<WaitNodeData>) => void }) {
  return (
    <>
      <Field label="Modo">
        <select
          className={SELECT_CLASS}
          value={config.mode ?? "duration"}
          onChange={(event) => set({ mode: event.target.value as WaitNodeData["mode"] })}
        >
          <option value="duration">Por um tempo fixo</option>
          <option value="until_next_business_hours">Até o próximo expediente</option>
        </select>
      </Field>
      {(config.mode ?? "duration") === "duration" && (
        <div className="flex gap-2">
          <div className="w-24">
            <Field label="Quanto">
              <Input
                type="number"
                min={1}
                value={config.amount ?? 1}
                onChange={(event) => set({ amount: Number(event.target.value) || 1 })}
              />
            </Field>
          </div>
          <div className="flex-1">
            <Field label="Unidade">
              <select
                className={SELECT_CLASS}
                value={config.unit ?? "minutes"}
                onChange={(event) => set({ unit: event.target.value as WaitNodeData["unit"] })}
              >
                {AUTOMATION_WAIT_UNITS.map((unit) => (
                  <option key={unit} value={unit}>
                    {unit === "minutes" ? "Minutos" : unit === "hours" ? "Horas" : "Dias"}
                  </option>
                ))}
              </select>
            </Field>
          </div>
        </div>
      )}
      <label className="flex items-start gap-2 text-sm text-slate-700">
        <input
          type="checkbox"
          className="mt-0.5 h-4 w-4 rounded border-slate-300 text-brand-600 focus:ring-brand-500/30"
          checked={config.resumeOnReply ?? false}
          onChange={(event) => set({ resumeOnReply: event.target.checked })}
        />
        <span>
          Uma resposta do cliente durante a espera interrompe o timer
          <span className="block text-xs text-slate-500">
            Liga a saída extra "Cliente respondeu", além de "Tempo esgotado".
          </span>
        </span>
      </label>
    </>
  );
}

function TagField({ tagId, tags, onChange }: { tagId: string; tags: TagDto[]; onChange: (value: string) => void }) {
  return (
    <Field label="Etiqueta">
      <select className={SELECT_CLASS} value={tagId ?? ""} onChange={(event) => onChange(event.target.value)}>
        <option value="">Selecione</option>
        {tags.map((tag) => (
          <option key={tag.id} value={tag.id}>
            {tag.name}
          </option>
        ))}
      </select>
    </Field>
  );
}

function DepartmentField({
  departmentId,
  departments,
  onChange,
}: {
  departmentId: string;
  departments: DepartmentDto[];
  onChange: (value: string) => void;
}) {
  return (
    <Field label="Departamento">
      <select className={SELECT_CLASS} value={departmentId ?? ""} onChange={(event) => onChange(event.target.value)}>
        <option value="">Selecione</option>
        {departments.map((department) => (
          <option key={department.id} value={department.id}>
            {department.name}
          </option>
        ))}
      </select>
    </Field>
  );
}

function UserField({
  userId,
  users,
  onChange,
}: {
  userId: string;
  users: UserDirectoryDto[];
  onChange: (value: string) => void;
}) {
  return (
    <Field label="Atendente">
      <select className={SELECT_CLASS} value={userId ?? ""} onChange={(event) => onChange(event.target.value)}>
        <option value="">Selecione</option>
        {users
          .filter((user) => user.status === "active")
          .map((user) => (
            <option key={user.id} value={user.id}>
              {user.name}
            </option>
          ))}
      </select>
    </Field>
  );
}

function ChangeStatusFields({
  config,
  set,
}: {
  config: ChangeStatusNodeData;
  set: (patch: Partial<ChangeStatusNodeData>) => void;
}) {
  return (
    <Field label="Novo status">
      <select
        className={SELECT_CLASS}
        value={config.status ?? "open"}
        onChange={(event) => set({ status: event.target.value as ChangeStatusNodeData["status"] })}
      >
        <option value="open">Aberto</option>
        <option value="waiting_client">AG. Cliente</option>
        <option value="waiting_internal">AG. Operacional</option>
        <option value="resolved">Concluído</option>
      </select>
    </Field>
  );
}

function WebhookFields({ config, set }: { config: WebhookNodeData; set: (patch: Partial<WebhookNodeData>) => void }) {
  const [headersText, setHeadersText] = useState(() => JSON.stringify(config.headers ?? {}, null, 2));
  return (
    <>
      <Field label="URL (POST)">
        <Input value={config.url ?? ""} onChange={(event) => set({ url: event.target.value })} placeholder="https://..." />
      </Field>
      <Field label="Cabeçalhos extras (JSON, opcional)">
        <Textarea
          rows={3}
          value={headersText}
          onChange={(event) => {
            setHeadersText(event.target.value);
            try {
              set({ headers: JSON.parse(event.target.value || "{}") });
            } catch {
              // JSON inválido enquanto digita — não grava até fechar corretamente.
            }
          }}
        />
      </Field>
    </>
  );
}

function FinishFields({
  config,
  set,
  tags,
}: {
  config: FinishNodeData;
  set: (patch: Partial<FinishNodeData>) => void;
  tags: TagDto[];
}) {
  return (
    <>
      <Field label="Mensagem final (opcional)">
        <Textarea rows={3} value={config.message ?? ""} onChange={(event) => set({ message: event.target.value })} />
      </Field>
      <label className="flex items-center gap-2 text-sm text-slate-700">
        <input
          type="checkbox"
          className="h-4 w-4 rounded border-slate-300 text-brand-600 focus:ring-brand-500/30"
          checked={config.resolveConversation ?? false}
          onChange={(event) => set({ resolveConversation: event.target.checked })}
        />
        Marcar atendimento como concluído
      </label>
      <label className="flex items-center gap-2 text-sm text-slate-700">
        <input
          type="checkbox"
          className="h-4 w-4 rounded border-slate-300 text-brand-600 focus:ring-brand-500/30"
          checked={config.generateProtocol ?? false}
          onChange={(event) => set({ generateProtocol: event.target.checked })}
        />
        Gerar protocolo (disponível como <code className="ml-1">{"{{protocolo}}"}</code>)
      </label>
      <TagField tagId={config.addTagId ?? ""} tags={tags} onChange={(value) => set({ addTagId: value || undefined })} />
    </>
  );
}

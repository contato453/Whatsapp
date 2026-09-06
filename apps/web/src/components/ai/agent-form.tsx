"use client";

import { useMemo, useState } from "react";
import { ChevronDown, ChevronRight, Plus, Trash2 } from "lucide-react";
import {
  AI_ASSIGNEE_MODES,
  AI_ASSIGNEE_MODE_LABELS,
  AI_BEHAVIOR_KEYS,
  AI_BEHAVIOR_LABELS,
  AI_CAPABILITIES,
  AI_COLLECTION_ORDERS,
  AI_COLLECTION_ORDER_LABELS,
  AI_CONFIG_LIMITS,
  AI_EMOJI_USAGES,
  AI_EMOJI_USAGE_LABELS,
  AI_HANDOFF_TRIGGER_KEYS,
  AI_HANDOFF_TRIGGER_LABELS,
  AI_RESPONSE_LENGTHS,
  AI_RESPONSE_LENGTH_LABELS,
  AI_SUGGESTED_COLLECT_FIELDS,
  AI_TONES,
  AI_TONE_LABELS,
  type AiAgentConfig,
  type AiCollectField,
  type AiKnowledgeSourceDto,
  type AiModelDto,
} from "@azvchat/shared";
import type { AiAgentInput } from "@/lib/api";
import type { DepartmentDto, UserDirectoryDto } from "@/lib/types";
import { Button, Field, Input, Textarea } from "@/components/ui";
import { DepartmentCheckboxes } from "@/components/department-picker";
import { Notice, Section, Select, Toggle } from "./ai-ui";

/**
 * O formulário do agente: CAMPOS ESTRUTURADOS, cada seção da tela é uma
 * seção de `AiAgentConfig`. O prompt é montado na API a partir daqui — o
 * administrador nunca escreve um prompt único.
 */

export interface AgentFormOptions {
  departments: DepartmentDto[];
  allDepartments: DepartmentDto[];
  users: UserDirectoryDto[];
  knowledge: AiKnowledgeSourceDto[];
  models: AiModelDto[];
  defaultModel: string | null;
  canCreateGeneral: boolean;
}

export function AgentForm({
  value,
  onChange,
  options,
}: {
  value: AiAgentInput;
  onChange: (next: AiAgentInput) => void;
  options: AgentFormOptions;
}) {
  const config = value.config;
  const setConfig = (patch: Partial<AiAgentConfig>) => onChange({ ...value, config: { ...config, ...patch } });
  const patchSection = <K extends keyof AiAgentConfig>(section: K, patch: Partial<AiAgentConfig[K]>) =>
    setConfig({ [section]: { ...(config[section] as object), ...(patch as object) } } as Partial<AiAgentConfig>);

  return (
    <div className="space-y-4">
      {/* ---------------- Identidade ---------------- */}
      <Section title="Identidade" description="Como o agente se chama para a equipe e como se apresenta ao cliente.">
        <div className="grid gap-4 md:grid-cols-2">
          <Field label="Nome">
            <Input value={value.name} maxLength={80} placeholder="Ex.: IA Comercial" onChange={(event) => onChange({ ...value, name: event.target.value })} />
          </Field>
          <Field label="Descrição (interna)">
            <Input value={value.description} maxLength={500} placeholder="Ex.: Atendimento inicial de potenciais clientes" onChange={(event) => onChange({ ...value, description: event.target.value })} />
          </Field>
        </div>
        <Field label="Apresentação ao cliente">
          <Textarea rows={2} maxLength={1000} value={config.identity.greeting} onChange={(event) => patchSection("identity", { greeting: event.target.value })} />
        </Field>
        <Toggle
          checked={config.identity.sendGreeting}
          onChange={(checked) => patchSection("identity", { sendGreeting: checked })}
          label="Enviar a apresentação ao iniciar o atendimento"
          hint="Sai exatamente como escrita, antes da primeira resposta gerada."
        />
      </Section>

      {/* ---------------- Departamentos ---------------- */}
      <Section title="Departamentos" description="Como etiquetas e respostas rápidas: vale para todos ou para os departamentos marcados. Quem enxerga o agente aqui é quem tem esses departamentos.">
        {options.canCreateGeneral && (
          <Toggle
            checked={value.isGeneral}
            onChange={(checked) => onChange({ ...value, isGeneral: checked, departmentIds: checked ? [] : value.departmentIds })}
            label="Vale para todos os departamentos"
            hint="Só o administrador cria agente geral — ele aparece para a organização inteira."
          />
        )}
        <DepartmentCheckboxes
          departments={options.departments}
          selected={value.departmentIds}
          disabled={value.isGeneral}
          onChange={(departmentIds) => onChange({ ...value, departmentIds })}
        />
      </Section>

      {/* ---------------- Objetivo ---------------- */}
      <Section title="Objetivo da IA" description="A missão do agente, em português claro. Entra em primeiro lugar nas instruções.">
        <Textarea
          rows={5}
          maxLength={8000}
          placeholder="Ex.: Atender potenciais clientes interessados nos serviços do escritório, identificar a necessidade, responder dúvidas iniciais, coletar as informações necessárias e encaminhar oportunidades qualificadas para o departamento Comercial."
          value={config.objective}
          onChange={(event) => setConfig({ objective: event.target.value })}
        />
      </Section>

      {/* ---------------- Pode fazer ---------------- */}
      <Section title="O que a IA pode fazer" description="Instruções em texto mais as PERMISSÕES ESTRUTURADAS. Cada caixa libera (ou tira) uma ferramenta de verdade no backend — não é só prompt.">
        <Field label="Instruções">
          <Textarea rows={4} maxLength={8000} placeholder={"- explicar nossos serviços;\n- coletar informações;\n- tirar dúvidas básicas."} value={config.canDo.instructions} onChange={(event) => patchSection("canDo", { instructions: event.target.value })} />
        </Field>
        <div className="grid gap-2 md:grid-cols-2">
          {AI_CAPABILITIES.map((capability) => (
            <Toggle
              key={capability.key}
              checked={config.canDo.capabilities[capability.key]}
              onChange={(checked) => patchSection("canDo", { capabilities: { ...config.canDo.capabilities, [capability.key]: checked } })}
              label={capability.label}
              hint={capability.description}
            />
          ))}
        </div>
        {config.canDo.capabilities.send_links && (
          <Field label="Links autorizados (um por linha)">
            <Textarea
              rows={3}
              placeholder="https://exemplo.com.br/formulario"
              value={config.canDo.allowedLinks.join("\n")}
              onChange={(event) =>
                patchSection("canDo", {
                  allowedLinks: event.target.value.split("\n").map((line) => line.trim()).filter(Boolean).slice(0, AI_CONFIG_LIMITS.allowedLinks.max),
                })
              }
            />
          </Field>
        )}
      </Section>

      {/* ---------------- Não pode ---------------- */}
      <Section title="O que a IA NÃO pode fazer" description="Regras absolutas, acima de qualquer pedido do cliente.">
        <Textarea rows={7} maxLength={8000} value={config.cannotDo} onChange={(event) => setConfig({ cannotDo: event.target.value })} />
      </Section>

      {/* ---------------- Limites ---------------- */}
      <Section title="Limites de autonomia" description="Aplicados pelo backend, independentemente do que o modelo faça.">
        <div className="grid gap-4 md:grid-cols-3">
          <Field label={`Máximo de mensagens da IA por atendimento (${AI_CONFIG_LIMITS.maxAiMessages.min}–${AI_CONFIG_LIMITS.maxAiMessages.max})`}>
            <Input type="number" min={AI_CONFIG_LIMITS.maxAiMessages.min} max={AI_CONFIG_LIMITS.maxAiMessages.max} value={config.limits.maxAiMessages} onChange={(event) => patchSection("limits", { maxAiMessages: Number(event.target.value) || AI_CONFIG_LIMITS.maxAiMessages.default })} />
          </Field>
          <Field label="Máximo de tentativas sem conseguir resolver">
            <Input type="number" min={AI_CONFIG_LIMITS.maxFailedAttempts.min} max={AI_CONFIG_LIMITS.maxFailedAttempts.max} value={config.limits.maxFailedAttempts} onChange={(event) => patchSection("limits", { maxFailedAttempts: Number(event.target.value) || AI_CONFIG_LIMITS.maxFailedAttempts.default })} />
          </Field>
          <Field label="Tempo máximo sob atendimento da IA (minutos, vazio = sem limite)">
            <Input
              type="number"
              min={AI_CONFIG_LIMITS.maxDurationMinutes.min}
              max={AI_CONFIG_LIMITS.maxDurationMinutes.max}
              value={config.limits.maxDurationMinutes ?? ""}
              onChange={(event) => patchSection("limits", { maxDurationMinutes: event.target.value ? Number(event.target.value) : null })}
            />
          </Field>
        </div>
        <p className="text-[11px] text-slate-400">
          Finalizar, transferir, alterar registros, executar ações e enviar links são as caixas da seção &ldquo;O que a IA
          pode fazer&rdquo;. Enviar mídia não está disponível nesta versão: a IA responde só em texto.
        </p>
      </Section>

      {/* ---------------- Transferência ---------------- */}
      <Section title="Transferir para humano quando" description="Os casos abaixo viram instrução ao modelo; os de limite são aplicados também pelo backend.">
        <div className="grid gap-2 md:grid-cols-2">
          {AI_HANDOFF_TRIGGER_KEYS.map((key) => (
            <Toggle key={key} checked={config.handoff.triggers[key]} onChange={(checked) => patchSection("handoff", { triggers: { ...config.handoff.triggers, [key]: checked } })} label={AI_HANDOFF_TRIGGER_LABELS[key]} />
          ))}
        </div>
        <Field label="Outras situações que exigem transferência">
          <Textarea rows={3} maxLength={8000} placeholder="Ex.: Cliente perguntar sobre processo trabalhista em andamento." value={config.handoff.customTriggers} onChange={(event) => patchSection("handoff", { customTriggers: event.target.value })} />
        </Field>
        <div className="grid gap-4 md:grid-cols-3">
          <Field label="Departamento de destino">
            <Select value={config.handoff.departmentId ?? ""} onChange={(event) => patchSection("handoff", { departmentId: event.target.value || null })}>
              <option value="">Manter o da conversa</option>
              {options.allDepartments.map((department) => (
                <option key={department.id} value={department.id}>
                  {department.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Responsável">
            <Select value={config.handoff.assigneeMode} onChange={(event) => patchSection("handoff", { assigneeMode: event.target.value as AiAgentConfig["handoff"]["assigneeMode"] })}>
              {AI_ASSIGNEE_MODES.map((mode) => (
                <option key={mode} value={mode}>
                  {AI_ASSIGNEE_MODE_LABELS[mode]}
                </option>
              ))}
            </Select>
          </Field>
          {config.handoff.assigneeMode === "specific" && (
            <Field label="Pessoa">
              <Select value={config.handoff.assigneeUserId ?? ""} onChange={(event) => patchSection("handoff", { assigneeUserId: event.target.value || null })}>
                <option value="">Selecione…</option>
                {options.users.map((user) => (
                  <option key={user.id} value={user.id}>
                    {user.name}
                  </option>
                ))}
              </Select>
            </Field>
          )}
        </div>
        <div className="grid gap-4 md:grid-cols-2">
          <Field label="Mensagem ao cliente ao transferir">
            <Textarea rows={2} maxLength={1000} value={config.handoff.transferMessage} onChange={(event) => patchSection("handoff", { transferMessage: event.target.value })} />
          </Field>
          <Field label="Mensagem de fallback (erro, limite ou orçamento)">
            <Textarea rows={2} maxLength={1000} value={config.handoff.fallbackMessage} onChange={(event) => patchSection("handoff", { fallbackMessage: event.target.value })} />
          </Field>
        </div>
        <Notice tone="info">
          Antes de transferir, o sistema sempre: gera o resumo (cliente, assunto, necessidade, dados coletados, motivo)
          como nota interna, registra o motivo no histórico e mantém a conversa inteira. O atendente continua sem perguntar
          tudo de novo.
        </Notice>
      </Section>

      {/* ---------------- Comunicação ---------------- */}
      <Section title="Comunicação" description="Tom de voz e forma das respostas.">
        <div className="grid gap-4 md:grid-cols-3">
          <Field label="Tom">
            <Select value={config.communication.tone} onChange={(event) => patchSection("communication", { tone: event.target.value as AiAgentConfig["communication"]["tone"] })}>
              {AI_TONES.map((tone) => (
                <option key={tone} value={tone}>
                  {AI_TONE_LABELS[tone]}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Tamanho das respostas">
            <Select value={config.communication.responseLength} onChange={(event) => patchSection("communication", { responseLength: event.target.value as AiAgentConfig["communication"]["responseLength"] })}>
              {AI_RESPONSE_LENGTHS.map((length) => (
                <option key={length} value={length}>
                  {AI_RESPONSE_LENGTH_LABELS[length]}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Usar emojis">
            <Select value={config.communication.emojis} onChange={(event) => patchSection("communication", { emojis: event.target.value as AiAgentConfig["communication"]["emojis"] })}>
              {AI_EMOJI_USAGES.map((usage) => (
                <option key={usage} value={usage}>
                  {AI_EMOJI_USAGE_LABELS[usage]}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        {config.communication.tone === "custom" && (
          <Field label="Descreva o tom">
            <Textarea rows={2} maxLength={1000} value={config.communication.customTone} onChange={(event) => patchSection("communication", { customTone: event.target.value })} />
          </Field>
        )}
        <div className="grid gap-2 md:grid-cols-3">
          <Toggle checked={config.communication.useFirstName} onChange={(checked) => patchSection("communication", { useFirstName: checked })} label="Usar o primeiro nome do cliente" />
          <Toggle checked={config.communication.oneQuestionAtATime} onChange={(checked) => patchSection("communication", { oneQuestionAtATime: checked })} label="Fazer uma pergunta por vez" />
          <Toggle checked={config.communication.avoidJargon} onChange={(checked) => patchSection("communication", { avoidJargon: checked })} label="Evitar linguagem técnica" />
        </div>
        <Field label="Instruções de comunicação personalizadas">
          <Textarea rows={3} maxLength={8000} value={config.communication.customInstructions} onChange={(event) => patchSection("communication", { customInstructions: event.target.value })} />
        </Field>
      </Section>

      {/* ---------------- Condutas ---------------- */}
      <Section title="Comportamentos gerais">
        <div className="grid gap-2 md:grid-cols-2">
          {AI_BEHAVIOR_KEYS.map((key) => (
            <Toggle key={key} checked={config.behaviors[key]} onChange={(checked) => setConfig({ behaviors: { ...config.behaviors, [key]: checked } })} label={AI_BEHAVIOR_LABELS[key]} />
          ))}
        </div>
      </Section>

      {/* ---------------- Coleta ---------------- */}
      <Section title="Dados a coletar" description="A IA registra cada dado assim que o cliente informa, e nunca pergunta de novo o que já sabe. Não há cadastro de campos personalizados no AZVCHAT: os dados vivem na memória do atendimento e vão no resumo ao atendente. O nome também atualiza o nome da conversa, quando permitido.">
        <CollectFieldsEditor fields={config.dataCollection.fields} onChange={(fields) => patchSection("dataCollection", { fields })} />
        <Field label="Ordem de coleta">
          <Select value={config.dataCollection.order} onChange={(event) => patchSection("dataCollection", { order: event.target.value as AiAgentConfig["dataCollection"]["order"] })}>
            {AI_COLLECTION_ORDERS.map((order) => (
              <option key={order} value={order}>
                {AI_COLLECTION_ORDER_LABELS[order]}
              </option>
            ))}
          </Select>
        </Field>
      </Section>

      {/* ---------------- Base de conhecimento ---------------- */}
      <Section title="Base de conhecimento" description="Só as fontes marcadas são consultadas por este agente. Cadastre fontes na aba Base de conhecimento.">
        {options.knowledge.length === 0 ? (
          <p className="text-sm text-slate-400">Nenhuma fonte cadastrada ainda.</p>
        ) : (
          <div className="grid gap-2 md:grid-cols-2">
            {options.knowledge.map((source) => (
              <Toggle
                key={source.id}
                checked={value.knowledgeSourceIds.includes(source.id)}
                onChange={(checked) =>
                  onChange({
                    ...value,
                    knowledgeSourceIds: checked ? [...value.knowledgeSourceIds, source.id] : value.knowledgeSourceIds.filter((id) => id !== source.id),
                  })
                }
                label={
                  <span>
                    {source.title} {!source.active && <span className="text-amber-700">(inativa)</span>}
                  </span>
                }
                hint={`${source.kind === "faq" ? "Perguntas e respostas" : "Texto"} · ${source.content.length.toLocaleString("pt-BR")} caracteres`}
              />
            ))}
          </div>
        )}
        <div className="grid gap-2 md:grid-cols-2">
          <Toggle checked={config.knowledge.includeQuickReplies} onChange={(checked) => patchSection("knowledge", { includeQuickReplies: checked })} label="Usar as respostas rápidas como conhecimento" hint="As respostas rápidas que valem para a conversa entram como fonte." />
          <Toggle checked={config.knowledge.allowGeneralKnowledge} onChange={(checked) => patchSection("knowledge", { allowGeneralKnowledge: checked })} label="Permitir conhecimento geral do modelo" hint="Só quando a base e o sistema não cobrem. Desligado, a IA admite que não sabe." />
        </div>
        <p className="text-[11px] text-slate-400">
          Prioridade: 1º regras e limites do agente · 2º dados oficiais do sistema · 3º base autorizada · 4º contexto da
          conversa · 5º conhecimento geral, só quando permitido.
        </p>
      </Section>

      {/* ---------------- Avançado ---------------- */}
      {/* O modelo do agente mora na coluna `model` (consultável por SQL) e é
          espelhado em `config.advanced.model`, para a versão gravada saber
          qual era — os dois mudam juntos, aqui. */}
      <AdvancedSection
        config={config}
        onPatch={(patch) => patchSection("advanced", patch)}
        model={value.model}
        onModel={(model) => onChange({ ...value, model, config: { ...config, advanced: { ...config.advanced, model } } })}
        options={options}
      />
    </div>
  );
}

function CollectFieldsEditor({ fields, onChange }: { fields: AiCollectField[]; onChange: (fields: AiCollectField[]) => void }) {
  const [customKey, setCustomKey] = useState("");
  const [customLabel, setCustomLabel] = useState("");
  const available = useMemo(() => AI_SUGGESTED_COLLECT_FIELDS.filter((suggested) => !fields.some((field) => field.key === suggested.key)), [fields]);

  function update(index: number, patch: Partial<AiCollectField>) {
    onChange(fields.map((field, i) => (i === index ? { ...field, ...patch } : field)));
  }
  function move(index: number, delta: number) {
    const next = [...fields];
    const target = index + delta;
    if (target < 0 || target >= next.length) return;
    const [item] = next.splice(index, 1);
    next.splice(target, 0, item as AiCollectField);
    onChange(next);
  }

  return (
    <div className="space-y-2">
      {fields.map((field, index) => (
        <div key={field.key} className="grid grid-cols-[1.5rem_1fr_1fr_1fr_auto] items-center gap-2 rounded-lg border border-slate-200 px-2 py-1.5 text-sm">
          <span className="text-center text-xs text-slate-400">{index + 1}</span>
          <div>
            <p className="font-medium text-slate-800">{field.label}</p>
            <p className="font-mono text-[10px] text-slate-400">{field.key}</p>
          </div>
          <Input placeholder="Dica de formato (opcional)" value={field.hint} maxLength={200} onChange={(event) => update(index, { hint: event.target.value })} />
          <label className="flex items-center gap-1.5 text-xs">
            <input type="checkbox" className="h-4 w-4 rounded border-slate-300 text-brand-600" checked={field.required} onChange={(event) => update(index, { required: event.target.checked })} />
            Obrigatório
          </label>
          <div className="flex gap-0.5">
            <Button size="sm" variant="ghost" onClick={() => move(index, -1)} disabled={index === 0} title="Subir">
              ↑
            </Button>
            <Button size="sm" variant="ghost" onClick={() => move(index, 1)} disabled={index === fields.length - 1} title="Descer">
              ↓
            </Button>
            <Button size="sm" variant="ghost" onClick={() => onChange(fields.filter((_, i) => i !== index))}>
              <Trash2 className="h-3.5 w-3.5 text-red-500" />
            </Button>
          </div>
        </div>
      ))}
      {fields.length === 0 && <p className="text-xs text-slate-400">Nenhum dado a coletar. Adicione abaixo.</p>}
      <div className="flex flex-wrap items-end gap-2">
        {available.length > 0 && (
          <Select
            className="w-auto"
            value=""
            onChange={(event) => {
              const suggested = AI_SUGGESTED_COLLECT_FIELDS.find((field) => field.key === event.target.value);
              if (suggested && fields.length < AI_CONFIG_LIMITS.collectFields.max) onChange([...fields, { ...suggested }]);
            }}
          >
            <option value="">Adicionar campo sugerido…</option>
            {available.map((field) => (
              <option key={field.key} value={field.key}>
                {field.label}
              </option>
            ))}
          </Select>
        )}
        <Input className="w-40" placeholder="chave_tecnica" value={customKey} onChange={(event) => setCustomKey(event.target.value.toLowerCase().replace(/[^a-z0-9_]/g, "_"))} />
        <Input className="w-48" placeholder="Rótulo do campo" value={customLabel} onChange={(event) => setCustomLabel(event.target.value)} />
        <Button
          size="sm"
          variant="outline"
          disabled={!customKey || !customLabel.trim() || fields.some((field) => field.key === customKey) || fields.length >= AI_CONFIG_LIMITS.collectFields.max}
          onClick={() => {
            onChange([...fields, { key: customKey, label: customLabel.trim(), required: false, hint: "" }]);
            setCustomKey("");
            setCustomLabel("");
          }}
        >
          <Plus className="h-3.5 w-3.5" /> Campo personalizado
        </Button>
      </div>
    </div>
  );
}

function AdvancedSection({
  config,
  onPatch,
  model,
  onModel,
  options,
}: {
  config: AiAgentConfig;
  onPatch: (patch: Partial<AiAgentConfig["advanced"]>) => void;
  model: string | null;
  onModel: (model: string | null) => void;
  options: AgentFormOptions;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Section
      title="Configurações avançadas"
      aside={
        <Button size="sm" variant="ghost" onClick={() => setOpen((value) => !value)}>
          {open ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />} {open ? "Recolher" : "Expandir"}
        </Button>
      }
    >
      {open && (
        <div className="space-y-4">
          <div className="grid gap-4 md:grid-cols-3">
            <Field label="Modelo deste agente">
              <Select value={model ?? ""} onChange={(event) => onModel(event.target.value || null)}>
                <option value="">Padrão do sistema{options.defaultModel ? ` (${options.defaultModel})` : ""}</option>
                {options.models.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.label}
                    {item.recommended ? " (recomendado)" : ""}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Temperatura (vazio = padrão do modelo)">
              <Input type="number" step={0.1} min={0} max={2} value={config.advanced.temperature ?? ""} onChange={(event) => onPatch({ temperature: event.target.value === "" ? null : Number(event.target.value) })} />
            </Field>
            <Field label={`Mensagens recentes no contexto (${AI_CONFIG_LIMITS.contextMessageLimit.min}–${AI_CONFIG_LIMITS.contextMessageLimit.max})`}>
              <Input type="number" min={AI_CONFIG_LIMITS.contextMessageLimit.min} max={AI_CONFIG_LIMITS.contextMessageLimit.max} value={config.advanced.contextMessageLimit} onChange={(event) => onPatch({ contextMessageLimit: Number(event.target.value) || AI_CONFIG_LIMITS.contextMessageLimit.default })} />
            </Field>
          </div>
          <Field label="Instruções adicionais para a IA (complemento; não substitui os campos acima)">
            <Textarea rows={5} maxLength={8000} value={config.advanced.additionalInstructions} onChange={(event) => onPatch({ additionalInstructions: event.target.value })} />
          </Field>
        </div>
      )}
    </Section>
  );
}

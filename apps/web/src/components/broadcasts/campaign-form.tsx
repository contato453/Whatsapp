"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle, Plus, Trash2 } from "lucide-react";
import {
  BROADCAST_CRM_MODES,
  BROADCAST_CRM_MODE_DESCRIPTIONS,
  BROADCAST_CRM_MODE_LABELS,
  BROADCAST_LIMITS,
  BROADCAST_VARIABLES,
  estimateCampaignMinutes,
  extractBroadcastVariables,
  formatEstimate,
  resolveBroadcastTemplate,
  type BroadcastAudienceDto,
  type BroadcastCampaignDto,
  type BroadcastCrmMode,
} from "@azvchat/shared";
import {
  ApiError,
  broadcastApi,
  type BroadcastCampaignInput,
  type BroadcastOptionsDto,
} from "@/lib/api";
import { Button, Card, Field, Input, Spinner, Textarea } from "@/components/ui";

/**
 * O FORMULÁRIO DA CAMPANHA — usado para criar e para editar o rascunho.
 *
 * Um componente só, e não duas telas parecidas: campanha em rascunho é
 * editável inteira, e depois de iniciada a API tranca tudo (`campaign_locked`).
 * Duas cópias do mesmo formulário divergiriam no dia em que um campo novo
 * entrasse só numa delas — e o campo esquecido aqui seria uma trava
 * anti-bloqueio que o escritório acharia que tinha configurado.
 *
 * A tela não tem passos numerados de propósito: quem monta disparo volta e
 * mexe no intervalo depois de ler a estimativa, e um assistente em etapas
 * obrigaria a atravessar tudo de novo para trocar um número.
 */

const INTERVALOS_SUGERIDOS = [
  { label: "Rápido (5–15s)", min: 5, max: 15, hint: "Só para lista pequena e contatos que já falam com o escritório." },
  { label: "Equilibrado (30–90s)", min: 30, max: 90, hint: "O padrão. É o que mais se parece com gente digitando." },
  { label: "Cauteloso (2–5 min)", min: 120, max: 300, hint: "Número novo ou lista fria — mais devagar, mais seguro." },
];

export interface CampaignFormProps {
  /** Campanha existente = edição de rascunho; ausente = criação. */
  campaign?: BroadcastCampaignDto;
}

export function CampaignForm({ campaign }: CampaignFormProps) {
  const router = useRouter();
  const [options, setOptions] = useState<BroadcastOptionsDto | null>(null);
  const [audiences, setAudiences] = useState<BroadcastAudienceDto[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const [name, setName] = useState(campaign?.name ?? "");
  const [audienceId, setAudienceId] = useState(campaign?.audienceId ?? "");
  const [instanceId, setInstanceId] = useState(campaign?.whatsappInstanceId ?? "");
  const [message, setMessage] = useState(campaign?.message ?? "");
  const [variants, setVariants] = useState<string[]>(campaign?.messageVariants ?? []);
  const [scheduledFor, setScheduledFor] = useState(
    campaign?.scheduledFor ? toLocalInput(campaign.scheduledFor) : "",
  );
  const [minInterval, setMinInterval] = useState(
    campaign?.minIntervalSeconds ?? BROADCAST_LIMITS.DEFAULT_MIN_INTERVAL_SECONDS,
  );
  const [maxInterval, setMaxInterval] = useState(
    campaign?.maxIntervalSeconds ?? BROADCAST_LIMITS.DEFAULT_MAX_INTERVAL_SECONDS,
  );
  const [dailyLimit, setDailyLimit] = useState<number | null>(
    campaign?.dailyLimit ?? BROADCAST_LIMITS.DEFAULT_DAILY_LIMIT,
  );
  const [respectBusinessHours, setRespectBusinessHours] = useState(
    campaign?.respectBusinessHours ?? true,
  );
  const [crmMode, setCrmMode] = useState<BroadcastCrmMode>(campaign?.crmMode ?? "on_reply");
  const [crmPipelineId, setCrmPipelineId] = useState(campaign?.crmPipelineId ?? "");
  const [crmStageId, setCrmStageId] = useState(campaign?.crmStageId ?? "");
  const [tagId, setTagId] = useState(campaign?.tagId ?? "");

  useEffect(() => {
    void (async () => {
      try {
        const [opcoes, listas] = await Promise.all([
          broadcastApi.options(),
          broadcastApi.audiences.list(),
        ]);
        setOptions(opcoes);
        setAudiences(listas);
      } catch (err) {
        setError(err instanceof ApiError ? err.message : "Não foi possível carregar as opções");
      }
    })();
  }, []);

  const audiencia = (audiences ?? []).find((item) => item.id === audienceId) ?? null;
  const funil = (options?.pipelines ?? []).find((item) => item.id === crmPipelineId) ?? null;

  // O funil e a etapa andam juntos: trocar o funil com uma etapa do funil
  // anterior selecionada é 422 na API, e o erro chegaria só no salvar.
  useEffect(() => {
    if (!funil) {
      if (crmStageId) setCrmStageId("");
      return;
    }
    if (crmStageId && !funil.stages.some((etapa) => etapa.id === crmStageId)) {
      setCrmStageId(funil.stages[0]?.id ?? "");
    }
  }, [funil, crmStageId]);

  const destinatarios = audiencia ? Math.max(0, audiencia.contactCount - audiencia.optedOutCount) : 0;
  const estimativa = estimateCampaignMinutes(destinatarios, minInterval, maxInterval);

  const variaveisUsadas = useMemo(
    () => extractBroadcastVariables([message, ...variants].join("\n")),
    [message, variants],
  );

  const previa = useMemo(
    () =>
      resolveBroadcastTemplate(message || "", {
        name: "Maria Souza",
        company: "Souza Comércio Ltda",
        phone: "(11) 99999-8888",
        fields: {},
      }),
    [message],
  );

  const intervaloInvertido = minInterval > maxInterval;
  const precisaFunil = crmMode !== "never" && !crmPipelineId;

  const podeSalvar =
    name.trim().length >= 2 &&
    Boolean(audienceId) &&
    Boolean(instanceId) &&
    message.trim().length > 0 &&
    !intervaloInvertido &&
    !precisaFunil &&
    !saving;

  async function salvar() {
    setSaving(true);
    setError(null);
    const payload: BroadcastCampaignInput = {
      name: name.trim(),
      audienceId,
      whatsappInstanceId: instanceId,
      message: message.trim(),
      messageVariants: variants.map((texto) => texto.trim()).filter((texto) => texto.length > 0),
      scheduledFor: scheduledFor ? new Date(scheduledFor).toISOString() : null,
      minIntervalSeconds: minInterval,
      maxIntervalSeconds: maxInterval,
      dailyLimit,
      respectBusinessHours,
      crmMode,
      crmPipelineId: crmPipelineId || null,
      crmStageId: crmStageId || null,
      tagId: tagId || null,
    };
    try {
      const salva = campaign
        ? await broadcastApi.campaigns.update(campaign.id, payload)
        : await broadcastApi.campaigns.create(payload);
      router.push(`/automations/broadcasts/${salva.id}`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Não foi possível salvar a campanha");
      setSaving(false);
    }
  }

  function inserirVariavel(chave: string) {
    setMessage((atual) => `${atual}{{${chave}}}`);
  }

  if (!options || !audiences) {
    return (
      <div className="flex justify-center py-16">
        <Spinner />
      </div>
    );
  }

  // Duas colunas só a partir de `xl`. Em `lg` (1024px) a coluna do resumo
  // cabia no papel e sumia na prática: com o navegador em zoom, o conteúdo
  // era empurrado para fora e o `<main>` do layout, que é `overflow-hidden`,
  // cortava sem deixar barra de rolagem. Empilhado é pior esteticamente e
  // melhor de usar.
  return (
    <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_320px]">
      <div className="space-y-5">
        {/* ---------- Quem recebe ---------- */}
        <Card className="space-y-4 p-5">
          <h2 className="text-sm font-semibold text-slate-900">1. Quem recebe e por onde sai</h2>
          <Field label="Nome da campanha">
            <Input
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Ex.: Aviso de fechamento fiscal — setembro"
              maxLength={120}
            />
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Audiência">
              <select
                value={audienceId}
                onChange={(event) => setAudienceId(event.target.value)}
                className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm"
              >
                <option value="">Escolha a lista de contatos</option>
                {audiences.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name} ({item.contactCount})
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Número que vai enviar">
              <select
                value={instanceId}
                onChange={(event) => setInstanceId(event.target.value)}
                className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm"
              >
                <option value="">Escolha o número</option>
                {options.instances.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                    {item.status === "connected" ? "" : " — desconectado"}
                  </option>
                ))}
              </select>
            </Field>
          </div>
          {audiencia && audiencia.optedOutCount > 0 && (
            <p className="text-xs text-amber-700">
              {audiencia.optedOutCount} contato(s) desta audiência pediram descadastro e não vão
              receber — eles entram no histórico como &quot;Pulada&quot;.
            </p>
          )}
        </Card>

        {/* ---------- A mensagem ---------- */}
        <Card className="space-y-4 p-5">
          <h2 className="text-sm font-semibold text-slate-900">2. A mensagem</h2>
          <Textarea
            value={message}
            onChange={(event) => setMessage(event.target.value)}
            rows={6}
            maxLength={BROADCAST_LIMITS.MESSAGE_MAX_LENGTH}
            placeholder={"Olá {{primeiro_nome}}, {{saudacao}}!\n\nAqui é do escritório..."}
          />
          <div className="flex flex-wrap gap-1.5">
            {BROADCAST_VARIABLES.filter((item) => !item.key.includes("<")).map((item) => (
              <button
                key={item.key}
                type="button"
                title={item.description}
                onClick={() => inserirVariavel(item.key)}
                className="rounded-full border border-slate-200 px-2.5 py-1 text-[11px] text-slate-600 hover:border-brand-400 hover:text-brand-600"
              >
                {`{{${item.key}}}`}
              </button>
            ))}
            <span className="px-1 py-1 text-[11px] text-slate-400">
              Colunas extras da planilha: {"{{campo.cidade}}"}, {"{{campo.vencimento}}"}…
            </span>
          </div>
          {message.trim().length > 0 && (
            <div className="rounded-lg bg-slate-50 p-3">
              <p className="mb-1 text-[11px] font-medium uppercase tracking-wide text-slate-500">
                Como um contato vê
              </p>
              <p className="whitespace-pre-wrap text-sm text-slate-800">{previa}</p>
            </div>
          )}
          {variaveisUsadas.length > 0 && (
            <p className="text-xs text-slate-500">
              Variável sem valor no contato vira vazio e a frase é costurada — mas confira a
              audiência antes: nome em branco em metade da lista aparece como mensagem genérica.
            </p>
          )}

          {/* Variações: o anti-padrão mais barato que existe. */}
          <div className="space-y-2 border-t border-slate-100 pt-4">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-xs font-medium text-slate-700">Variações do texto (opcional)</p>
                <p className="text-[11px] text-slate-500">
                  O sistema sorteia entre a principal e as variações a cada envio. Mil mensagens
                  idênticas é o padrão que o WhatsApp reconhece mais rápido.
                </p>
              </div>
              {variants.length < BROADCAST_LIMITS.MAX_MESSAGE_VARIANTS && (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => setVariants((atual) => [...atual, ""])}
                >
                  <Plus className="h-3.5 w-3.5" />
                  Variação
                </Button>
              )}
            </div>
            {variants.map((texto, indice) => (
              <div key={indice} className="flex items-start gap-2">
                <Textarea
                  value={texto}
                  rows={3}
                  maxLength={BROADCAST_LIMITS.MESSAGE_MAX_LENGTH}
                  onChange={(event) =>
                    setVariants((atual) =>
                      atual.map((item, i) => (i === indice ? event.target.value : item)),
                    )
                  }
                  placeholder="Mesmo recado, escrito de outro jeito"
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => setVariants((atual) => atual.filter((_, i) => i !== indice))}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </div>
            ))}
          </div>
        </Card>

        {/* ---------- Ritmo ---------- */}
        <Card className="space-y-4 p-5">
          <h2 className="text-sm font-semibold text-slate-900">3. Quando e em que ritmo</h2>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Começar em (vazio = manual)">
              <Input
                type="datetime-local"
                value={scheduledFor}
                onChange={(event) => setScheduledFor(event.target.value)}
              />
            </Field>
            <Field label="Teto por dia">
              <Input
                type="number"
                min={1}
                max={BROADCAST_LIMITS.MAX_DAILY_LIMIT}
                value={dailyLimit ?? ""}
                placeholder="Sem teto"
                onChange={(event) =>
                  setDailyLimit(event.target.value ? Number(event.target.value) : null)
                }
              />
            </Field>
          </div>

          <div className="space-y-2">
            <p className="text-xs font-medium uppercase tracking-wide text-slate-500">
              Intervalo entre mensagens
            </p>
            <div className="flex flex-wrap gap-1.5">
              {INTERVALOS_SUGERIDOS.map((sugestao) => {
                const ativo = minInterval === sugestao.min && maxInterval === sugestao.max;
                return (
                  <button
                    key={sugestao.label}
                    type="button"
                    title={sugestao.hint}
                    onClick={() => {
                      setMinInterval(sugestao.min);
                      setMaxInterval(sugestao.max);
                    }}
                    className={
                      ativo
                        ? "rounded-full bg-brand-550 px-3 py-1 text-xs font-medium text-white"
                        : "rounded-full border border-slate-200 px-3 py-1 text-xs text-slate-600 hover:border-brand-400"
                    }
                  >
                    {sugestao.label}
                  </button>
                );
              })}
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Mínimo (segundos)">
                <Input
                  type="number"
                  min={BROADCAST_LIMITS.MIN_INTERVAL_SECONDS}
                  max={BROADCAST_LIMITS.MAX_INTERVAL_SECONDS}
                  value={minInterval}
                  onChange={(event) => setMinInterval(Number(event.target.value))}
                />
              </Field>
              <Field label="Máximo (segundos)">
                <Input
                  type="number"
                  min={BROADCAST_LIMITS.MIN_INTERVAL_SECONDS}
                  max={BROADCAST_LIMITS.MAX_INTERVAL_SECONDS}
                  value={maxInterval}
                  onChange={(event) => setMaxInterval(Number(event.target.value))}
                />
              </Field>
            </div>
            <p className="text-[11px] text-slate-500">
              O sistema sorteia um valor dentro da faixa a cada mensagem. Intervalo fixo é
              assinatura de robô — a faixa não custa nada e quebra a regularidade.
            </p>
            {intervaloInvertido && (
              <p className="text-xs text-red-600">O mínimo não pode ser maior que o máximo.</p>
            )}
          </div>

          <label className="flex items-start gap-2 text-sm text-slate-700">
            <input
              type="checkbox"
              className="mt-0.5"
              checked={respectBusinessHours}
              onChange={(event) => setRespectBusinessHours(event.target.checked)}
            />
            <span>
              Só enviar dentro do expediente
              <span className="block text-[11px] text-slate-500">
                Usa o mesmo expediente dos Parâmetros de atendimento. Mensagem de escritório às
                3h da manhã é a que mais vira denúncia.
              </span>
            </span>
          </label>
        </Card>

        {/* ---------- CRM ---------- */}
        <Card className="space-y-4 p-5">
          <h2 className="text-sm font-semibold text-slate-900">4. O que acontece depois</h2>
          <Field label="Oportunidade no CRM">
            <div className="space-y-1.5">
              {BROADCAST_CRM_MODES.map((modo) => (
                <label key={modo} className="flex items-start gap-2 text-sm text-slate-700">
                  <input
                    type="radio"
                    className="mt-1"
                    checked={crmMode === modo}
                    onChange={() => setCrmMode(modo)}
                  />
                  <span>
                    {BROADCAST_CRM_MODE_LABELS[modo]}
                    <span className="block text-[11px] text-slate-500">
                      {BROADCAST_CRM_MODE_DESCRIPTIONS[modo]}
                    </span>
                  </span>
                </label>
              ))}
            </div>
          </Field>
          {crmMode !== "never" && (
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Funil">
                <select
                  value={crmPipelineId}
                  onChange={(event) => setCrmPipelineId(event.target.value)}
                  className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm"
                >
                  <option value="">Escolha o funil</option>
                  {options.pipelines.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.name}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Etapa (vazio = a primeira)">
                <select
                  value={crmStageId}
                  onChange={(event) => setCrmStageId(event.target.value)}
                  disabled={!funil}
                  className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm disabled:bg-slate-50"
                >
                  <option value="">Primeira etapa do funil</option>
                  {(funil?.stages ?? []).map((etapa) => (
                    <option key={etapa.id} value={etapa.id}>
                      {etapa.name}
                    </option>
                  ))}
                </select>
              </Field>
            </div>
          )}
          <Field label="Etiquetar a conversa (opcional)">
            <select
              value={tagId}
              onChange={(event) => setTagId(event.target.value)}
              className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm"
            >
              <option value="">Sem etiqueta</option>
              {options.tags.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
            </select>
          </Field>
          <p className="text-[11px] text-slate-500">
            A etiqueta é o que permite achar depois, na Inbox, todas as conversas que nasceram
            deste disparo — sem ela, elas se misturam ao atendimento normal.
          </p>
        </Card>
      </div>

      {/* ---------- Resumo grudado ---------- */}
      <div className="space-y-4 xl:sticky xl:top-4 xl:self-start">
        <Card className="space-y-3 p-5">
          <h2 className="text-sm font-semibold text-slate-900">Resumo</h2>
          <Linha rotulo="Contatos que recebem" valor={audiencia ? String(destinatarios) : "—"} />
          <Linha
            rotulo="Duração estimada"
            valor={audiencia ? formatEstimate(estimativa) : "—"}
          />
          <Linha
            rotulo="Teto diário"
            valor={dailyLimit ? `${dailyLimit} por dia` : "Sem teto"}
          />
          <Linha
            rotulo="Início"
            valor={scheduledFor ? new Date(scheduledFor).toLocaleString("pt-BR") : "Manual"}
          />
          {dailyLimit && destinatarios > dailyLimit && (
            <p className="rounded-lg bg-amber-50 p-2 text-[11px] text-amber-800">
              A lista é maior que o teto diário: o disparo continua sozinho nos dias seguintes,
              de onde parou.
            </p>
          )}
          {error && (
            <p className="flex items-start gap-1.5 rounded-lg bg-red-50 p-2 text-xs text-red-700">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              {error}
            </p>
          )}
          <Button className="w-full" disabled={!podeSalvar} onClick={() => void salvar()}>
            {saving ? "Salvando..." : campaign ? "Salvar rascunho" : "Criar campanha"}
          </Button>
          <p className="text-[11px] text-slate-500">
            Criar não dispara nada. A campanha nasce em rascunho, e o envio começa só quando
            alguém clicar em Iniciar na tela dela — depois de mandar um teste para o próprio
            celular.
          </p>
        </Card>
      </div>
    </div>
  );
}

function Linha({ rotulo, valor }: { rotulo: string; valor: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3 text-sm">
      <span className="text-slate-500">{rotulo}</span>
      <span className="font-medium text-slate-900">{valor}</span>
    </div>
  );
}

/** ISO → o formato que `datetime-local` entende, no fuso do navegador. */
function toLocalInput(iso: string): string {
  const data = new Date(iso);
  const deslocado = new Date(data.getTime() - data.getTimezoneOffset() * 60_000);
  return deslocado.toISOString().slice(0, 16);
}

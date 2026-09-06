"use client";

import { useCallback, useEffect, useState } from "react";
import { KeyRound, Plug, PlugZap, RefreshCw, Unplug } from "lucide-react";
import {
  AI_PROVIDER_LABELS,
  AI_PROVIDER_STATUS_LABELS,
  formatUsdFromMicros,
  type AiModelDto,
  type AiProviderBillingDto,
  type AiProviderDto,
} from "@azvchat/shared";
import { ApiError, aiApi } from "@/lib/api";
import { formatDateTime } from "@/lib/utils";
import { Badge, Button, Field, Input, Spinner } from "@/components/ui";
import { Notice, Section, Select } from "./ai-ui";

/**
 * Provedores de IA — só admin (a página já filtra e a API recusa de novo).
 *
 * A chave é digitada, sobe UMA vez e nunca volta: depois de salva a tela
 * mostra só o `apiKeyHint`. "Conectar" grava e testa na mesma chamada; o
 * status só vira "Conectado" quando o provedor aceitou a chave.
 */
export function ProvidersPanel() {
  const [providers, setProviders] = useState<AiProviderDto[] | null>(null);
  const [dedicatedKey, setDedicatedKey] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const data = await aiApi.providers();
      setProviders(data.providers);
      setDedicatedKey(data.dedicatedSecretsKey);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Não foi possível carregar os provedores");
    }
  }, []);
  useEffect(() => void load(), [load]);

  if (error) return <Notice tone="error">{error}</Notice>;
  if (!providers) {
    return (
      <div className="flex justify-center py-8">
        <Spinner />
      </div>
    );
  }
  return (
    <div className="space-y-4">
      {!dedicatedKey && (
        <Notice tone="warn">
          <strong>AI_SECRETS_KEY não definida na API.</strong> A chave do provedor está cifrada com uma
          derivação do JWT_SECRET: funciona, mas trocar o JWT_SECRET invalida a chave gravada. Gere uma
          com <code>openssl rand -hex 32</code> e defina no <code>.env</code> da VPS.
        </Notice>
      )}
      {providers.map((provider) => (
        <ProviderCard key={provider.provider} provider={provider} onChanged={load} />
      ))}
    </div>
  );
}

function ProviderCard({ provider, onChanged }: { provider: AiProviderDto; onChanged: () => Promise<void> }) {
  const [apiKey, setApiKey] = useState("");
  const [defaultModel, setDefaultModel] = useState(provider.defaultModel ?? "");
  const [models, setModels] = useState<AiModelDto[]>([]);
  const [modelsSource, setModelsSource] = useState<"provider" | "catalog" | null>(null);
  const [busy, setBusy] = useState<"connect" | "test" | "disconnect" | "models" | "billing" | null>(null);
  const [feedback, setFeedback] = useState<{ ok: boolean; message: string } | null>(null);
  const [billing, setBilling] = useState<AiProviderBillingDto | null>(null);
  const connected = provider.status === "connected";

  const loadModels = useCallback(
    async (refresh: boolean) => {
      setBusy("models");
      try {
        const data = await aiApi.models(provider.provider, refresh);
        setModels(data.models);
        setModelsSource(data.source);
      } catch {
        setModels([]);
      } finally {
        setBusy(null);
      }
    },
    [provider.provider],
  );

  useEffect(() => {
    void loadModels(false);
  }, [loadModels, provider.apiKeyHint]);

  useEffect(() => {
    setDefaultModel(provider.defaultModel ?? "");
  }, [provider.defaultModel]);

  async function connect() {
    setBusy("connect");
    setFeedback(null);
    try {
      const result = await aiApi.saveProvider(provider.provider, {
        ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
        ...(defaultModel ? { defaultModel } : {}),
      });
      setFeedback(result.test ?? { ok: true, message: "Modelo padrão atualizado." });
      setApiKey("");
      await onChanged();
    } catch (err) {
      setFeedback({ ok: false, message: err instanceof ApiError ? err.message : "Falha ao salvar" });
    } finally {
      setBusy(null);
    }
  }

  async function test() {
    setBusy("test");
    setFeedback(null);
    try {
      const result = await aiApi.testProvider(provider.provider);
      setFeedback(result.test);
      await onChanged();
    } catch (err) {
      setFeedback({ ok: false, message: err instanceof ApiError ? err.message : "Falha na conexão. Verifique sua chave API." });
    } finally {
      setBusy(null);
    }
  }

  async function disconnect() {
    if (!window.confirm("Desconectar a OpenAI? Os agentes ativos param de responder até uma nova chave ser cadastrada.")) return;
    setBusy("disconnect");
    try {
      await aiApi.disconnectProvider(provider.provider);
      setFeedback(null);
      setBilling(null);
      await onChanged();
    } catch (err) {
      setFeedback({ ok: false, message: err instanceof ApiError ? err.message : "Falha ao desconectar" });
    } finally {
      setBusy(null);
    }
  }

  async function checkBilling() {
    setBusy("billing");
    try {
      setBilling(await aiApi.billing(provider.provider));
    } catch (err) {
      setBilling({
        available: false,
        reason: err instanceof ApiError ? err.message : "Não foi possível consultar o provedor.",
        monthCostMicros: null,
        checkedAt: new Date().toISOString(),
      });
    } finally {
      setBusy(null);
    }
  }

  return (
    <Section
      title={AI_PROVIDER_LABELS[provider.provider]}
      description="A chave fica cifrada no servidor e nunca é exibida de novo. Todo agente usa este provedor."
      aside={
        <Badge color={connected ? "#16a34a" : provider.status === "error" ? "#dc2626" : "#64748b"}>
          <span className={connected ? "text-emerald-700" : ""}>{connected ? "●" : "○"}</span> {AI_PROVIDER_STATUS_LABELS[provider.status]}
        </Badge>
      }
    >
      <div className="grid gap-4 md:grid-cols-2">
        <Field label={provider.apiKeyHint ? "Chave API (gravada)" : "Chave API"}>
          <div className="space-y-1.5">
            {provider.apiKeyHint && (
              <p className="flex items-center gap-2 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 font-mono text-xs text-slate-700">
                <KeyRound className="h-3.5 w-3.5 text-slate-400" /> {provider.apiKeyHint}
              </p>
            )}
            <Input
              type="password"
              autoComplete="off"
              placeholder={provider.apiKeyHint ? "Cole uma chave nova para substituir" : "sk-..."}
              value={apiKey}
              onChange={(event) => setApiKey(event.target.value)}
            />
          </div>
        </Field>
        <Field label="Modelo padrão">
          <div className="space-y-1.5">
            <Select value={defaultModel} onChange={(event) => setDefaultModel(event.target.value)}>
              <option value="">Selecione…</option>
              {models.map((model) => (
                <option key={model.id} value={model.id}>
                  {model.label}
                  {model.recommended ? " (recomendado)" : ""}
                  {model.inputPerMillion != null ? ` — US$ ${model.inputPerMillion}/${model.outputPerMillion} por 1M tokens` : ""}
                </option>
              ))}
            </Select>
            <div className="flex items-center justify-between text-[11px] text-slate-400">
              <span>
                {modelsSource === "provider"
                  ? `Lista da sua conta na OpenAI${provider.modelsFetchedAt ? ` (${formatDateTime(provider.modelsFetchedAt)})` : ""}`
                  : modelsSource === "catalog"
                    ? "Catálogo local: conecte a chave para listar os modelos da sua conta"
                    : ""}
              </span>
              <button type="button" className="inline-flex items-center gap-1 hover:text-slate-600" onClick={() => void loadModels(true)} disabled={busy === "models"}>
                <RefreshCw className={busy === "models" ? "h-3 w-3 animate-spin" : "h-3 w-3"} /> Atualizar lista
              </button>
            </div>
            {defaultModel && models.find((model) => model.id === defaultModel)?.purpose && (
              <p className="text-xs text-slate-500">{models.find((model) => model.id === defaultModel)?.purpose}</p>
            )}
          </div>
        </Field>
      </div>

      {feedback && <Notice tone={feedback.ok ? "ok" : "error"}>{feedback.ok ? "✓ " : ""}{feedback.message}</Notice>}
      {provider.lastTestedAt && (
        <p className="text-[11px] text-slate-400">
          Último teste: {formatDateTime(provider.lastTestedAt)}
          {provider.lastTestError ? ` — ${provider.lastTestError}` : " — OK"}
        </p>
      )}

      <div className="flex flex-wrap gap-2">
        <Button disabled={busy !== null || (!apiKey.trim() && !defaultModel)} onClick={() => void connect()}>
          {apiKey.trim() ? <Plug className="h-4 w-4" /> : <RefreshCw className="h-4 w-4" />}
          {busy === "connect" ? "Conectando…" : apiKey.trim() ? (provider.apiKeyHint ? "Atualizar chave" : "Conectar") : "Salvar modelo"}
        </Button>
        <Button variant="outline" disabled={busy !== null || !provider.apiKeyHint} onClick={() => void test()}>
          <PlugZap className="h-4 w-4" /> {busy === "test" ? "Testando…" : "Testar conexão"}
        </Button>
        {provider.apiKeyHint && (
          <Button variant="outline" disabled={busy !== null} onClick={() => void disconnect()}>
            <Unplug className="h-4 w-4" /> Desconectar
          </Button>
        )}
      </div>

      <div className="space-y-2 border-t border-slate-100 pt-4">
        <div className="flex items-center justify-between">
          <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Saldo / créditos do provedor</p>
          <Button size="sm" variant="outline" disabled={busy !== null || !connected} onClick={() => void checkBilling()}>
            {busy === "billing" ? "Consultando…" : "Consultar"}
          </Button>
        </div>
        {billing ? (
          billing.available ? (
            <p className="text-sm text-slate-700">
              Custo faturado no mês, informado pela OpenAI: <strong>{formatUsdFromMicros(billing.monthCostMicros)}</strong>
              <span className="block text-[11px] text-slate-400">Consultado em {formatDateTime(billing.checkedAt)}. Saldo pré-pago não é exposto pela API.</span>
            </p>
          ) : (
            <Notice tone="info">{billing.reason}</Notice>
          )
        ) : (
          <p className="text-xs text-slate-400">
            A OpenAI não expõe saldo pré-pago por API. O custo faturado só é informado para chave de administrador; o
            consumo registrado pelo AZVCHAT está em Consumo e limites.
          </p>
        )}
      </div>
    </Section>
  );
}

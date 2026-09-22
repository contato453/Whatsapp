"use client";

import { useEffect, useState } from "react";
import { Plus, Save, Trash2 } from "lucide-react";
import {
  AI_MODEL_CATALOG,
  AI_TRANSCRIPTION_LIMITS,
  AI_TRANSCRIPTION_MODELS,
  AI_VISION_LIMITS,
  type AiSettingsDto,
} from "@azvchat/shared";
import { ApiError, aiApi } from "@/lib/api";
import { Button, Field, Input } from "@/components/ui";
import { Notice, Section } from "./ai-ui";

/**
 * Configurações gerais — só admin: timeout do provedor, quantas mensagens
 * recentes vão ao modelo por padrão, a transcrição dos áudios do cliente e a
 * tabela de preço por modelo (para o custo estimado de modelo que o catálogo
 * não conhece, ou para corrigir um preço que mudou).
 */
export function GeneralPanel() {
  const [settings, setSettings] = useState<AiSettingsDto | null>(null);
  const [timeoutSeconds, setTimeoutSeconds] = useState("30");
  const [contextLimit, setContextLimit] = useState("20");
  const [transcribeAudio, setTranscribeAudio] = useState(true);
  const [transcriptionModel, setTranscriptionModel] = useState(AI_TRANSCRIPTION_MODELS[0]?.id ?? "");
  const [describeImages, setDescribeImages] = useState(true);
  const [pricing, setPricing] = useState<Array<{ model: string; input: string; output: string }>>([]);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<{ ok: boolean; message: string } | null>(null);

  useEffect(() => {
    void aiApi.settings().then((data) => {
      setSettings(data);
      setTimeoutSeconds(String(Math.round(data.timeoutMs / 1000)));
      setContextLimit(String(data.contextMessageLimit));
      setTranscribeAudio(data.transcribeAudio);
      setTranscriptionModel(data.transcriptionModel);
      setDescribeImages(data.describeImages);
      setPricing(
        Object.entries(data.pricingOverrides).map(([model, price]) => ({
          model,
          input: String(price.inputPerMillion),
          output: String(price.outputPerMillion),
        })),
      );
    });
  }, []);

  async function save() {
    if (!settings) return;
    setBusy(true);
    setFeedback(null);
    try {
      const overrides: AiSettingsDto["pricingOverrides"] = {};
      for (const row of pricing) {
        const model = row.model.trim();
        const input = Number(row.input.replace(",", "."));
        const output = Number(row.output.replace(",", "."));
        if (!model) continue;
        if (!Number.isFinite(input) || !Number.isFinite(output)) throw new Error(`Preço inválido para ${model}`);
        overrides[model] = { inputPerMillion: input, outputPerMillion: output };
      }
      const saved = await aiApi.saveSettings({
        monthlyBudgetCents: settings.monthlyBudgetCents,
        alertThresholds: settings.alertThresholds,
        budgetPolicy: settings.budgetPolicy,
        timeoutMs: Math.max(5, Math.min(120, Number(timeoutSeconds) || 30)) * 1000,
        contextMessageLimit: Math.max(4, Math.min(60, Number(contextLimit) || 20)),
        pricingOverrides: overrides,
        transcribeAudio,
        transcriptionModel: transcriptionModel.trim() || (AI_TRANSCRIPTION_MODELS[0]?.id ?? ""),
        describeImages,
      });
      setSettings(saved);
      setFeedback({ ok: true, message: "Configurações salvas." });
    } catch (err) {
      setFeedback({ ok: false, message: err instanceof ApiError || err instanceof Error ? err.message : "Não foi possível salvar" });
    } finally {
      setBusy(false);
    }
  }

  if (!settings) return null;
  return (
    <div className="space-y-4">
      <Section title="Tempo de resposta e contexto" description="Valem para todos os agentes; o agente pode definir o próprio limite de contexto.">
        <div className="grid gap-4 md:grid-cols-2">
          <Field label="Timeout do provedor (segundos, 5 a 120)">
            <Input type="number" min={5} max={120} value={timeoutSeconds} onChange={(event) => setTimeoutSeconds(event.target.value)} />
          </Field>
          <Field label="Mensagens recentes enviadas ao modelo (4 a 60)">
            <Input type="number" min={4} max={60} value={contextLimit} onChange={(event) => setContextLimit(event.target.value)} />
          </Field>
        </div>
        <p className="text-[11px] text-slate-400">
          Em timeout a chamada é registrada como erro; o motor tenta de novo com segurança e, esgotadas as tentativas do
          agente, aplica o fallback (mensagem ao cliente + fila humana). Nunca responde duas vezes.
        </p>
      </Section>

      <Section
        title="Anexos do cliente"
        description="Com a leitura ligada, o áudio, a foto e o documento que o cliente manda chegam à IA como texto. Desligada, a IA avisa que não conseguiu abrir e pede que o cliente escreva."
      >
        <label className="flex items-start gap-2 text-sm text-slate-700">
          <input
            type="checkbox"
            className="mt-0.5"
            checked={transcribeAudio}
            onChange={(event) => setTranscribeAudio(event.target.checked)}
          />
          <span>
            Transcrever os áudios recebidos para a IA entender
            <span className="block text-[11px] text-slate-400">
              Cada agente ainda decide pela capacidade &quot;Ouvir áudios do cliente&quot;: este é o interruptor do
              escritório, e desligado vale para todos.
            </span>
          </span>
        </label>
        <Field label="Modelo que transcreve">
          <select
            className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm"
            value={transcriptionModel}
            onChange={(event) => setTranscriptionModel(event.target.value)}
            disabled={!transcribeAudio}
          >
            {AI_TRANSCRIPTION_MODELS.every((model) => model.id !== transcriptionModel) && (
              <option value={transcriptionModel}>{transcriptionModel}</option>
            )}
            {AI_TRANSCRIPTION_MODELS.map((model) => (
              <option key={model.id} value={model.id}>
                {model.label} — {model.purpose}
              </option>
            ))}
          </select>
        </Field>
        <label className="flex items-start gap-2 text-sm text-slate-700">
          <input
            type="checkbox"
            className="mt-0.5"
            checked={describeImages}
            onChange={(event) => setDescribeImages(event.target.checked)}
          />
          <span>
            Descrever as imagens recebidas para a IA entender
            <span className="block text-[11px] text-slate-400">
              A foto é lida pelo mesmo modelo do agente, que também transcreve o texto visível (comprovante, boleto,
              print). O agente ainda decide pela capacidade &quot;Ver imagens do cliente&quot;.
            </span>
          </span>
        </label>
        <p className="text-[11px] text-slate-400">
          Cada anexo é lido uma vez e o resultado aparece na bolha da conversa, para a equipe conferir o que a IA
          entendeu. O áudio é cobrado por minuto (&quot;Transcrição de áudio&quot; no consumo) e a imagem por token do
          modelo do agente (&quot;Leitura de imagem&quot;), as duas separadas do atendimento. Áudio acima de{" "}
          {Math.round(AI_TRANSCRIPTION_LIMITS.maxSeconds / 60)} minutos e imagem acima de{" "}
          {Math.round(AI_VISION_LIMITS.maxBytes / (1024 * 1024))} MB não são lidos. <strong>Documento</strong> (PDF,
          DOCX e TXT) é lido aqui no servidor, sem custo, e por isso não tem interruptor: quem decide é a capacidade
          &quot;Ler documentos do cliente&quot; de cada agente.
        </p>
      </Section>

      <Section
        title="Tabela de preço por modelo (USD por 1 milhão de tokens)"
        description="O custo estimado sai do catálogo local. Sobreponha aqui quando o preço mudar ou para um modelo que o catálogo não conhece — sem preço, a chamada fica sem custo (e a tela avisa), nunca com custo inventado."
      >
        <div className="space-y-2">
          <div className="grid grid-cols-[1fr_8rem_8rem_2.5rem] gap-2 text-[10px] font-semibold uppercase text-slate-400">
            <span>Modelo</span>
            <span>Entrada</span>
            <span>Saída</span>
            <span />
          </div>
          {pricing.map((row, index) => (
            <div key={index} className="grid grid-cols-[1fr_8rem_8rem_2.5rem] gap-2">
              <Input list="ai-model-ids" value={row.model} placeholder="gpt-4.1-mini" onChange={(event) => setPricing(pricing.map((item, i) => (i === index ? { ...item, model: event.target.value } : item)))} />
              <Input inputMode="decimal" value={row.input} onChange={(event) => setPricing(pricing.map((item, i) => (i === index ? { ...item, input: event.target.value } : item)))} />
              <Input inputMode="decimal" value={row.output} onChange={(event) => setPricing(pricing.map((item, i) => (i === index ? { ...item, output: event.target.value } : item)))} />
              <Button variant="ghost" size="sm" onClick={() => setPricing(pricing.filter((_, i) => i !== index))}>
                <Trash2 className="h-3.5 w-3.5 text-red-500" />
              </Button>
            </div>
          ))}
          <datalist id="ai-model-ids">
            {AI_MODEL_CATALOG.map((model) => (
              <option key={model.id} value={model.id} />
            ))}
          </datalist>
          <Button size="sm" variant="outline" onClick={() => setPricing([...pricing, { model: "", input: "", output: "" }])}>
            <Plus className="h-3.5 w-3.5" /> Adicionar modelo
          </Button>
        </div>
        <details className="text-xs text-slate-500">
          <summary className="cursor-pointer">Catálogo local (referência)</summary>
          <ul className="mt-2 space-y-0.5">
            {AI_MODEL_CATALOG.map((model) => (
              <li key={model.id}>
                <span className="font-mono">{model.id}</span>: US$ {model.inputPerMillion} / {model.outputPerMillion} — {model.purpose}
              </li>
            ))}
          </ul>
        </details>
      </Section>

      {feedback && <Notice tone={feedback.ok ? "ok" : "error"}>{feedback.message}</Notice>}
      <Button disabled={busy} onClick={() => void save()}>
        <Save className="h-4 w-4" /> Salvar configurações
      </Button>
    </div>
  );
}

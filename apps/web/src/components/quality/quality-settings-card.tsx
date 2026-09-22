"use client";

import { useState } from "react";
import { QUALITY_SETTINGS_LIMITS } from "@azvchat/shared";
import { qualityApi } from "@/lib/api";
import type { QualitySettingsDto } from "@/lib/types";
import { Button, Card, Field, Input, Spinner } from "@/components/ui";

/**
 * Os tetos do módulo. Configuráveis porque o custo é do escritório, e lidos do
 * banco a cada disparo — mudar aqui vale na análise seguinte, sem reiniciar
 * nada.
 */
export function QualitySettingsCard({
  settings,
  onSaved,
}: {
  settings: QualitySettingsDto;
  onSaved: (settings: QualitySettingsDto) => void;
}) {
  const [conversas, setConversas] = useState(String(settings.maxConversationsPerRun));
  const [minutosAudio, setMinutosAudio] = useState(String(Math.round(settings.maxAudioSeconds / 60)));
  const [cobertura, setCobertura] = useState(String(settings.minCoveragePercent));
  const [modelo, setModelo] = useState(settings.model ?? "");
  const [salvando, setSalvando] = useState(false);
  const [erro, setErro] = useState<string | null>(null);

  async function salvar(): Promise<void> {
    setErro(null);
    setSalvando(true);
    try {
      onSaved(
        await qualityApi.saveSettings({
          maxConversationsPerRun: Number(conversas),
          maxAudioSeconds: Number(minutosAudio) * 60,
          minCoveragePercent: Number(cobertura),
          model: modelo.trim() || null,
        }),
      );
    } catch (err) {
      setErro(err instanceof Error ? err.message : "Não foi possível salvar.");
    } finally {
      setSalvando(false);
    }
  }

  return (
    <Card>
      <h2 className="text-sm font-semibold text-slate-900">Limites do módulo</h2>
      <p className="mt-1 text-xs text-slate-500">
        Cada análise é uma chamada paga ao provedor de inteligência artificial. Estes limites existem para
        o custo ficar previsível.
      </p>
      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        <Field label="Conversas por disparo">
          <Input
            type="number"
            min={QUALITY_SETTINGS_LIMITS.maxConversationsPerRun.min}
            max={QUALITY_SETTINGS_LIMITS.maxConversationsPerRun.max}
            value={conversas}
            onChange={(event) => setConversas(event.target.value)}
          />
        </Field>
        <Field label="Duração máxima de áudio transcrito (minutos)">
          <Input
            type="number"
            min={Math.round(QUALITY_SETTINGS_LIMITS.maxAudioSeconds.min / 60)}
            max={Math.round(QUALITY_SETTINGS_LIMITS.maxAudioSeconds.max / 60)}
            value={minutosAudio}
            onChange={(event) => setMinutosAudio(event.target.value)}
          />
        </Field>
        <Field label="Cobertura mínima para não marcar como parcial (%)">
          <Input
            type="number"
            min={QUALITY_SETTINGS_LIMITS.minCoveragePercent.min}
            max={QUALITY_SETTINGS_LIMITS.minCoveragePercent.max}
            value={cobertura}
            onChange={(event) => setCobertura(event.target.value)}
          />
        </Field>
        <Field label="Modelo da avaliação (em branco usa o padrão do provedor)">
          <Input value={modelo} onChange={(event) => setModelo(event.target.value)} placeholder="gpt-4.1-mini" />
        </Field>
      </div>
      <p className="mt-3 text-xs text-slate-500">
        Áudio mais longo que o limite entra na avaliação apenas como marcador com a duração, e isso reduz a
        cobertura da análise.
      </p>
      {erro ? <p className="mt-3 text-xs text-red-600">{erro}</p> : null}
      <Button className="mt-4" onClick={salvar} disabled={salvando}>
        {salvando ? <Spinner className="h-4 w-4" /> : null}
        Salvar limites
      </Button>
    </Card>
  );
}

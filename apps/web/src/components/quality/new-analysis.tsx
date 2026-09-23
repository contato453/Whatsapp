"use client";

import { useState } from "react";
import { Play, X } from "lucide-react";
import { qualityApi } from "@/lib/api";
import type { ConversationDto, QualityRunDto, QualitySettingsDto } from "@/lib/types";
import { Button, Card, Input, Spinner } from "@/components/ui";
import { ConversationPicker, conversationLabel } from "./conversation-picker";
import { dateInputValue } from "./quality-ui";

/**
 * DISPARO DA ANÁLISE: escolher o período, escolher as conversas, disparar.
 *
 * Nada roda sozinho, e é isso que mantém o custo sob controle: quem dispara é o
 * administrador, com a seleção inteira na frente dele. A escolha das conversas
 * mora em `ConversationPicker`, que mostra a lista com o chip do número, o
 * departamento e o responsável — ver o comentário de lá.
 */

/** Atalhos de período. Dias corridos, contando hoje. */
const ATALHOS = [
  { dias: 7, label: "7 dias" },
  { dias: 15, label: "15 dias" },
  { dias: 30, label: "30 dias" },
] as const;

export function NewAnalysis({
  settings,
  onStarted,
}: {
  settings: QualitySettingsDto | null;
  onStarted: (run: QualityRunDto) => void;
}) {
  const [selecionadas, setSelecionadas] = useState<ConversationDto[]>([]);
  const [de, setDe] = useState(() => dateInputValue(new Date(Date.now() - 6 * 86_400_000)));
  const [ate, setAte] = useState(() => dateInputValue(new Date()));
  const [enviando, setEnviando] = useState(false);
  const [erro, setErro] = useState<string | null>(null);

  const teto = settings?.maxConversationsPerRun ?? 20;

  async function disparar(): Promise<void> {
    setErro(null);
    if (selecionadas.length === 0) {
      setErro("Escolha ao menos uma conversa.");
      return;
    }
    if (selecionadas.length > teto) {
      setErro(
        `Cada análise aceita no máximo ${teto} conversas, e você escolheu ${selecionadas.length}. Reduza a seleção ou aumente o limite em Configurações do módulo.`,
      );
      return;
    }
    setEnviando(true);
    try {
      // O período vai como INSTANTE: do começo do primeiro dia ao fim do
      // último, senão "hoje até hoje" seria uma janela de zero segundo.
      const run = await qualityApi.start({
        conversationIds: selecionadas.map((conversation) => conversation.id),
        from: new Date(`${de}T00:00:00`).toISOString(),
        to: new Date(`${ate}T23:59:59`).toISOString(),
      });
      setSelecionadas([]);
      onStarted(run);
    } catch (err) {
      setErro(err instanceof Error ? err.message : "Não foi possível disparar a análise.");
    } finally {
      setEnviando(false);
    }
  }

  return (
    <div className="space-y-4">
      <Card className="p-5">
        <h2 className="text-sm font-semibold text-slate-900">Período avaliado</h2>
        <p className="mt-1 text-xs text-slate-500">
          Só as mensagens dentro deste período entram na avaliação. Mensagens apagadas e notas internas
          nunca entram.
        </p>
        <div className="mt-3 flex flex-wrap items-end gap-3">
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-slate-600">De</span>
            <Input type="date" value={de} max={ate} onChange={(event) => setDe(event.target.value)} />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-slate-600">Até</span>
            <Input type="date" value={ate} min={de} onChange={(event) => setAte(event.target.value)} />
          </label>
          {/* Atalhos: o período quase sempre é "a semana" ou "o mês", e digitar
              duas datas para isso é trabalho que a tela pode poupar. */}
          <div className="flex flex-wrap gap-1 pb-0.5">
            {ATALHOS.map((atalho) => (
              <Button
                key={atalho.dias}
                type="button"
                variant="outline"
                size="sm"
                onClick={() => {
                  setDe(dateInputValue(new Date(Date.now() - (atalho.dias - 1) * 86_400_000)));
                  setAte(dateInputValue(new Date()));
                }}
              >
                {atalho.label}
              </Button>
            ))}
          </div>
        </div>
      </Card>

      <Card className="p-5">
        {/* `min-w-0` no título e `shrink-0` no contador: sem os dois, o contador
            é empurrado para fora do card quando a coluna estreita. */}
        <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
          <h2 className="min-w-0 text-sm font-semibold text-slate-900">Conversas</h2>
          <span className="shrink-0 text-xs text-slate-500">
            {selecionadas.length} de {teto} selecionadas
          </span>
        </div>
        <p className="mt-1 text-xs text-slate-500">
          Filtre por conexão, departamento ou atendente e marque as conversas que entram na análise.
        </p>

        {selecionadas.length > 0 ? (
          <div className="mt-3 flex flex-wrap gap-2">
            {selecionadas.map((conversation) => (
              <span
                key={conversation.id}
                className="inline-flex max-w-full items-center gap-1 rounded-full bg-brand-50 px-3 py-1 text-xs text-brand-700 ring-1 ring-brand-400"
              >
                <span className="min-w-0 truncate">{conversationLabel(conversation)}</span>
                <button
                  type="button"
                  aria-label={`Remover ${conversationLabel(conversation)} da seleção`}
                  className="shrink-0 rounded-full p-0.5 hover:bg-brand-100"
                  onClick={() =>
                    setSelecionadas((atual) => atual.filter((item) => item.id !== conversation.id))
                  }
                >
                  <X className="h-3 w-3" />
                </button>
              </span>
            ))}
          </div>
        ) : null}

        <div className="mt-3">
          <ConversationPicker
            selecionadas={selecionadas}
            onChange={(conversas) => {
              setErro(null);
              setSelecionadas(conversas);
            }}
            teto={teto}
          />
        </div>
      </Card>

      {erro ? (
        <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700 ring-1 ring-red-200">{erro}</p>
      ) : null}

      <div className="flex items-center gap-3">
        <Button onClick={disparar} disabled={enviando}>
          {enviando ? <Spinner className="h-4 w-4" /> : <Play className="h-4 w-4" />}
          Disparar análise
        </Button>
        <p className="text-xs text-slate-500">
          A análise roda em segundo plano: você pode sair desta tela e voltar depois.
        </p>
      </div>
    </div>
  );
}

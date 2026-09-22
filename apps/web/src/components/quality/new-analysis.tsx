"use client";

import { useEffect, useMemo, useState } from "react";
import { Loader2, Play, Search, X } from "lucide-react";
import { qualityApi, searchApi } from "@/lib/api";
import type { ConversationDto, QualityRunDto, QualitySettingsDto } from "@/lib/types";
import { Button, Card, Input, Spinner } from "@/components/ui";
import { dateInputValue } from "./quality-ui";

/**
 * DISPARO DA ANÁLISE: escolher conversas, escolher o período, disparar.
 *
 * O seletor usa a MESMA busca de conversas do resto do sistema (`GET /search`),
 * em vez de uma busca própria: duas buscas divergiriam no que encontram, e a
 * equipe sentiria sem saber nomear.
 *
 * Nada roda sozinho, e é isso que mantém o custo sob controle: quem dispara é o
 * administrador, com a seleção na frente dele.
 */
export function NewAnalysis({
  settings,
  onStarted,
}: {
  settings: QualitySettingsDto | null;
  onStarted: (run: QualityRunDto) => void;
}) {
  const [termo, setTermo] = useState("");
  const [buscando, setBuscando] = useState(false);
  const [resultados, setResultados] = useState<ConversationDto[]>([]);
  const [selecionadas, setSelecionadas] = useState<ConversationDto[]>([]);
  const [de, setDe] = useState(() => dateInputValue(new Date(Date.now() - 6 * 86_400_000)));
  const [ate, setAte] = useState(() => dateInputValue(new Date()));
  const [enviando, setEnviando] = useState(false);
  const [erro, setErro] = useState<string | null>(null);

  const teto = settings?.maxConversationsPerRun ?? 20;

  // Busca com espera curta: o campo é de digitação, e uma requisição por tecla
  // castigaria o banco para mostrar resultado que já vai mudar.
  useEffect(() => {
    const consulta = termo.trim();
    if (consulta.length < 2) {
      setResultados([]);
      return;
    }
    let ativo = true;
    setBuscando(true);
    const timer = setTimeout(() => {
      searchApi
        .query(consulta, 20)
        .then((data) => {
          if (ativo) setResultados(data.conversations);
        })
        .catch(() => {
          if (ativo) setResultados([]);
        })
        .finally(() => {
          if (ativo) setBuscando(false);
        });
    }, 350);
    return () => {
      ativo = false;
      clearTimeout(timer);
    };
  }, [termo]);

  const selecionadasIds = useMemo(
    () => new Set(selecionadas.map((conversation) => conversation.id)),
    [selecionadas],
  );

  function alternar(conversation: ConversationDto): void {
    setErro(null);
    setSelecionadas((atual) =>
      atual.some((item) => item.id === conversation.id)
        ? atual.filter((item) => item.id !== conversation.id)
        : [...atual, conversation],
    );
  }

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
      <Card>
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
        </div>
      </Card>

      <Card>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-sm font-semibold text-slate-900">Conversas</h2>
          <span className="text-xs text-slate-500">
            {selecionadas.length} de no máximo {teto} selecionadas
          </span>
        </div>
        <div className="relative mt-3">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
          <Input
            className="pl-9"
            placeholder="Buscar conversa por nome, telefone ou código do cadastro"
            value={termo}
            onChange={(event) => setTermo(event.target.value)}
          />
          {buscando ? (
            <Loader2 className="absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 animate-spin text-slate-400" />
          ) : null}
        </div>

        {selecionadas.length > 0 ? (
          <div className="mt-3 flex flex-wrap gap-2">
            {selecionadas.map((conversation) => (
              <span
                key={conversation.id}
                className="inline-flex items-center gap-1 rounded-full bg-brand-50 px-3 py-1 text-xs text-brand-700 ring-1 ring-brand-400"
              >
                {conversationLabel(conversation)}
                <button
                  type="button"
                  aria-label={`Remover ${conversationLabel(conversation)} da seleção`}
                  className="rounded-full p-0.5 hover:bg-brand-100"
                  onClick={() => alternar(conversation)}
                >
                  <X className="h-3 w-3" />
                </button>
              </span>
            ))}
          </div>
        ) : null}

        <div className="mt-3 max-h-72 space-y-1 overflow-y-auto">
          {termo.trim().length >= 2 && !buscando && resultados.length === 0 ? (
            <p className="py-6 text-center text-sm text-slate-500">Nenhuma conversa encontrada.</p>
          ) : null}
          {resultados.map((conversation) => {
            const marcada = selecionadasIds.has(conversation.id);
            return (
              <button
                key={conversation.id}
                type="button"
                onClick={() => alternar(conversation)}
                className={`flex w-full items-center justify-between gap-3 rounded-lg border px-3 py-2 text-left text-sm transition ${
                  marcada
                    ? "border-brand-400 bg-brand-50 text-brand-700"
                    : "border-slate-200 bg-white hover:bg-slate-50"
                }`}
              >
                <span className="min-w-0 truncate">{conversationLabel(conversation)}</span>
                <span className="shrink-0 text-xs text-slate-500">
                  {conversation.type === "group" ? "Grupo" : "Individual"}
                </span>
              </button>
            );
          })}
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

function conversationLabel(conversation: ConversationDto): string {
  return conversation.customTitle || conversation.title || "Conversa sem título";
}

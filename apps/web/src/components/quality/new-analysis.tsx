"use client";

import { useEffect, useState } from "react";
import { Building2, Play, X } from "lucide-react";
import { api } from "@/lib/api";
import { qualityApi } from "@/lib/api";
import type {
  ConversationDto,
  DepartmentDto,
  QualityRunDto,
  QualitySettingsDto,
  UserDirectoryDto,
} from "@/lib/types";
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
 *
 * MONTAR PELO SETOR é o atalho para a pergunta que o dono do escritório faz de
 * verdade ("como o CS foi em agosto"): escolhe setor e período, e
 * `GET /quality/candidates` devolve as conversas que REALMENTE entrariam — as
 * que têm mensagem de um atendente no período, que é a mesma condição que o
 * analisador aplica. Sem esse recorte, metade do teto seria gasta com conversa
 * que o disparo iria pular, e a recusa só apareceria depois, na tela de
 * análises.
 *
 * O atalho PREENCHE a seleção, nunca dispara direto. A pessoa vê os chips do
 * que vai ser analisado antes de gastar, pelo mesmo motivo que a prévia do
 * anexo existe antes do envio: análise disparada não se desfaz, e o custo já
 * foi pago ao provedor.
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

  // Montar pelo setor.
  const [departments, setDepartments] = useState<DepartmentDto[]>([]);
  const [users, setUsers] = useState<UserDirectoryDto[]>([]);
  const [setor, setSetor] = useState("");
  const [quemRespondeu, setQuemRespondeu] = useState("");
  const [soAtrasadas, setSoAtrasadas] = useState(false);
  const [buscando, setBuscando] = useState(false);
  const [resumo, setResumo] = useState<{ total: number; trazidas: number; omitted: number } | null>(null);

  const teto = settings?.maxConversationsPerRun ?? 20;

  useEffect(() => {
    void api
      .get<{ departments: DepartmentDto[] }>("/departments")
      .then((data) => setDepartments(data.departments))
      .catch(() => undefined);
    void api
      .get<{ users: UserDirectoryDto[] }>("/users")
      .then((data) => setUsers(data.users))
      .catch(() => undefined);
  }, []);

  /**
   * Preenche a seleção com as candidatas do recorte. SUBSTITUI o que estava
   * marcado em vez de somar: o atalho é "analise o CS de agosto", e somar a uma
   * seleção anterior produziria um recorte que ninguém pediu.
   */
  async function montarPeloSetor(): Promise<void> {
    setErro(null);
    setBuscando(true);
    try {
      const data = await qualityApi.candidates({
        from: new Date(`${de}T00:00:00`).toISOString(),
        to: new Date(`${ate}T23:59:59`).toISOString(),
        departmentId: setor || undefined,
        userId: quemRespondeu || undefined,
        onlyOverdue: soAtrasadas || undefined,
        limit: teto,
      });
      setSelecionadas(data.conversations);
      setResumo({ total: data.total, trazidas: data.conversations.length, omitted: data.omitted });
    } catch (err) {
      setResumo(null);
      setErro(err instanceof Error ? err.message : "Não foi possível montar a seleção.");
    } finally {
      setBuscando(false);
    }
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
        <h2 className="flex items-center gap-2 text-sm font-semibold text-slate-900">
          <Building2 className="h-4 w-4 text-brand-600" /> Montar pelo setor
        </h2>
        <p className="mt-1 text-xs text-slate-500">
          Traz as conversas do período em que algum atendente respondeu — que são as que a análise
          consegue avaliar. Substitui a seleção atual, e você confere antes de disparar.
        </p>
        <div className="mt-3 flex flex-wrap items-end gap-3">
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-slate-600">Departamento</span>
            <select
              value={setor}
              onChange={(event) => setSetor(event.target.value)}
              className="w-56 rounded-lg border border-slate-300 px-3 py-2 text-sm"
            >
              <option value="">Todos</option>
              {departments.map((department) => (
                <option key={department.id} value={department.id}>
                  {department.name}
                </option>
              ))}
              <option value="none">Sem departamento</option>
            </select>
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-slate-600">Quem respondeu</span>
            <select
              value={quemRespondeu}
              onChange={(event) => setQuemRespondeu(event.target.value)}
              className="w-56 rounded-lg border border-slate-300 px-3 py-2 text-sm"
              title="Quem escreveu no período, e não o responsável do card: a conversa que a pessoa atendeu cobrindo férias de outra é trabalho dela."
            >
              <option value="">Qualquer atendente</option>
              {users
                .filter((user) => user.status === "active")
                .map((user) => (
                  <option key={user.id} value={user.id}>
                    {user.name}
                  </option>
                ))}
            </select>
          </label>
          <label
            className={`flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-2 text-sm transition ${
              soAtrasadas
                ? "border-amber-300 bg-amber-50 text-amber-800"
                : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50"
            }`}
            title="Mesma conta do card Atrasados agora: não resolvidas, com a última mensagem do cliente, esperando além do limite em tempo de expediente."
          >
            <input
              type="checkbox"
              checked={soAtrasadas}
              onChange={(event) => setSoAtrasadas(event.target.checked)}
              className="h-4 w-4 rounded border-slate-300"
            />
            Só as atrasadas
          </label>
          <Button variant="outline" onClick={() => void montarPeloSetor()} disabled={buscando}>
            {buscando ? <Spinner className="h-4 w-4" /> : <Building2 className="h-4 w-4" />}
            Buscar candidatas
          </Button>
        </div>
        {resumo ? (
          <p className="mt-3 rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-600 ring-1 ring-slate-200">
            {resumo.trazidas === 0
              ? "Nenhuma conversa do recorte teve resposta de atendente neste período."
              : `${resumo.trazidas} ${resumo.trazidas === 1 ? "conversa marcada" : "conversas marcadas"} de ${resumo.total} que se encaixam no recorte.`}
            {resumo.omitted > 0
              ? ` ${resumo.omitted} ${resumo.omitted === 1 ? "ficou" : "ficaram"} de fora pelo limite de ${teto} por análise — as mais recentes entram primeiro.`
              : ""}
          </p>
        ) : null}
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
              // Mexer na seleção na mão invalida o resumo do atalho: ele
              // descreve o recorte que foi buscado, não o que está marcado.
              setResumo(null);
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

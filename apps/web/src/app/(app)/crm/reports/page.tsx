"use client";

import { useCallback, useEffect, useState } from "react";
import { BarChart3 } from "lucide-react";
import { crmOriginLabel, formatCurrencyBRL } from "@azvchat/shared";
import { crmApi } from "@/lib/api";
import type { CrmPipelineDto, CrmReportDto } from "@/lib/types";
import { Card, EmptyState, Input, Spinner } from "@/components/ui";
import { CrmNav } from "@/components/crm/crm-nav";

/**
 * Os números do funil.
 *
 * O PIPELINE não tem período — ou a oportunidade está aberta agora, ou não
 * está —, enquanto ganhas, perdidas e conversão são do INTERVALO escolhido.
 * É a mesma separação do Dashboard entre "estado de agora" e "atividade do
 * período", e o rótulo de cada bloco diz qual é qual: sem isso alguém lê
 * "R$ 120.000 no funil" achando que fechou isso no mês.
 */
export default function CrmReportsPage() {
  const [pipelines, setPipelines] = useState<CrmPipelineDto[]>([]);
  const [pipelineId, setPipelineId] = useState("");
  const [from, setFrom] = useState(() => {
    const data = new Date();
    data.setDate(data.getDate() - 30);
    return data.toISOString().slice(0, 10);
  });
  const [to, setTo] = useState(() => new Date().toISOString().slice(0, 10));
  const [report, setReport] = useState<CrmReportDto | null>(null);
  const [carregando, setCarregando] = useState(true);
  const [erro, setErro] = useState<string | null>(null);

  useEffect(() => {
    void crmApi.pipelines().then(setPipelines).catch(() => undefined);
  }, []);

  const carregar = useCallback(async () => {
    setCarregando(true);
    setErro(null);
    try {
      setReport(
        await crmApi.reports({
          pipelineId: pipelineId || undefined,
          from: new Date(`${from}T00:00:00`).toISOString(),
          to: new Date(`${to}T23:59:59`).toISOString(),
        }),
      );
    } catch (err) {
      setErro(err instanceof Error ? err.message : "Não foi possível carregar os indicadores");
    } finally {
      setCarregando(false);
    }
  }, [pipelineId, from, to]);

  useEffect(() => {
    void carregar();
  }, [carregar]);

  return (
    <div className="flex h-full flex-col">
      <div className="px-4 pt-4">
        <h1 className="text-lg font-semibold text-slate-900">CRM</h1>
        <p className="text-xs text-slate-500">Indicadores do funil</p>
      </div>
      <CrmNav />

      <div className="flex flex-wrap items-end gap-2 px-4 py-2">
        <select
          value={pipelineId}
          onChange={(event) => setPipelineId(event.target.value)}
          className="rounded-lg border border-slate-300 bg-white px-2 py-1 text-xs"
          aria-label="Funil"
        >
          <option value="">Todos os funis</option>
          {pipelines.map((item) => (
            <option key={item.id} value={item.id}>
              {item.name}
            </option>
          ))}
        </select>
        <label className="text-[11px] text-slate-500">
          De
          <Input
            type="date"
            value={from}
            onChange={(event) => setFrom(event.target.value)}
            className="ml-1 inline-block h-7 w-36 py-0.5 text-xs"
          />
        </label>
        <label className="text-[11px] text-slate-500">
          Até
          <Input
            type="date"
            value={to}
            onChange={(event) => setTo(event.target.value)}
            className="ml-1 inline-block h-7 w-36 py-0.5 text-xs"
          />
        </label>
      </div>

      <div className="thin-scroll min-h-0 flex-1 overflow-y-auto px-4 pb-6">
        {carregando && <Spinner />}
        {erro && <p className="text-xs text-red-600">{erro}</p>}

        {!carregando && report && (
          <div className="space-y-4">
            <section>
              <h2 className="mb-2 text-xs font-medium uppercase tracking-wide text-slate-500">
                Agora (independe do período)
              </h2>
              <div className="grid gap-3 sm:grid-cols-3">
                <Indicador
                  titulo="Oportunidades em aberto"
                  valor={String(report.summary.pipeline.count)}
                />
                <Indicador
                  titulo="Valor do pipeline"
                  valor={formatCurrencyBRL(report.summary.pipeline.value)}
                />
                <Indicador
                  titulo="Valor ponderado"
                  valor={formatCurrencyBRL(report.summary.pipeline.weightedValue)}
                  detalhe="valor × probabilidade da etapa"
                />
              </div>
            </section>

            <section>
              <h2 className="mb-2 text-xs font-medium uppercase tracking-wide text-slate-500">
                No período
              </h2>
              <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-6">
                <Indicador titulo="Novas" valor={String(report.summary.created)} />
                <Indicador titulo="Ganhas" valor={String(report.summary.won)} />
                <Indicador titulo="Perdidas" valor={String(report.summary.lost)} />
                <Indicador
                  titulo="Conversão"
                  valor={`${report.summary.conversionRate}%`}
                  detalhe="ganhas ÷ fechadas"
                />
                <Indicador
                  titulo="Ticket médio"
                  valor={formatCurrencyBRL(report.summary.averageTicket)}
                />
                <Indicador
                  titulo="Tempo até fechar"
                  valor={`${report.summary.averageDaysToClose} dias`}
                />
              </div>
              <p className="mt-1 text-[11px] text-slate-500">
                Receita ganha no período: {formatCurrencyBRL(report.summary.wonValue)}
              </p>
            </section>

            <section>
              <h2 className="mb-2 text-xs font-medium uppercase tracking-wide text-slate-500">
                Por responsável
              </h2>
              <Tabela
                linhas={report.byUser}
                vazio="Nenhuma oportunidade no recorte."
              />
            </section>

            <section>
              <h2 className="mb-2 text-xs font-medium uppercase tracking-wide text-slate-500">
                Por origem
              </h2>
              <Tabela
                linhas={report.byOrigin.map((linha) => ({
                  ...linha,
                  label: crmOriginLabel(linha.key === "sem-origem" ? null : linha.key),
                }))}
                vazio="Nenhuma origem registrada."
              />
            </section>

            <section>
              <h2 className="mb-2 text-xs font-medium uppercase tracking-wide text-slate-500">
                Motivos de perda no período
              </h2>
              {report.lossReasons.length === 0 ? (
                <EmptyState
                  icon={<BarChart3 className="h-8 w-8" />}
                  title="Nenhuma perda registrada"
                  description="Motivo é obrigatório ao marcar uma oportunidade como perdida — é o que alimenta este bloco."
                />
              ) : (
                <Card className="divide-y divide-slate-100">
                  {report.lossReasons.map((motivo) => (
                    <div
                      key={motivo.id}
                      className="flex items-center justify-between px-3 py-2 text-sm"
                    >
                      <span className="text-slate-700">{motivo.name}</span>
                      <span className="font-medium text-slate-900">{motivo.count}</span>
                    </div>
                  ))}
                </Card>
              )}
            </section>
          </div>
        )}
      </div>
    </div>
  );
}

function Indicador({
  titulo,
  valor,
  detalhe,
}: {
  titulo: string;
  valor: string;
  detalhe?: string;
}) {
  return (
    <Card className="p-3">
      <p className="text-[11px] uppercase tracking-wide text-slate-400">{titulo}</p>
      <p className="mt-1 text-lg font-semibold text-slate-900">{valor}</p>
      {detalhe && <p className="text-[10px] text-slate-400">{detalhe}</p>}
    </Card>
  );
}

function Tabela({
  linhas,
  vazio,
}: {
  linhas: Array<{
    key: string;
    label: string;
    open: number;
    pipelineValue: number;
    won: number;
    lost: number;
    wonValue: number;
    conversionRate: number;
  }>;
  vazio: string;
}) {
  if (linhas.length === 0) {
    return <p className="text-xs text-slate-400">{vazio}</p>;
  }
  return (
    <Card className="overflow-x-auto">
      <table className="w-full min-w-[42rem] text-sm">
        <thead>
          <tr className="border-b border-slate-100 text-left text-[11px] uppercase tracking-wide text-slate-400">
            <th className="px-3 py-2">Nome</th>
            <th className="px-3 py-2 text-right">Em aberto</th>
            <th className="px-3 py-2 text-right">Pipeline</th>
            <th className="px-3 py-2 text-right">Ganhas</th>
            <th className="px-3 py-2 text-right">Perdidas</th>
            <th className="px-3 py-2 text-right">Receita</th>
            <th className="px-3 py-2 text-right">Conversão</th>
          </tr>
        </thead>
        <tbody>
          {linhas.map((linha) => (
            <tr key={linha.key} className="border-b border-slate-50 last:border-0">
              <td className="px-3 py-2 text-slate-700">{linha.label}</td>
              <td className="px-3 py-2 text-right text-slate-600">{linha.open}</td>
              <td className="px-3 py-2 text-right text-slate-600">
                {formatCurrencyBRL(linha.pipelineValue)}
              </td>
              <td className="px-3 py-2 text-right text-green-700">{linha.won}</td>
              <td className="px-3 py-2 text-right text-red-600">{linha.lost}</td>
              <td className="px-3 py-2 text-right text-slate-700">
                {formatCurrencyBRL(linha.wonValue)}
              </td>
              <td className="px-3 py-2 text-right text-slate-600">{linha.conversionRate}%</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
}

"use client";

import { useEffect, useState } from "react";
import { Plus } from "lucide-react";
import { formatCurrencyBRL } from "@azvchat/shared";
import { crmApi } from "@/lib/api";
import type { CrmLossReasonDto, CrmProductDto } from "@/lib/types";
import { Button, Card, Input, Spinner } from "@/components/ui";
import { CrmNav } from "@/components/crm/crm-nav";

/**
 * As duas listas de apoio do CRM: SERVIÇOS e MOTIVOS DE PERDA.
 *
 * Nenhuma das duas é apagável, só desativável — as duas aparecem em
 * oportunidades já fechadas, e apagar reescreveria o histórico ("perdida por
 * quê?" viraria "sem motivo" em negociações do ano passado). Desativar tira do
 * seletor e preserva o que já foi medido, o mesmo caminho de revogar token em
 * vez de excluir.
 */
export default function CrmSettingsPage() {
  const [products, setProducts] = useState<CrmProductDto[]>([]);
  const [lossReasons, setLossReasons] = useState<CrmLossReasonDto[]>([]);
  const [carregando, setCarregando] = useState(true);
  const [novoServico, setNovoServico] = useState("");
  const [valorServico, setValorServico] = useState("");
  const [novoMotivo, setNovoMotivo] = useState("");
  const [erro, setErro] = useState<string | null>(null);

  async function recarregar() {
    const data = await crmApi.settings();
    setProducts(data.products);
    setLossReasons(data.lossReasons);
    setCarregando(false);
  }

  useEffect(() => {
    void recarregar().catch(() => setCarregando(false));
  }, []);

  return (
    <div className="flex h-full flex-col">
      <div className="px-4 pt-4">
        <h1 className="text-lg font-semibold text-slate-900">CRM</h1>
        <p className="text-xs text-slate-500">Serviços e motivos de perda</p>
      </div>
      <CrmNav />

      <div className="thin-scroll min-h-0 flex-1 space-y-4 overflow-y-auto p-4">
        {carregando && <Spinner />}
        {erro && <p className="text-xs text-red-600">{erro}</p>}

        <Card className="p-4">
          <h2 className="text-sm font-semibold text-slate-800">Serviços</h2>
          <p className="mb-3 text-[11px] text-slate-500">
            O que o escritório vende. O valor sugerido só preenche o formulário — a oportunidade
            guarda o valor negociado, e mudar a lista nunca reescreve negociação fechada.
          </p>
          <div className="mb-3 flex flex-wrap gap-2">
            <Input
              value={novoServico}
              onChange={(event) => setNovoServico(event.target.value)}
              placeholder="Ex.: Abertura de empresa"
              className="w-64"
            />
            <Input
              value={valorServico}
              onChange={(event) => setValorServico(event.target.value)}
              placeholder="Valor sugerido"
              inputMode="decimal"
              className="w-40"
            />
            <Button
              size="sm"
              disabled={!novoServico.trim()}
              onClick={async () => {
                try {
                  const valor = Number(valorServico.replace(/\./g, "").replace(",", "."));
                  await crmApi.createProduct({
                    name: novoServico.trim(),
                    defaultValue: Number.isFinite(valor) && valor > 0 ? valor : null,
                  });
                  setNovoServico("");
                  setValorServico("");
                  await recarregar();
                } catch (err) {
                  setErro(err instanceof Error ? err.message : "Não foi possível criar");
                }
              }}
            >
              <Plus className="h-3.5 w-3.5" /> Adicionar
            </Button>
          </div>
          <div className="divide-y divide-slate-100">
            {products.map((produto) => (
              <div key={produto.id} className="flex items-center justify-between py-2 text-sm">
                <span className={produto.active ? "text-slate-700" : "text-slate-400 line-through"}>
                  {produto.name}
                  {produto.defaultValue != null && (
                    <span className="ml-2 text-[11px] text-slate-400">
                      {formatCurrencyBRL(produto.defaultValue)}
                    </span>
                  )}
                </span>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={async () => {
                    await crmApi.updateProduct(produto.id, { active: !produto.active });
                    await recarregar();
                  }}
                >
                  {produto.active ? "Desativar" : "Reativar"}
                </Button>
              </div>
            ))}
            {products.length === 0 && (
              <p className="py-3 text-xs text-slate-400">Nenhum serviço cadastrado ainda.</p>
            )}
          </div>
        </Card>

        <Card className="p-4">
          <h2 className="text-sm font-semibold text-slate-800">Motivos de perda</h2>
          <p className="mb-3 text-[11px] text-slate-500">
            Obrigatório ao marcar uma oportunidade como perdida. É esta lista que vira o relatório
            de motivos — campo livre não se agrupa.
          </p>
          <div className="mb-3 flex gap-2">
            <Input
              value={novoMotivo}
              onChange={(event) => setNovoMotivo(event.target.value)}
              placeholder="Ex.: Fechou com concorrente"
              className="w-64"
            />
            <Button
              size="sm"
              disabled={!novoMotivo.trim()}
              onClick={async () => {
                try {
                  await crmApi.createLossReason(novoMotivo.trim());
                  setNovoMotivo("");
                  await recarregar();
                } catch (err) {
                  setErro(err instanceof Error ? err.message : "Não foi possível criar");
                }
              }}
            >
              <Plus className="h-3.5 w-3.5" /> Adicionar
            </Button>
          </div>
          <div className="divide-y divide-slate-100">
            {lossReasons.map((motivo) => (
              <div key={motivo.id} className="flex items-center justify-between py-2 text-sm">
                <span className={motivo.active ? "text-slate-700" : "text-slate-400 line-through"}>
                  {motivo.name}
                </span>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={async () => {
                    await crmApi.updateLossReason(motivo.id, { active: !motivo.active });
                    await recarregar();
                  }}
                >
                  {motivo.active ? "Desativar" : "Reativar"}
                </Button>
              </div>
            ))}
          </div>
        </Card>
      </div>
    </div>
  );
}

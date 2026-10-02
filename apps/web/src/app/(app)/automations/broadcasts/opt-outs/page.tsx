"use client";

import { useCallback, useEffect, useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import type { BroadcastOptOutDto } from "@azvchat/shared";
import { ApiError, broadcastApi } from "@/lib/api";
import { useAuth } from "@/lib/auth-context";
import { Badge, Button, Card, EmptyState, Input, Spinner } from "@/components/ui";
import { BroadcastHeader, BroadcastTabs } from "@/components/broadcasts/broadcast-ui";

const MOTIVOS: Record<string, string> = {
  keyword: "Respondeu pedindo para sair",
  manual: "Cadastrado pela equipe",
  import: "Veio marcado na planilha",
};

export default function BroadcastOptOutsPage() {
  const { can } = useAuth();
  const [optOuts, setOptOuts] = useState<BroadcastOptOutDto[] | null>(null);
  const [phone, setPhone] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const podeMontar = can("broadcast.audience.manage");

  const load = useCallback(async () => {
    try {
      setOptOuts(await broadcastApi.optOuts.list());
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Não foi possível carregar a lista");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function adicionar() {
    setBusy(true);
    setError(null);
    try {
      await broadcastApi.optOuts.add(phone);
      setPhone("");
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Não foi possível cadastrar");
    } finally {
      setBusy(false);
    }
  }

  async function remover(item: BroadcastOptOutDto) {
    if (
      !window.confirm(
        `Tirar ${item.phoneLabel} da lista de descadastro?\n\n` +
          "Ele volta a receber disparo. Só faça isso se a pessoa pediu para voltar.",
      )
    ) {
      return;
    }
    try {
      await broadcastApi.optOuts.remove(item.id);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Não foi possível remover");
    }
  }

  return (
    <div className="thin-scroll h-full overflow-y-auto p-8">
      <BroadcastHeader
        title="Descadastros"
        description="Quem não recebe disparo nenhum do escritório, em nenhuma audiência."
      />
      <BroadcastTabs />

      <Card className="mb-5 p-4">
        <p className="text-xs leading-relaxed text-slate-500">
          Quem responde <strong>SAIR</strong>, <strong>PARAR</strong> ou <strong>CANCELAR</strong> a
          uma campanha entra aqui sozinho, na hora, e para de receber de TODAS as audiências —
          inclusive das planilhas que forem importadas depois. É a trava mais importante do
          módulo: receber depois de pedir para sair é o que transforma cliente irritado em
          denúncia, e denúncia derruba o número mais rápido que volume.
        </p>
      </Card>

      {podeMontar && (
        <div className="mb-5 flex flex-wrap items-end gap-2">
          <div className="w-full max-w-xs">
            <Input
              value={phone}
              onChange={(event) => setPhone(event.target.value)}
              placeholder="(11) 99999-8888"
            />
          </div>
          <Button disabled={busy || phone.trim().length < 8} onClick={() => void adicionar()}>
            <Plus className="h-4 w-4" /> Cadastrar descadastro
          </Button>
        </div>
      )}

      {error && <p className="mb-4 text-sm text-red-600">{error}</p>}

      {!optOuts ? (
        <div className="flex justify-center py-16">
          <Spinner className="h-8 w-8" />
        </div>
      ) : optOuts.length === 0 ? (
        <Card className="p-4">
          <EmptyState
            title="Ninguém descadastrado"
            description="Quando alguém pedir para sair, o número aparece aqui automaticamente."
          />
        </Card>
      ) : (
        <Card className="divide-y divide-slate-100">
          {optOuts.map((item) => (
            <div key={item.id} className="flex items-center justify-between gap-3 p-3">
              <div className="min-w-0">
                <p className="text-sm font-medium text-slate-800">{item.phoneLabel}</p>
                <p className="text-xs text-slate-400">
                  {MOTIVOS[item.reason] ?? item.reason} ·{" "}
                  {new Date(item.createdAt).toLocaleDateString("pt-BR")}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                {item.reason === "keyword" && <Badge color="#d97706">Pediu para sair</Badge>}
                {podeMontar && (
                  <button
                    type="button"
                    title="Remover da lista"
                    className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100 hover:text-red-600"
                    onClick={() => void remover(item)}
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                )}
              </div>
            </div>
          ))}
        </Card>
      )}
    </div>
  );
}

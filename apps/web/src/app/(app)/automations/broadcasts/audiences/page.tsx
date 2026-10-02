"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Plus, Trash2, Users } from "lucide-react";
import type { BroadcastAudienceDto } from "@azvchat/shared";
import { ApiError, broadcastApi } from "@/lib/api";
import { useAuth } from "@/lib/auth-context";
import { Badge, Button, Card, EmptyState, Field, Input, Modal, Spinner, Textarea } from "@/components/ui";
import { BroadcastHeader, BroadcastTabs } from "@/components/broadcasts/broadcast-ui";

export default function BroadcastAudiencesPage() {
  const { can } = useAuth();
  const [audiences, setAudiences] = useState<BroadcastAudienceDto[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({ name: "", description: "" });
  const [busy, setBusy] = useState(false);

  const podeMontar = can("broadcast.audience.manage");

  const load = useCallback(async () => {
    try {
      setAudiences(await broadcastApi.audiences.list());
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Não foi possível carregar as audiências");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function criar() {
    setBusy(true);
    setError(null);
    try {
      await broadcastApi.audiences.create({
        name: form.name.trim(),
        description: form.description.trim() || null,
      });
      setCreating(false);
      setForm({ name: "", description: "" });
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Não foi possível criar a audiência");
    } finally {
      setBusy(false);
    }
  }

  async function excluir(audience: BroadcastAudienceDto) {
    if (!window.confirm(`Excluir a audiência "${audience.name}" e os ${audience.contactCount} contatos dela?`)) {
      return;
    }
    setError(null);
    try {
      await broadcastApi.audiences.remove(audience.id);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Não foi possível excluir");
    }
  }

  return (
    <div className="thin-scroll h-full overflow-y-auto p-8">
      <BroadcastHeader
        title="Audiências"
        description="As listas de contatos que as campanhas usam. A mesma lista serve a quantas campanhas quiser."
        action={
          podeMontar ? (
            <Button onClick={() => setCreating(true)}>
              <Plus className="h-4 w-4" /> Nova audiência
            </Button>
          ) : undefined
        }
      />
      <BroadcastTabs />

      {error && <p className="mb-4 text-sm text-red-600">{error}</p>}

      {!audiences ? (
        <div className="flex justify-center py-16">
          <Spinner className="h-8 w-8" />
        </div>
      ) : audiences.length === 0 ? (
        <Card className="p-4">
          <EmptyState
            title="Nenhuma audiência ainda"
            description="Crie uma audiência e traga os contatos na mão ou por planilha."
          />
        </Card>
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {audiences.map((audience) => (
            <Card key={audience.id} className="p-5">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <Link
                    href={`/automations/broadcasts/audiences/${audience.id}`}
                    className="text-sm font-semibold text-slate-900 hover:text-brand-600"
                  >
                    {audience.name}
                  </Link>
                  {audience.description && (
                    <p className="mt-0.5 line-clamp-2 text-xs text-slate-500">{audience.description}</p>
                  )}
                </div>
                {podeMontar && (
                  <button
                    type="button"
                    title="Excluir"
                    className="shrink-0 rounded-lg p-1.5 text-slate-400 hover:bg-slate-100 hover:text-red-600"
                    onClick={() => void excluir(audience)}
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                )}
              </div>
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <Badge>
                  <Users className="h-3 w-3" /> {audience.contactCount} contatos
                </Badge>
                {/* Descadastrado continua NA audiência e aparece contado: some
                    da lista, ninguém entenderia por que o disparo saiu para
                    menos gente do que o cadastro mostra. */}
                {audience.optedOutCount > 0 && (
                  <Badge color="#d97706">{audience.optedOutCount} descadastrados</Badge>
                )}
              </div>
            </Card>
          ))}
        </div>
      )}

      <Modal open={creating} onClose={() => setCreating(false)} title="Nova audiência">
        <div className="space-y-4">
          <Field label="Nome">
            <Input
              value={form.name}
              onChange={(event) => setForm({ ...form, name: event.target.value })}
              placeholder="Clientes do Simples — janeiro"
              required
            />
          </Field>
          <Field label="Descrição (opcional)">
            <Textarea
              rows={3}
              value={form.description}
              onChange={(event) => setForm({ ...form, description: event.target.value })}
              placeholder="De onde veio esta lista e para que serve."
            />
          </Field>
          <Button className="w-full" disabled={busy || form.name.trim().length < 2} onClick={() => void criar()}>
            Criar audiência
          </Button>
        </div>
      </Modal>
    </div>
  );
}

"use client";

import { useCallback, useEffect, useState } from "react";
import { Plus, Trash2, Wallet } from "lucide-react";
import {
  AI_CREDIT_ENTRY_KIND_HINTS,
  AI_CREDIT_ENTRY_KIND_LABELS,
  AI_SPEND_USE_HINTS,
  type AiBalanceDto,
  type AiCreditEntryKind,
} from "@azvchat/shared";
import { ApiError, aiApi } from "@/lib/api";
import { useAuth } from "@/lib/auth-context";
import { cn, formatDateTime } from "@/lib/utils";
import { Button, Card, Field, Input, Modal, Spinner } from "@/components/ui";
import { formatCost, Notice, Section, StatTile } from "./ai-ui";

/**
 * Saldo ESTIMADO do crédito da IA (ver `services/ai/balance.ts`).
 *
 * A OpenAI não informa saldo pré-pago pela API, então o número sai de uma
 * conta: o saldo que o admin leu na OpenAI, mais as recargas, menos o
 * consumo que o AZVCHAT registra. O card diz isso com todas as letras: um
 * saldo apresentado como se viesse da OpenAI seria lido como verdade, e a
 * surpresa viria no dia em que ela recusasse por falta de crédito.
 */

function parseUsdToCents(text: string): number | null {
  let clean = text.replace(/US\$|\$|\s/gi, "");
  if (!clean) return null;
  // "1.234,56" e "37,20" (jeito brasileiro) ou "37.20".
  if (clean.includes(",")) clean = clean.replace(/\./g, "").replace(",", ".");
  const value = Number(clean);
  if (!Number.isFinite(value) || value < 0) return null;
  return Math.round(value * 100);
}

function centsToInput(cents: number | null): string {
  return cents == null ? "" : (cents / 100).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** `datetime-local` quer o horário LOCAL sem fuso, e não o ISO em UTC. */
function nowForInput(): string {
  const now = new Date();
  now.setMinutes(now.getMinutes() - now.getTimezoneOffset());
  return now.toISOString().slice(0, 16);
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit", year: "numeric" });
}

export function AiBalanceCard() {
  const { user } = useAuth();
  const isAdmin = user?.role === "admin";
  const [balance, setBalance] = useState<AiBalanceDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState<AiCreditEntryKind | null>(null);
  const [showEntries, setShowEntries] = useState(false);

  const load = useCallback(async () => {
    try {
      setBalance(await aiApi.balance());
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Não foi possível carregar o saldo");
    }
  }, []);
  useEffect(() => void load(), [load]);

  async function remove(id: string) {
    if (!window.confirm("Excluir este lançamento? O saldo estimado é recalculado sem ele.")) return;
    try {
      setBalance(await aiApi.deleteCreditEntry(id));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Não foi possível excluir o lançamento");
    }
  }

  const description =
    "A OpenAI não informa o saldo pela API. O AZVCHAT parte do saldo que você informar, soma as recargas e desconta o consumo que ele mesmo registra (atendimento, automações, Quality, transcrição e imagem). A conta fecha porque a chave é usada só pelo AZVCHAT.";

  if (!balance) {
    return (
      <Section title="Saldo estimado da IA" description={description}>
        {error ? (
          <Notice tone="error">{error}</Notice>
        ) : (
          <div className="flex justify-center py-4">
            <Spinner />
          </div>
        )}
      </Section>
    );
  }

  const quotaAfterStart = balance.lastQuotaErrorAt && balance.since && balance.lastQuotaErrorAt >= balance.since;
  const negative = balance.balanceMicros != null && balance.balanceMicros < 0;
  const maxUse = Math.max(1, ...balance.byUse.map((row) => row.costMicros));

  return (
    <Section
      title="Saldo estimado da IA"
      description={description}
      aside={
        isAdmin ? (
          <div className="flex shrink-0 gap-2">
            <Button size="sm" variant="outline" onClick={() => setForm("balance")}>
              <Wallet className="h-3.5 w-3.5" /> Informar saldo atual
            </Button>
            <Button size="sm" onClick={() => setForm("top_up")}>
              <Plus className="h-3.5 w-3.5" /> Registrar recarga
            </Button>
          </div>
        ) : undefined
      }
    >
      {error && <Notice tone="error">{error}</Notice>}

      {!balance.configured ? (
        <Notice tone="info">
          {isAdmin
            ? "Nenhum saldo lançado ainda. Abra o painel de cobrança da OpenAI, veja o crédito disponível hoje e clique em \"Informar saldo atual\". A partir daí o AZVCHAT desconta o consumo sozinho."
            : "Nenhum saldo lançado ainda. Um administrador precisa informar o crédito disponível na OpenAI."}
        </Notice>
      ) : (
        <>
          <div className="grid gap-3 md:grid-cols-4">
            <StatTile
              label="Saldo estimado"
              value={<span className={cn(negative && "text-red-600")}>{formatCost(balance.balanceMicros)}</span>}
              hint={`${formatCost(balance.creditedMicros)} lançados desde ${formatDate(balance.since as string)}`}
              tone={balance.low || negative ? "warn" : "default"}
            />
            <StatTile label="Consumido no período" value={formatCost(balance.spentMicros)} hint={`desde ${formatDate(balance.since as string)}`} />
            <StatTile
              label="Média por dia"
              value={formatCost(balance.dailyAverageMicros)}
              hint={balance.dailyAverageMicros == null ? "menos de um dia de consumo" : "últimos 30 dias"}
            />
            <StatTile
              label="Dura cerca de"
              value={balance.estimatedDaysLeft == null ? "—" : `${balance.estimatedDaysLeft} ${balance.estimatedDaysLeft === 1 ? "dia" : "dias"}`}
              hint="no ritmo da média diária"
            />
          </div>

          {quotaAfterStart && (
            <Notice tone="error">
              A OpenAI recusou uma chamada por falta de crédito em {formatDateTime(balance.lastQuotaErrorAt)}. O saldo real
              pode estar zerado: confira no painel da OpenAI e informe o saldo atual.
            </Notice>
          )}
          {negative && !quotaAfterStart && (
            <Notice tone="warn">
              A estimativa passou do crédito lançado. Se houve recarga que não foi registrada, registre-a; senão, confira o saldo na OpenAI.
            </Notice>
          )}
          {balance.low && !negative && (
            <Notice tone="warn">Saldo abaixo do aviso de {`US$ ${centsToInput(balance.lowBalanceAlertCents)}`}. Está na hora de recarregar.</Notice>
          )}
          {balance.unpricedRequests > 0 && (
            <Notice tone="info">
              {balance.unpricedRequests} {balance.unpricedRequests === 1 ? "chamada usou modelo" : "chamadas usaram modelo"} sem tabela de
              preço e {balance.unpricedRequests === 1 ? "ficou" : "ficaram"} fora da conta: o saldo real é um pouco menor. Cadastre o preço em
              Configurações gerais.
            </Notice>
          )}

          <div>
            <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">Para onde foi o crédito</p>
            {balance.byUse.length === 0 ? (
              <p className="text-sm text-slate-400">Nenhum consumo desde o último lançamento.</p>
            ) : (
              <Card className="divide-y divide-slate-100">
                {balance.byUse.map((row) => (
                  <div key={row.use} className="flex items-center gap-3 px-4 py-2 text-sm">
                    <div className="w-48 shrink-0">
                      <p className="font-medium text-slate-800">{row.label}</p>
                      <p className="text-[11px] text-slate-400">{AI_SPEND_USE_HINTS[row.use]}</p>
                    </div>
                    <div className="h-2 min-w-0 flex-1 overflow-hidden rounded-full bg-slate-100" aria-hidden>
                      <div className="h-full rounded-full bg-brand-600" style={{ width: `${(row.costMicros / maxUse) * 100}%` }} />
                    </div>
                    <span className="w-24 shrink-0 text-right tabular-nums text-slate-900">{formatCost(row.costMicros)}</span>
                    <span className="w-24 shrink-0 text-right text-xs tabular-nums text-slate-400">
                      {row.requests.toLocaleString("pt-BR")} {row.requests === 1 ? "chamada" : "chamadas"}
                    </span>
                  </div>
                ))}
              </Card>
            )}
          </div>
        </>
      )}

      {isAdmin && <AlertThreshold balance={balance} onSaved={setBalance} />}

      {balance.entries.length > 0 && (
        <div className="border-t border-slate-100 pt-3">
          <button type="button" className="text-xs font-medium text-slate-500 hover:text-slate-800" onClick={() => setShowEntries((value) => !value)}>
            {showEntries ? "Ocultar lançamentos" : `Ver lançamentos (${balance.entries.length})`}
          </button>
          {showEntries && (
            <ul className="mt-2 divide-y divide-slate-100 rounded-lg border border-slate-200">
              {balance.entries.map((entry) => (
                <li key={entry.id} className="flex items-center gap-3 px-3 py-2 text-sm">
                  <span
                    className={cn(
                      "shrink-0 rounded px-1.5 py-0.5 text-[11px] font-medium",
                      entry.kind === "balance" ? "bg-slate-100 text-slate-700" : "bg-brand-100 text-brand-700",
                    )}
                  >
                    {AI_CREDIT_ENTRY_KIND_LABELS[entry.kind]}
                  </span>
                  <span className="w-24 shrink-0 tabular-nums font-medium text-slate-900">US$ {centsToInput(entry.amountCents)}</span>
                  <span className="min-w-0 flex-1 truncate text-xs text-slate-500">
                    {formatDateTime(entry.effectiveAt)}
                    {entry.createdBy ? ` · ${entry.createdBy.name}` : ""}
                    {entry.note ? ` · ${entry.note}` : ""}
                  </span>
                  {isAdmin && (
                    <button
                      type="button"
                      className="rounded p-1 text-slate-400 hover:bg-red-50 hover:text-red-600"
                      aria-label="Excluir lançamento"
                      onClick={() => void remove(entry.id)}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      <CreditEntryModal
        kind={form}
        onClose={() => setForm(null)}
        onSaved={(next) => {
          setBalance(next);
          setForm(null);
        }}
      />
    </Section>
  );
}

function AlertThreshold({ balance, onSaved }: { balance: AiBalanceDto; onSaved: (balance: AiBalanceDto) => void }) {
  const [value, setValue] = useState(centsToInput(balance.lowBalanceAlertCents));
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  useEffect(() => setValue(centsToInput(balance.lowBalanceAlertCents)), [balance.lowBalanceAlertCents]);

  async function save() {
    const cents = value.trim() ? parseUsdToCents(value) : null;
    if (value.trim() && cents == null) {
      setMessage({ ok: false, text: "Valor inválido. Use o formato 10,00." });
      return;
    }
    setBusy(true);
    try {
      onSaved(await aiApi.saveBalanceAlert(cents));
      setMessage({ ok: true, text: cents == null ? "Aviso desligado." : "Aviso salvo." });
    } catch (err) {
      setMessage({ ok: false, text: err instanceof ApiError ? err.message : "Não foi possível salvar" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-wrap items-end gap-2 border-t border-slate-100 pt-3">
      <div className="w-48">
        <Field label="Avisar abaixo de (US$)">
          <Input inputMode="decimal" placeholder="Sem aviso" value={value} onChange={(event) => setValue(event.target.value)} />
        </Field>
      </div>
      <Button size="sm" variant="outline" disabled={busy} onClick={() => void save()}>
        {busy ? "Salvando…" : "Salvar aviso"}
      </Button>
      {message && <span className={cn("text-xs", message.ok ? "text-emerald-700" : "text-red-600")}>{message.text}</span>}
      <p className="w-full text-[11px] text-slate-400">O card fica em alerta quando o saldo estimado cai abaixo deste valor. Não bloqueia nada.</p>
    </div>
  );
}

function CreditEntryModal({
  kind,
  onClose,
  onSaved,
}: {
  kind: AiCreditEntryKind | null;
  onClose: () => void;
  onSaved: (balance: AiBalanceDto) => void;
}) {
  const [amount, setAmount] = useState("");
  const [effectiveAt, setEffectiveAt] = useState(nowForInput());
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Cada abertura começa limpa, com o horário de agora.
  useEffect(() => {
    if (!kind) return;
    setAmount("");
    setEffectiveAt(nowForInput());
    setNote("");
    setError(null);
  }, [kind]);

  async function save() {
    if (!kind) return;
    const cents = parseUsdToCents(amount);
    if (cents == null || (kind === "top_up" && cents === 0)) {
      setError("Informe o valor em dólar, por exemplo 37,20.");
      return;
    }
    setBusy(true);
    try {
      onSaved(
        await aiApi.addCreditEntry({
          kind,
          amountCents: cents,
          effectiveAt: effectiveAt ? new Date(effectiveAt).toISOString() : undefined,
          note: note.trim() || undefined,
        }),
      );
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Não foi possível salvar o lançamento");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open={kind !== null} onClose={onClose} title={kind ? AI_CREDIT_ENTRY_KIND_LABELS[kind] : ""}>
      {kind && (
        <div className="space-y-4">
          <p className="text-sm text-slate-500">{AI_CREDIT_ENTRY_KIND_HINTS[kind]}</p>
          <Field label={kind === "balance" ? "Saldo na OpenAI (US$)" : "Valor da recarga (US$)"}>
            <Input autoFocus inputMode="decimal" placeholder="37,20" value={amount} onChange={(event) => setAmount(event.target.value)} />
          </Field>
          <Field label={kind === "balance" ? "Lido em" : "Data da recarga"}>
            <Input type="datetime-local" max={nowForInput()} value={effectiveAt} onChange={(event) => setEffectiveAt(event.target.value)} />
          </Field>
          <Field label="Observação (opcional)">
            <Input maxLength={200} value={note} onChange={(event) => setNote(event.target.value)} />
          </Field>
          {error && <Notice tone="error">{error}</Notice>}
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={onClose}>
              Cancelar
            </Button>
            <Button disabled={busy} onClick={() => void save()}>
              {busy ? "Salvando…" : "Salvar"}
            </Button>
          </div>
        </div>
      )}
    </Modal>
  );
}

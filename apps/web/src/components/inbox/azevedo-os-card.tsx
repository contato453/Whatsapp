"use client";

import { useCallback, useEffect, useState } from "react";
import { Building2, ExternalLink, Link2, Link2Off, RefreshCw } from "lucide-react";
import {
  AZEVEDO_OS_SOURCE,
  azevedoOsCompanyDisplayName,
  azevedoOsSearchIsValid,
  normalizeAzevedoOsStatus,
  type AzevedoOsCompanyDto,
} from "@azvchat/shared";
import { ApiError, azevedoOsApi } from "@/lib/api";
import { azevedoOsErrorMessage, azevedoOsStatusDotClass } from "@/lib/azevedo-os";
import type { ConversationDto } from "@/lib/types";
import { Button, Input, Modal, Spinner } from "@/components/ui";

/**
 * Card "Cliente Azevedo-OS" do painel de contexto.
 *
 * O Azevedo-OS é a fonte da verdade do cadastro: o AZVCHAT guarda só o
 * ponteiro para a empresa e busca o resto na hora de exibir. Por isso o
 * card carrega sozinho, com o seu próprio estado de espera e de erro — se
 * o Azevedo-OS estiver fora do ar, quem para é este bloco, e não a Inbox.
 */

/** Rótulo + valor. O item inteiro some quando o Azevedo-OS não informou. */
function CompanyField({ label, value }: { label: string; value: string | null }) {
  if (!value) return null;
  return (
    <div>
      <p className="text-[11px] uppercase tracking-wide text-slate-400">{label}</p>
      <p className="text-xs text-slate-700">{value}</p>
    </div>
  );
}

/** Linha da lista de resultados da busca. */
function CompanyOption({
  company,
  disabled,
  onSelect,
}: {
  company: AzevedoOsCompanyDto;
  disabled: boolean;
  onSelect: () => void;
}) {
  const { primary, secondary } = azevedoOsCompanyDisplayName(company);
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onSelect}
      className="w-full rounded-lg border border-slate-200 px-3 py-2 text-left hover:bg-slate-50 disabled:opacity-60"
    >
      <p className="text-sm text-slate-800">
        {company.companyNumber && (
          <span className="font-semibold text-slate-500">{company.companyNumber} — </span>
        )}
        {primary}
      </p>
      {secondary && <p className="text-xs text-slate-500">{secondary}</p>}
      {company.cnpj && <p className="text-xs text-slate-400">CNPJ {company.cnpj}</p>}
    </button>
  );
}

function SearchModal({
  conversationId,
  open,
  onClose,
  onLinked,
}: {
  conversationId: string;
  open: boolean;
  onClose: () => void;
  onLinked: () => void;
}) {
  const [term, setTerm] = useState("");
  const [results, setResults] = useState<AzevedoOsCompanyDto[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [linking, setLinking] = useState(false);

  useEffect(() => {
    if (!open) {
      setTerm("");
      setResults(null);
      setError(null);
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    if (!azevedoOsSearchIsValid(term)) {
      setResults(null);
      setError(null);
      return;
    }
    // Mesma espera da busca da lista de conversas: uma consulta por pausa na
    // digitação, e não uma por tecla.
    setSearching(true);
    const timer = setTimeout(() => {
      azevedoOsApi
        .search(conversationId, term.trim())
        .then((companies) => {
          setResults(companies);
          setError(null);
        })
        .catch((err) =>
          setError(azevedoOsErrorMessage(err instanceof ApiError ? err.code : undefined)),
        )
        .finally(() => setSearching(false));
    }, 300);
    return () => clearTimeout(timer);
  }, [term, open, conversationId]);

  async function selecionar(company: AzevedoOsCompanyDto) {
    setLinking(true);
    try {
      await azevedoOsApi.link(conversationId, company.id);
      onLinked();
      onClose();
    } catch (err) {
      setError(
        err instanceof ApiError && err.status === 403
          ? err.message
          : azevedoOsErrorMessage(err instanceof ApiError ? err.code : undefined),
      );
    } finally {
      setLinking(false);
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="Vincular empresa do Azevedo-OS">
      <div className="space-y-3">
        <Input
          autoFocus
          value={term}
          placeholder="Nome, número da empresa ou CNPJ"
          onChange={(event) => setTerm(event.target.value)}
        />
        {!azevedoOsSearchIsValid(term) ? (
          <p className="text-xs text-slate-500">
            Digite o nome, o número ou o CNPJ da empresa.
          </p>
        ) : error ? (
          <p className="text-xs text-rose-600">{error}</p>
        ) : searching ? (
          <div className="flex items-center gap-2 text-xs text-slate-500">
            <Spinner className="h-4 w-4" /> Consultando o Azevedo-OS...
          </div>
        ) : results && results.length === 0 ? (
          <p className="text-xs text-slate-500">Nenhuma empresa encontrada.</p>
        ) : (
          <div className="thin-scroll max-h-72 space-y-1.5 overflow-y-auto">
            {results?.map((company) => (
              <CompanyOption
                key={company.id}
                company={company}
                disabled={linking}
                onSelect={() => void selecionar(company)}
              />
            ))}
          </div>
        )}
      </div>
    </Modal>
  );
}

export function AzevedoOsCard({
  conversation,
  canManage,
  onChanged,
}: {
  conversation: ConversationDto;
  /** Vincular, trocar e desvincular: supervisor para cima. */
  canManage: boolean;
  onChanged: () => void;
}) {
  const linked =
    conversation.externalSource === AZEVEDO_OS_SOURCE && !!conversation.externalReference;
  const [company, setCompany] = useState<AzevedoOsCompanyDto | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);

  const carregar = useCallback(() => {
    if (!linked) {
      setCompany(null);
      setError(null);
      return;
    }
    setLoading(true);
    setError(null);
    azevedoOsApi
      .company(conversation.id)
      .then(setCompany)
      .catch((err) => {
        setCompany(null);
        setError(azevedoOsErrorMessage(err instanceof ApiError ? err.code : undefined));
      })
      .finally(() => setLoading(false));
    // A busca refaz quando muda a conversa E quando muda a empresa vinculada:
    // trocar de empresa sem recarregar deixaria o card mostrando a anterior.
  }, [conversation.id, conversation.externalReference, linked]);

  useEffect(carregar, [carregar]);

  async function desvincular() {
    if (!window.confirm("Desvincular a empresa desta conversa? As mensagens não são afetadas.")) {
      return;
    }
    setBusy(true);
    try {
      await azevedoOsApi.unlink(conversation.id);
      onChanged();
    } catch (err) {
      window.alert(err instanceof Error ? err.message : "Não foi possível desvincular");
    } finally {
      setBusy(false);
    }
  }

  const status = company ? normalizeAzevedoOsStatus(company.status) : null;
  const nome = company ? azevedoOsCompanyDisplayName(company) : null;

  return (
    <section className="space-y-2">
      <h3 className="flex items-center gap-1 text-xs font-semibold uppercase tracking-wide text-slate-400">
        <Building2 className="h-3.5 w-3.5" /> Cliente Azevedo-OS
      </h3>

      {!linked ? (
        <div className="space-y-2">
          <p className="text-xs text-slate-400">Nenhuma empresa vinculada.</p>
          {canManage && (
            <Button size="sm" variant="outline" className="w-full" onClick={() => setSearchOpen(true)}>
              <Link2 className="h-3.5 w-3.5" /> Vincular empresa
            </Button>
          )}
        </div>
      ) : loading ? (
        <div className="flex items-center gap-2 text-xs text-slate-500">
          <Spinner className="h-4 w-4" /> Carregando dados do cliente...
        </div>
      ) : error ? (
        <div className="space-y-2 rounded-lg bg-slate-50 p-2.5">
          <p className="text-xs text-slate-500">{error}</p>
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={carregar}
              className="inline-flex items-center gap-1 text-xs font-medium text-brand-600 hover:underline"
            >
              <RefreshCw className="h-3 w-3" /> Tentar de novo
            </button>
            {/* Empresa apagada no Azevedo-OS deixaria o card preso no erro
                sem uma saída: quem pode gravar consegue desfazer o vínculo. */}
            {canManage && (
              <button
                type="button"
                disabled={busy}
                onClick={() => void desvincular()}
                className="inline-flex items-center gap-1 text-xs font-medium text-slate-500 hover:underline disabled:opacity-60"
              >
                <Link2Off className="h-3 w-3" /> Desvincular
              </button>
            )}
          </div>
        </div>
      ) : (
        company &&
        nome && (
          <div className="space-y-3">
            {/* 1. Identificação */}
            <div>
              <p className="text-sm font-semibold text-slate-900">{nome.primary}</p>
              {nome.secondary && <p className="text-xs text-slate-500">{nome.secondary}</p>}
              {company.cnpj && <p className="text-xs text-slate-500">CNPJ {company.cnpj}</p>}
              {company.companyNumber && (
                <p className="text-xs text-slate-500">Empresa nº {company.companyNumber}</p>
              )}
              {status && (
                <p className="mt-1 flex items-center gap-1.5 text-xs text-slate-600">
                  <span
                    aria-hidden
                    className={`h-2 w-2 rounded-full ${azevedoOsStatusDotClass(status.tone)}`}
                  />
                  {status.label}
                </p>
              )}
            </div>

            {/* 2 e 3. Regime tributário e folha — some o item que não veio */}
            <CompanyField label="Regime tributário" value={company.taxRegime} />
            <CompanyField label="Folha de pgto" value={company.payrollInfo} />

            {/* 4. Contatos do cliente (não são responsáveis internos) */}
            {company.contacts.length > 0 && (
              <div className="space-y-1">
                <p className="text-[11px] uppercase tracking-wide text-slate-400">Contatos</p>
                {company.contacts.map((contact, index) => (
                  <div key={`${contact.name}-${index}`}>
                    <p className="text-xs text-slate-700">
                      {contact.name}
                      {contact.role && <span className="text-slate-500"> — {contact.role}</span>}
                    </p>
                    {(contact.phone || contact.email) && (
                      <p className="text-[11px] text-slate-400">
                        {[contact.phone, contact.email].filter(Boolean).join(" · ")}
                      </p>
                    )}
                  </div>
                ))}
              </div>
            )}

            {/* 5. Ação — sem endereço configurado, o botão não existe */}
            {company.webUrl && (
              <a
                href={company.webUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-xs font-medium text-brand-600 hover:underline"
              >
                <ExternalLink className="h-3 w-3" /> Abrir no Azevedo-OS
              </a>
            )}

            {canManage && (
              <div className="flex gap-1.5">
                <Button
                  size="sm"
                  variant="outline"
                  className="flex-1"
                  disabled={busy}
                  onClick={() => setSearchOpen(true)}
                >
                  <Link2 className="h-3.5 w-3.5" /> Trocar
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  className="flex-1"
                  disabled={busy}
                  onClick={() => void desvincular()}
                >
                  <Link2Off className="h-3.5 w-3.5" /> Desvincular
                </Button>
              </div>
            )}
          </div>
        )
      )}

      {/* O modal só existe para quem pode gravar o vínculo. */}
      {canManage && (
        <SearchModal
          conversationId={conversation.id}
          open={searchOpen}
          onClose={() => setSearchOpen(false)}
          onLinked={onChanged}
        />
      )}
    </section>
  );
}

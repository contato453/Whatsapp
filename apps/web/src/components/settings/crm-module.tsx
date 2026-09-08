"use client";

import { useCallback, useEffect, useState } from "react";
import { KanbanSquare } from "lucide-react";
import { api, organizationApi } from "@/lib/api";
import { useAuth } from "@/lib/auth-context";
import type { UserDto } from "@/lib/types";
import { Button, Card, Spinner } from "@/components/ui";

/**
 * O interruptor do CRM (Kanban).
 *
 * Fica em Configurações, junto dos tokens de integração e da saúde do
 * Azevedo-OS, porque é da mesma natureza: administração do sistema do
 * escritório, não do atendimento do dia.
 *
 * TRÊS COISAS QUE A TELA PRECISA DEIXAR CLARAS, e por isso não é só um
 * `<input type="checkbox">` solto:
 *
 * 1. **desligar não apaga nada.** Funis, oportunidades e histórico continuam
 *    no banco; religar devolve tudo. Sem essa frase, ninguém desliga por medo
 *    — ou desliga achando que apagou;
 * 2. **desligar CANCELA os follow-ups pendentes**, e a tela diz QUANTOS antes
 *    de confirmar. É a diferença entre "escondi o menu" e "parei de mandar
 *    mensagem para cliente": sem cancelar, o agendador continuaria enviando
 *    "conseguiu ver a proposta?" nos dias seguintes, de um módulo que ninguém
 *    mais enxerga e que ninguém teria como desmarcar;
 * 3. **o menu some na hora**, para todo mundo — inclusive para o admin que
 *    desligou. Por isso a sessão é recarregada logo depois de gravar.
 */
export function CrmModuleCard() {
  const { setUser, hasFeature } = useAuth();
  const ligado = hasFeature("crm");
  const [impacto, setImpacto] = useState<{
    pendingFollowUps: number;
    openOpportunities: number;
  } | null>(null);
  const [confirmando, setConfirmando] = useState(false);
  const [salvando, setSalvando] = useState(false);
  const [aviso, setAviso] = useState<string | null>(null);
  const [erro, setErro] = useState<string | null>(null);

  const carregarImpacto = useCallback(async () => {
    try {
      setImpacto(await organizationApi.crmImpact());
    } catch {
      // O número é conveniência do aviso: sem ele a tela ainda funciona, só
      // não consegue dizer quantos follow-ups seriam cancelados.
      setImpacto(null);
    }
  }, []);

  useEffect(() => {
    if (ligado) void carregarImpacto();
  }, [ligado, carregarImpacto]);

  async function gravar(valor: boolean) {
    setSalvando(true);
    setErro(null);
    try {
      const resultado = await organizationApi.setCrm(valor);
      // A sessão carrega os módulos ligados; sem recarregá-la o menu do CRM
      // continuaria na tela de quem acabou de desligá-lo.
      const atualizado = await api.get<{ user: UserDto }>("/auth/me");
      setUser(atualizado.user);
      setConfirmando(false);
      setAviso(
        valor
          ? "CRM religado. Os funis e as oportunidades voltaram como estavam."
          : resultado.followUpsCancelados > 0
            ? `CRM desativado. ${resultado.followUpsCancelados} follow-up(s) automático(s) foram cancelados para não sair sem o módulo no ar.`
            : "CRM desativado. Nenhum follow-up automático estava pendente.",
      );
      if (valor) void carregarImpacto();
    } catch (err) {
      setErro(err instanceof Error ? err.message : "Não foi possível salvar");
    } finally {
      setSalvando(false);
    }
  }

  return (
    <Card className="p-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-slate-500">
            <KanbanSquare className="h-4 w-4" /> CRM (Kanban)
          </h2>
          <p className="mt-1 text-sm text-slate-600">
            Funil de oportunidades dentro do atendimento: quadro, atividades, follow-up e
            relatórios. Desligado, o menu some para todo mundo e as rotas param de responder —
            mas <strong>nada é apagado</strong>.
          </p>
        </div>
        <span
          className={
            ligado
              ? "shrink-0 rounded-full bg-green-50 px-2 py-0.5 text-[11px] font-medium text-green-700"
              : "shrink-0 rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-medium text-slate-500"
          }
        >
          {ligado ? "Ativo" : "Desativado"}
        </span>
      </div>

      {ligado && impacto && (
        <p className="mt-3 text-xs text-slate-500">
          Hoje: {impacto.openOpportunities} oportunidade(s) em aberto e{" "}
          {impacto.pendingFollowUps} follow-up(s) automático(s) na fila.
        </p>
      )}

      {aviso && (
        <p className="mt-3 rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-600">{aviso}</p>
      )}
      {erro && <p className="mt-3 text-xs text-red-600">{erro}</p>}

      {confirmando ? (
        <div className="mt-4 rounded-lg border border-amber-200 bg-amber-50 p-3">
          <p className="text-xs text-amber-800">
            Desativar o CRM para o escritório inteiro?
            {impacto && impacto.pendingFollowUps > 0 && (
              <>
                {" "}
                <strong>
                  {impacto.pendingFollowUps} follow-up(s) automático(s) pendente(s) serão
                  cancelados
                </strong>{" "}
                — eles sairiam para o cliente mesmo com o módulo desligado, e ninguém teria
                onde desmarcá-los.
              </>
            )}{" "}
            Mensagens agendadas por pessoas no composer não são afetadas. Os funis, as
            oportunidades e o histórico continuam guardados.
          </p>
          <div className="mt-3 flex gap-2">
            <Button size="sm" variant="secondary" onClick={() => setConfirmando(false)}>
              Cancelar
            </Button>
            <Button size="sm" variant="danger" disabled={salvando} onClick={() => void gravar(false)}>
              {salvando ? <Spinner className="h-4 w-4" /> : "Desativar CRM"}
            </Button>
          </div>
        </div>
      ) : (
        <div className="mt-4">
          {ligado ? (
            <Button size="sm" variant="outline" onClick={() => setConfirmando(true)}>
              Desativar CRM
            </Button>
          ) : (
            <Button size="sm" disabled={salvando} onClick={() => void gravar(true)}>
              {salvando ? <Spinner className="h-4 w-4" /> : "Ativar CRM"}
            </Button>
          )}
        </div>
      )}
    </Card>
  );
}

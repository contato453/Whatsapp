"use client";

import { useCallback, useEffect, useState } from "react";
import { ALL_USERS_ASSIGNEE_HINT, ALL_USERS_ASSIGNEE_LABEL } from "@azvchat/shared";
import { conversationAssignmentApi } from "@/lib/api";
import type { ConversationDto, UserDirectoryDto } from "@/lib/types";
import { cn } from "@/lib/utils";

/**
 * O seletor de Responsável, com a lista de candidatos vinda da API.
 *
 * Mora fora do painel de contexto porque tem estado próprio (a lista, o
 * carregamento e a confirmação da supervisão) e porque a decisão de quem
 * pode receber a conversa muda por conversa — o painel inteiro não precisa
 * remontar por causa disso.
 *
 * A lista NÃO é filtrada aqui: quem decide é `conversationAssigneeWhere`
 * (`apps/api/src/lib/access.ts`), pela rota `GET
 * /conversations/:id/assignees`. Filtro montado na tela seria uma segunda
 * régua, que sai de sincronia com a da API na primeira manutenção — e, pior,
 * pareceria controle de acesso sem ser: a recusa de verdade está no
 * `POST .../assign`.
 */

/**
 * Valor do seletor que representa o coletivo. Não é id de ninguém — no
 * banco a conversa marcada segue sem responsável.
 */
const ALL_USERS_OPTION = "__all_users__";

interface Candidatos {
  users: UserDirectoryDto[];
  /** Ativos que NÃO enxergam a conversa. Só chega para supervisor e admin. */
  others: UserDirectoryDto[];
  canAssignBeyondReach: boolean;
}

const VAZIO: Candidatos = { users: [], others: [], canAssignBeyondReach: false };

export function AssigneeSelect({
  conversation,
  disabled,
  onChanged,
}: {
  conversation: ConversationDto;
  disabled: boolean;
  /** Recarrega a conversa no painel — o mesmo `onChanged` do resto do painel. */
  onChanged: () => void;
}) {
  const conversationId = conversation.id;
  const [candidatos, setCandidatos] = useState<Candidatos>(VAZIO);
  const [carregando, setCarregando] = useState(true);
  const [salvando, setSalvando] = useState(false);

  const carregar = useCallback(async () => {
    setCarregando(true);
    try {
      setCandidatos(await conversationAssignmentApi.assignees(conversationId));
    } catch {
      // Lista indisponível não trava o atendimento: o seletor continua
      // oferecendo "@todos" e "Sem responsável", que não escolhem pessoa.
      setCandidatos(VAZIO);
    } finally {
      setCarregando(false);
    }
  }, [conversationId]);

  useEffect(() => {
    void carregar();
  }, [carregar]);

  async function executar(action: () => Promise<unknown>) {
    setSalvando(true);
    try {
      await action();
      onChanged();
      // A regra depende do departamento e dos vínculos, que podem ter mudado
      // no meio do caminho: quem some da lista some agora, não no F5.
      await carregar();
    } catch (err) {
      window.alert(err instanceof Error ? err.message : "Não foi possível transferir a conversa");
      // Recarrega porque a recusa mais provável é justamente a lista velha:
      // a pessoa perdeu o número ou o departamento entre abrir a tela e clicar.
      await carregar();
    } finally {
      setSalvando(false);
    }
  }

  function escolher(value: string) {
    if (value === ALL_USERS_OPTION) {
      // Um movimento só: tira o responsável atual e liga a marcação.
      void executar(() => conversationAssignmentApi.assignAll(conversationId));
      return;
    }
    if (!value) {
      void executar(() => conversationAssignmentApi.unassign(conversationId));
      return;
    }
    const foraDoAlcance = candidatos.others.find((user) => user.id === value);
    if (foraDoAlcance) {
      // Supervisão pode transferir para fora do alcance, mas nunca em
      // silêncio: sem o aviso, a conversa ganha um dono que não a enxerga e
      // some da tela de todo mundo sem erro nenhum.
      const ok = window.confirm(
        `${foraDoAlcance.name} não tem o número ou o departamento desta conversa e não vai conseguir vê-la depois da transferência.\n\nTransferir mesmo assim?`,
      );
      if (!ok) return;
    }
    // Atribuir desliga o @todos sozinho, do lado da API.
    void executar(() => conversationAssignmentApi.assign(conversationId, value));
  }

  /**
   * O responsável atual entra na lista mesmo quando não é mais candidato —
   * é o caso de quem foi desativado, perdeu o vínculo ou ficou de fora
   * depois que a conversa mudou de departamento. Sem isso o seletor
   * mostraria "Sem responsável" numa conversa que tem dono.
   *
   * Ninguém é desatribuído por causa da regra nova: ela vale para
   * transferências novas, e tirar o atendimento de quem já está conversando
   * com o cliente seria pior do que a inconsistência.
   */
  const atual = conversation.assignedUser;
  const jaListado =
    atual != null &&
    (candidatos.users.some((user) => user.id === atual.id) ||
      candidatos.others.some((user) => user.id === atual.id));
  const pessoas = atual && !jaListado ? [...candidatos.users, atual] : candidatos.users;

  const semCandidatos = !carregando && pessoas.length === 0 && candidatos.others.length === 0;
  const travado = disabled || salvando || carregando;

  return (
    <>
      <div className="flex items-center justify-between">
        <span className="text-slate-500">Responsável</span>
        <select
          className={cn(
            "max-w-[55%] rounded-lg border px-2 py-1 text-xs",
            // Coletivo marcado fica visualmente diferente de um nome de
            // pessoa: no banco não existe usuário "@todos", e na tela ele
            // também não pode passar por um.
            conversation.assignedToAll
              ? "border-brand-100 bg-brand-50 font-semibold text-brand-700"
              : "border-slate-200",
          )}
          value={conversation.assignedToAll ? ALL_USERS_OPTION : (atual?.id ?? "")}
          disabled={travado}
          onChange={(event) => escolher(event.target.value)}
        >
          {/* No topo e separado das pessoas: é uma decisão de atendimento,
              não mais um nome na lista. */}
          <option value={ALL_USERS_OPTION}>{ALL_USERS_ASSIGNEE_LABEL}</option>
          <option value="">Sem responsável</option>
          {pessoas.length > 0 && (
            <optgroup label="Pessoas">
              {pessoas.map((user) => (
                <option key={user.id} value={user.id}>
                  {user.name}
                </option>
              ))}
            </optgroup>
          )}
          {/* Separado, e nomeado pelo motivo: quem escolhe daqui precisa
              saber o que está fazendo antes da confirmação. */}
          {candidatos.others.length > 0 && (
            <optgroup label="Não atendem esta conversa">
              {candidatos.others.map((user) => (
                <option key={user.id} value={user.id}>
                  {user.name}
                </option>
              ))}
            </optgroup>
          )}
        </select>
      </div>
      {/* Seletor sem gente não pode ficar mudo: quem abre a lista e não
          encontra ninguém precisa saber que é regra, e não defeito. */}
      {semCandidatos && (
        <p className="text-right text-[11px] text-amber-600">
          Ninguém além de você atende este número neste departamento. Você pode assumir a conversa
          ou deixá-la em &quot;Sem responsável&quot;, para quem estiver livre.
        </p>
      )}
      {/* A linha fica sempre visível: o efeito de "@todos" precisa estar
          explicado ANTES de a pessoa escolher, e um <option> não comporta
          texto de apoio. Marcada, ela muda de tom e confirma o estado. */}
      <p
        className={cn(
          "text-right text-[11px]",
          conversation.assignedToAll ? "text-brand-600" : "text-slate-400",
        )}
      >
        {ALL_USERS_ASSIGNEE_LABEL}: {ALL_USERS_ASSIGNEE_HINT}
      </p>
    </>
  );
}

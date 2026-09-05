/**
 * Enquete: forma de armazenamento dos votos e a apuração, em fonte única —
 * a API grava, o serializer/DTO transporta e o frontend desenha pela MESMA
 * regra. O WhatsApp entrega os votos já decifrados pelo AstraCalls, e manda a
 * seleção ATUAL completa de cada votante a cada mudança (trocar de opção
 * reenvia a lista inteira), então guardamos UMA entrada por votante e a
 * sobrescrevemos — nunca somamos voto sobre voto.
 */

/** Voto de UMA pessoa: as opções que ela tem marcadas agora. */
export interface PollVote {
  /** Rótulos das opções escolhidas (os mesmos textos de `pollOptions`). */
  names: string[];
  /** Nome de quem votou, quando conhecido (só para exibir). */
  voterName: string | null;
  /** ISO do último voto desta pessoa. */
  at: string;
}

/**
 * Votos de uma enquete, chaveados por votante (telefone quando há, senão o
 * JID). A chave identifica a PESSOA para o voto novo dela substituir o antigo.
 */
export type PollVotes = Record<string, PollVote>;

export interface PollTallyOption {
  option: string;
  count: number;
  /** Nomes (ou chaves) de quem votou nesta opção — para exibir quem votou. */
  voters: string[];
}

export interface PollTally {
  options: PollTallyOption[];
  /** Quantas PESSOAS distintas votaram (não a soma de opções). */
  totalVoters: number;
}

/**
 * Apura os votos sobre as opções da enquete. Opção sem voto vem com `count` 0
 * (a enquete mostra todas as alternativas, votadas ou não). Voto em opção que
 * não existe mais é ignorado — o rótulo é a chave, e enquete não muda de
 * opções depois de criada.
 */
export function tallyPollVotes(options: string[], votes: PollVotes | undefined): PollTally {
  const byOption = new Map<string, string[]>();
  for (const option of options) byOption.set(option, []);

  const voters = votes ?? {};
  let totalVoters = 0;
  for (const [voterKey, vote] of Object.entries(voters)) {
    if (!vote?.names?.length) continue; // votante que limpou a escolha não conta
    totalVoters += 1;
    const label = vote.voterName ?? voterKey;
    for (const name of vote.names) {
      const bucket = byOption.get(name);
      if (bucket) bucket.push(label);
    }
  }

  return {
    options: options.map((option) => ({
      option,
      count: byOption.get(option)?.length ?? 0,
      voters: byOption.get(option) ?? [],
    })),
    totalVoters,
  };
}

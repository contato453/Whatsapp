"use client";

/**
 * Rascunho do composer, guardado no navegador por conversa.
 *
 * Existe por causa do fim do horário de uso: a sessão é encerrada no minuto
 * do fechamento, e sem isto o que a pessoa tinha escrito e ainda não mandou
 * ia embora junto. De quebra, cobre o F5 sem querer e a troca de conversa no
 * meio de uma frase.
 *
 * Fica no navegador, e não na API, pelo mesmo motivo da barra lateral
 * recolhida: é estado de uma máquina, não do atendimento. Nada de coluna em
 * `Conversation` nem de rota gravando a cada tecla.
 *
 * **A chave inclui o usuário.** Máquina compartilhada é o caso normal do
 * escritório: sem isso, quem entrasse depois do fechamento encontraria o
 * rascunho do colega no composer.
 *
 * **O modo vai junto com o texto.** Nota interna e mensagem escrevem no
 * mesmo campo, e restaurar uma nota em modo mensagem mandaria para o cliente
 * um texto escrito para a equipe ler.
 */

const PREFIX = "zapdesk.draft.";

/** Rascunho parado há mais de uma semana já não é rascunho, é lixo. */
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export type DraftMode = "message" | "note";

export interface Draft {
  text: string;
  mode: DraftMode;
}

interface StoredDraft extends Draft {
  updatedAt: number;
}

const EMPTY: Draft = { text: "", mode: "message" };

function keyFor(userId: string, conversationId: string): string {
  return `${PREFIX}${userId}.${conversationId}`;
}

/**
 * Toda leitura e escrita passa por aqui: `localStorage` estoura quando a
 * cota acaba ou quando o navegador está em modo restrito, e perder um
 * rascunho é ruim — derrubar a Inbox por causa dele seria pior.
 */
function safely<T>(action: () => T, fallback: T): T {
  if (typeof window === "undefined") return fallback;
  try {
    return action();
  } catch {
    return fallback;
  }
}

export function readDraft(userId: string, conversationId: string): Draft {
  return safely(() => {
    const raw = window.localStorage.getItem(keyFor(userId, conversationId));
    if (!raw) return EMPTY;
    const parsed = JSON.parse(raw) as Partial<StoredDraft>;
    if (typeof parsed.text !== "string" || parsed.text.length === 0) return EMPTY;
    return { text: parsed.text, mode: parsed.mode === "note" ? "note" : "message" };
  }, EMPTY);
}

/** Texto vazio apaga a entrada — rascunho em branco não é rascunho. */
export function saveDraft(
  userId: string,
  conversationId: string,
  draft: Draft,
): void {
  safely(() => {
    const key = keyFor(userId, conversationId);
    if (draft.text.length === 0) {
      window.localStorage.removeItem(key);
      return;
    }
    const stored: StoredDraft = { ...draft, updatedAt: Date.now() };
    window.localStorage.setItem(key, JSON.stringify(stored));
  }, undefined);
}

/**
 * Limpa rascunho velho de qualquer usuário desta máquina. Roda uma vez, na
 * abertura da Inbox: sem isso o navegador acumularia entrada de conversa que
 * ninguém abre há meses até estourar a cota — e aí o rascunho de hoje é que
 * deixaria de ser gravado.
 */
export function pruneDrafts(now = Date.now()): void {
  safely(() => {
    const stale: string[] = [];
    for (let index = 0; index < window.localStorage.length; index += 1) {
      const key = window.localStorage.key(index);
      if (!key?.startsWith(PREFIX)) continue;
      const raw = window.localStorage.getItem(key);
      let updatedAt = 0;
      try {
        updatedAt = (JSON.parse(raw ?? "{}") as Partial<StoredDraft>).updatedAt ?? 0;
      } catch {
        // Entrada corrompida (versão antiga, escrita pela metade): sai fora.
      }
      if (now - updatedAt > MAX_AGE_MS) stale.push(key);
    }
    for (const key of stale) window.localStorage.removeItem(key);
  }, undefined);
}

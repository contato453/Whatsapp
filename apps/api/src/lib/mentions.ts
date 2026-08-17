import { z } from "zod";
import { MENTION_MAX_PER_MESSAGE, isMentionable, mentionJid } from "@azvchat/shared";
import { AppError } from "./errors.js";

/**
 * Menções de uma mensagem enviada pela equipe.
 *
 * A lista chega do navegador com os identificadores dos participantes
 * (`GroupParticipant.externalContactId`) e é conferida aqui contra o grupo da
 * conversa. Sem essa conferência, qualquer login poderia notificar um número
 * que não está no grupo — o corpo da requisição é do cliente, não nosso.
 */
export const mentionsSchema = z
  .array(z.string().min(1).max(120))
  .max(MENTION_MAX_PER_MESSAGE);

export interface MentionableParticipant {
  externalContactId: string;
  phoneNumber: string | null;
}

export interface ResolvedMentions {
  /** JIDs que vão no `contextInfo` da mensagem. */
  jids: string[];
  /** Pedidos que não deram em ninguém marcável (saiu do grupo, sem telefone). */
  dropped: number;
}

/**
 * Converte os participantes pedidos nos JIDs que vão no `contextInfo`.
 *
 * Quem não é participante do grupo é DESCARTADO, nunca marcado: notificar um
 * número que ninguém conferiu é o furo que esta função existe para fechar.
 * Descartar em vez de recusar a requisição inteira é deliberado — entre a
 * escolha na lista e o Enter alguém pode ter saído do grupo, e derrubar a
 * mensagem por causa disso faria a equipe perder o texto por um detalhe que
 * não é dela. A mensagem sai para os demais, e o descarte vira log.
 */
export function resolveMentionTargets(
  conversationType: string,
  requested: string[],
  participants: MentionableParticipant[],
): ResolvedMentions {
  if (requested.length === 0) return { jids: [], dropped: 0 };

  // Menção só existe em grupo: em conversa individual não há a quem marcar,
  // e o "@" digitado ali é caractere comum.
  if (conversationType !== "group") {
    throw new AppError(
      "Marcação só existe em conversa de grupo",
      400,
      "mentions_not_allowed",
    );
  }

  const byExternalId = new Map(
    participants.map((participant) => [participant.externalContactId, participant]),
  );
  const jids: string[] = [];
  let dropped = 0;
  for (const externalId of new Set(requested)) {
    const participant = byExternalId.get(externalId);
    // Não é (ou não é mais) participante deste grupo: fora.
    if (!participant) {
      dropped += 1;
      continue;
    }
    // Sem telefone conhecido (participante só com "@lid") a marcação não
    // chega a lugar nenhum — a tela já mostra a pessoa desabilitada.
    if (!isMentionable(participant)) {
      dropped += 1;
      continue;
    }
    jids.push(mentionJid(participant.phoneNumber as string));
  }
  return { jids: [...new Set(jids)], dropped };
}

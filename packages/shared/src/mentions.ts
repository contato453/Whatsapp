/**
 * Marcação de participantes ("@") em conversa de grupo.
 *
 * A REGRA QUE SUSTENTA TUDO AQUI: menção no WhatsApp **não é formatação de
 * texto**. Escrever o nome (ou até o número) na mensagem não marca ninguém —
 * quem notifica é a lista de identificadores que viaja no `contextInfo`, ao
 * lado do texto. Por isso o rascunho do composer carrega texto E lista de
 * menções o tempo todo, e as duas coisas são recalculadas juntas a cada
 * tecla: se elas se separarem, a mensagem sai visualmente certa e não avisa
 * ninguém — defeito silencioso, que só aparece semanas depois, quando o
 * cliente reclamar que não foi chamado.
 *
 * As funções são puras de propósito: quem digita é o navegador, quem valida é
 * a API, e as duas pontas precisam decidir igual.
 */

/** Trecho que o composer insere para marcar o grupo inteiro. */
export const MENTION_ALL_TOKEN = "@todos";

export const MENTION_ALL_LABEL = "@todos";
export const MENTION_ALL_HINT = "Notifica todos os participantes do grupo";

/**
 * Teto próprio de menções por mensagem. O Baileys não impõe limite e o
 * WhatsApp não documenta nenhum — mas mandar uma lista sem teto num grupo de
 * centenas é pedir para o envio inteiro falhar. Melhor recusar antes, com
 * número na tela, do que descobrir no cliente.
 */
export const MENTION_MAX_PER_MESSAGE = 100;

/** Explicação curta do participante que não dá para marcar. */
export const MENTION_UNAVAILABLE_HINT =
  "Sem telefone conhecido — o WhatsApp não entrega a marcação para este participante.";

/**
 * Uma marcação viva no rascunho.
 *
 * `label` é o que aparece no campo ("@João Silva"), `token` é o que vai no
 * texto enviado ("@5511999998888", ou "@todos" no coletivo) e `externalIds`
 * são os participantes que essa marcação notifica.
 */
export interface DraftMention {
  label: string;
  token: string;
  externalIds: string[];
}

/** Ponto do texto em que o "@" abriu o seletor. */
export interface MentionTrigger {
  /** Índice do "@" no texto. */
  start: number;
  /** O que foi digitado depois do "@" (sem o próprio "@"). */
  query: string;
}

/** Consulta maior que isto não é mais busca de nome — é frase. */
const MAX_QUERY_LENGTH = 40;

/**
 * Decide se o "@" antes do cursor abre o seletor.
 *
 * Só abre no início da mensagem ou depois de espaço: "contato@escritorio.com"
 * é e-mail, não marcação, e abrir ali atrapalharia quem digita endereço o dia
 * inteiro. Espaço depois do "@" fecha — o caractere fica como texto comum.
 */
export function mentionTrigger(text: string, caret: number): MentionTrigger | null {
  const upTo = text.slice(0, Math.max(0, Math.min(caret, text.length)));
  const start = upTo.lastIndexOf("@");
  if (start < 0) return null;
  const previous = start > 0 ? upTo[start - 1] : "";
  if (previous && !/\s/.test(previous)) return null;
  const query = upTo.slice(start + 1);
  // Espaço, quebra de linha ou um segundo "@" encerram a busca.
  if (/[\s@]/.test(query)) return null;
  if (query.length > MAX_QUERY_LENGTH) return null;
  return { start, query };
}

/** Troca o trecho "@consulta" pelo rótulo escolhido e devolve o novo cursor. */
export function insertMention(
  text: string,
  trigger: MentionTrigger,
  label: string,
): { text: string; caret: number } {
  const head = text.slice(0, trigger.start);
  const tail = text.slice(trigger.start + 1 + trigger.query.length);
  // O espaço depois do rótulo é o que permite marcar duas pessoas seguidas
  // sem que a segunda "@" caia colada na primeira (e não abra o seletor).
  const inserted = `${label} `;
  return { text: `${head}${inserted}${tail}`, caret: head.length + inserted.length };
}

/**
 * Conta as ocorrências de cada rótulo no texto sem deixar um rótulo contar
 * dentro de outro: "@João" está dentro de "@João Silva", e sem a máscara a
 * marcação curta seria contada de graça. Rótulo mais longo primeiro.
 */
function labelOccurrences(text: string, labels: string[]): Map<string, number> {
  const taken = new Array<boolean>(text.length).fill(false);
  const counts = new Map<string, number>();
  const ordered = [...new Set(labels)].sort((a, b) => b.length - a.length);
  for (const label of ordered) {
    let count = 0;
    if (label.length > 0) {
      let from = 0;
      for (;;) {
        const at = text.indexOf(label, from);
        if (at < 0) break;
        let free = true;
        for (let i = at; i < at + label.length; i += 1) {
          if (taken[i]) {
            free = false;
            break;
          }
        }
        if (free) {
          for (let i = at; i < at + label.length; i += 1) taken[i] = true;
          count += 1;
        }
        from = at + 1;
      }
    }
    counts.set(label, count);
  }
  return counts;
}

/**
 * Mantém só as marcações cujo rótulo ainda está escrito no texto.
 *
 * É isto que faz o backspace desmarcar: apagar "@João" do campo tira o João
 * da lista. Menção órfã na lista notificaria alguém que não aparece na
 * mensagem — o cliente receberia um aviso sobre um texto que não o cita.
 *
 * Duas pessoas com exatamente o mesmo nome exibido compartilham o rótulo;
 * nesse caso apagar uma delas descarta a marcação mais antiga do rótulo.
 * Conviver com isso é melhor do que enfeitar o nome no campo.
 */
export function activeMentions(text: string, mentions: DraftMention[]): DraftMention[] {
  const remaining = labelOccurrences(
    text,
    mentions.map((mention) => mention.label),
  );
  const kept: DraftMention[] = [];
  for (const mention of mentions) {
    const left = remaining.get(mention.label) ?? 0;
    if (left <= 0) continue;
    remaining.set(mention.label, left - 1);
    kept.push(mention);
  }
  return kept;
}

/**
 * Monta o que de fato sai para o WhatsApp: o texto com os tokens no lugar dos
 * rótulos e a lista de participantes a notificar.
 *
 * O token é "@<dígitos do telefone>" porque é assim que o cliente do WhatsApp
 * reconhece a marcação e a desenha com o nome da agenda de quem recebe. O
 * "@todos" fica literal: não existe token de grupo no protocolo, o que marca
 * todo mundo é a lista de identificadores.
 */
export function buildOutboundMention(
  text: string,
  mentions: DraftMention[],
): { text: string; externalIds: string[] } {
  const active = activeMentions(text, mentions);
  if (active.length === 0) return { text, externalIds: [] };

  // Fila de tokens por rótulo, na ordem em que as marcações foram inseridas.
  const queue = new Map<string, string[]>();
  for (const mention of active) {
    const tokens = queue.get(mention.label) ?? [];
    tokens.push(mention.token);
    queue.set(mention.label, tokens);
  }

  // Mesma ordem da contagem (mais longo primeiro) para não estragar o rótulo
  // que contém outro rótulo dentro.
  const ordered = [...queue.keys()].sort((a, b) => b.length - a.length);
  let output = text;
  for (const label of ordered) {
    const tokens = queue.get(label) ?? [];
    for (const token of tokens) {
      const at = output.indexOf(label);
      if (at < 0) break;
      if (token === label) continue;
      output = `${output.slice(0, at)}${token}${output.slice(at + label.length)}`;
    }
  }

  const externalIds = [...new Set(active.flatMap((mention) => mention.externalIds))];
  return { text: output, externalIds };
}

/** Só dígitos do JID ("5511999998888@s.whatsapp.net" -> "5511999998888"). */
export function mentionDigits(jid: string): string {
  const bare = jid.split("@")[0] ?? "";
  return (bare.split(":")[0] ?? "").replace(/\D/g, "");
}

/**
 * JID que vai na lista de mencionados. Sempre a partir do telefone: é a forma
 * que o cliente do WhatsApp casa com o token do texto.
 */
export function mentionJid(phoneNumber: string): string {
  return `${phoneNumber.replace(/\D/g, "")}@s.whatsapp.net`;
}

/** Token que representa a pessoa dentro do texto enviado. */
export function mentionToken(phoneNumber: string): string {
  return `@${phoneNumber.replace(/\D/g, "")}`;
}

/**
 * Marcar exige telefone conhecido. Participante que só tem identificador
 * interno ("@lid") não é mencionável: o LID não é telefone, e mandá-lo como
 * marcação não notifica ninguém — some sem erro.
 */
export function isMentionable(participant: { phoneNumber: string | null }): boolean {
  return !!participant.phoneNumber && participant.phoneNumber.replace(/\D/g, "").length > 0;
}

/**
 * Progresso e MOTIVO DE ENCERRAMENTO de uma ligação.
 *
 * Fonte única dos dois lados: o provider traduz o que o AstraCalls manda
 * (`call-status`, `call-ended` com `reason`, erro ao discar) num destes
 * códigos, a API guarda o código em `Message.metadata.callEndReason` e a tela
 * mostra o rótulo daqui. Código, nunca frase: o texto pode mudar sem migrar
 * nada, e o código técnico do provedor fica só no log.
 *
 * Ligação antiga, de antes deste registro, NÃO tem motivo — e continua sem:
 * inventar "não atendeu" para quem só sabemos que foi "perdida" seria pior do
 * que mostrar o que já se mostrava.
 */
export const CALL_END_REASONS = [
  "completed",
  "no_answer",
  "busy",
  "rejected",
  "not_found",
  "canceled",
  "failed",
] as const;
export type CallEndReason = (typeof CALL_END_REASONS)[number];

/** Rótulo curto, para a lista de Ligações e o fim do painel do discador. */
export const CALL_END_REASON_LABELS: Record<CallEndReason, string> = {
  completed: "Atendida",
  no_answer: "Não atendeu",
  busy: "Ocupado",
  rejected: "Recusada",
  not_found: "Número sem WhatsApp",
  canceled: "Cancelada por nós",
  failed: "Falha na ligação",
};

/** Frase mais explicada, para o painel de quem acabou de discar. */
export const CALL_END_REASON_DESCRIPTIONS: Record<CallEndReason, string> = {
  completed: "Ligação encerrada.",
  no_answer: "O cliente não atendeu.",
  busy: "O cliente está ocupado em outra ligação.",
  rejected: "O cliente recusou a ligação.",
  not_found: "Este número não existe ou não tem WhatsApp.",
  canceled: "Você encerrou antes de o cliente atender.",
  failed: "Falha na ligação. Tente de novo em instantes.",
};

export function isCallEndReason(value: unknown): value is CallEndReason {
  return typeof value === "string" && (CALL_END_REASONS as readonly string[]).includes(value);
}

/**
 * Traduz o `reason` cru do `call-ended` do AstraCalls (whatsmeow) num motivo.
 *
 * O AstraCalls não documenta a lista, então a leitura é por PALAVRA, em minúsculas.
 * Regras, na ordem:
 * - quem encerrou fomos NÓS antes de o cliente atender → `canceled` (vence o resto:
 *   é a única informação que só nós temos, e não pode virar "perdida do cliente");
 * - chamada que chegou a ser atendida → `completed`;
 * - recusa, ocupado, número inexistente e tempo esgotado têm palavra própria;
 * - SEM motivo nenhum e nunca atendida → `no_answer`, que é o que o registro
 *   sempre chamou de "perdida" (preserva o comportamento de antes);
 * - motivo que não reconhecemos → `failed`. O texto cru vai para o log, nunca
 *   para a tela, e é o que permite ensinar a próxima palavra em minutos.
 */
export function callEndReasonFromProvider(input: {
  reason: string | null | undefined;
  accepted: boolean;
  endedByUs: boolean;
}): { reason: CallEndReason; recognized: boolean } {
  const raw = (input.reason ?? "").trim().toLowerCase();
  if (input.endedByUs && !input.accepted) return { reason: "canceled", recognized: true };
  if (input.accepted) return { reason: "completed", recognized: true };
  if (!raw) return { reason: "no_answer", recognized: true };
  if (/reject|declin|recus/.test(raw)) return { reason: "rejected", recognized: true };
  if (/busy|ocupad|in[_\s-]?call|another/.test(raw)) return { reason: "busy", recognized: true };
  if (/not[_\s-]?(found|registered|on[_\s-]?whatsapp|exist)|invalid|unknown[_\s-]?(number|user|jid)|no[_\s-]?account/.test(raw)) {
    return { reason: "not_found", recognized: true };
  }
  if (/time[_\s-]?out|no[_\s-]?answer|unanswer|missed|expired|offline|unavailable/.test(raw)) {
    return { reason: "no_answer", recognized: true };
  }
  if (/cancel|hang[_\s-]?up|caller|local/.test(raw)) {
    // Cancelado pelo lado que ligou: se fomos nós ligando, é o mesmo caso do
    // botão de desligar (o painel pode ter fechado por outro caminho).
    return { reason: "canceled", recognized: true };
  }
  return { reason: "failed", recognized: false };
}

/**
 * Tons de progresso no PADRÃO BRASILEIRO (Anatel), tocados no navegador quando o
 * outro lado não manda áudio próprio. A ligação aqui é do WHATSAPP, não da
 * telefonia: o WhatsApp não envia som de chamada pela rede (o aplicativo de
 * quem liga é que sintetiza o "tuuu"), então quem disca pelo AZVCHAT só ouve
 * algo se nós gerarmos. Frequência única de 425 Hz para os três:
 * - chamada (ringback): 1 s de tom, 4 s de silêncio;
 * - ocupado: 250 ms de tom, 250 ms de silêncio;
 * - número inexistente: a sequência de informação especial (três tons
 *   subindo), que é o som que qualquer pessoa associa a "número não existe".
 */
export const CALL_TONE_FREQUENCY_HZ = 425;
export const CALL_RINGBACK_PATTERN = { onMs: 1000, offMs: 4000 } as const;
export const CALL_BUSY_PATTERN = { onMs: 250, offMs: 250, totalMs: 3000 } as const;
export const CALL_NOT_FOUND_SEQUENCE_HZ = [950, 1400, 1800] as const;
export const CALL_NOT_FOUND_TONE_MS = 330;

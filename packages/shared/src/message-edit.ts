/**
 * Edição de mensagem já enviada.
 *
 * As duas regras que valem aqui vêm do WhatsApp, não de nós: só alguns tipos
 * de mensagem têm texto editável, e a edição só é aceita por alguns minutos
 * depois do envio. Elas moram neste arquivo porque a API e a tela precisam
 * decidir IGUAL — se a tela oferecer o botão e o servidor do WhatsApp
 * recusar, a Inbox passa a mostrar um texto que o cliente nunca recebeu, e
 * ninguém percebe.
 */

/** Janela em que o WhatsApp aceita a edição, contada a partir do envio. */
export const MESSAGE_EDIT_WINDOW_MINUTES = 15;

/**
 * Tipos com texto que dá para editar. Imagem, vídeo e documento entram pela
 * LEGENDA; áudio e figurinha ficam de fora porque não têm legenda no
 * WhatsApp — editar ali não teria o que mudar.
 */
export const EDITABLE_MESSAGE_TYPES = ["text", "image", "video", "document"] as const;

export type EditableMessageType = (typeof EDITABLE_MESSAGE_TYPES)[number];

export function isEditableMessageType(type: string): type is EditableMessageType {
  return (EDITABLE_MESSAGE_TYPES as readonly string[]).includes(type);
}

/** A mensagem ainda está dentro da janela de edição? */
export function isWithinEditWindow(
  sentAt: Date | string,
  now: Date = new Date(),
): boolean {
  const timestamp = sentAt instanceof Date ? sentAt : new Date(sentAt);
  const elapsed = now.getTime() - timestamp.getTime();
  if (Number.isNaN(elapsed)) return false;
  // Relógio do WhatsApp adiantado deixaria `elapsed` negativo: mensagem do
  // "futuro" continua editável, e não o contrário.
  return elapsed < MESSAGE_EDIT_WINDOW_MINUTES * 60_000;
}

export const MESSAGE_EDIT_EXPIRED_MESSAGE =
  `O WhatsApp só aceita edição nos primeiros ${MESSAGE_EDIT_WINDOW_MINUTES} minutos após o envio.`;

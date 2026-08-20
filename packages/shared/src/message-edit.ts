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

/**
 * Histórico de versões de uma mensagem editada.
 *
 * Ele mora em `Message.metadata`, e não em coluna nova, por dois motivos:
 * é dado de exibição de um caso raro (a maioria das mensagens nunca é
 * editada, e uma coluna nula em toda linha não se paga) e o `metadata` já
 * viaja inteiro no DTO e no evento `message:updated` — o histórico chega à
 * tela sem ampliar contrato de tempo real nenhum.
 *
 * Guardamos o conteúdo ANTERIOR, e não o novo: num escritório contábil, o
 * cliente que corrige um CNPJ, um valor ou uma competência costuma corrigir
 * exatamente o dado que a atendente já usou. Saber o que estava escrito
 * antes é o que permite desfazer o erro do lado de cá.
 */
export const MESSAGE_VERSIONS_METADATA_KEY = "versions";

export interface MessageVersion {
  /** O que a mensagem dizia ANTES desta edição. */
  content: string | null;
  /** Quando esta versão foi substituída, em ISO 8601. */
  at: string;
}

/** Lê o histórico gravado no `metadata`, tolerando lixo e formato antigo. */
export function readMessageVersions(metadata: unknown): MessageVersion[] {
  if (!metadata || typeof metadata !== "object") return [];
  const raw = (metadata as Record<string, unknown>)[MESSAGE_VERSIONS_METADATA_KEY];
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const { content, at } = entry as { content?: unknown; at?: unknown };
    if (typeof at !== "string") return [];
    return [{ content: typeof content === "string" ? content : null, at }];
  });
}

/**
 * Acrescenta uma versão ao histórico, preservando o resto do `metadata`
 * (as marcações do "@" moram no mesmo objeto e não podem ser perdidas).
 *
 * Não há limite de versões: o WhatsApp já limita a edição a poucos minutos,
 * então a lista não cresce sem fim na prática.
 */
export function appendMessageVersion(
  metadata: unknown,
  previousContent: string | null,
  replacedAt: Date | string,
): Record<string, unknown> {
  const base =
    metadata && typeof metadata === "object" && !Array.isArray(metadata)
      ? { ...(metadata as Record<string, unknown>) }
      : {};
  const at = replacedAt instanceof Date ? replacedAt.toISOString() : replacedAt;
  base[MESSAGE_VERSIONS_METADATA_KEY] = [
    ...readMessageVersions(metadata),
    { content: previousContent, at },
  ];
  return base;
}

/**
 * Marca das bolhas que NUNCA foram mensagem: pacotes de protocolo de edição
 * gravados por engano, antes de a edição ser reconhecida. Elas ficam no
 * banco (nada de exclusão física), apenas com `deletedAt` e esta marca.
 *
 * Sem a marca, a linha apagada renderizaria "Esta mensagem foi apagada" —
 * dizendo ao atendente que o cliente apagou algo que ele nunca mandou. Com
 * ela, a linha simplesmente não é desenhada, que é o que "ocultar" quer
 * dizer aqui.
 */
export const PROTOCOL_ARTIFACT_METADATA_KEY = "protocolArtifact";

export function isProtocolArtifact(metadata: unknown): boolean {
  if (!metadata || typeof metadata !== "object") return false;
  return (metadata as Record<string, unknown>)[PROTOCOL_ARTIFACT_METADATA_KEY] === true;
}

/**
 * Segredo por mensagem, guardado no `metadata`.
 *
 * O WhatsApp cifra a edição feita pelo cliente com uma chave derivada deste
 * valor. Sem ele, a edição chega e não há como lê-la. Fica no `metadata`
 * pelo mesmo motivo do histórico de versões: nem toda mensagem tem, e uma
 * coluna nula em milhares de linhas não se paga.
 *
 * NÃO é chave de conta nem de sessão: cada segredo serve a UMA mensagem, e
 * quem tem acesso ao banco já lê o conteúdo dela em texto puro. Guardá-lo
 * não amplia o que um banco vazado entregaria.
 */
export const MESSAGE_SECRET_METADATA_KEY = "messageSecret";

export function readMessageSecret(metadata: unknown): string | null {
  if (!metadata || typeof metadata !== "object") return null;
  const value = (metadata as Record<string, unknown>)[MESSAGE_SECRET_METADATA_KEY];
  return typeof value === "string" && value.length > 0 ? value : null;
}


/**
 * Marca de "o cliente editou, e não conseguimos ler o texto novo".
 *
 * Existe porque o WhatsApp passou a cifrar a edição com uma chave derivada
 * do segredo da mensagem original, e há casos em que a abertura falha: a
 * mensagem é anterior a guardarmos esse segredo, ou o identificador que ele
 * usou na derivação não é nenhum dos que conhecemos.
 *
 * Sem a marca, o pior desfecho volta: a atendente segue lendo o valor, o
 * CNPJ ou a competência que o cliente já corrigiu, sem nada na tela
 * denunciando isso. Com ela, o texto antigo continua visível (é o que temos)
 * mas ninguém age achando que está atualizado.
 */
export const EDIT_CONTENT_UNAVAILABLE_METADATA_KEY = "editedContentUnavailable";

export function isEditContentUnavailable(metadata: unknown): boolean {
  if (!metadata || typeof metadata !== "object") return false;
  return (
    (metadata as Record<string, unknown>)[EDIT_CONTENT_UNAVAILABLE_METADATA_KEY] === true
  );
}

export const EDIT_CONTENT_UNAVAILABLE_LABEL = "editada pelo cliente";

export const EDIT_CONTENT_UNAVAILABLE_HINT =
  "O cliente editou esta mensagem e o WhatsApp não entregou o texto novo. O que aparece aqui é o conteúdo anterior: confirme no WhatsApp antes de usar.";

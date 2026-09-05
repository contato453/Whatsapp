import type { ConversationType, MessageType, NormalizedMessage } from "@azvchat/shared";

/**
 * Helpers de normalização entre o formato do AstraCalls (whatsmeow) e os
 * contratos neutros do AZVCHAT. Nada de Baileys aqui — é o equivalente ao
 * `normalize.ts` do provider de QR, só que para a outra implementação.
 */

/** Narrowing seguro de `unknown` (o webhook chega sem tipo). */
export function asString(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}
export function asNumber(v: unknown): number | null {
  return typeof v === "number" ? v : null;
}
export function asBool(v: unknown): boolean {
  return v === true;
}
export function asRecord(v: unknown): Record<string, unknown> | null {
  return typeof v === "object" && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

/** Remove o sufixo de aparelho ("...:13@...") que o WhatsApp às vezes anexa. */
export function stripDeviceSuffix(jid: string): string {
  return jid.replace(/:\d+(?=@)/, "");
}

/**
 * Normaliza um JID para o formato que o resto do AZVCHAT usa. O AstraCalls
 * expõe apelidos em `@c.us`; convertemos para `@s.whatsapp.net`. Grupo
 * (`@g.us`) e identificador interno (`@lid`) ficam como estão.
 */
export function normalizeJid(jid: string): string {
  const clean = stripDeviceSuffix(jid.trim());
  if (clean.endsWith("@c.us")) {
    return `${clean.slice(0, -"@c.us".length)}@s.whatsapp.net`;
  }
  return clean;
}

export function chatTypeFromJid(jid: string): ConversationType {
  return jid.includes("@g.us") ? "group" : "individual";
}

/** Telefone (E.164 sem +) a partir de um JID de pessoa; null para grupo/LID. */
export function phoneFromJid(jid: string | null): string | null {
  if (!jid) return null;
  const clean = stripDeviceSuffix(jid);
  if (clean.endsWith("@s.whatsapp.net") || clean.endsWith("@c.us")) {
    const digits = clean.split("@")[0]?.replace(/\D/g, "") ?? "";
    return digits || null;
  }
  return null;
}

const TYPE_MAP: Record<string, MessageType> = {
  text: "text",
  chat: "text",
  conversation: "text",
  image: "image",
  audio: "audio",
  ptt: "audio",
  voice: "audio",
  video: "video",
  document: "document",
  sticker: "sticker",
  location: "location",
  contact: "contact",
  vcard: "contact",
  poll: "poll",
  call: "call",
};

export function messageTypeFromAstra(type: string | null): MessageType {
  if (!type) return "other";
  return TYPE_MAP[type.toLowerCase()] ?? "other";
}

/**
 * Timestamp do AstraCalls (whatsmeow) → Date. FONTE ÚNICA da conversão, usada
 * na entrada (webhook) e na saída (SendOK, lista de chats). O valor vem em
 * MILISSEGUNDOS (13 dígitos); toleramos segundos por robustez e nunca
 * devolvemos Invalid Date — multiplicar ms por 1000 estourava o range do Date
 * e o Prisma recusava com "Could not convert ... DateTime", que foi o bug do
 * `message_ingest_failed` (entrada) E do envio pela rota do app (saída).
 */
export function astraTimestampToDate(raw: number | null): Date {
  if (!raw) return new Date();
  const d = new Date(raw > 1e12 ? raw : raw * 1000);
  return Number.isNaN(d.getTime()) ? new Date() : d;
}

/**
 * Extrai texto exibível de um sub-objeto de mensagem do whatsmeow (o
 * `quotedMessage` do contextInfo). O WhatsApp aninha o texto de formas
 * diferentes conforme o tipo; varremos as mais comuns e devolvemos o primeiro
 * que aparecer, para o bloco de citação não ficar vazio.
 */
function quotedText(quoted: Record<string, unknown>): string | null {
  const conversation = asString(quoted.conversation);
  if (conversation) return conversation;
  const ext = asRecord(quoted.extendedTextMessage);
  if (ext) {
    const t = asString(ext.text);
    if (t) return t;
  }
  for (const key of ["imageMessage", "videoMessage", "documentMessage"] as const) {
    const m = asRecord(quoted[key]);
    const caption = m ? asString(m.caption) : null;
    if (caption) return caption;
  }
  return null;
}

/** Tipo lógico de um sub-objeto de mensagem (para o rótulo da citação). */
function quotedType(quoted: Record<string, unknown>): MessageType {
  if (quoted.imageMessage) return "image";
  if (quoted.audioMessage) return "audio";
  if (quoted.videoMessage) return "video";
  if (quoted.documentMessage) return "document";
  if (quoted.stickerMessage) return "sticker";
  if (quoted.pollCreationMessage || quoted.pollCreationMessageV3) return "poll";
  return "text";
}

/**
 * Procura o TEXTO de uma mensagem em qualquer profundidade do `raw` do
 * whatsmeow — desembrulhando os invólucros (editedMessage, protocolMessage,
 * ephemeralMessage...) sem apostar num caminho fixo. Pula `contextInfo`/
 * `quotedMessage` para não pegar o texto da mensagem CITADA no lugar do novo.
 */
function findMessageText(value: unknown, depth = 0): string | null {
  if (depth > 8) return null;
  const rec = asRecord(value);
  if (!rec) return null;
  const conversation = asString(rec.conversation);
  if (conversation) return conversation;
  const ext = asRecord(rec.extendedTextMessage);
  if (ext) {
    const t = asString(ext.text);
    if (t) return t;
  }
  for (const key of ["imageMessage", "videoMessage", "documentMessage"] as const) {
    const m = asRecord(rec[key]);
    const caption = m ? asString(m.caption) : null;
    if (caption) return caption;
  }
  for (const [key, inner] of Object.entries(rec)) {
    if (key === "contextInfo" || key === "quotedMessage") continue;
    const found = findMessageText(inner, depth + 1);
    if (found) return found;
  }
  return null;
}

/**
 * Texto NOVO de uma edição feita pelo cliente. Igual à citação e às menções, o
 * AstraCalls entrega o texto no `raw` e deixa o `data.text` do topo VAZIO num
 * `edited` — ler só o topo gravava a mensagem editada como vazia (bolha preta
 * "editada" sem texto). Tentamos o topo e, faltando, varremos o `raw`.
 */
export function extractEditedText(data: Record<string, unknown>): string {
  const top =
    asString(data.text) ??
    asString(data.body) ??
    asString(data.caption) ??
    asString(data.editedText) ??
    asString(data.newText);
  if (top) return top;
  const raw = asRecord(data.raw);
  return (raw ? findMessageText(raw) : null) ?? "";
}

/**
 * Acha o `contextInfo` da mensagem `raw` do whatsmeow. Ele mora dentro do
 * sub-objeto do tipo (extendedTextMessage, imageMessage, ...), não no topo —
 * é dele que saem a CITAÇÃO (reply) e as MENÇÕES. Devolve o primeiro que
 * encontrar; mensagem sem contextInfo devolve null.
 */
function findContextInfo(raw: Record<string, unknown>): Record<string, unknown> | null {
  const direct = asRecord(raw.contextInfo);
  if (direct) return direct;
  for (const value of Object.values(raw)) {
    const sub = asRecord(value);
    if (sub) {
      const ctx = asRecord(sub.contextInfo);
      if (ctx) return ctx;
    }
  }
  return null;
}

/**
 * Sub-objeto de mídia dentro do `raw` do whatsmeow (documentMessage,
 * imageMessage, ...). É dele que saem o MIME TYPE e o NOME do arquivo — o
 * webhook deixa `data.mimetype`/`data.filename` VAZIOS na mídia que chega pelo
 * echo (enviada por fora, do próprio aparelho) e no recebimento, e sem eles o
 * download salva sem extensão, virando "arquivo bugado" que não abre.
 */
function mediaNodeFromRaw(raw: Record<string, unknown> | null): Record<string, unknown> | null {
  if (!raw) return null;
  for (const key of [
    "documentMessage",
    "imageMessage",
    "videoMessage",
    "audioMessage",
    "stickerMessage",
  ] as const) {
    const node = asRecord(raw[key]);
    if (node) return node;
  }
  // Documento com legenda vem embrulhado.
  const wrapped = asRecord(raw.documentWithCaptionMessage);
  if (wrapped) return mediaNodeFromRaw(asRecord(wrapped.message));
  return null;
}

/**
 * Constrói um NormalizedMessage a partir do `data` de um webhook `message`
 * (ou de um item de MessageList — mesma forma). Os campos garantidos pelo spec
 * são `chat/sender/id/fromMe/timestamp/type/body`; citação, menções, opções de
 * enquete, duração e o MIME/NOME da mídia saem do `raw` (a mensagem crua do
 * whatsmeow), que o webhook entrega ao lado dos campos já mastigados.
 */
export function parseInboundMessage(
  instanceId: string,
  data: Record<string, unknown>,
  buildDownload: (data: Record<string, unknown>) => (() => Promise<Buffer>) | null,
): NormalizedMessage | null {
  const chatRaw = asString(data.chat) ?? asString(data.chatId) ?? asString(data.from);
  const idRaw = asString(data.id) ?? asString(data.messageId);
  if (!chatRaw || !idRaw) return null;

  const externalChatId = normalizeJid(chatRaw);
  // Canal (@newsletter) e lista de transmissão (@broadcast) NÃO são atendimento:
  // o número segue canais (Globo etc.) e cada post chegava como conversa nova,
  // poluindo a Inbox. O getChats já os pula na sincronização; aqui barramos a
  // mesma coisa que entra AO VIVO pelo webhook `message`.
  if (externalChatId.endsWith("@newsletter") || externalChatId.endsWith("@broadcast")) {
    return null;
  }
  const chatType = chatTypeFromJid(externalChatId);
  const fromMe = asBool(data.fromMe);

  const senderRaw = asString(data.sender) ?? asString(data.participant) ?? asString(data.author);
  const senderExternalId = senderRaw ? normalizeJid(senderRaw) : fromMe ? null : externalChatId;

  const type = messageTypeFromAstra(asString(data.type));
  const content =
    asString(data.body) ?? asString(data.text) ?? asString(data.caption) ?? null;

  const timestamp = astraTimestampToDate(asNumber(data.timestamp));

  // Mídia: `buildDownload` prefere base64/url quando vierem e, senão, usa a
  // rota de mídia do AstraCalls (bytes já decifrados por id — P0#1 resolvido).
  // Devolve null para mensagem sem mídia (texto etc.).
  const download = buildDownload(data);
  // MIME e nome: o topo vem vazio na mídia echoada/recebida, então caímos no
  // sub-objeto do `raw`. Sem isto o download sai sem extensão ("bugado").
  const mediaNode = mediaNodeFromRaw(asRecord(data.raw));
  const mimeType =
    asString(data.mimetype) ??
    asString(data.mimeType) ??
    (mediaNode ? asString(mediaNode.mimetype) ?? asString(mediaNode.mimeType) : null);
  const filename =
    asString(data.filename) ??
    (mediaNode ? asString(mediaNode.fileName) ?? asString(mediaNode.title) : null);
  const media =
    download || mimeType || filename
      ? {
          mimeType: mimeType ?? null,
          filename: filename ?? null,
          download:
            download ??
            (() =>
              Promise.reject(
                new Error("astracalls_media_download_indisponivel"),
              )),
        }
      : null;

  // Ruído do whatsmeow: history-sync e protocolMessage chegam como
  // `type:"unknown"` (→ "other") sem texto e sem mídia. Equivale ao
  // isDisplayableContent do provider de QR — não vira linha na conversa.
  if (type === "other" && !content && !media) return null;

  // A mensagem crua do whatsmeow. É dela que saem citação, menções, opções de
  // enquete e duração — o AstraCalls entrega os campos mastigados no topo, mas
  // esses quatro só existem aqui dentro.
  const raw = asRecord(data.raw);

  // Citação (reply) e menções: o `contextInfo` mora no sub-objeto do tipo.
  // Sem isto, a resposta do CLIENTE chegava sem o bloco de citação (a nossa,
  // de saída, já ia pelo quotedMessageId do envio) — era o bug do "responder".
  let quotedExternalMessageId: string | null = asString(data.quotedMessageId);
  let quotedInfo: NormalizedMessage["quotedInfo"] = null;
  let mentionedExternalIds: string[] = [];
  if (raw) {
    const ctx = findContextInfo(raw);
    if (ctx) {
      // O whatsmeow serializa o id da citada como `stanzaID` (I maiúsculo);
      // aceitamos as duas grafias porque a caixa variou entre versões e foi
      // exatamente o `stanzaId` que passava batido — a resposta do cliente
      // chegava como mensagem nova, sem o bloco de citação.
      quotedExternalMessageId =
        quotedExternalMessageId ?? asString(ctx.stanzaID) ?? asString(ctx.stanzaId);
      const quoted = asRecord(ctx.quotedMessage);
      if (quotedExternalMessageId || quoted) {
        const participant = asString(ctx.participant);
        quotedInfo = {
          participantExternalId: participant ? normalizeJid(participant) : null,
          content: quoted ? quotedText(quoted) : null,
          type: quoted ? quotedType(quoted) : "text",
        };
      }
      // Menção: `mentionedJID` (whatsmeow) ou `mentionedJid`, conforme a versão.
      const mentioned = ctx.mentionedJID ?? ctx.mentionedJid;
      if (Array.isArray(mentioned)) {
        mentionedExternalIds = mentioned
          .map((jid) => asString(jid))
          .filter((jid): jid is string => !!jid)
          .map((jid) => normalizeJid(jid));
      }
    }
  }

  // Opções da enquete: sem elas a Inbox mostrava a pergunta e nenhuma opção
  // para acompanhar. `optionName` é o rótulo de cada alternativa.
  let pollOptions: string[] | undefined;
  const pollRaw = raw ? asRecord(raw.pollCreationMessage) ?? asRecord(raw.pollCreationMessageV3) : null;
  if (pollRaw && Array.isArray(pollRaw.options)) {
    pollOptions = pollRaw.options
      .map((opt) => {
        const o = asRecord(opt);
        return o ? asString(o.optionName) : null;
      })
      .filter((name): name is string => !!name);
  }

  // Duração do áudio (segundos): o player do navegador não a lê de um OGG/Opus
  // sem baixar tudo, então a barra da nota de voz recebida ficava zerada.
  let mediaDurationSeconds: number | undefined;
  const audioRaw = raw ? asRecord(raw.audioMessage) : null;
  const secs = audioRaw ? asNumber(audioRaw.seconds) : null;
  if (secs && secs > 0) mediaDurationSeconds = secs;

  return {
    instanceId,
    externalMessageId: idRaw,
    externalChatId,
    chatType,
    chatName: asString(data.chatName),
    direction: fromMe ? "outbound" : "inbound",
    type,
    content,
    senderExternalId,
    // O webhook agora traz o telefone real (PN) de quem enviou, resolvendo o
    // `@lid` — usamos ele e só caímos no cálculo pelo JID como reserva.
    senderPhone: asString(data.senderPhone) ?? phoneFromJid(senderExternalId),
    senderName: asString(data.pushName) ?? asString(data.senderName) ?? null,
    quotedExternalMessageId,
    quotedInfo,
    mentionedExternalIds,
    pollOptions,
    mediaDurationSeconds,
    timestamp,
    media,
  };
}

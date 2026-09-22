/**
 * Marca de "a mídia desta mensagem não foi baixada/guardada", no
 * `metadata`.
 *
 * Falha no download (o WhatsApp ainda não liberou o arquivo, um tropeço de
 * rede) ou no storage (disco cheio, permissão) não pode derrubar a
 * mensagem inteira — o texto/legenda que o cliente escreveu não pode se
 * perder por causa do anexo. A mensagem entra sem `mediaUrl`, com esta
 * marca, para a equipe achar depois o que ficou sem arquivo e reprocessar
 * (a fila de retentativa em si é item futuro — ver o CLAUDE.md, seção 14).
 */
export const MEDIA_DOWNLOAD_FAILED_METADATA_KEY = "mediaDownloadFailed";

export function isMediaDownloadFailed(metadata: unknown): boolean {
  if (!metadata || typeof metadata !== "object") return false;
  return (metadata as Record<string, unknown>)[MEDIA_DOWNLOAD_FAILED_METADATA_KEY] === true;
}

/**
 * Chave do storage do MP3 já convertido deste áudio, no `metadata`.
 *
 * Existe para o mesmo áudio não ser convertido a cada download: a equipe baixa
 * o comprovante, anexa no e-mail, o cliente cobra de novo e alguém baixa outra
 * vez. Converter é processo de ffmpeg e CPU da VPS; guardar a chave custa uma
 * linha de `metadata` que já viaja inteira no DTO.
 *
 * É chave de storage, não URL: só a rota autenticada de mídia sabe o que fazer
 * com ela, e quem não enxerga a conversa não chega nela de jeito nenhum.
 */
export const AUDIO_MP3_METADATA_KEY = "audioMp3Url";

export function readAudioMp3Key(metadata: unknown): string | null {
  if (!metadata || typeof metadata !== "object") return null;
  const value = (metadata as Record<string, unknown>)[AUDIO_MP3_METADATA_KEY];
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * Grava a chave PRESERVANDO o resto do `metadata`. O mesmo objeto guarda as
 * marcações do "@", o histórico de versões e o resumo da citação: um spread
 * descuidado aqui apagaria qualquer um deles.
 */
export function withAudioMp3Key(metadata: unknown, key: string): Record<string, unknown> {
  const base =
    metadata && typeof metadata === "object" ? { ...(metadata as Record<string, unknown>) } : {};
  base[AUDIO_MP3_METADATA_KEY] = key;
  return base;
}

/**
 * O QUE A IA ENTENDEU DE UM ANEXO RECEBIDO, no `metadata` da mensagem.
 *
 * Existe porque a IA não abre arquivo: o áudio do cliente vira TEXTO por
 * transcrição, a imagem vira uma DESCRIÇÃO escrita por um modelo de visão, e o
 * documento vira o TEXTO extraído dele (ver
 * `apps/api/src/services/ai/attachments.ts`). Os três seguem o mesmo desenho, e
 * por isso moram na mesma estrutura.
 *
 * O resultado é guardado aqui, e não recalculado a cada turno, por três motivos
 * que valem para qualquer mexida: (1) ler um anexo é chamada PAGA ao provedor
 * (áudio por minuto, imagem por token de visão), e o mesmo anexo entra no
 * contexto de vários turnos seguidos — refazer a leitura multiplicaria a conta
 * pelo tamanho do histórico; (2) o `metadata` já viaja inteiro no DTO e no
 * `message:updated`, então a equipe vê na bolha exatamente o que a IA entendeu,
 * sem rota nova; e (3) sobrevive a reinício, como todo o resto do estado do
 * atendimento.
 *
 * O registro guarda o INSUCESSO também, de propósito: sem ele, anexo que não dá
 * para ler (arquivo que não baixou, áudio longo demais, PDF digitalizado sem
 * texto, provedor fora do ar) seria tentado de novo a cada turno, e a IA
 * seguiria respondendo como se o cliente não tivesse mandado nada. Com a marca,
 * o motor sabe avisar ao modelo "este anexo você não conseguiu ler" e pedir que
 * o cliente escreva.
 */
export const AI_ATTACHMENT_KINDS = ["audio", "image", "document"] as const;
export type AiAttachmentKind = (typeof AI_ATTACHMENT_KINDS)[number];

/**
 * UMA CHAVE POR TIPO, e não uma genérica, por duas razões: a do áudio
 * (`audioTranscript`) já está gravada em mensagens de produção e renomeá-la
 * cegaria as bolhas que já a têm; e o nome da chave diz o que aquele texto é —
 * transcrição, descrição e texto extraído não são a mesma coisa para quem lê o
 * `metadata` cru depois.
 */
export const AI_ATTACHMENT_METADATA_KEYS: Record<AiAttachmentKind, string> = {
  audio: "audioTranscript",
  image: "imageDescription",
  document: "documentText",
};

/** Mantido pelo nome antigo: é a chave que já existe em produção. */
export const AUDIO_TRANSCRIPT_METADATA_KEY = AI_ATTACHMENT_METADATA_KEYS.audio;

/**
 * `ok` é a única situação com texto. As demais são motivos de não ter:
 * `empty` = leu e não havia conteúdo (áudio sem fala, PDF digitalizado);
 * `no_file` = a mídia não foi baixada (ver `mediaDownloadFailed`);
 * `too_long` = passou do teto de duração/tamanho; `unsupported` = formato que
 * não sabemos ler (planilha, zip); `failed` = o provedor recusou ou caiu.
 */
export const AI_ATTACHMENT_STATUSES = ["ok", "empty", "no_file", "too_long", "unsupported", "failed"] as const;
export type AiAttachmentStatus = (typeof AI_ATTACHMENT_STATUSES)[number];

export interface AiAttachmentInsight {
  kind: AiAttachmentKind;
  status: AiAttachmentStatus;
  /** Só em `ok`; nos outros status é nulo, nunca string vazia. */
  text: string | null;
  /** Modelo que leu, quando houve um (documento é lido aqui, sem provedor). */
  model: string | null;
  /** ISO da tentativa — é ela que diz "já tentei", mesmo sem texto. */
  at: string;
  /**
   * Quantas vezes já foi tentado. Existe por causa da falha TRANSITÓRIA: o
   * provedor fora do ar por um minuto não pode deixar o anexo mudo para sempre
   * (é o mesmo defeito que a retentativa do download de mídia veio consertar).
   * Status determinístico — `no_file`, `too_long`, `empty`, `unsupported` —
   * nunca é tentado de novo, porque tentar daria o mesmo resultado pago.
   */
  attempts: number;
}

/**
 * Teto do texto guardado. Áudio de dez minutos, ou um PDF de contrato, rendem
 * muito mais que isto; o corte protege o contexto do modelo e o tamanho do
 * `metadata`, que viaja em todo evento da mensagem.
 */
export const AI_ATTACHMENT_TEXT_MAX_CHARS = 6000;

/** Tentativas por anexo. Duas: a do turno em que ele chegou e mais uma. */
export const AI_ATTACHMENT_MAX_ATTEMPTS = 2;

function parseInsight(kind: AiAttachmentKind, raw: unknown): AiAttachmentInsight | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Record<string, unknown>;
  const status = AI_ATTACHMENT_STATUSES.find((candidate) => candidate === value.status);
  if (!status) return null;
  return {
    kind,
    status,
    text: typeof value.text === "string" && value.text.length > 0 ? value.text : null,
    model: typeof value.model === "string" && value.model.length > 0 ? value.model : null,
    at: typeof value.at === "string" ? value.at : new Date(0).toISOString(),
    attempts: typeof value.attempts === "number" && value.attempts > 0 ? value.attempts : 1,
  };
}

/** A leitura daquele tipo de anexo, quando existe. */
export function readAiAttachmentInsightOf(
  kind: AiAttachmentKind,
  metadata: unknown,
): AiAttachmentInsight | null {
  if (!metadata || typeof metadata !== "object") return null;
  return parseInsight(kind, (metadata as Record<string, unknown>)[AI_ATTACHMENT_METADATA_KEYS[kind]]);
}

/**
 * A leitura que existir, seja de que tipo for — é o que a BOLHA usa, porque ela
 * desenha a mensagem sem precisar decidir o tipo de novo. Uma mensagem só tem
 * uma das três chaves por construção.
 */
export function readAiAttachmentInsight(metadata: unknown): AiAttachmentInsight | null {
  for (const kind of AI_ATTACHMENT_KINDS) {
    const insight = readAiAttachmentInsightOf(kind, metadata);
    if (insight) return insight;
  }
  return null;
}

/** Grava PRESERVANDO o resto do `metadata` — ver `withAudioMp3Key`. */
export function withAiAttachmentInsight(
  metadata: unknown,
  insight: AiAttachmentInsight,
): Record<string, unknown> {
  const base =
    metadata && typeof metadata === "object" ? { ...(metadata as Record<string, unknown>) } : {};
  base[AI_ATTACHMENT_METADATA_KEYS[insight.kind]] = {
    status: insight.status,
    text: insight.text ? insight.text.slice(0, AI_ATTACHMENT_TEXT_MAX_CHARS) : null,
    model: insight.model,
    at: insight.at,
    attempts: insight.attempts,
  };
  return base;
}

/**
 * Vale tentar de novo? Só a falha do provedor, e só dentro do teto — os outros
 * status são decisão fechada sobre aquele arquivo.
 */
export function aiAttachmentCanRetry(insight: AiAttachmentInsight | null): boolean {
  if (!insight) return true;
  return insight.status === "failed" && insight.attempts < AI_ATTACHMENT_MAX_ATTEMPTS;
}

/** Por que não há texto — frase curta, em português, para a bolha e o log. */
export const AI_ATTACHMENT_STATUS_LABELS: Record<AiAttachmentStatus, string> = {
  ok: "Lido",
  empty: "Sem conteúdo reconhecido",
  no_file: "O arquivo não chegou ao sistema",
  too_long: "Arquivo grande demais para ler",
  unsupported: "Formato que o sistema não lê",
  failed: "Não foi possível ler agora",
};

/** Título do bloco na bolha, por tipo: transcrever, descrever e extrair não são a mesma coisa. */
export const AI_ATTACHMENT_INSIGHT_TITLES: Record<AiAttachmentKind, string> = {
  audio: "Transcrição",
  image: "Descrição da imagem",
  document: "Texto do documento",
};

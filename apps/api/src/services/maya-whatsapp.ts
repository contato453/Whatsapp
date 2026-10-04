import type { PrismaClient } from "@azvchat/database";
import { RealtimeEvents, normalizeBrazilPhone } from "@azvchat/shared";
import type { WhatsAppProvider } from "@azvchat/whatsapp";
import type { Server } from "socket.io";
import type { Logger } from "pino";
import { conversationInclude } from "../lib/conversation-events.js";
import { serializeConversation, serializeMessage } from "../lib/serialize.js";
import { resolveConversationPersonName } from "../lib/person-profile.js";
import { conversationAudience } from "../realtime/socket.js";
import { buildPreview } from "./message-ingest.js";
import type { ReadableMessage } from "./ai/attachments.js";
import type { MayaAudioResult, MayaAudioTranscriber } from "./maya-audio.js";

/**
 * MAYA NO WHATSAPP — a assistente do Azevedo OS respondendo num grupo daqui.
 *
 * Duas coisas, e só num grupo configurado (`MAYA_GRUPO`):
 *
 * 1. Pergunta e resposta: mensagem de ENTRADA no grupo, vinda do número
 *    `MAYA_TELEFONE`, vai para a Edge Function `maya-whatsapp` do Azevedo OS,
 *    e a resposta volta para o grupo. Mensagem de qualquer outro número é
 *    ignorada, calada.
 * 2. Resumo programado: no horário `MAYA_RESUMO_HORARIO` (fuso de Brasília),
 *    nos dias `MAYA_RESUMO_DIAS`, a mesma pergunta fixa vai para a Maya em nome
 *    de `MAYA_TELEFONE`, e a resposta é postada no grupo.
 *
 * A Maya NÃO mora aqui. Quem decide o que ela pode ver é o Azevedo OS: o
 * telefone precisa estar vinculado lá (Gestão > Configurações), e a resposta
 * sai com a visão da pessoa dona do número. Este serviço é só o carteiro.
 *
 * Áudio do mesmo número vira texto antes de ir (`maya-audio.ts`, a mesma
 * transcrição da IA de atendimento), e a pergunta segue o caminho do texto.
 *
 * Sem `MAYA_GRUPO` ou `MAYA_TELEFONE`, ou sem a integração do Azevedo OS
 * configurada, o serviço nasce desligado e nada muda no atendimento.
 */

export interface MayaWhatsappConfig {
  /** Endereço da Edge Function `maya-whatsapp`. */
  url: string;
  /** O mesmo token da integração de leitura (`AZEVEDO_OS_API_TOKEN`). */
  token: string;
  /** JID do grupo (`...@g.us`) ou o nome exato dele. */
  grupo: string;
  /** Único número que aciona a Maya no grupo e em nome de quem sai o resumo. */
  telefone: string;
  /** "HH:MM" no fuso de Brasília, ou null para não mandar resumo. */
  resumoHorario: string | null;
  /** Dias da semana do resumo, 0 = domingo. */
  resumoDias: number[];
  resumoPergunta: string;
  timeoutMs: number;
}

export const RESUMO_PERGUNTA_PADRAO =
  "Monte o meu resumo do dia, curto: certificados que vencem nos próximos 15 dias, " +
  "tarefas atrasadas por departamento, solicitações do RH pendentes e quem está de férias hoje.";

const FUSO = "America/Sao_Paulo";
const TICK_MS = 60_000;
const HISTORICO_MAXIMO = 6;
const SENDER_RESPOSTA = "Maya";
/** Também é a marca que impede o resumo de sair duas vezes no mesmo dia. */
const SENDER_RESUMO = "Maya (resumo)";

/**
 * O que a Maya diz quando o áudio não virou pergunta. Calar seria pior: quem
 * mandou o áudio ficaria esperando uma resposta que não vem.
 */
const AVISO_AUDIO: Record<Exclude<MayaAudioResult, { ok: true }>["motivo"], string> = {
  unreadable: "Não consegui ouvir o áudio. Pode escrever a pergunta?",
  ai_not_configured:
    "Para eu ouvir áudio, a IA precisa estar configurada no AZVCHAT (Configurações > Inteligência artificial). Por enquanto, escreva a pergunta.",
  budget_blocked:
    "O orçamento de IA do AZVCHAT deste mês acabou, então não consigo ouvir áudio agora. Escreva a pergunta.",
};

/**
 * Monta a configuração a partir do ambiente. Devolve null (desligado) quando
 * falta qualquer peça: porta que abre por omissão não existe aqui.
 *
 * O endereço sai do `AZEVEDO_OS_API_URL` trocando o último segmento
 * (`.../functions/v1/azvchat` → `.../functions/v1/maya-whatsapp`), para não
 * pedir mais uma variável que só repetiria o projeto do Supabase.
 * `MAYA_WHATSAPP_URL` sobrepõe se um dia for preciso.
 */
export function mayaConfigFromEnv(env: {
  AZEVEDO_OS_API_URL?: string;
  AZEVEDO_OS_API_TOKEN?: string;
  AZEVEDO_OS_TIMEOUT_MS: number;
  MAYA_WHATSAPP_URL?: string;
  MAYA_GRUPO?: string;
  MAYA_TELEFONE?: string;
  MAYA_RESUMO_HORARIO?: string;
  MAYA_RESUMO_DIAS: string;
  MAYA_RESUMO_PERGUNTA?: string;
}): MayaWhatsappConfig | null {
  const token = env.AZEVEDO_OS_API_TOKEN?.trim();
  const grupo = env.MAYA_GRUPO?.trim();
  const telefone = env.MAYA_TELEFONE?.trim();
  if (!token || !grupo || !telefone) return null;

  let url = env.MAYA_WHATSAPP_URL?.trim() ?? "";
  if (!url && env.AZEVEDO_OS_API_URL) {
    url = env.AZEVEDO_OS_API_URL.trim().replace(/\/+$/, "").replace(/\/[^/]+$/, "/maya-whatsapp");
  }
  if (!url) return null;

  return {
    url,
    token,
    grupo,
    telefone,
    resumoHorario: env.MAYA_RESUMO_HORARIO?.trim() || null,
    resumoDias: parseDias(env.MAYA_RESUMO_DIAS),
    resumoPergunta: env.MAYA_RESUMO_PERGUNTA?.trim() || RESUMO_PERGUNTA_PADRAO,
    // A Maya pensa (várias chamadas ao modelo); o timeout da leitura de
    // empresas, curto de propósito, não serve aqui.
    timeoutMs: Math.max(env.AZEVEDO_OS_TIMEOUT_MS, 60_000),
  };
}

/** "1-5" → [1,2,3,4,5]; "1,3,5" → [1,3,5]. Valor fora de 0..6 é ignorado. */
export function parseDias(raw: string): number[] {
  const dias = new Set<number>();
  for (const parte of raw.split(",")) {
    const m = /^\s*(\d)\s*(?:-\s*(\d)\s*)?$/.exec(parte);
    if (!m) continue;
    const ini = Number(m[1]);
    const fim = m[2] === undefined ? ini : Number(m[2]);
    for (let d = ini; d <= fim; d++) if (d >= 0 && d <= 6) dias.add(d);
  }
  return [...dias].sort();
}

/**
 * Telefone em forma de comparação: 55 + DDD + assinante, sem o nono dígito.
 * O WhatsApp entrega celular antigo sem o 9; sem isto, o mesmo número
 * cadastrado com 9 nunca casaria. É a mesma regra de `os_telefone_canonico`
 * no Azevedo OS.
 */
export function telefoneCanonico(raw: string | null | undefined): string | null {
  const n = normalizeBrazilPhone(raw);
  if (!n.ok) return null;
  const p = n.phone;
  return p.length === 13 && p[4] === "9" ? p.slice(0, 4) + p.slice(5) : p;
}

/**
 * A Maya escreve em Markdown (é o que o portal mostra); o WhatsApp tem a
 * formatação dele. Sem esta tradução, `**248**` chega com os asteriscos.
 */
export function paraWhatsapp(texto: string): string {
  return texto
    .replace(/\*\*(.+?)\*\*/g, "*$1*")
    .replace(/__(.+?)__/g, "_$1_")
    .replace(/^#{1,6}\s+(.+)$/gm, "*$1*")
    .replace(/\[([^\]]+)\]\((https?:[^)]+)\)/g, "$1 ($2)")
    .trim();
}

/** Data, hora e dia da semana no fuso de Brasília. */
export function agoraEmBrasilia(agora: Date): { data: string; hora: string; diaSemana: number } {
  const partes = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: FUSO,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
      weekday: "short",
    })
      .formatToParts(agora)
      .map((p) => [p.type, p.value]),
  );
  const dias = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  return {
    data: `${partes.year}-${partes.month}-${partes.day}`,
    hora: `${partes.hour}:${partes.minute}`,
    diaSemana: dias.indexOf(partes.weekday ?? ""),
  };
}

interface Fala {
  papel: "usuario" | "maya";
  texto: string;
}

type RespostaMaya =
  | { tipo: "ok"; texto: string }
  /** Recusa do Azevedo OS com frase para a pessoa (Maya desativada, sem acesso). */
  | { tipo: "recusa"; texto: string }
  /** Telefone sem vínculo no Azevedo OS: fica calado. */
  | { tipo: "sem_vinculo" }
  | { tipo: "falha" };

interface ConversaDoGrupo {
  id: string;
  organizationId: string;
  whatsappInstanceId: string;
  externalChatId: string;
  type: string;
  title: string;
  customTitle: string | null;
  archivedAt: Date | null;
}

export class MayaWhatsappService {
  private timer: ReturnType<typeof setInterval> | null = null;
  private resumoRodando = false;
  /** Último dia (AAAA-MM-DD) em que o resumo saiu, para não repetir. */
  private ultimoResumo: string | null = null;
  private readonly filas = new Map<string, Promise<void>>();
  private readonly historicos = new Map<string, Fala[]>();

  constructor(
    private readonly prisma: PrismaClient,
    private readonly provider: WhatsAppProvider,
    private readonly io: Server,
    private readonly logger: Logger,
    private readonly config: MayaWhatsappConfig | null,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly relogio: () => Date = () => new Date(),
    /** Sem ele (testes antigos, IA não montada), áudio é ignorado como antes. */
    private readonly transcrever?: MayaAudioTranscriber,
  ) {}

  get enabled(): boolean {
    return this.config !== null;
  }

  /** Este é o grupo da Maya? Por JID quando configurado assim, senão pelo nome. */
  ehOGrupo(conversa: Pick<ConversaDoGrupo, "type" | "externalChatId" | "title" | "customTitle">): boolean {
    if (!this.config || conversa.type !== "group") return false;
    const alvo = this.config.grupo;
    if (alvo.endsWith("@g.us")) return conversa.externalChatId === alvo;
    const nome = alvo.toLocaleLowerCase("pt-BR");
    return [conversa.title, conversa.customTitle].some((t) => t?.trim().toLocaleLowerCase("pt-BR") === nome);
  }

  /**
   * Chamado pelo instance-manager para toda mensagem de ENTRADA nova. Nunca
   * lança e nunca espera: a ingestão não pode ficar presa a uma IA pensando.
   */
  onInboundMessage(input: {
    conversation: ConversaDoGrupo;
    senderPhone: string | null;
    content: string | null;
    /** A mensagem de áudio já gravada (com o arquivo no storage), ou null. */
    audio?: ReadableMessage | null;
  }): void {
    if (!this.config) return;
    const { conversation, senderPhone, content, audio } = input;
    if (!this.ehOGrupo(conversation) || conversation.archivedAt) return;
    const texto = content?.trim();
    const comAudio = !texto && audio && this.transcrever ? audio : null;
    if (!texto && !comAudio) return;
    const autorizado = telefoneCanonico(this.config.telefone);
    if (!autorizado || telefoneCanonico(senderPhone) !== autorizado) return;

    // Uma pergunta por vez por grupo: a segunda espera a primeira responder,
    // senão as respostas chegariam fora de ordem. O áudio entra na MESMA fila,
    // e a transcrição acontece já dentro dela, pelo mesmo motivo.
    const anterior = this.filas.get(conversation.id) ?? Promise.resolve();
    const proxima = anterior
      .then(() => (texto ? this.responder(conversation, texto) : this.responderAudio(conversation, comAudio!)))
      .catch((err: unknown) => {
        this.logger.error({ event: "maya_whatsapp_reply_failed", conversationId: conversation.id, error: String(err) });
      });
    this.filas.set(conversation.id, proxima);
    void proxima.finally(() => {
      if (this.filas.get(conversation.id) === proxima) this.filas.delete(conversation.id);
    });
  }

  start(): void {
    if (!this.config?.resumoHorario || this.timer) return;
    this.timer = setInterval(() => void this.tickResumo(), TICK_MS);
    this.logger.info({ event: "maya_whatsapp_resumo_started", horario: this.config.resumoHorario });
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Exposto para os testes; em produção é o `setInterval` que chama. */
  async tickResumo(): Promise<void> {
    const config = this.config;
    if (!config?.resumoHorario || this.resumoRodando) return;
    const agora = agoraEmBrasilia(this.relogio());
    if (!config.resumoDias.includes(agora.diaSemana)) return;
    // `>=` e não `===`: um restart às 08:00:30 não pode pular o dia.
    if (agora.hora < config.resumoHorario || this.ultimoResumo === agora.data) return;

    this.resumoRodando = true;
    try {
      const conversa = await this.acharGrupo();
      if (!conversa) {
        this.logger.warn({ event: "maya_whatsapp_group_not_found" });
        return;
      }
      // O processo pode ter reiniciado depois do envio de hoje: o banco é
      // quem diz se já saiu.
      const inicioDoDia = new Date(`${agora.data}T00:00:00-03:00`);
      const jaSaiu = await this.prisma.message.findFirst({
        where: {
          conversationId: conversa.id,
          direction: "outbound",
          senderName: SENDER_RESUMO,
          timestamp: { gte: inicioDoDia },
        },
        select: { id: true },
      });
      if (jaSaiu) {
        this.ultimoResumo = agora.data;
        return;
      }

      const r = await this.perguntar(config.telefone, config.resumoPergunta, []);
      if (r.tipo === "sem_vinculo") {
        this.logger.warn({ event: "maya_whatsapp_unknown_phone", conversationId: conversa.id });
        this.ultimoResumo = agora.data;
        return;
      }
      if (r.tipo === "falha") return; // tenta de novo no próximo minuto
      await this.enviar(conversa, r.texto, SENDER_RESUMO, "maya-resumo");
      this.ultimoResumo = agora.data;
    } catch (err) {
      this.logger.error({ event: "maya_whatsapp_resumo_failed", error: String(err) });
    } finally {
      this.resumoRodando = false;
    }
  }

  private async acharGrupo(): Promise<ConversaDoGrupo | null> {
    const config = this.config;
    if (!config) return null;
    const candidatas = await this.prisma.conversation.findMany({
      where: config.grupo.endsWith("@g.us")
        ? { type: "group", externalChatId: config.grupo, archivedAt: null }
        : { type: "group", archivedAt: null },
      select: {
        id: true,
        organizationId: true,
        whatsappInstanceId: true,
        externalChatId: true,
        type: true,
        title: true,
        customTitle: true,
        archivedAt: true,
      },
    });
    const achadas = candidatas.filter((c) => this.ehOGrupo(c));
    if (achadas.length > 1) {
      // Dois grupos com o mesmo nome: mandar o resumo para um deles no chute
      // é pior do que não mandar. O log diz o que fazer.
      this.logger.warn({ event: "maya_whatsapp_group_ambiguous", count: achadas.length });
      return null;
    }
    return achadas[0] ?? null;
  }

  private async responderAudio(conversa: ConversaDoGrupo, audio: ReadableMessage): Promise<void> {
    if (!this.transcrever) return;
    const r = await this.transcrever({
      organizationId: conversa.organizationId,
      conversationId: conversa.id,
      message: audio,
    });
    if (!r.ok) {
      this.logger.warn({ event: "maya_whatsapp_audio_unreadable", conversationId: conversa.id, motivo: r.motivo });
      await this.enviar(conversa, AVISO_AUDIO[r.motivo], SENDER_RESPOSTA, "maya");
      return;
    }
    await this.responder(conversa, r.text);
  }

  private async responder(conversa: ConversaDoGrupo, pergunta: string): Promise<void> {
    const config = this.config;
    if (!config) return;
    const historico = this.historicos.get(conversa.id) ?? [];
    const r = await this.perguntar(config.telefone, pergunta, historico);

    if (r.tipo === "sem_vinculo") {
      this.logger.warn({ event: "maya_whatsapp_unknown_phone", conversationId: conversa.id });
      return;
    }
    const texto =
      r.tipo === "falha" ? "Não consegui consultar a Maya agora. Tente de novo em instantes." : r.texto;
    await this.enviar(conversa, texto, SENDER_RESPOSTA, "maya");

    if (r.tipo === "ok") {
      const novo = [...historico, { papel: "usuario" as const, texto: pergunta }, { papel: "maya" as const, texto: r.texto }];
      this.historicos.set(conversa.id, novo.slice(-HISTORICO_MAXIMO));
    }
  }

  private async perguntar(telefone: string, pergunta: string, historico: Fala[]): Promise<RespostaMaya> {
    const config = this.config;
    if (!config) return { tipo: "falha" };
    let resposta: Response;
    try {
      resposta = await this.fetchImpl(config.url, {
        method: "POST",
        headers: {
          // O token só existe nesta linha: nunca vai para log nem para o banco.
          Authorization: `Bearer ${config.token}`,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({ telefone, pergunta, historico }),
        signal: AbortSignal.timeout(config.timeoutMs),
      });
    } catch (err) {
      this.logger.warn({ event: "maya_whatsapp_request_failed", error: String(err) });
      return { tipo: "falha" };
    }

    const corpo = (await resposta.json().catch(() => null)) as {
      resposta?: unknown;
      error?: { code?: unknown; message?: unknown };
    } | null;

    if (resposta.ok && typeof corpo?.resposta === "string") {
      return { tipo: "ok", texto: paraWhatsapp(corpo.resposta) };
    }
    if (resposta.status === 404 && corpo?.error?.code === "unknown_phone") return { tipo: "sem_vinculo" };
    if (resposta.status === 403 && typeof corpo?.error?.message === "string") {
      return { tipo: "recusa", texto: corpo.error.message };
    }
    this.logger.warn({ event: "maya_whatsapp_response_error", status: resposta.status });
    return { tipo: "falha" };
  }

  /** Mesmo caminho do envio da automação: provedor, banco, tempo real. */
  private async enviar(conversa: ConversaDoGrupo, texto: string, senderName: string, origem: string): Promise<void> {
    const result = await this.provider.sendText(conversa.whatsappInstanceId, conversa.externalChatId, texto);
    const message = await this.prisma.message.create({
      data: {
        organizationId: conversa.organizationId,
        conversationId: conversa.id,
        externalMessageId: result.externalMessageId,
        direction: "outbound",
        type: "text",
        content: texto,
        senderName,
        timestamp: result.timestamp,
        status: "sent",
        metadata: { origem },
      },
    });
    await this.prisma.conversation.update({
      where: { id: conversa.id },
      data: { lastMessageAt: result.timestamp, lastMessagePreview: buildPreview({ type: "text", content: texto }) },
    });

    try {
      const [conversation, persisted] = await Promise.all([
        this.prisma.conversation.findUnique({ where: { id: conversa.id }, include: conversationInclude }),
        this.prisma.message.findUnique({ where: { id: message.id } }),
      ]);
      if (!conversation || !persisted) return;
      const personName = await resolveConversationPersonName(this.prisma, conversa.organizationId, conversation);
      const room = conversationAudience(conversa.organizationId, conversation);
      this.io.to(room).emit(RealtimeEvents.MessageNew, {
        conversation: serializeConversation(conversation, personName),
        message: serializeMessage(persisted),
      });
      this.io.to(room).emit(RealtimeEvents.ConversationUpdated, serializeConversation(conversation, personName));
    } catch (err) {
      // A mensagem já saiu e está gravada; só não apareceu ao vivo.
      this.logger.warn({ event: "maya_whatsapp_realtime_failed", conversationId: conversa.id, error: String(err) });
    }
  }
}

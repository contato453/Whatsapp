import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  QUALITY_SETTINGS_LIMITS,
  QUALITY_SUBJECTS,
  isQualitySubject,
  readAiAttachmentInsightOf,
  type QualityAgentSummaryDto,
  type QualityAvailabilityDto,
  type QualityCriterionKey,
  type QualityEvaluationDto,
  type QualityRunDetailDto,
  type QualitySubject,
  type QualityTranscriptDto,
  QUALITY_CRITERIA_KEYS,
} from "@azvchat/shared";
import { z } from "zod";
import { authenticate } from "../../lib/auth.js";
import { AppError, NotFoundError } from "../../lib/errors.js";
import { loadQualitySettings, serializeQualitySettings } from "../../lib/quality/settings.js";
import {
  serializeQualityEvaluation,
  serializeQualityRun,
  serializeQualityRunItem,
} from "../../lib/serialize.js";
import { conversationDisplayTitle } from "../../lib/quality/title.js";
import { QualityAnalyzer } from "../../services/quality/analyzer.js";
import type { AppDeps } from "../../types.js";

/**
 * MÓDULO QUALITY — rotas.
 *
 * SIGILO TOTAL PARA QUEM NÃO É ADMIN, e isso é o desenho, não um detalhe de
 * implementação: o atendente não vê a avaliação dele, não vê que ela existe, e
 * não tem como descobrir que o recurso existe. Por isso a guarda é
 * `apenasAdmin`, que responde **404**, e não 403: "sem permissão" confirmaria o
 * recurso, e a diferença entre as duas respostas é justamente o que uma pessoa
 * curiosa leria.
 *
 * A guarda é FIXA no código, fora do catálogo de `PERMISSION_ACTIONS` — como
 * criar usuário, excluir número e a tela de Permissões. Uma chave por papel aqui
 * transformaria "só o dono vê" numa configuração que alguém pode afrouxar sem
 * perceber, e o módulo inteiro existe justamente sob a promessa de que ninguém
 * mais vê.
 *
 * Nada aqui encosta em `lib/access.ts`: visibilidade de conversa não mudou, e o
 * administrador já enxerga a organização inteira sem filtro.
 */

/** Sem IA configurada o módulo fica DESLIGADO: o menu some e as rotas recusam. */
const DISABLED_MESSAGE =
  "O módulo de qualidade depende da inteligência artificial, que ainda não está configurada nesta organização.";

async function apenasAdmin(request: FastifyRequest, _reply: FastifyReply): Promise<void> {
  await authenticate(request);
  if (request.user.role !== "admin") {
    // 404, nunca 403: a resposta não pode confirmar que o Quality existe.
    throw new NotFoundError("Recurso");
  }
}

const uuid = z.string().uuid();

export async function qualityRoutes(app: FastifyInstance, deps: AppDeps): Promise<void> {
  const analyzer = new QualityAnalyzer({
    prisma: deps.prisma,
    logger: deps.logger.child({ module: "quality" }),
    io: deps.io,
    storage: deps.storage,
    aiCipher: deps.aiCipher,
  });

  /** O módulo está de pé? É esta rota que decide o item de menu. */
  async function availability(organizationId: string): Promise<QualityAvailabilityDto> {
    const config = await deps.prisma.aiProviderConfig.findFirst({
      where: { organizationId, apiKeyEncrypted: { not: null } },
      select: { id: true },
    });
    return config ? { enabled: true, reason: null } : { enabled: false, reason: DISABLED_MESSAGE };
  }

  app.get("/quality/availability", { preHandler: apenasAdmin }, async (request) => ({
    availability: await availability(request.user.organizationId),
  }));

  app.get("/quality/settings", { preHandler: apenasAdmin }, async (request) => {
    const view = await loadQualitySettings(deps.prisma, request.user.organizationId);
    return { settings: serializeQualitySettings(view) };
  });

  app.put("/quality/settings", { preHandler: apenasAdmin }, async (request) => {
    const limits = QUALITY_SETTINGS_LIMITS;
    const body = z
      .object({
        maxConversationsPerRun: z
          .number()
          .int()
          .min(limits.maxConversationsPerRun.min)
          .max(limits.maxConversationsPerRun.max),
        maxAudioSeconds: z.number().int().min(limits.maxAudioSeconds.min).max(limits.maxAudioSeconds.max),
        minCoveragePercent: z
          .number()
          .int()
          .min(limits.minCoveragePercent.min)
          .max(limits.minCoveragePercent.max),
        model: z.string().trim().min(1).max(120).nullable(),
      })
      .parse(request.body);

    const saved = await deps.prisma.qualitySettings.upsert({
      where: { organizationId: request.user.organizationId },
      create: { ...body, organizationId: request.user.organizationId, updatedById: request.user.sub },
      update: { ...body, updatedById: request.user.sub },
    });
    deps.audit.record({
      organizationId: request.user.organizationId,
      userId: request.user.sub,
      action: "quality.settings_updated",
      entityType: "QualitySettings",
      entityId: saved.id,
      metadata: body,
      ip: request.ip,
    });
    return {
      settings: serializeQualitySettings({
        maxConversationsPerRun: saved.maxConversationsPerRun,
        maxAudioSeconds: saved.maxAudioSeconds,
        minCoveragePercent: saved.minCoveragePercent,
        model: saved.model,
        updatedAt: saved.updatedAt,
      }),
    };
  });

  /**
   * DISPARO. Manual, sempre: nada roda sozinho, e é isso que mantém o custo
   * sob controle. O teto de conversas é do banco, e acima dele a recusa diz o
   * número — mensagem clara, não um 400 genérico.
   */
  app.post("/quality/runs", { preHandler: apenasAdmin }, async (request) => {
    const body = z
      .object({
        conversationIds: z.array(uuid).min(1).max(QUALITY_SETTINGS_LIMITS.maxConversationsPerRun.max),
        from: z.coerce.date(),
        to: z.coerce.date(),
      })
      .parse(request.body);

    const disponivel = await availability(request.user.organizationId);
    if (!disponivel.enabled) throw new AppError(DISABLED_MESSAGE, 409, "quality_disabled");

    if (body.to.getTime() <= body.from.getTime()) {
      throw new AppError("O fim do período precisa ser depois do início.", 400, "validation_error");
    }

    const settings = await loadQualitySettings(deps.prisma, request.user.organizationId);
    const ids = [...new Set(body.conversationIds)];
    if (ids.length > settings.maxConversationsPerRun) {
      throw new AppError(
        `Cada análise aceita no máximo ${settings.maxConversationsPerRun} conversas, e foram selecionadas ${ids.length}. Reduza a seleção ou aumente o limite nas configurações do módulo.`,
        400,
        "quality_run_limit",
      );
    }

    // O administrador enxerga a organização inteira, então a conferência aqui é
    // de EXISTÊNCIA na organização — não de alcance. Conversa de outra
    // organização simplesmente não é encontrada.
    const conversations = await deps.prisma.conversation.findMany({
      where: { id: { in: ids }, organizationId: request.user.organizationId },
      select: { id: true },
    });
    if (conversations.length === 0) throw new NotFoundError("Conversa");

    const provider = await deps.prisma.aiProviderConfig.findFirst({
      where: { organizationId: request.user.organizationId, apiKeyEncrypted: { not: null } },
      select: { defaultModel: true },
    });
    const model = settings.model ?? provider?.defaultModel ?? "gpt-4.1-mini";

    const run = await deps.prisma.qualityRun.create({
      data: {
        organizationId: request.user.organizationId,
        periodFrom: body.from,
        periodTo: body.to,
        requestedById: request.user.sub,
        requestedByName: request.user.name,
        model,
        conversationCount: conversations.length,
        items: {
          create: conversations.map((conversation) => ({
            organizationId: request.user.organizationId,
            conversationId: conversation.id,
          })),
        },
      },
    });

    deps.audit.record({
      organizationId: request.user.organizationId,
      userId: request.user.sub,
      action: "quality.analysis_requested",
      entityType: "QualityRun",
      entityId: run.id,
      metadata: {
        conversationIds: conversations.map((conversation) => conversation.id),
        periodFrom: body.from.toISOString(),
        periodTo: body.to.toISOString(),
        model,
      },
      ip: request.ip,
    });

    // Assíncrono de propósito: transcrever e avaliar levam minutos, e a tela não
    // pode ficar presa numa requisição esperando. O estado vive no banco, então
    // fechar o navegador (ou reiniciar o processo) não perde o registro do que
    // foi pedido.
    void analyzer.run(run.id);

    return { run: serializeQualityRun(run) };
  });

  app.get("/quality/runs", { preHandler: apenasAdmin }, async (request) => {
    const query = z.object({ limit: z.coerce.number().int().min(1).max(100).default(30) }).parse(request.query);
    const runs = await deps.prisma.qualityRun.findMany({
      where: { organizationId: request.user.organizationId },
      orderBy: { createdAt: "desc" },
      take: query.limit,
    });
    return { runs: runs.map(serializeQualityRun) };
  });

  app.get("/quality/runs/:id", { preHandler: apenasAdmin }, async (request) => {
    const params = z.object({ id: uuid }).parse(request.params);
    const run = await deps.prisma.qualityRun.findFirst({
      where: { id: params.id, organizationId: request.user.organizationId },
      include: {
        items: {
          orderBy: { createdAt: "asc" },
          include: {
            conversation: { select: { id: true, title: true, customTitle: true } },
            evaluations: { orderBy: { createdAt: "asc" } },
          },
        },
      },
    });
    if (!run) throw new NotFoundError("Análise");

    const detail: QualityRunDetailDto = {
      ...serializeQualityRun(run),
      items: run.items.map((item) => {
        const titulo = conversationDisplayTitle(item.conversation);
        return serializeQualityRunItem(
          item,
          titulo,
          item.evaluations.map((evaluation) => serializeQualityEvaluation(evaluation, titulo)),
        );
      }),
    };
    return { run: detail };
  });

  /**
   * As transcrições dos áudios do período de uma conversa da análise.
   *
   * ÍNTEGRAS, sem máscara: é conteúdo da conversa, que o administrador já pode
   * ler abrindo o chat. A máscara existe para o que SAI para a IA, não para o
   * que o dono do escritório vê da própria operação.
   */
  app.get("/quality/runs/:id/items/:itemId/transcripts", { preHandler: apenasAdmin }, async (request) => {
    const params = z.object({ id: uuid, itemId: uuid }).parse(request.params);
    const item = await deps.prisma.qualityRunItem.findFirst({
      where: { id: params.itemId, runId: params.id, organizationId: request.user.organizationId },
      include: { run: { select: { periodFrom: true, periodTo: true } } },
    });
    if (!item) throw new NotFoundError("Conversa da análise");

    const messages = await deps.prisma.message.findMany({
      where: {
        conversationId: item.conversationId,
        type: "audio",
        deletedAt: null,
        timestamp: { gte: item.run.periodFrom, lte: item.run.periodTo },
      },
      orderBy: { timestamp: "asc" },
      select: { id: true, timestamp: true, direction: true, metadata: true },
    });

    const transcripts: QualityTranscriptDto[] = messages.map((message) => {
      const insight = readAiAttachmentInsightOf("audio", message.metadata);
      return {
        messageId: message.id,
        at: message.timestamp.toISOString(),
        direction: message.direction as "inbound" | "outbound",
        durationSeconds: readDurationSeconds(message.metadata),
        status: insight?.status ?? "no_file",
        text: insight?.status === "ok" ? insight.text : null,
      };
    });
    return { transcripts };
  });

  app.get("/quality/evaluations", { preHandler: apenasAdmin }, async (request) => {
    const query = z
      .object({
        userId: uuid.optional(),
        subject: z.enum(QUALITY_SUBJECTS).optional(),
        from: z.coerce.date().optional(),
        to: z.coerce.date().optional(),
        minScore: z.coerce.number().min(0).max(10).optional(),
        maxScore: z.coerce.number().min(0).max(10).optional(),
        includeDiscarded: z.coerce.boolean().optional(),
        limit: z.coerce.number().int().min(1).max(200).default(100),
      })
      .parse(request.query);

    const evaluations = await deps.prisma.qualityEvaluation.findMany({
      where: {
        organizationId: request.user.organizationId,
        ...(query.userId ? { userId: query.userId } : {}),
        ...(query.subject ? { subject: query.subject } : {}),
        ...(query.from || query.to
          ? { createdAt: { ...(query.from ? { gte: query.from } : {}), ...(query.to ? { lte: query.to } : {}) } }
          : {}),
        ...(query.minScore != null || query.maxScore != null
          ? {
              overallScore: {
                ...(query.minScore != null ? { gte: query.minScore } : {}),
                ...(query.maxScore != null ? { lte: query.maxScore } : {}),
              },
            }
          : {}),
        // Descartada fica de fora por padrão: ela foi descartada justamente para
        // não pesar na leitura. Continua no banco, e o filtro a traz de volta.
        ...(query.includeDiscarded ? {} : { discardedAt: null }),
      },
      orderBy: { createdAt: "desc" },
      take: query.limit,
      include: { conversation: { select: { id: true, title: true, customTitle: true } } },
    });

    return {
      evaluations: evaluations.map((evaluation) =>
        serializeQualityEvaluation(evaluation, conversationDisplayTitle(evaluation.conversation)),
      ),
    };
  });

  /**
   * DESCARTE. Não apaga a linha, e o comentário do administrador NUNCA altera a
   * nota: ela é da IA, por decisão do desenho. Comentário que mexesse na nota
   * transformaria o painel em opinião assinada por um número que a IA deu.
   */
  app.post("/quality/evaluations/:id/discard", { preHandler: apenasAdmin }, async (request) => {
    const params = z.object({ id: uuid }).parse(request.params);
    const body = z.object({ comment: z.string().trim().max(2000).optional() }).parse(request.body ?? {});
    const evaluation = await deps.prisma.qualityEvaluation.findFirst({
      where: { id: params.id, organizationId: request.user.organizationId },
      select: { id: true, userId: true },
    });
    if (!evaluation) throw new NotFoundError("Avaliação");

    const saved = await deps.prisma.qualityEvaluation.update({
      where: { id: evaluation.id },
      data: {
        discardedAt: new Date(),
        discardedByUserId: request.user.sub,
        ...(body.comment !== undefined ? { adminComment: body.comment || null } : {}),
      },
      include: { conversation: { select: { id: true, title: true, customTitle: true } } },
    });
    deps.audit.record({
      organizationId: request.user.organizationId,
      userId: request.user.sub,
      action: "quality.evaluation_discarded",
      entityType: "QualityEvaluation",
      entityId: saved.id,
      metadata: { conversationId: saved.conversationId, evaluatedUserId: evaluation.userId },
      ip: request.ip,
    });
    return { evaluation: serializeQualityEvaluation(saved, conversationDisplayTitle(saved.conversation)) };
  });

  app.post("/quality/evaluations/:id/restore", { preHandler: apenasAdmin }, async (request) => {
    const params = z.object({ id: uuid }).parse(request.params);
    const evaluation = await deps.prisma.qualityEvaluation.findFirst({
      where: { id: params.id, organizationId: request.user.organizationId },
      select: { id: true },
    });
    if (!evaluation) throw new NotFoundError("Avaliação");
    const saved = await deps.prisma.qualityEvaluation.update({
      where: { id: evaluation.id },
      data: { discardedAt: null, discardedByUserId: null },
      include: { conversation: { select: { id: true, title: true, customTitle: true } } },
    });
    deps.audit.record({
      organizationId: request.user.organizationId,
      userId: request.user.sub,
      action: "quality.evaluation_restored",
      entityType: "QualityEvaluation",
      entityId: saved.id,
      ip: request.ip,
    });
    return { evaluation: serializeQualityEvaluation(saved, conversationDisplayTitle(saved.conversation)) };
  });

  app.patch("/quality/evaluations/:id/comment", { preHandler: apenasAdmin }, async (request) => {
    const params = z.object({ id: uuid }).parse(request.params);
    const body = z.object({ comment: z.string().trim().max(2000) }).parse(request.body);
    const evaluation = await deps.prisma.qualityEvaluation.findFirst({
      where: { id: params.id, organizationId: request.user.organizationId },
      select: { id: true },
    });
    if (!evaluation) throw new NotFoundError("Avaliação");
    const saved = await deps.prisma.qualityEvaluation.update({
      where: { id: evaluation.id },
      // A nota NÃO entra neste update, e é de propósito: o comentário é registro
      // do administrador ao lado da avaliação, nunca por cima dela.
      data: { adminComment: body.comment || null },
      include: { conversation: { select: { id: true, title: true, customTitle: true } } },
    });
    return { evaluation: serializeQualityEvaluation(saved, conversationDisplayTitle(saved.conversation)) };
  });

  /**
   * VISÃO POR ATENDENTE: média ao longo do tempo, assuntos mais frequentes e os
   * pontos a melhorar que mais se repetem. Agregado aqui, no servidor, pela
   * mesma razão das contas do CRM: duas médias calculadas em lugares diferentes
   * divergiriam por arredondamento, e "o total não bate" é como um painel perde
   * a confiança de quem o lê.
   */
  app.get("/quality/agents", { preHandler: apenasAdmin }, async (request) => {
    const query = z
      .object({ from: z.coerce.date().optional(), to: z.coerce.date().optional() })
      .parse(request.query);

    const evaluations = await deps.prisma.qualityEvaluation.findMany({
      where: {
        organizationId: request.user.organizationId,
        discardedAt: null,
        ...(query.from || query.to
          ? { createdAt: { ...(query.from ? { gte: query.from } : {}), ...(query.to ? { lte: query.to } : {}) } }
          : {}),
      },
      orderBy: { createdAt: "asc" },
      include: { conversation: { select: { id: true, title: true, customTitle: true } } },
    });

    return { agents: foldQualityAgents(evaluations.map((row) => serializeQualityEvaluation(row, conversationDisplayTitle(row.conversation)))) };
  });
}

/** Duração que o WhatsApp mandou, gravada pela ingestão. */
function readDurationSeconds(metadata: unknown): number | null {
  if (!metadata || typeof metadata !== "object") return null;
  const value = (metadata as Record<string, unknown>).durationSeconds;
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

/**
 * Dobra as avaliações em uma linha por atendente. Função pura, exportada para o
 * teste: é ela que decide a média que o dono do escritório lê.
 */
export function foldQualityAgents(evaluations: QualityEvaluationDto[]): QualityAgentSummaryDto[] {
  interface Bucket {
    userId: string | null;
    userName: string;
    total: number;
    sum: number;
    byCriterion: Map<QualityCriterionKey, { sum: number; total: number }>;
    byMonth: Map<string, { sum: number; total: number }>;
    subjects: Map<QualitySubject, number>;
    improvements: Map<string, number>;
  }
  const buckets = new Map<string, Bucket>();

  for (const evaluation of evaluations) {
    // Atendente removido do cadastro (userId nulo) é agrupado pelo NOME copiado:
    // apagar a pessoa não pode apagar o histórico que o administrador guarda.
    const key = evaluation.userId ?? `nome:${evaluation.userName}`;
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = {
        userId: evaluation.userId,
        userName: evaluation.userName,
        total: 0,
        sum: 0,
        byCriterion: new Map(),
        byMonth: new Map(),
        subjects: new Map(),
        improvements: new Map(),
      };
      buckets.set(key, bucket);
    }
    bucket.total += 1;
    bucket.sum += evaluation.overallScore;

    for (const criterion of evaluation.criteria) {
      const current = bucket.byCriterion.get(criterion.key) ?? { sum: 0, total: 0 };
      current.sum += criterion.score;
      current.total += 1;
      bucket.byCriterion.set(criterion.key, current);
    }

    const month = evaluation.createdAt.slice(0, 7);
    const monthly = bucket.byMonth.get(month) ?? { sum: 0, total: 0 };
    monthly.sum += evaluation.overallScore;
    monthly.total += 1;
    bucket.byMonth.set(month, monthly);

    if (isQualitySubject(evaluation.subject)) {
      bucket.subjects.set(evaluation.subject, (bucket.subjects.get(evaluation.subject) ?? 0) + 1);
    }

    for (const improvement of evaluation.actionPlan.improvements) {
      // Agrupa por ponto normalizado (minúsculas, sem pontuação final): a IA
      // escreve a mesma recomendação com palavras ligeiramente diferentes, e sem
      // normalizar nada se repetiria o suficiente para virar "mais frequente".
      const normalized = improvement.point.trim().toLowerCase().replace(/[.!?]+$/, "");
      if (!normalized) continue;
      bucket.improvements.set(normalized, (bucket.improvements.get(normalized) ?? 0) + 1);
    }
  }

  const round = (value: number): number => Math.round(value * 10) / 10;

  return [...buckets.values()]
    .map((bucket): QualityAgentSummaryDto => ({
      userId: bucket.userId,
      userName: bucket.userName,
      evaluations: bucket.total,
      averageScore: round(bucket.sum / bucket.total),
      averageByCriterion: QUALITY_CRITERIA_KEYS.flatMap((key) => {
        const current = bucket.byCriterion.get(key);
        return current && current.total > 0 ? [{ key, score: round(current.sum / current.total) }] : [];
      }),
      timeline: [...bucket.byMonth.entries()]
        .sort(([a], [b]) => (a < b ? -1 : 1))
        .map(([month, value]) => ({ month, score: round(value.sum / value.total), evaluations: value.total })),
      subjects: [...bucket.subjects.entries()]
        .map(([subject, total]) => ({ subject, total }))
        .sort((a, b) => b.total - a.total),
      recurringImprovements: [...bucket.improvements.entries()]
        .map(([point, total]) => ({ point, total }))
        .sort((a, b) => b.total - a.total)
        .slice(0, 8),
    }))
    .sort((a, b) => a.userName.localeCompare(b.userName, "pt-BR"));
}

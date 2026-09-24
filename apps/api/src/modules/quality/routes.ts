import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  AI_DEFAULT_MODEL,
  QUALITY_SETTINGS_LIMITS,
  QUALITY_SUBJECTS,
  readAiAttachmentInsightOf,
  type QualityAvailabilityDto,
  type QualityRunDetailDto,
  type QualityTranscriptDto,
} from "@azvchat/shared";
import { z } from "zod";
import type { Prisma } from "@azvchat/database";
import { conversationScope, loadConversationAccess } from "../../lib/access.js";
import { loadAttendanceSettings } from "../../lib/attendance-settings.js";
import { conversationInclude } from "../../lib/conversation-events.js";
import { scanOverdueConversations } from "../../lib/overdue.js";
import { resolveConversationPersonNames } from "../../lib/person-profile.js";
import { authenticate } from "../../lib/auth.js";
import { loadPermissions } from "../../lib/permissions.js";
import { AppError, NotFoundError } from "../../lib/errors.js";
import { loadQualitySettings, serializeQualitySettings } from "../../lib/quality/settings.js";
import {
  serializeConversation,
  serializeQualityEvaluation,
  serializeQualityRun,
  serializeQualityRunItem,
} from "../../lib/serialize.js";
import {
  QUALITY_CONVERSATION_SELECT,
  type QualityConversationRef,
  resolveQualityTitles,
} from "../../lib/quality/title.js";
import { foldQualityAgents, foldQualityDepartments } from "../../lib/quality/fold.js";
import { QualityAnalyzer } from "../../services/quality/analyzer.js";
import type { AppDeps } from "../../types.js";

// Reexportado porque o fold saiu daqui para `lib/quality/fold.ts` quando a
// leitura por setor passou a somar as MESMAS avaliações: quem já o
// importava deste módulo continua funcionando.
export { foldQualityAgents, foldQualityDepartments };

/**
 * MÓDULO QUALITY — rotas.
 *
 * SIGILO TOTAL PARA QUEM NÃO TEM A CHAVE, e isso é o desenho, não um detalhe
 * de implementação: o atendente não vê a avaliação dele, não vê que ela
 * existe, e não tem como descobrir que o recurso existe. Por isso a guarda
 * (`guardaQuality`) responde **404**, e não 403: "sem permissão" confirmaria o
 * recurso, e a diferença entre as duas respostas é justamente o que uma pessoa
 * curiosa leria.
 *
 * O módulo nasceu fixo em admin. Com o papel Gerente ele virou a chave
 * `quality.use` do catálogo (padrão: Gerente sim, Supervisor e Usuário não),
 * e a guarda continua sendo UMA só, na frente de toda rota daqui, esconder o
 * menu e recusar a rota saem da mesma chave.
 *
 * A CHAVE DÁ A AÇÃO, NUNCA O ALCANCE. O administrador enxerga a organização
 * inteira; quem chega aqui pela chave só dispara análise e só lê disparo,
 * avaliação e transcrição de conversa que `conversationScope` já lhe mostra.
 * Sem isso o Quality viraria a porta dos fundos de `lib/access.ts`: as
 * transcrições saem ÍNTEGRAS, e bastaria a chave para ler conversa de
 * departamento que o gerente não tem.
 */

/** Sem IA configurada o módulo fica DESLIGADO: o menu some e as rotas recusam. */
const DISABLED_MESSAGE =
  "O módulo de qualidade depende da inteligência artificial, que ainda não está configurada nesta organização.";

function guardaQuality(deps: AppDeps) {
  return async (request: FastifyRequest, _reply: FastifyReply): Promise<void> => {
    await authenticate(request);
    const permissions = await loadPermissions(deps.prisma, request.user);
    if (!permissions.can("quality.use")) {
      // 404, nunca 403: a resposta não pode confirmar que o Quality existe.
      throw new NotFoundError("Recurso");
    }
  };
}

/**
 * O recorte de conversas de quem está pedindo, pela régua de sempre. Vazio
 * para o administrador (que enxerga tudo), e o mesmo filtro da Inbox para os
 * demais.
 */
async function escopoDeConversa(
  deps: AppDeps,
  request: FastifyRequest,
): Promise<Prisma.ConversationWhereInput> {
  return conversationScope(await loadConversationAccess(deps.prisma, request.user));
}

const uuid = z.string().uuid();

/**
 * Lista de ids: parâmetro REPETIDO ou separado por vírgula, como na Inbox e no
 * Dashboard. Vazia significa "todos", nunca "nenhum".
 */
const listaDeUuid = z
  .union([uuid, z.array(uuid), z.string()])
  .optional()
  .transform((value): string[] => {
    if (!value) return [];
    const bruto = Array.isArray(value) ? value : value.split(",");
    return [...new Set(bruto.map((item) => item.trim()).filter(Boolean))];
  })
  .pipe(z.array(uuid));

export async function qualityRoutes(app: FastifyInstance, deps: AppDeps): Promise<void> {
  const guarda = guardaQuality(deps);
  const analyzer = new QualityAnalyzer({
    prisma: deps.prisma,
    logger: deps.logger.child({ module: "quality" }),
    // `deps.io` ainda é undefined aqui (ver o comentário em QualityAnalyzerDeps):
    // o socket nasce depois de buildApp. A função adia a leitura para a emissão.
    io: () => deps.io,
    storage: deps.storage,
    aiCipher: deps.aiCipher,
  });

  /**
   * O nome de UMA conversa, para as três rotas que devolvem uma avaliação só
   * (descartar, restaurar, comentar). Passa pelo mesmo resolvedor das listas em
   * vez de recortar a cadeia: são ações raras de administrador, e uma régua
   * própria aqui faria a mesma conversa trocar de nome ao ser descartada.
   */
  async function tituloDaConversa(
    organizationId: string,
    conversation: QualityConversationRef | null,
  ): Promise<string | null> {
    if (!conversation) return null;
    const titulos = await resolveQualityTitles(deps.prisma, organizationId, [conversation]);
    return titulos.get(conversation.id) ?? null;
  }

  /** O módulo está de pé? É esta rota que decide o item de menu. */
  async function availability(organizationId: string): Promise<QualityAvailabilityDto> {
    const config = await deps.prisma.aiProviderConfig.findFirst({
      where: { organizationId, apiKeyEncrypted: { not: null } },
      select: { id: true },
    });
    return config ? { enabled: true, reason: null } : { enabled: false, reason: DISABLED_MESSAGE };
  }

  app.get("/quality/availability", { preHandler: guarda }, async (request) => ({
    availability: await availability(request.user.organizationId),
  }));

  app.get("/quality/settings", { preHandler: guarda }, async (request) => {
    const view = await loadQualitySettings(deps.prisma, request.user.organizationId);
    return { settings: serializeQualitySettings(view) };
  });

  app.put("/quality/settings", { preHandler: guarda }, async (request) => {
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
  app.post("/quality/runs", { preHandler: guarda }, async (request) => {
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

    // Existência na organização E alcance de quem pede. Para o administrador o
    // escopo é vazio (ele enxerga tudo); para quem chega pela chave, conversa
    // fora do recorte dele conta como não encontrada, a mesma resposta de
    // conversa inexistente, para a recusa não confirmar o que ele não vê.
    const conversations = await deps.prisma.conversation.findMany({
      where: {
        AND: [
          { id: { in: ids }, organizationId: request.user.organizationId },
          await escopoDeConversa(deps, request),
        ],
      },
      select: { id: true },
    });
    // Id que não existe é RECUSADO, nunca ignorado — a mesma regra dos filtros
    // da Inbox. Descartar em silêncio analisaria um conjunto menor do que o que
    // a pessoa marcou, e o relatório sairia plausível e errado.
    if (conversations.length !== ids.length) {
      const faltando = ids.length - conversations.length;
      throw new AppError(
        `${faltando} ${faltando === 1 ? "conversa selecionada não foi encontrada" : "conversas selecionadas não foram encontradas"}. Recarregue a tela e escolha de novo.`,
        400,
        "quality_conversation_not_found",
      );
    }

    const provider = await deps.prisma.aiProviderConfig.findFirst({
      where: { organizationId: request.user.organizationId, apiKeyEncrypted: { not: null } },
      select: { defaultModel: true },
    });
    const model = settings.model ?? provider?.defaultModel ?? AI_DEFAULT_MODEL;

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

  app.get("/quality/runs", { preHandler: guarda }, async (request) => {
    const query = z.object({ limit: z.coerce.number().int().min(1).max(100).default(30) }).parse(request.query);
    const runs = await deps.prisma.qualityRun.findMany({
      where: {
        organizationId: request.user.organizationId,
        // Disparo aparece só quando TODAS as conversas dele estão no alcance:
        // um disparo do administrador que misture uma conversa de fora mostraria
        // o nome dela na linha, e o detalhe, a nota.
        items: { every: { conversation: await escopoDeConversa(deps, request) } },
      },
      orderBy: { createdAt: "desc" },
      take: query.limit,
      // O nome de cada conversa vem JUNTO: sem ele a lista só diria "1
      // conversa", e os quatro grupos "Demandas CS" do escritório seriam
      // quatro linhas idênticas. É uma junção, nunca uma consulta por linha.
      include: {
        items: {
          orderBy: { createdAt: "asc" },
          select: { conversation: { select: QUALITY_CONVERSATION_SELECT } },
        },
      },
    });
    const titulos = await resolveQualityTitles(
      deps.prisma,
      request.user.organizationId,
      runs.flatMap((run) => run.items.map((item) => item.conversation)),
    );
    return {
      runs: runs.map((run) =>
        serializeQualityRun(
          run,
          // Conversa excluída do cadastro sai da lista de nomes em vez de virar
          // um buraco: o contador continua dizendo quantas foram analisadas.
          run.items
            .map((item) => (item.conversation ? titulos.get(item.conversation.id) : null))
            .filter((titulo): titulo is string => Boolean(titulo)),
        ),
      ),
    };
  });

  app.get("/quality/runs/:id", { preHandler: guarda }, async (request) => {
    const params = z.object({ id: uuid }).parse(request.params);
    const run = await deps.prisma.qualityRun.findFirst({
      where: {
        id: params.id,
        organizationId: request.user.organizationId,
        items: { every: { conversation: await escopoDeConversa(deps, request) } },
      },
      include: {
        items: {
          orderBy: { createdAt: "asc" },
          include: {
            conversation: { select: QUALITY_CONVERSATION_SELECT },
            evaluations: { orderBy: { createdAt: "asc" } },
          },
        },
      },
    });
    if (!run) throw new NotFoundError("Análise");

    const titulos = await resolveQualityTitles(
      deps.prisma,
      request.user.organizationId,
      run.items.map((item) => item.conversation),
    );
    const nomeDe = (item: (typeof run.items)[number]): string | null =>
      item.conversation ? (titulos.get(item.conversation.id) ?? null) : null;

    const detail: QualityRunDetailDto = {
      ...serializeQualityRun(
        run,
        run.items.map(nomeDe).filter((titulo): titulo is string => Boolean(titulo)),
      ),
      items: run.items.map((item) => {
        const titulo = nomeDe(item);
        return serializeQualityRunItem(
          item,
          titulo,
          item.evaluations.map((evaluation) => serializeQualityEvaluation(evaluation, titulo, run)),
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
  app.get("/quality/runs/:id/items/:itemId/transcripts", { preHandler: guarda }, async (request) => {
    const params = z.object({ id: uuid, itemId: uuid }).parse(request.params);
    const item = await deps.prisma.qualityRunItem.findFirst({
      where: {
        id: params.itemId,
        runId: params.id,
        organizationId: request.user.organizationId,
        // As transcrições saem ÍNTEGRAS: é aqui que o alcance mais importa.
        conversation: await escopoDeConversa(deps, request),
      },
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

  app.get("/quality/evaluations", { preHandler: guarda }, async (request) => {
    const query = z
      .object({
        userId: uuid.optional(),
        /**
         * `none` é "sem departamento", como no Dashboard e na Inbox — e não a
         * ausência do filtro. O recorte é sobre o departamento COPIADO na
         * avaliação, nunca o de agora: ver `QualityEvaluation.departmentId`.
         */
        departmentId: z.union([uuid, z.literal("none")]).optional(),
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
        conversation: await escopoDeConversa(deps, request),
        ...(query.userId ? { userId: query.userId } : {}),
        ...departamentoWhere(query.departmentId),
        ...(query.subject ? { subject: query.subject } : {}),
        // O recorte de data é sobre o PERÍODO AVALIADO (o do disparo), e não
        // sobre quando a IA leu: perguntar "como foi o atendimento em agosto"
        // não pode depender do dia em que alguém clicou em analisar.
        ...(query.from || query.to
          ? {
              run: {
                is: {
                  ...(query.from ? { periodTo: { gte: query.from } } : {}),
                  ...(query.to ? { periodFrom: { lte: query.to } } : {}),
                },
              },
            }
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
      include: {
        conversation: { select: QUALITY_CONVERSATION_SELECT },
        run: { select: { periodFrom: true, periodTo: true } },
      },
    });

    const titulos = await resolveQualityTitles(
      deps.prisma,
      request.user.organizationId,
      evaluations.map((evaluation) => evaluation.conversation),
    );
    return {
      evaluations: evaluations.map((evaluation) =>
        serializeQualityEvaluation(
          evaluation,
          evaluation.conversation ? (titulos.get(evaluation.conversation.id) ?? null) : null,
          evaluation.run,
        ),
      ),
    };
  });

  /**
   * DESCARTE. Não apaga a linha, e o comentário do administrador NUNCA altera a
   * nota: ela é da IA, por decisão do desenho. Comentário que mexesse na nota
   * transformaria o painel em opinião assinada por um número que a IA deu.
   */
  app.post("/quality/evaluations/:id/discard", { preHandler: guarda }, async (request) => {
    const params = z.object({ id: uuid }).parse(request.params);
    const body = z.object({ comment: z.string().trim().max(2000).optional() }).parse(request.body ?? {});
    const evaluation = await deps.prisma.qualityEvaluation.findFirst({
      where: {
        id: params.id,
        organizationId: request.user.organizationId,
        conversation: await escopoDeConversa(deps, request),
      },
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
      include: {
        conversation: { select: QUALITY_CONVERSATION_SELECT },
        run: { select: { periodFrom: true, periodTo: true } },
      },
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
    return {
      evaluation: serializeQualityEvaluation(
        saved,
        await tituloDaConversa(request.user.organizationId, saved.conversation),
        saved.run,
      ),
    };
  });

  app.post("/quality/evaluations/:id/restore", { preHandler: guarda }, async (request) => {
    const params = z.object({ id: uuid }).parse(request.params);
    const evaluation = await deps.prisma.qualityEvaluation.findFirst({
      where: {
        id: params.id,
        organizationId: request.user.organizationId,
        conversation: await escopoDeConversa(deps, request),
      },
      select: { id: true },
    });
    if (!evaluation) throw new NotFoundError("Avaliação");
    const saved = await deps.prisma.qualityEvaluation.update({
      where: { id: evaluation.id },
      data: { discardedAt: null, discardedByUserId: null },
      include: {
        conversation: { select: QUALITY_CONVERSATION_SELECT },
        run: { select: { periodFrom: true, periodTo: true } },
      },
    });
    deps.audit.record({
      organizationId: request.user.organizationId,
      userId: request.user.sub,
      action: "quality.evaluation_restored",
      entityType: "QualityEvaluation",
      entityId: saved.id,
      ip: request.ip,
    });
    return {
      evaluation: serializeQualityEvaluation(
        saved,
        await tituloDaConversa(request.user.organizationId, saved.conversation),
        saved.run,
      ),
    };
  });

  app.patch("/quality/evaluations/:id/comment", { preHandler: guarda }, async (request) => {
    const params = z.object({ id: uuid }).parse(request.params);
    const body = z.object({ comment: z.string().trim().max(2000) }).parse(request.body);
    const evaluation = await deps.prisma.qualityEvaluation.findFirst({
      where: {
        id: params.id,
        organizationId: request.user.organizationId,
        conversation: await escopoDeConversa(deps, request),
      },
      select: { id: true },
    });
    if (!evaluation) throw new NotFoundError("Avaliação");
    const saved = await deps.prisma.qualityEvaluation.update({
      where: { id: evaluation.id },
      // A nota NÃO entra neste update, e é de propósito: o comentário é registro
      // do administrador ao lado da avaliação, nunca por cima dela.
      data: { adminComment: body.comment || null },
      include: {
        conversation: { select: QUALITY_CONVERSATION_SELECT },
        run: { select: { periodFrom: true, periodTo: true } },
      },
    });
    return {
      evaluation: serializeQualityEvaluation(
        saved,
        await tituloDaConversa(request.user.organizationId, saved.conversation),
        saved.run,
      ),
    };
  });

  /**
   * VISÃO POR ATENDENTE: média ao longo do tempo, assuntos mais frequentes e os
   * pontos a melhorar que mais se repetem. Agregado aqui, no servidor, pela
   * mesma razão das contas do CRM: duas médias calculadas em lugares diferentes
   * divergiriam por arredondamento, e "o total não bate" é como um painel perde
   * a confiança de quem o lê.
   */
  /**
   * CANDIDATAS DO PERÍODO — o disparo por setor, sem marcar conversa a conversa.
   *
   * A pergunta do dono do escritório é "como o CS foi em agosto", e montá-la
   * na mão significava filtrar o seletor e marcar 20 linhas. Aqui ele escolhe
   * setor e período, e a rota devolve as conversas que REALMENTE entrariam.
   *
   * O recorte não é "as conversas do setor": é **as que têm mensagem de um
   * atendente no período**, que é a mesma condição que o analisador aplica
   * antes de avaliar (`no_agent_messages`). Sem isso, metade do teto seria
   * gasto com conversa que o disparo iria pular — o custo é pago na seleção, e
   * a recusa apareceria só depois, na tela de análises.
   *
   * `userId` filtra por **quem respondeu**, e não por quem é o responsável do
   * card: a avaliação é sobre o atendimento prestado, e a conversa em que a
   * Damiana escreveu durante as férias de outra pessoa é trabalho dela.
   *
   * A rota só LISTA. Quem dispara continua sendo `POST /quality/runs`, com os
   * ids que a tela mostrou — a pessoa vê o que vai ser analisado antes de
   * gastar, do mesmo jeito que a prévia do anexo existe antes do envio.
   */
  app.get("/quality/candidates", { preHandler: guarda }, async (request) => {
    const query = z
      .object({
        from: z.coerce.date(),
        to: z.coerce.date(),
        departmentId: z.union([uuid, z.literal("none")]).optional(),
        instanceId: listaDeUuid,
        /** Quem RESPONDEU no período, não o responsável do card. */
        userId: uuid.optional(),
        onlyOverdue: z.coerce.boolean().optional(),
        limit: z.coerce.number().int().min(1).max(QUALITY_SETTINGS_LIMITS.maxConversationsPerRun.max).optional(),
      })
      .parse(request.query);

    if (query.to.getTime() <= query.from.getTime()) {
      throw new AppError("O fim do período precisa ser depois do início.", 400, "validation_error");
    }

    const settings = await loadQualitySettings(deps.prisma, request.user.organizationId);
    const limit = query.limit ?? settings.maxConversationsPerRun;

    const filtros: Prisma.ConversationWhereInput[] = [
      await escopoDeConversa(deps, request),
      // Arquivada fica de fora, como em toda contagem e listagem da casa.
      { archivedAt: null },
      ...(query.departmentId
        ? [{ departmentId: query.departmentId === "none" ? null : query.departmentId }]
        : []),
      ...(query.instanceId.length > 0 ? [{ whatsappInstanceId: { in: query.instanceId } }] : []),
      // A MESMA condição do analisador: mensagem de atendente, sem ligação
      // (registro de chamada não é resposta escrita) e sem apagada.
      {
        messages: {
          some: {
            timestamp: { gte: query.from, lte: query.to },
            direction: "outbound",
            deletedAt: null,
            type: { not: "call" },
            ...(query.userId ? { sentByUserId: query.userId } : { sentByUserId: { not: null } }),
          },
        },
      },
    ];

    if (query.onlyOverdue) {
      // A MESMA conta do card "Atrasados agora" — nunca uma régua nova.
      const atendimento = await loadAttendanceSettings(deps.prisma, request.user.organizationId);
      const atrasadas = await scanOverdueConversations(
        deps.prisma,
        request.user.organizationId,
        { organizationId: request.user.organizationId, AND: filtros },
        atendimento,
        new Date(),
      );
      filtros.push({ id: { in: atrasadas.ids } });
    }

    const where: Prisma.ConversationWhereInput = {
      organizationId: request.user.organizationId,
      AND: filtros,
    };

    const [total, conversations] = await Promise.all([
      deps.prisma.conversation.count({ where }),
      deps.prisma.conversation.findMany({
        where,
        orderBy: { lastMessageAt: "desc" },
        take: limit,
        include: conversationInclude,
      }),
    ]);

    const nomes = await resolveConversationPersonNames(
      deps.prisma,
      request.user.organizationId,
      conversations,
    );
    return {
      conversations: conversations.map((conversation) =>
        serializeConversation(conversation, nomes.get(conversation.id) ?? null),
      ),
      total,
      /** Quantas ficaram de fora do teto: a tela diz o número, nunca esconde. */
      omitted: Math.max(0, total - conversations.length),
      limit,
    };
  });

  /**
   * A LEITURA POR DEPARTAMENTO, mais a linha do escritório inteiro.
   *
   * Responde a pergunta que a visão por atendente não responde: "como o CS foi
   * em agosto". Soma as MESMAS avaliações da aba por atendente, pelo mesmo
   * acumulador (`lib/quality/fold.ts`) — duas somas separadas fariam a média
   * do setor discordar da média das pessoas que atendem nele, e é esse tipo de
   * desencontro que faz a equipe parar de confiar no painel.
   *
   * O recorte usa o departamento COPIADO na avaliação: conversa transferida
   * depois não muda o passado. Descartada continua fora, pelo mesmo motivo da
   * visão por atendente — ela foi descartada justamente para não pesar.
   */
  app.get("/quality/departments", { preHandler: guarda }, async (request) => {
    const query = z
      .object({ from: z.coerce.date().optional(), to: z.coerce.date().optional() })
      .parse(request.query);

    const evaluations = await deps.prisma.qualityEvaluation.findMany({
      where: {
        organizationId: request.user.organizationId,
        conversation: await escopoDeConversa(deps, request),
        discardedAt: null,
        ...(query.from || query.to
          ? {
              run: {
                is: {
                  ...(query.from ? { periodTo: { gte: query.from } } : {}),
                  ...(query.to ? { periodFrom: { lte: query.to } } : {}),
                },
              },
            }
          : {}),
      },
      orderBy: { createdAt: "asc" },
      include: {
        conversation: { select: QUALITY_CONVERSATION_SELECT },
        run: { select: { periodFrom: true, periodTo: true } },
      },
    });

    // O título não entra no agregado, mas o serializer o pede: resolver em
    // lote é o mesmo custo de sempre (uma consulta), e passar nulo aqui
    // obrigaria a um segundo caminho de serialização só para esta rota.
    const titulos = await resolveQualityTitles(
      deps.prisma,
      request.user.organizationId,
      evaluations.map((row) => row.conversation),
    );
    return foldQualityDepartments(
      evaluations.map((row) =>
        serializeQualityEvaluation(
          row,
          row.conversation ? (titulos.get(row.conversation.id) ?? null) : null,
          row.run,
        ),
      ),
    );
  });

  app.get("/quality/agents", { preHandler: guarda }, async (request) => {
    const query = z
      .object({
        from: z.coerce.date().optional(),
        to: z.coerce.date().optional(),
        // Cruza com o período, como no Dashboard: "a Ana DENTRO do CS".
        departmentId: z.union([uuid, z.literal("none")]).optional(),
      })
      .parse(request.query);

    const evaluations = await deps.prisma.qualityEvaluation.findMany({
      where: {
        organizationId: request.user.organizationId,
        conversation: await escopoDeConversa(deps, request),
        discardedAt: null,
        ...departamentoWhere(query.departmentId),
        // Mesmo recorte por PERÍODO AVALIADO da lista de avaliações.
        ...(query.from || query.to
          ? {
              run: {
                is: {
                  ...(query.from ? { periodTo: { gte: query.from } } : {}),
                  ...(query.to ? { periodFrom: { lte: query.to } } : {}),
                },
              },
            }
          : {}),
      },
      orderBy: { createdAt: "asc" },
      include: {
        conversation: { select: QUALITY_CONVERSATION_SELECT },
        run: { select: { periodFrom: true, periodTo: true } },
      },
    });

    const titulos = await resolveQualityTitles(
      deps.prisma,
      request.user.organizationId,
      evaluations.map((row) => row.conversation),
    );
    return {
      agents: foldQualityAgents(
        evaluations.map((row) =>
          serializeQualityEvaluation(
            row,
            row.conversation ? (titulos.get(row.conversation.id) ?? null) : null,
            row.run,
          ),
        ),
      ),
    };
  });
}

/** Duração que o WhatsApp mandou, gravada pela ingestão. */
function readDurationSeconds(metadata: unknown): number | null {
  if (!metadata || typeof metadata !== "object") return null;
  const value = (metadata as Record<string, unknown>).durationSeconds;
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

/**
 * O `where` do filtro por departamento. `none` é "sem departamento" — um
 * recorte de verdade, e não a ausência do filtro: a conversa que o número não
 * classificou é atendimento igual, e some-la do painel esconderia justamente a
 * que ninguém está olhando.
 */
function departamentoWhere(departmentId: string | undefined): { departmentId?: string | null } {
  if (!departmentId) return {};
  return { departmentId: departmentId === "none" ? null : departmentId };
}

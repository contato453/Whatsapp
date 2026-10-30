import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { RealtimeEvents, normalizeBrazilPhone } from "@azvchat/shared";
import type { IntegrationToken } from "@azvchat/database";
import { requireRole } from "../../lib/auth.js";
import { AppError, NotFoundError, UnauthorizedError } from "../../lib/errors.js";
import {
  generateIntegrationToken,
  hashIntegrationToken,
} from "../../lib/integration-token.js";
import { openIntegrationOpportunity, type IntegrationCrmResult } from "../../lib/integration-crm.js";
import { serializeConversation, serializeMessage } from "../../lib/serialize.js";
import { conversationAudience } from "../../realtime/socket.js";
import { buildPreview } from "../../services/message-ingest.js";
import type { AppDeps } from "../../types.js";
import { serializeIntegrationToken } from "./serialize.js";

// Anexa o token autenticado à requisição, para o handler não repetir a busca.
declare module "fastify" {
  interface FastifyRequest {
    integrationToken?: IntegrationToken;
  }
}

/** Texto máximo de uma mensagem de integração — o WhatsApp aceita bem mais,
 * mas confirmação de agendamento não precisa, e um teto evita abuso. */
const MESSAGE_MAX_LENGTH = 4096;

/** Janela da idempotência: a mesma chave dentro deste prazo não reenvia. */
const IDEMPOTENCY_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Autenticação por token de MÁQUINA — o primeiro caminho do sistema que não é
 * JWT de sessão de navegador (o `financeiro-lembrete` usa bearer ESTÁTICO do
 * `.env`; aqui o token vem do banco, por-tenant, conferido por hash). Não
 * passa por `verifySession`, `authenticate` nem `requireRole`: não há usuário.
 *
 * Sem token, token inexistente E token revogado respondem TODOS 401 — não
 * revelamos qual dos três, e revogado (`active = false`) é 401 de propósito (a
 * integração "some"), diferente do 403 de instância errada, em que o token é
 * válido mas não manda por aquele número.
 */
export function authenticateIntegrationToken(deps: AppDeps) {
  return async (request: FastifyRequest): Promise<void> => {
    const header = request.headers.authorization ?? "";
    const provided = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
    if (!provided) throw new UnauthorizedError();
    const token = await deps.prisma.integrationToken.findFirst({
      where: { tokenHash: hashIntegrationToken(provided) },
    });
    if (!token || !token.active) throw new UnauthorizedError();
    request.integrationToken = token;
  };
}

const sendBodySchema = z.object({
  // Sem `.min`: número vazio ou lixo é decidido pela normalização, que
  // responde 422 com o motivo, em vez de 400 genérico de validação.
  telefone: z.string(),
  mensagem: z.string().max(MESSAGE_MAX_LENGTH),
  // Idempotência opcional: o sistema externo manda a mesma chave ao repetir
  // por timeout, e a segunda chamada não reenvia.
  idempotencyKey: z.string().min(1).max(200).optional(),
  // Instância é SEMPRE a do token; aceitar o campo só serve para RECUSAR uma
  // tentativa de enviar por outra (403). Enviar sem ele usa a do token.
  instanceId: z.string().uuid().optional(),
  // Nome da pessoa, quando o sistema externo tem (o formulário do site tem):
  // vira o título do card no CRM. Não mexe no nome da conversa — esse continua
  // vindo do WhatsApp e da equipe, como em qualquer conversa.
  nome: z.string().trim().max(120).optional(),
  // Destino no CRM escolhido pela CHAMADA, por cima do configurado no token.
  // O normal é deixar a escolha no token (quem administra troca a etapa sem
  // mexer no site); estes dois existem para o sistema que precisa mandar cada
  // lead para um funil diferente.
  funilId: z.string().uuid().optional(),
  etapaId: z.string().uuid().optional(),
});

/** Destino do card no CRM para este envio: o da chamada vence o do token. */
interface CrmTarget {
  pipelineId: string;
  stageId: string | null;
}

/**
 * Resolve e CONFERE o destino ANTES de enviar. O que vem na chamada é
 * recusado com 422 se estiver errado — a mensagem ainda não saiu, então o
 * sistema externo pode corrigir e repetir sem duplicar nada. O que vem do
 * token não é conferido aqui: ele foi validado ao ser gravado, e se o funil
 * mudou depois quem trata é o helper, sem derrubar o envio.
 */
async function resolveCrmTarget(
  deps: AppDeps,
  token: IntegrationToken,
  body: z.infer<typeof sendBodySchema>,
  organizationId: string,
): Promise<CrmTarget | null> {
  if (!body.funilId && !body.etapaId) {
    return token.crmPipelineId ? { pipelineId: token.crmPipelineId, stageId: token.crmStageId } : null;
  }
  const pipelineId = body.funilId ?? token.crmPipelineId;
  if (!pipelineId) {
    throw new AppError(
      "Informe o funil (funilId): este token não tem funil do CRM configurado.",
      422,
      "funil_nao_informado",
    );
  }
  const pipeline = await deps.prisma.crmPipeline.findFirst({
    where: { id: pipelineId, organizationId },
    select: { isActive: true, stages: { select: { id: true } } },
  });
  if (!pipeline || !pipeline.isActive) {
    throw new AppError("Funil do CRM não encontrado ou desativado.", 422, "funil_invalido");
  }
  // Etapa sem funil na chamada vale para o funil do token; funil novo sem
  // etapa começa na primeira — a etapa do token é de OUTRO funil.
  const stageId = body.etapaId ?? (body.funilId ? null : token.crmStageId);
  if (body.etapaId && !pipeline.stages.some((stage) => stage.id === body.etapaId)) {
    throw new AppError("Esta etapa não pertence ao funil informado.", 422, "etapa_invalida");
  }
  return { pipelineId, stageId };
}

/**
 * Rota de ENVIO da API de integração — autenticada por token de máquina.
 * Reaproveita o mesmo caminho do envio manual da Inbox: `ensureConversation`
 * (idêntico ao número novo que chega), `provider.sendText`, `Message.create`
 * outbound, atualização de prévia e os eventos `message:new` +
 * `conversation:updated` na audiência da conversa.
 *
 * Separada das rotas de administração de propósito: o teste registra só ela,
 * sem arrastar o `requireRole` das outras.
 */
export function registerIntegrationSendRoute(app: FastifyInstance, deps: AppDeps): void {
  app.post(
    "/integrations/messages",
    {
      preHandler: authenticateIntegrationToken(deps),
      config: {
        // Limite POR TOKEN (não por IP): a chave é o hash do bearer. O valor
        // vem da configuração, não espalhado no código. Em teste o plugin de
        // rate-limit não está registrado, então este bloco é inerte lá.
        rateLimit: {
          max: deps.config.INTEGRATION_TOKEN_RATE_LIMIT_PER_MINUTE,
          timeWindow: "1 minute",
          keyGenerator: (request: FastifyRequest) => {
            const header = request.headers.authorization ?? "";
            const provided = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
            return provided ? `itk:${hashIntegrationToken(provided)}` : (request.ip ?? "itk:anon");
          },
        },
      },
    },
    async (request, reply) => {
      const body = sendBodySchema.parse(request.body);
      // Garantido presente pelo preHandler.
      const token = request.integrationToken as IntegrationToken;

      // Amarração à instância: um token não envia por outra. Sem o campo, usa
      // a do token; com o campo divergente, recusa antes de qualquer envio.
      if (body.instanceId && body.instanceId !== token.whatsappInstanceId) {
        throw new AppError(
          "Este token só pode enviar pela instância à qual está vinculado.",
          403,
          "instance_forbidden",
        );
      }

      // Normaliza o telefone ANTES de qualquer coisa (com ou sem 55, com ou
      // sem pontuação). Grupo e número inválido não chegam a tentar enviar.
      const normalized = normalizeBrazilPhone(body.telefone);
      if (!normalized.ok) {
        if (normalized.reason === "group") {
          throw new AppError(
            "Envio para grupo não é permitido nesta rota.",
            422,
            "grupo_nao_suportado",
          );
        }
        throw new AppError(
          "Telefone inválido: informe um número brasileiro com DDD.",
          422,
          "telefone_invalido",
        );
      }

      const mensagem = body.mensagem.trim();
      if (!mensagem) {
        throw new AppError("A mensagem não pode ser vazia.", 422, "mensagem_vazia");
      }

      // Idempotência: chave já usada dentro da janela devolve o resultado
      // original, sem reenviar. Fora da janela, segue o envio (e a linha é
      // sobrescrita no fim).
      if (body.idempotencyKey) {
        const prior = await deps.prisma.integrationMessageLog.findUnique({
          where: {
            integrationTokenId_idempotencyKey: {
              integrationTokenId: token.id,
              idempotencyKey: body.idempotencyKey,
            },
          },
        });
        if (prior && prior.createdAt.getTime() > Date.now() - IDEMPOTENCY_WINDOW_MS) {
          return reply.status(200).send({
            status: prior.status,
            messageId: prior.messageId,
            conversationId: prior.conversationId,
            phone: prior.normalizedPhone,
            idempotent: true,
            // A repetição não abre card de novo: a chamada original já cuidou
            // disso, e o resultado dela não é guardado (o card está no CRM).
            crm: null,
          });
        }
      }

      // Instância do token: pode ter sido excluída depois de o token ser
      // criado (409, não 500). O organizationId vem dela, não de env separado.
      const instance = await deps.prisma.whatsAppInstance.findUnique({
        where: { id: token.whatsappInstanceId },
      });
      if (!instance) {
        throw new AppError(
          "O número de WhatsApp deste token não existe mais.",
          409,
          "instance_unavailable",
        );
      }

      // Desconectada ou aguardando QR: não enfileira em silêncio — responde
      // 409 para o sistema externo saber que a confirmação NÃO saiu.
      // Destino no CRM conferido ANTES do envio: erro aqui ainda não mandou
      // nada ao cliente.
      const crmTarget = await resolveCrmTarget(deps, token, body, instance.organizationId);

      const status = await deps.provider.getConnectionStatus(instance.id);
      if (status !== "connected") {
        throw new AppError(
          `O número de WhatsApp está desconectado no momento (status: ${status}).`,
          409,
          "instance_offline",
        );
      }

      // Conversa (e contato) criados no MESMO caminho do número novo que chega
      // — sem inventar departamento nem responsável (nasce como qualquer
      // conversa de número desconhecido).
      const conversation = await deps.ingest.ensureConversation(
        {
          instanceId: instance.id,
          externalChatId: normalized.jid,
          isGroup: false,
          callerName: null,
          callerPhone: normalized.phone,
        },
        instance.organizationId,
      );

      let sendResult: { externalMessageId: string; timestamp: Date };
      try {
        sendResult = await deps.provider.sendText(instance.id, normalized.jid, mensagem);
      } catch (err) {
        throw new AppError(
          `Falha ao enviar a mensagem pelo WhatsApp: ${err instanceof Error ? err.message : "erro desconhecido"}`,
          502,
          "falha_envio",
        );
      }

      const preview = buildPreview({ type: "text", content: mensagem });
      const message = await deps.prisma.message.create({
        data: {
          organizationId: instance.organizationId,
          conversationId: conversation.id,
          externalMessageId: sendResult.externalMessageId,
          direction: "outbound",
          type: "text",
          content: mensagem,
          // Nome que diferencia da mensagem digitada pela equipe, com o token.
          senderName: `Integração (${token.name})`,
          timestamp: sendResult.timestamp,
          status: "sent",
          // Sem `sentByUserId`: não é pessoa logada. `origem` marca a fonte.
          metadata: { origem: "api-integration", integrationTokenId: token.id },
        },
      });

      await deps.prisma.conversation.update({
        where: { id: conversation.id },
        data: { lastMessageAt: sendResult.timestamp, lastMessagePreview: preview },
      });

      // Emite o mesmo par de eventos do envio manual, na mesma audiência —
      // com a prévia/`lastMessageAt` já atualizados no objeto que serializa,
      // para a lista não anunciar o estado velho.
      const conversationForEmit = {
        ...conversation,
        lastMessageAt: sendResult.timestamp,
        lastMessagePreview: preview,
      };
      const room = conversationAudience(instance.organizationId, conversation);
      deps.io.to(room).emit(RealtimeEvents.MessageNew, {
        conversation: serializeConversation(conversationForEmit, null),
        message: serializeMessage(message),
      });
      deps.io
        .to(room)
        .emit(RealtimeEvents.ConversationUpdated, serializeConversation(conversationForEmit, null));

      // Card no CRM. Depois do envio e sem poder derrubá-lo: a mensagem já
      // saiu, e responder erro agora faria o sistema externo repeti-la.
      const crm: IntegrationCrmResult | null = crmTarget
        ? await openIntegrationOpportunity(
            { prisma: deps.prisma, io: deps.io, logger: deps.logger },
            {
              organizationId: instance.organizationId,
              conversationId: conversation.id,
              pipelineId: crmTarget.pipelineId,
              stageId: crmTarget.stageId,
              title: body.nome || null,
              integrationTokenId: token.id,
            },
          )
        : null;

      // Marca o uso do token — para a tela mostrar "último uso" e o contador.
      await deps.prisma.integrationToken.update({
        where: { id: token.id },
        data: { lastUsedAt: sendResult.timestamp, usageCount: { increment: 1 } },
      });

      // Idempotência: grava (ou sobrescreve, após a janela) o resultado.
      if (body.idempotencyKey) {
        const logData = {
          conversationId: conversation.id,
          messageId: message.id,
          normalizedPhone: normalized.phone,
          status: "sent",
        };
        await deps.prisma.integrationMessageLog.upsert({
          where: {
            integrationTokenId_idempotencyKey: {
              integrationTokenId: token.id,
              idempotencyKey: body.idempotencyKey,
            },
          },
          create: {
            integrationTokenId: token.id,
            idempotencyKey: body.idempotencyKey,
            ...logData,
          },
          update: { ...logData, createdAt: new Date() },
        });
      }

      // Auditoria: token, instância, conversa e resultado — nunca o conteúdo
      // da mensagem nem o token em claro.
      deps.audit.record({
        organizationId: instance.organizationId,
        userId: null,
        action: "message.sent.integration",
        entityType: "Conversation",
        entityId: conversation.id,
        metadata: {
          origem: "api-integration",
          integrationTokenId: token.id,
          instanceId: instance.id,
          conversationId: conversation.id,
          messageId: message.id,
          result: "sent",
          crmStatus: crm?.status ?? null,
          crmOpportunityId: crm?.opportunityId ?? null,
        },
      });

      return reply.status(200).send({
        status: "sent",
        messageId: message.id,
        conversationId: conversation.id,
        phone: normalized.phone,
        idempotent: false,
        // Nulo = este envio não tinha destino no CRM.
        crm,
      });
    },
  );
}

const crmTargetFields = {
  crmPipelineId: z.string().uuid().nullish(),
  crmStageId: z.string().uuid().nullish(),
};

const createTokenSchema = z.object({
  name: z.string().min(2).max(80),
  whatsappInstanceId: z.string().uuid(),
  ...crmTargetFields,
});

const updateTokenSchema = z.object({
  name: z.string().min(2).max(80).optional(),
  ...crmTargetFields,
});

/** O que a lista de tokens precisa para mostrar número e destino no CRM. */
const tokenInclude = {
  instance: { select: { name: true } },
  crmPipeline: { select: { name: true } },
  crmStage: { select: { name: true } },
} as const;

/**
 * Confere o destino no CRM antes de GRAVAR no token: funil desta organização
 * e etapa dele. Etapa sem funil é recusada — não teria a que pertencer.
 */
async function assertCrmTarget(
  deps: AppDeps,
  organizationId: string,
  pipelineId: string | null,
  stageId: string | null,
): Promise<void> {
  if (!pipelineId) {
    if (stageId) throw new AppError("Escolha o funil antes da etapa.", 422, "funil_nao_informado");
    return;
  }
  const pipeline = await deps.prisma.crmPipeline.findFirst({
    where: { id: pipelineId, organizationId },
    select: { stages: { select: { id: true } } },
  });
  if (!pipeline) throw new NotFoundError("Funil");
  if (stageId && !pipeline.stages.some((stage) => stage.id === stageId)) {
    throw new AppError("Esta etapa não pertence ao funil escolhido.", 422, "etapa_invalida");
  }
}

/**
 * Administração de tokens — só admin, papel FIXO no código (mesma régua de
 * criar/excluir número): manejar credencial de máquina é ato de administração,
 * não recorte de permissão configurável.
 */
export function registerIntegrationTokenAdminRoutes(app: FastifyInstance, deps: AppDeps): void {
  app.get(
    "/integration-tokens",
    { preHandler: requireRole("admin") },
    async (request) => {
      const tokens = await deps.prisma.integrationToken.findMany({
        where: { organizationId: request.user.organizationId },
        orderBy: { createdAt: "desc" },
        include: tokenInclude,
      });
      return { tokens: tokens.map(serializeIntegrationToken) };
    },
  );

  app.post(
    "/integration-tokens",
    { preHandler: requireRole("admin") },
    async (request, reply) => {
      const body = createTokenSchema.parse(request.body);
      // A instância precisa ser da organização — senão o token nasceria
      // apontando para número de fora.
      const instance = await deps.prisma.whatsAppInstance.findFirst({
        where: { id: body.whatsappInstanceId, organizationId: request.user.organizationId },
        select: { id: true },
      });
      if (!instance) throw new NotFoundError("Instância de WhatsApp");
      const crmPipelineId = body.crmPipelineId ?? null;
      const crmStageId = crmPipelineId ? (body.crmStageId ?? null) : null;
      await assertCrmTarget(deps, request.user.organizationId, crmPipelineId, body.crmStageId ?? null);

      const generated = generateIntegrationToken();
      const created = await deps.prisma.integrationToken.create({
        data: {
          organizationId: request.user.organizationId,
          name: body.name,
          tokenPrefix: generated.tokenPrefix,
          tokenHash: generated.tokenHash,
          whatsappInstanceId: body.whatsappInstanceId,
          crmPipelineId,
          crmStageId,
          createdById: request.user.sub,
        },
        include: tokenInclude,
      });

      deps.audit.record({
        organizationId: request.user.organizationId,
        userId: request.user.sub,
        action: "integration_token.created",
        entityType: "IntegrationToken",
        entityId: created.id,
        metadata: { instanceId: body.whatsappInstanceId, name: body.name, crmPipelineId, crmStageId },
      });

      // O token em claro sai UMA vez, aqui. Não há rota que o devolva de novo.
      return reply.status(201).send({
        token: generated.token,
        integrationToken: serializeIntegrationToken(created),
      });
    },
  );

  // Editar nome e destino no CRM. O número NÃO muda por aqui: trocar o número
  // de um token em uso faria o sistema externo passar a falar por outro chip
  // sem ninguém do lado de lá saber — para isso, gera-se um token novo.
  app.patch(
    "/integration-tokens/:id",
    { preHandler: requireRole("admin") },
    async (request) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
      const body = updateTokenSchema.parse(request.body);
      const token = await deps.prisma.integrationToken.findFirst({
        where: { id, organizationId: request.user.organizationId },
      });
      if (!token) throw new NotFoundError("Token de integração");

      const data: { name?: string; crmPipelineId?: string | null; crmStageId?: string | null } = {};
      if (body.name !== undefined) data.name = body.name;
      if (body.crmPipelineId !== undefined || body.crmStageId !== undefined) {
        const crmPipelineId =
          body.crmPipelineId !== undefined ? (body.crmPipelineId ?? null) : token.crmPipelineId;
        // Trocar ou limpar o funil sem dizer a etapa zera a etapa: a antiga
        // era de outro funil.
        const crmStageId = !crmPipelineId
          ? null
          : body.crmStageId !== undefined
            ? (body.crmStageId ?? null)
            : crmPipelineId === token.crmPipelineId
              ? token.crmStageId
              : null;
        await assertCrmTarget(deps, request.user.organizationId, crmPipelineId, crmStageId);
        data.crmPipelineId = crmPipelineId;
        data.crmStageId = crmStageId;
      }

      const updated = await deps.prisma.integrationToken.update({
        where: { id },
        data,
        include: tokenInclude,
      });

      deps.audit.record({
        organizationId: request.user.organizationId,
        userId: request.user.sub,
        action: "integration_token.updated",
        entityType: "IntegrationToken",
        entityId: id,
        metadata: {
          before: { name: token.name, crmPipelineId: token.crmPipelineId, crmStageId: token.crmStageId },
          after: {
            name: updated.name,
            crmPipelineId: updated.crmPipelineId,
            crmStageId: updated.crmStageId,
          },
        },
      });

      return { integrationToken: serializeIntegrationToken(updated) };
    },
  );

  app.post(
    "/integration-tokens/:id/revoke",
    { preHandler: requireRole("admin") },
    async (request) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
      const token = await deps.prisma.integrationToken.findFirst({
        where: { id, organizationId: request.user.organizationId },
      });
      if (!token) throw new NotFoundError("Token de integração");

      // Revogar é DESATIVAR, nunca apagar: o histórico de uso fica de pé.
      const updated = await deps.prisma.integrationToken.update({
        where: { id },
        data: { active: false },
        include: tokenInclude,
      });

      deps.audit.record({
        organizationId: request.user.organizationId,
        userId: request.user.sub,
        action: "integration_token.revoked",
        entityType: "IntegrationToken",
        entityId: id,
      });

      return { integrationToken: serializeIntegrationToken(updated) };
    },
  );
}

/** Registra a rota de envio (token) e as de administração (admin). */
export function integrationMessageApiRoutes(app: FastifyInstance, deps: AppDeps): void {
  registerIntegrationSendRoute(app, deps);
  registerIntegrationTokenAdminRoutes(app, deps);
}

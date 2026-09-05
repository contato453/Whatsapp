import { rm, stat } from "node:fs/promises";
import { join } from "node:path";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { Prisma } from "@azvchat/database";
import { formatPhone } from "@azvchat/shared";
import { conversationScope, loadConversationAccess } from "../../lib/access.js";
import { requirePermission } from "../../lib/permissions.js";
import { AppError, NotFoundError } from "../../lib/errors.js";
import { phoneFromJid, resolveConversationPersonNames } from "../../lib/person-profile.js";
import type { AppDeps } from "../../types.js";

/** Lista de valores num filtro: aceita repetido (?x=a&x=b) ou "a,b". */
function toList(value: unknown): string[] {
  const raw = Array.isArray(value) ? value : value == null ? [] : [value];
  return raw
    .flatMap((entry) => String(entry).split(","))
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

/**
 * Discador de voz. O ÁUDIO é WebRTC direto (UDP) entre o navegador e o
 * servidor do AstraCalls; estas rotas cuidam só da SINALIZAÇÃO
 * (iniciar/atender/recusar/encerrar e a troca de SDP) e existem para manter a
 * chave do AstraCalls no servidor — o navegador nunca fala com ele.
 *
 * Tudo é escopado pela CONVERSA (mesmo controle de acesso das mensagens): quem
 * não enxerga a conversa não liga por ela. Chamada é do número da conversa.
 */

// Métodos de chamada vivem FORA da interface WhatsAppProvider (o Baileys não os
// tem). Alcançamos por narrowing, como o webhook faz com handleWebhook.
interface CallCapableProvider {
  startCall?(instanceId: string, phone: string, opts?: { video?: boolean }): Promise<{ callId: string }>;
  acceptCall?(instanceId: string, callId: string): Promise<void>;
  rejectCall?(instanceId: string, callId: string): Promise<void>;
  endCall?(instanceId: string, callId: string): Promise<void>;
  webrtcOffer?(instanceId: string, callId: string, sdpOffer: string): Promise<{ sdpAnswer: string }>;
}

export async function callRoutes(app: FastifyInstance, deps: AppDeps): Promise<void> {
  function callProvider(): Required<CallCapableProvider> {
    const provider = deps.provider as CallCapableProvider;
    if (
      typeof provider.startCall !== "function" ||
      typeof provider.acceptCall !== "function" ||
      typeof provider.rejectCall !== "function" ||
      typeof provider.endCall !== "function" ||
      typeof provider.webrtcOffer !== "function"
    ) {
      throw new AppError(
        "O provider de WhatsApp atual não suporta chamadas.",
        501,
        "calls_nao_suportado",
      );
    }
    return provider as Required<CallCapableProvider>;
  }

  async function findConversationOr404(id: string, user: FastifyRequest["user"]) {
    const access = await loadConversationAccess(deps.prisma, user);
    const conversation = await deps.prisma.conversation.findFirst({
      where: { id, organizationId: user.organizationId, ...conversationScope(access) },
      select: { id: true, type: true, externalChatId: true, whatsappInstanceId: true },
    });
    if (!conversation) throw new NotFoundError("Conversa");
    return conversation;
  }

  /**
   * Telefone discável da conversa. Individual em `@s.whatsapp.net` já traz os
   * dígitos; senão (ex.: `@lid`) tentamos o Contact. Sem telefone real, 422 —
   * discar o LID não liga para ninguém.
   */
  async function resolveCallPhone(
    organizationId: string,
    conversation: { id: string; type: string; externalChatId: string; whatsappInstanceId: string },
  ): Promise<string> {
    if (conversation.type === "group") {
      throw new AppError("Não é possível ligar para um grupo.", 400, "call_group_unsupported");
    }
    if (conversation.externalChatId.endsWith("@s.whatsapp.net")) {
      const digits = conversation.externalChatId.split("@")[0]?.replace(/\D/g, "") ?? "";
      if (digits) return digits;
    }
    const contact = await deps.prisma.contact.findFirst({
      where: {
        organizationId,
        whatsappInstanceId: conversation.whatsappInstanceId,
        externalId: conversation.externalChatId,
      },
      select: { phoneNumber: true },
    });
    if (contact?.phoneNumber) return contact.phoneNumber.replace(/\D/g, "");
    // Conversa por `@lid` não carrega telefone no id, mas o webhook grava o
    // telefone real (PN) em cada mensagem recebida (Message.senderPhone).
    // Usamos a última recebida com telefone — é o número por onde a pessoa fala.
    const lastWithPhone = await deps.prisma.message.findFirst({
      where: {
        conversationId: conversation.id,
        direction: "inbound",
        senderPhone: { not: null },
      },
      orderBy: { createdAt: "desc" },
      select: { senderPhone: true },
    });
    if (lastWithPhone?.senderPhone) return lastWithPhone.senderPhone.replace(/\D/g, "");
    throw new AppError(
      "Esta conversa não tem um telefone discável (identificada só por @lid).",
      422,
      "call_no_phone",
    );
  }

  const idParams = z.object({ id: z.string().uuid() });
  const callParams = z.object({ id: z.string().uuid(), callId: z.string().min(1) });

  // Inicia uma chamada de SAÍDA para o número da conversa. Faz o telefone tocar.
  app.post("/conversations/:id/calls", { preHandler: requirePermission(deps, "call.answer") }, async (request) => {
    const { id } = idParams.parse(request.params);
    const body = z.object({ video: z.boolean().optional() }).parse(request.body ?? {});
    const conversation = await findConversationOr404(id, request.user);
    const phone = await resolveCallPhone(request.user.organizationId, conversation);
    const { callId } = await callProvider().startCall(conversation.whatsappInstanceId, phone, {
      video: body.video,
    });
    deps.audit.record({
      organizationId: request.user.organizationId,
      userId: request.user.sub,
      action: "call.started",
      entityType: "Conversation",
      entityId: conversation.id,
    });
    return { callId };
  });

  app.post("/conversations/:id/calls/:callId/accept", { preHandler: requirePermission(deps, "call.answer") }, async (request) => {
    const { id, callId } = callParams.parse(request.params);
    const conversation = await findConversationOr404(id, request.user);
    await callProvider().acceptCall(conversation.whatsappInstanceId, callId);
    return { ok: true };
  });

  app.post("/conversations/:id/calls/:callId/reject", { preHandler: requirePermission(deps, "call.answer") }, async (request) => {
    const { id, callId } = callParams.parse(request.params);
    const conversation = await findConversationOr404(id, request.user);
    await callProvider().rejectCall(conversation.whatsappInstanceId, callId);
    return { ok: true };
  });

  app.delete("/conversations/:id/calls/:callId", { preHandler: requirePermission(deps, "call.answer") }, async (request) => {
    const { id, callId } = callParams.parse(request.params);
    const conversation = await findConversationOr404(id, request.user);
    await callProvider().endCall(conversation.whatsappInstanceId, callId);
    return { ok: true };
  });

  // Troca de SDP do WebRTC: recebe a oferta do navegador, devolve a resposta.
  // A chave do AstraCalls fica aqui no servidor — o navegador nunca a vê.
  app.post("/conversations/:id/calls/:callId/webrtc", { preHandler: requirePermission(deps, "call.answer") }, async (request) => {
    const { id, callId } = callParams.parse(request.params);
    const { sdp_offer } = z.object({ sdp_offer: z.string().min(1) }).parse(request.body);
    const conversation = await findConversationOr404(id, request.user);
    const { sdpAnswer } = await callProvider().webrtcOffer(
      conversation.whatsappInstanceId,
      callId,
      sdp_offer,
    );
    return { sdp_answer: sdpAnswer };
  });

  // ---------------------------------------------------------------------------
  // Registro de Ligações (tela "Ligações"): lista as chamadas — que são
  // `Message` type "call" — e serve a gravação em MP3 do AstraCalls.
  // Mesmo recorte de acesso das conversas: quem não enxerga a conversa não vê
  // a chamada dela.
  // ---------------------------------------------------------------------------

  const CALL_STATUSES = ["ringing", "accepted", "missed", "rejected"] as const;

  const listQuery = z.object({
    from: z.string().datetime().optional().or(z.string().date().optional()),
    to: z.string().datetime().optional().or(z.string().date().optional()),
    limit: z.coerce.number().min(1).max(100).default(50),
    offset: z.coerce.number().min(0).default(0),
    search: z.string().trim().max(120).optional(),
  });

  app.get("/calls", { preHandler: requirePermission(deps, "call.view") }, async (request) => {
    const query = listQuery.parse(request.query);
    const raw = (request.query ?? {}) as Record<string, unknown>;
    const statuses = toList(raw.status).filter((s): s is (typeof CALL_STATUSES)[number] =>
      (CALL_STATUSES as readonly string[]).includes(s),
    );
    const directions = toList(raw.direction).filter(
      (d): d is "inbound" | "outbound" => d === "inbound" || d === "outbound",
    );
    const callTypes = toList(raw.callType).filter((t) => t === "video" || t === "voice");
    const instanceIds = toList(raw.instanceId);

    const access = await loadConversationAccess(deps.prisma, request.user);

    // Datas: `to` inclui o dia inteiro quando vem sem hora (formato AAAA-MM-DD).
    const from = query.from ? new Date(query.from) : null;
    let to = query.to ? new Date(query.to) : null;
    if (to && /^\d{4}-\d{2}-\d{2}$/.test(query.to ?? "")) {
      to = new Date(to.getTime() + 24 * 60 * 60 * 1000 - 1);
    }

    const and: Prisma.MessageWhereInput[] = [];
    if (from || to) {
      and.push({ timestamp: { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) } });
    }
    if (directions.length) and.push({ direction: { in: directions } });
    if (instanceIds.length) {
      and.push({ conversation: { is: { whatsappInstanceId: { in: instanceIds } } } });
    }
    // Status e vídeo vivem no metadata JSON — filtro por caminho, com OR dentro.
    if (statuses.length) {
      and.push({ OR: statuses.map((s) => ({ metadata: { path: ["callStatus"], equals: s } })) });
    }
    // Vídeo/voz só filtra quando NÃO estão os dois marcados (aí é "todos").
    if (callTypes.length === 1) {
      and.push({ metadata: { path: ["isVideo"], equals: callTypes[0] === "video" } });
    }
    if (query.search) {
      const q = query.search;
      and.push({
        OR: [
          { conversation: { is: { title: { contains: q, mode: "insensitive" } } } },
          { conversation: { is: { customTitle: { contains: q, mode: "insensitive" } } } },
          { senderPhone: { contains: q.replace(/\D/g, "") } },
        ],
      });
    }

    const where: Prisma.MessageWhereInput = {
      type: "call",
      deletedAt: null,
      // Escopo de acesso + fora de arquivadas, POR CIMA dos filtros.
      conversation: { is: { ...conversationScope(access), archivedAt: null } },
      ...(and.length ? { AND: and } : {}),
    };

    const [rows, total] = await Promise.all([
      deps.prisma.message.findMany({
        where,
        orderBy: { timestamp: "desc" },
        take: query.limit,
        skip: query.offset,
        select: {
          id: true,
          conversationId: true,
          direction: true,
          senderExternalId: true,
          senderPhone: true,
          timestamp: true,
          metadata: true,
          conversation: {
            select: {
              id: true,
              type: true,
              title: true,
              customTitle: true,
              externalChatId: true,
              whatsappInstanceId: true,
              instance: { select: { name: true } },
            },
          },
        },
      }),
      deps.prisma.message.count({ where }),
    ]);

    // Nome da PESSOA nas conversas individuais — uma consulta para a página.
    const personNames = await resolveConversationPersonNames(
      deps.prisma,
      request.user.organizationId,
      rows.map((row) => row.conversation).filter((c): c is NonNullable<typeof c> => c != null),
    );

    const calls = rows.map((row) => {
      const conversation = row.conversation;
      const metadata = (row.metadata as Record<string, unknown> | null) ?? {};
      const personName = conversation ? personNames.get(conversation.id) ?? null : null;
      const phone =
        row.senderPhone ??
        (conversation ? phoneFromJid(conversation.externalChatId) : null);
      const name =
        conversation?.customTitle ??
        personName ??
        conversation?.title ??
        (phone ? formatPhone(phone) : null);
      return {
        id: row.id,
        conversationId: row.conversationId,
        contactName: name,
        contactPhone: phone,
        instanceName: conversation?.instance?.name ?? null,
        instanceId: conversation?.whatsappInstanceId ?? null,
        direction: row.direction,
        status: typeof metadata.callStatus === "string" ? metadata.callStatus : "missed",
        isVideo: metadata.isVideo === true,
        durationSeconds:
          typeof metadata.durationSeconds === "number" ? metadata.durationSeconds : null,
        hasRecording: typeof metadata.recordingId === "string" && metadata.recordingId.length > 0,
        timestamp: row.timestamp.toISOString(),
      };
    });

    return { calls, total };
  });

  // Serve a gravação (MP3) de uma chamada. O binário vem do AstraCalls com a
  // chave no servidor — o navegador recebe só o áudio, autenticado.
  app.get("/calls/:id/recording", { preHandler: requirePermission(deps, "call.recording.play") }, async (request, reply) => {
    const { id } = idParams.parse(request.params);
    const access = await loadConversationAccess(deps.prisma, request.user);
    const message = await deps.prisma.message.findFirst({
      where: {
        id,
        type: "call",
        organizationId: request.user.organizationId,
        conversation: { is: conversationScope(access) },
      },
      select: { metadata: true, conversation: { select: { whatsappInstanceId: true } } },
    });
    if (!message?.conversation) throw new NotFoundError("Ligação");
    const metadata = (message.metadata as Record<string, unknown> | null) ?? {};
    const recordingId = typeof metadata.recordingId === "string" ? metadata.recordingId : null;
    if (!recordingId) throw new NotFoundError("Gravação");

    const provider = deps.provider as {
      getCallRecording?: (
        instanceId: string,
        recordingId: string,
      ) => Promise<{ data: Buffer; mimeType: string } | null>;
    };
    if (typeof provider.getCallRecording !== "function") {
      throw new AppError("O provider atual não fornece gravação.", 501, "recording_unsupported");
    }
    const recording = await provider.getCallRecording(
      message.conversation.whatsappInstanceId,
      recordingId,
    );
    if (!recording) throw new NotFoundError("Gravação");
    reply.header("Content-Type", recording.mimeType);
    reply.header("Cache-Control", "private, max-age=3600");
    return reply.send(recording.data);
  });

  /**
   * Exclui as GRAVAÇÕES de um período para liberar espaço na VPS. Admin —
   * é destrutivo e é manutenção de infraestrutura, não atendimento. Apaga o
   * arquivo MP3 (que o AstraCalls grava em disco e não expõe rota de exclusão)
   * e limpa o `recordingId` no banco, para o botão de tocar sumir e não
   * apontar para arquivo que não existe mais. O REGISTRO da ligação continua
   * na lista — só o áudio some, que é o que ocupa espaço.
   */
  app.post("/calls/recordings/purge", { preHandler: requirePermission(deps, "call.recording.delete") }, async (request) => {
    const body = z
      .object({
        from: z.string().datetime().or(z.string().date()),
        to: z.string().datetime().or(z.string().date()),
      })
      .parse(request.body);

    const from = new Date(body.from);
    let to = new Date(body.to);
    if (/^\d{4}-\d{2}-\d{2}$/.test(body.to)) to = new Date(to.getTime() + 24 * 60 * 60 * 1000 - 1);
    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || from > to) {
      throw new AppError("Período inválido.", 400, "invalid_range");
    }

    const dir = deps.config.CALL_RECORDINGS_DIR;

    // Só chamadas da organização, com gravação, dentro do período. Admin
    // enxerga tudo, mas mantemos o organizationId como cerca do tenant.
    const calls = await deps.prisma.message.findMany({
      where: {
        type: "call",
        organizationId: request.user.organizationId,
        timestamp: { gte: from, lte: to },
      },
      select: { id: true, metadata: true },
    });

    let recordsCleared = 0;
    let filesDeleted = 0;
    let freedBytes = 0;
    let fileErrors = 0;
    for (const call of calls) {
      const metadata = (call.metadata as Record<string, unknown> | null) ?? {};
      const recordingId = typeof metadata.recordingId === "string" ? metadata.recordingId : null;
      // Só as que TÊM gravação: chamada sem áudio não ocupa espaço nem precisa
      // ter o ponteiro limpo.
      if (!recordingId) continue;
      recordsCleared += 1;

      if (dir) {
        // Nome do arquivo é `{recordingId}.mp3`. `join` + validação impedem
        // que um id torto escape do diretório (path traversal).
        const safeId = recordingId.replace(/[^A-Za-z0-9_-]/g, "");
        if (safeId === recordingId) {
          const path = join(dir, `${safeId}.mp3`);
          try {
            const info = await stat(path);
            await rm(path);
            filesDeleted += 1;
            freedBytes += info.size;
          } catch (err) {
            // Arquivo já não existia (ENOENT) não é erro; o resto conta.
            if ((err as NodeJS.ErrnoException).code !== "ENOENT") fileErrors += 1;
          }
        }
      }

      // Limpa o ponteiro da gravação, preservando o resto do metadata.
      const { recordingId: _drop, ...rest } = metadata;
      await deps.prisma.message.update({
        where: { id: call.id },
        data: { metadata: rest as Prisma.InputJsonValue },
      });
    }

    deps.audit.record({
      organizationId: request.user.organizationId,
      userId: request.user.sub,
      action: "call.recordings_purged",
      entityType: "Organization",
      entityId: request.user.organizationId,
      metadata: {
        from: from.toISOString(),
        to: to.toISOString(),
        recordsCleared,
        filesDeleted,
        freedBytes,
      },
    });

    return {
      recordsCleared,
      filesDeleted,
      freedBytes,
      fileErrors,
      // Sem o diretório configurado, só limpamos o banco — a tela avisa.
      diskConfigured: Boolean(dir),
    };
  });
}
